import {
  jsonSchema,
  stepCountIs,
  streamText,
  tool,
  type LanguageModel,
  type ModelMessage,
  type ToolSet,
} from "ai";
import { skillsToSystemBlock } from "../skills/loader.js";
import { toolsForAgent } from "../tools/catalog.js";
import { resolveLanguageModel } from "../models/registry.js";
import { createMockLanguageModel, estimateTokens, recordMockResult, BUILTIN_TOOL_NAMES } from "./mock.js";
import { compactHistory } from "./compact.js";
import {
  SubagentRegistry,
  createSubagentTools,
  subagentSystemSection,
} from "../agents/subagents.js";
import { createTodoStore, createTodoWriteTool, type TodoStore } from "../plan/todo.js";
import { createFileTodoStore } from "../plan/todo-file.js";
import { resolveTodoStoreDir, todoStoreIsPersistent } from "../plan/todo-dir.js";
import type {
  LoopEvent,
  MockScenario,
  RunLoopInput,
  StepUsage,
  TokenBudget,
  ToolDefinition,
  ToolResult,
} from "../types/index.js";

/** 层2：字符估算的兜底系数，与 DSH 同源 */
const CHARS_PER_TOKEN = 4;

/**
 * 层5：todo 的会话级投影。
 *
 * 对标 DSH 的「日志承载状态 + 单一所有者」：列表属于某个 agent 会话，
 * 不搞跨会话共享。轮次开始清空投影、事件日志保留。
 *
 * 落盘：事件追加进 `<仓库根>/data/loom-store/todos/<会话>.jsonl`（JSONL，只追加），
 * 重启后第一次碰到某个会话就回放它的日志 —— 投影与 turn 都能恢复。
 * 路径由 `LOOM_TODO_DIR` 覆盖；`LOOM_TODO_STORE=memory` 退回纯内存（CI 友好）。
 */
let sharedTodoStore: TodoStore | null = null;

function getSharedTodoStore(): TodoStore {
  if (sharedTodoStore) return sharedTodoStore;
  sharedTodoStore = todoStoreIsPersistent()
    ? createFileTodoStore({ dir: resolveTodoStoreDir() })
    : createTodoStore();
  return sharedTodoStore;
}

export function estimateTokensOf(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/** 层1-D：把内部 ToolDefinition 包成 AI SDK 原生工具 */
function toAISDKTools(
  tools: ToolDefinition[],
  ctx: {
    workspaceRoot: string;
    signal?: AbortSignal;
    onEvent?: (e: LoopEvent) => void;
    /** mock 的离线桩：toolCallId -> 结果 */
    stubs?: Map<string, ToolResult>;
    /** Ask 模式下把越权调用挡在 SDK 之前 */
    readOnly: boolean;
  },
): ToolSet {
  const set: ToolSet = {};
  for (const t of tools) {
    set[t.name] = tool({
      description: t.description,
      inputSchema: jsonSchema<Record<string, unknown>>(
        t.inputSchema as Parameters<typeof jsonSchema>[0],
      ),
      execute: async (input, options): Promise<ToolResult> => {
        const stub = ctx.stubs?.get(options.toolCallId);
        if (stub) return stub;

        if (
          ctx.readOnly &&
          (t.name === "write_file" || t.name === "run_safe_cmd")
        ) {
          const blocked: ToolResult = {
            ok: false,
            error: `Ask 模式禁止调用 ${t.name}`,
          };
          ctx.onEvent?.({ type: "tool_result", name: t.name, result: blocked });
          return blocked;
        }

        const result = await t.execute(input as Record<string, unknown>, {
          workspaceRoot: ctx.workspaceRoot,
          signal: options.abortSignal ?? ctx.signal,
        });
        return result;
      },
    });
  }
  return set;
}

/**
 * 合并工具来源。优先级：内置 / todo / 委派 > 插件（extraTools）。
 * 插件工具与前者同名时被丢弃并记一条 warning —— 与插件注册表同一套规则。
 */
function mergeTools(
  primary: ToolDefinition[],
  extra: ToolDefinition[],
  warn?: (m: string) => void,
): ToolDefinition[] {
  const taken = new Set(primary.map((t) => t.name));
  const merged = [...primary];
  for (const t of extra) {
    if (taken.has(t.name)) {
      warn?.(`插件工具 ${t.name} 与已有工具同名，已跳过`);
      continue;
    }
    taken.add(t.name);
    merged.push(t);
  }
  return merged;
}

/**
 * 单 Agent ReAct 循环。
 * 层1：真工具协议 —— 工具以 inputSchema 交给 SDK，循环交给 stopWhen，
 *       事件从 fullStream 映射；不再把工具塞进 system prompt、不再手写 JSON 协议。
 * 层1-C：mock 不再另起一条循环，而是换一个照剧本演的 LanguageModel。
 * 层3：上下文压缩 —— 真值/估算的 token 压力超过阈值就把最旧区间换成摘要。
 * 层4：子 agent 委派 —— 每个目标一个工具实例，另有 send_message / interrupt_agent / list_agents。
 * 层5：todo_write —— 整表替换，状态挂在会话投影上。
 */
export async function runAgentLoop(input: RunLoopInput): Promise<string> {
  const {
    workspaceRoot,
    agent,
    model,
    skills,
    goal,
    maxSteps = 6,
    signal,
    onEvent,
    mockScenario,
    temperature,
    history = [],
    readOnly = false,
    maxDepth = 1,
    extraTools = [],
  } = input;

  /*
   * 委派工具来源优先级：显式入参 > Agent 档案。
   * 让 Agent 档案自己声明委派能力，UI 就不必替每个 Agent 硬编码一份 —— 加一个
   * 「能派 3 个子 agent」的 Agent，改 profiles.ts 一处即可。
   */
  const subagents = input.subagents ?? agent.subagents ?? [];
  const effectiveMaxDepth = input.maxDepth ?? agent.maxDepth ?? maxDepth;

  const budget: TokenBudget = {
    maxSteps: input.budget?.maxSteps ?? maxSteps,
    maxTokens: input.budget?.maxTokens,
    // 上下文窗口的权威来源是模型路由（同 DSH：容量属于路由，压缩器只读不猜）
    contextWindow: input.budget?.contextWindow ?? model.contextWindow,
    compactThresholdRatio: input.budget?.compactThresholdRatio,
    compactRetainRatio: input.budget?.compactRetainRatio,
    headroomTokens: input.budget?.headroomTokens,
  };
  const stepLimit = budget.maxSteps ?? maxSteps;

  const allowed = readOnly
    ? agent.allowedTools.filter(
        (t) => t !== "write_file" && t !== "run_safe_cmd",
      )
    : agent.allowedTools;
  const baseTools = toolsForAgent(allowed);
  const skillBlock = skillsToSystemBlock(
    skills.filter((s) => agent.skillIds.includes(s.id)),
  );

  onEvent?.({ type: "phase", phase: "thinking" });

  // ---- 工具装配 -------------------------------------------------------
  // 先装工具再解析模型：mock 模型也要看见完整工具集（含委派与插件工具），
  // 否则离线演示永远演不出「派子 agent」这条路径，能力等于只在真模型下存在。
  // 委派工具：一个目标一个实例；子 agent 不再往下派（除非显式给了 childSubagents）
  const registry = new SubagentRegistry();
  const delegationTools = createSubagentTools(subagents, {
    // 用函数包一层，避免 run.ts <-> subagents.ts 的模块级循环依赖
    runLoop: (childInput) => runAgentLoop(childInput),
    registry,
    workspaceRoot,
    parentAllowedTools: allowed,
    parentModelId: model.id,
    parentSystemPrompt: agent.systemPrompt,
    readOnly,
    depth: 0,
    maxDepth: effectiveMaxDepth,
    mockScenario,
    parentSignal: signal,
    onEvent,
    todoSessionPrefix: input.todo?.sessionId,
    allowParallelTodo: input.todo?.allowParallelInProgress,
  });

  // todo 工具：只有调用方显式给了会话归属才注入（DSH：非 agent 调用方被拒）
  const todoStore = getSharedTodoStore();
  const todoTools: ToolDefinition[] = [];
  if (input.todo) {
    if (input.resetTodosAtTurnStart !== false) {
      todoStore.startTurn(input.todo.sessionId);
    }
    todoTools.push(
      createTodoWriteTool({
        store: todoStore,
        allowParallelInProgress: input.todo.allowParallelInProgress,
        sessionId: input.todo.sessionId,
      }),
    );
  }

  const tools = mergeTools(
    [...baseTools, ...todoTools, ...delegationTools],
    extraTools,
    (m) => onEvent?.({ type: "error", message: m }),
  );

  // 模型解析：显式注入 > registry > mock
  let mockRuntime: { stubs: Map<string, ToolResult> } | undefined;
  let resolved: LanguageModel | null = input.languageModel ?? null;
  if (!resolved) {
    resolved = resolveLanguageModel(model);
  }
  if (!resolved) {
    const scenario = resolveMockScenario({
      explicit: mockScenario,
      agentId: agent.id,
      modelId: model.id,
      goal,
      // 传合并后的工具名（含委派/插件工具），否则「派子 agent」这类场景不会被选中
      allowedTools: tools.map((t) => t.name),
    });
    const created = createMockLanguageModel({
      scenario,
      goal,
      workspaceRoot,
      agentId: agent.id,
      modelId: model.id,
      tools,
    });
    resolved = created.model;
    mockRuntime = created.runtime;
  }
  const languageModel: LanguageModel = resolved;

  const system = [
    agent.systemPrompt,
    readOnly ? "\n【Ask 模式】只读，禁止提出写文件或执行本地命令。" : "",
    "",
    "工作区根目录已沙箱隔离。按需调用已提供的工具；写文件与执行命令需要人工批准。",
    "任务完成后，用自然语言给出结论。",
    subagentSystemSection(subagents),
    skillBlock ? `\n已加载 Skills：\n${skillBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // ---- 消息装配与层3 压缩 --------------------------------------------
  const messages: ModelMessage[] = [];
  for (const h of history) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: "user", content: goal });

  if (budget.contextWindow && messages.length > 1) {
    const before = estimateTokensOf(JSON.stringify(messages));
    const preMessages = messages.slice(0, -1);
    const compacted = await compactHistory({
      messages: preMessages,
      model: languageModel,
      contextWindow: budget.contextWindow,
      thresholdRatio: budget.compactThresholdRatio,
      retainRatio: budget.compactRetainRatio,
      headroomTokens: budget.headroomTokens,
      signal,
    });
    if (compacted.compacted) {
      messages.length = 0;
      messages.push(...compacted.messages);
      messages.push({ role: "user", content: goal });
    }
    const after = estimateTokensOf(JSON.stringify(messages));
    onEvent?.({
      type: "compacted",
      compactedCount: compacted.compactedCount,
      releasedTokens: compacted.compacted ? Math.max(0, before - after) : 0,
      pressureTokens: compacted.pressureTokens,
      thresholdTokens: compacted.thresholdTokens,
      retainedCount: compacted.retainedCount,
      // 未触发是正常路径，不塞 reason 免得 UI 噪音；失败必须带原因
      reason: compacted.compacted ? undefined : compacted.reason,
    });
  }

  const aborter = new AbortController();
  const abortFromCaller = (): void => aborter.abort();
  if (signal) {
    if (signal.aborted) aborter.abort();
    else signal.addEventListener("abort", abortFromCaller, { once: true });
  }

  const usages: StepUsage[] = [];
  let stepIndex = 0;
  let totalTokens = 0;
  let budgetExceeded = false;

  /** toolCallId -> 工具名。tool-input-delta 只带 id，必须回查名字 */
  const toolNameById = new Map<string, string>();

  const stream = streamText({
    model: languageModel,
    system,
    messages,
    tools: toAISDKTools(tools, {
      workspaceRoot,
      signal: aborter.signal,
      onEvent,
      stubs: mockRuntime?.stubs,
      readOnly,
    }),
    stopWhen: stepCountIs(stepLimit),
    abortSignal: aborter.signal,
    maxRetries: 1,
    temperature: temperature ?? model.temperature ?? 0.3,
  });

  let stepText = "";
  let lastStepText = "";

  try {
    for await (const part of stream.fullStream) {
      switch (part.type) {
        case "start-step":
          stepText = "";
          break;

        case "text-delta":
          stepText += part.text;
          onEvent?.({ type: "text_delta", delta: part.text });
          break;

        case "text-end":
          if (stepText) {
            onEvent?.({ type: "text", text: stepText });
            lastStepText = stepText;
          }
          stepText = "";
          break;

        case "tool-input-start":
          // 层1 补丁：这里才有工具名，把它记下来给后面的 delta 回查
          toolNameById.set(part.id, String(part.toolName));
          break;

        case "tool-input-delta":
          onEvent?.({
            type: "tool_input_delta",
            name: toolNameById.get(part.id) ?? "",
            delta: part.delta,
          });
          break;

        case "tool-call": {
          const name = String(part.toolName);
          onEvent?.({
            type: "phase",
            phase:
              name === "write_file" || name === "run_safe_cmd"
                ? "writing"
                : "tooling",
          });
          onEvent?.({
            type: "tool_call",
            name,
            args: (part.input ?? {}) as Record<string, unknown>,
          });
          break;
        }

        case "tool-result": {
          const name = String(part.toolName);
          const result = part.output as ToolResult;
          recordMockResult(languageModel, result);
          onEvent?.({ type: "tool_result", name, result });
          if (result?.requiresApproval && result.pendingWrite) {
            onEvent?.({
              type: "approval_needed",
              kind: "write",
              path: result.pendingWrite.path,
              content: result.pendingWrite.content,
            });
          }
          if (result?.requiresApproval && result.pendingCmd) {
            onEvent?.({
              type: "approval_needed",
              kind: "cmd",
              path: result.pendingCmd.command,
              content: "",
              command: result.pendingCmd.command,
              background: result.pendingCmd.background,
            });
          }
          break;
        }

        case "tool-error": {
          onEvent?.({
            type: "tool_result",
            name: String(part.toolName),
            result: { ok: false, error: String(part.error) },
          });
          break;
        }

        case "finish-step": {
          stepIndex += 1;
          const usage = part.usage;
          const measured =
            typeof usage?.inputTokens === "number" ||
            typeof usage?.outputTokens === "number";
          const inputTokens =
            usage?.inputTokens ?? estimateTokensOf(JSON.stringify(messages));
          const outputTokens = usage?.outputTokens ?? estimateTokensOf(stepText);
          totalTokens += usage?.totalTokens ?? inputTokens + outputTokens;
          const record: StepUsage = {
            step: stepIndex,
            inputTokens,
            outputTokens,
            totalTokens: usage?.totalTokens ?? inputTokens + outputTokens,
            cacheReadTokens: usage?.inputTokenDetails?.cacheReadTokens ?? 0,
            cacheWriteTokens: usage?.inputTokenDetails?.cacheWriteTokens ?? 0,
            // 本步上下文压力：输入 token（真实值或估算值）
            pressureTokens: inputTokens,
            measured: Boolean(measured),
          };
          usages.push(record);
          onEvent?.({ type: "usage", usage: record, budget });
          if (budget.maxTokens && totalTokens > budget.maxTokens) {
            budgetExceeded = true;
            aborter.abort();
          }
          break;
        }

        case "error": {
          onEvent?.({ type: "error", message: String(part.error) });
          break;
        }

        case "abort": {
          break;
        }

        default:
          break;
      }
    }
  } finally {
    if (signal) signal.removeEventListener("abort", abortFromCaller);
    // 轮次收尾：保留当前 todo 清单（DSH：turn/end 保留刚完成的清单）
    if (input.todo) todoStore.endTurn(input.todo.sessionId);
  }

  if (budgetExceeded) {
    onEvent?.({
      type: "error",
      message: `已超预算：${totalTokens} tokens > ${budget.maxTokens}`,
    });
  } else if (aborter.signal.aborted) {
    onEvent?.({ type: "error", message: "已中止" });
  }

  let finalAnswer = lastStepText;
  if (!finalAnswer) {
    try {
      finalAnswer = await stream.text;
    } catch {
      finalAnswer = "";
    }
  }
  if (budgetExceeded) {
    finalAnswer += `\n（已超 token 预算 ${budget.maxTokens}，提前停止）`;
  }
  if (!finalAnswer.trim()) {
    finalAnswer = "（达到步数上限，未显式给出结论）";
  }

  onEvent?.({ type: "phase", phase: "done" });
  onEvent?.({ type: "done", text: finalAnswer, usage: usages });
  return finalAnswer;
}

export function resolveMockScenario(input: {
  explicit?: MockScenario;
  agentId: string;
  modelId: string;
  goal: string;
  allowedTools: string[];
}): MockScenario {
  if (input.explicit) return input.explicit;
  // 层4：只有当工具集里真的有非内置工具（委派/插件），且任务明确要求并行/委派时才演
  const hasForeignTool = input.allowedTools.some(
    (name) => !BUILTIN_TOOL_NAMES.has(name),
  );
  if (
    hasForeignTool &&
    /子\s?agent|subagent|并行|委派|分头|同时派/i.test(input.goal)
  ) {
    return "delegate_fanout";
  }
  // 后台 job：显式说「后台 / job」才演，别把普通「命令」抢过来（那条走 cmd_hitl）
  if (/后台|job_|job\b|长命令/i.test(input.goal) && input.allowedTools.includes("job_list")) {
    return "jobs_tour";
  }
  if (input.modelId === "mock-editor") {
    if (/两个|多文件|changelog/i.test(input.goal)) return "multi_write";
    if (/命令|git status|run_safe/i.test(input.goal)) return "cmd_hitl";
    return "write_hitl";
  }
  // 待办清单要排在 auditor 的 /TODO/i 之前：那条太宽，「看看 TODO.md 里的待办清单」
  // 会被它先截走判成 grep_audit，层5 的离线演示就永远进不了 todo_focus。
  // 这里只认显式待办措辞（TODO.md / 待办清单），「审计一下 TODO」仍旧走 grep_audit。
  if (/TODO\.md|待办清单/i.test(input.goal)) return "todo_focus";
  if (input.agentId === "auditor" || /审计|TODO|密钥|grep/i.test(input.goal)) {
    if (/env|\.env|password/i.test(input.goal)) return "env_audit";
    return "grep_audit";
  }
  if (
    (input.agentId === "editor" || input.allowedTools.includes("write_file")) &&
    /写|保存|创建|改|HITL|审批/i.test(input.goal)
  ) {
    if (/changelog/i.test(input.goal)) return "changelog_write";
    return "write_hitl";
  }
  if (/动手改码|代码研发/i.test(input.goal)) return "workflow_code";
  if (/核对结果|验证收尾/i.test(input.goal)) return "workflow_verify";
  if (/拟定改法|方案设计/i.test(input.goal)) return "workflow_design";
  if (/摸清现状|需求理解|多步任务/i.test(input.goal))
    return "workflow_requirements";
  if (/RULES|规则|\.loom/i.test(input.goal)) return "rules_focus";
  if (/package\.json|依赖/i.test(input.goal)) return "package_focus";
  if (/utils|工具函数/i.test(input.goal)) return "utils_focus";
  if (/API\.md|接口文档/i.test(input.goal)) return "api_docs";
  if (/fetch_url|抓取|http/i.test(input.goal)) return "fetch_url_stub";
  if (/只读|Ask 模式|不要写/i.test(input.goal)) return "ask_readonly";
  if (/导览|5 分钟|新人/i.test(input.goal)) return "skill_tour";
  if (/docs|架构|ARCHITECTURE/i.test(input.goal)) return "docs_focus";
  if (/README|说明|定位/i.test(input.goal)) return "readme_focus";
  if (/结构|目录|探索|list/i.test(input.goal)) return "structure_focus";
  return "explore";
}

export { estimateTokens };
export type { ToolResult };
