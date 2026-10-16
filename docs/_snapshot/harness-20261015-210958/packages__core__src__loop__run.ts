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
import { createMockLanguageModel, estimateTokens, recordMockResult } from "./mock.js";
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
 * 单 Agent ReAct 循环。
 * 层1：真工具协议 —— 工具以 inputSchema 交给 SDK，循环交给 stopWhen，
 *       事件从 fullStream 映射；不再把工具塞进 system prompt、不再手写 JSON 协议。
 * 层1-C：mock 不再另起一条循环，而是换一个照剧本演的 LanguageModel。
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
  } = input;

  const budget: TokenBudget = {
    maxSteps: input.budget?.maxSteps ?? maxSteps,
    maxTokens: input.budget?.maxTokens,
  };
  const stepLimit = budget.maxSteps ?? maxSteps;

  const allowed = readOnly
    ? agent.allowedTools.filter(
        (t) => t !== "write_file" && t !== "run_safe_cmd",
      )
    : agent.allowedTools;
  const tools = toolsForAgent(allowed);
  const skillBlock = skillsToSystemBlock(
    skills.filter((s) => agent.skillIds.includes(s.id)),
  );

  const system = [
    agent.systemPrompt,
    readOnly ? "\n【Ask 模式】只读，禁止提出写文件或执行本地命令。" : "",
    "",
    "工作区根目录已沙箱隔离。按需调用已提供的工具；写文件与执行命令需要人工批准。",
    "任务完成后，用自然语言给出结论。",
    skillBlock ? `\n已加载 Skills：\n${skillBlock}` : "",
  ]
    .filter(Boolean)
    .join("\n");

  onEvent?.({ type: "phase", phase: "thinking" });

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
      allowedTools: allowed,
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

  const messages: ModelMessage[] = [];
  for (const h of history.slice(-12)) {
    messages.push({ role: h.role, content: h.content });
  }
  messages.push({ role: "user", content: goal });

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

        case "tool-input-delta":
          onEvent?.({
            type: "tool_input_delta",
            name: toolNameOf(part),
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
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!budgetExceeded && !aborter.signal.aborted) {
      onEvent?.({ type: "error", message });
    }
  } finally {
    if (signal) signal.removeEventListener("abort", abortFromCaller);
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
    finalAnswer = `${finalAnswer}\n（已超 token 预算 ${budget.maxTokens}，提前停止）`;
  } else if (!finalAnswer) {
    finalAnswer = "（达到步数上限，未显式给出结论）";
  }

  onEvent?.({ type: "phase", phase: "done" });
  onEvent?.({ type: "done", text: finalAnswer, usage: usages });

  return finalAnswer;
}

/** tool-input-delta 分片只带 id，需要按 id 回查工具名 */
function toolNameOf(part: { id?: string }): string {
  return part.id ?? "";
}

export function resolveMockScenario(input: {
  explicit?: MockScenario;
  agentId: string;
  modelId: string;
  goal: string;
  allowedTools: string[];
}): MockScenario {
  if (input.explicit) return input.explicit;
  if (input.modelId === "mock-editor") {
    if (/两个|多文件|changelog/i.test(input.goal)) return "multi_write";
    if (/命令|git status|run_safe/i.test(input.goal)) return "cmd_hitl";
    return "write_hitl";
  }
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
  if (/TODO\.md|待办清单/i.test(input.goal)) return "todo_focus";
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
