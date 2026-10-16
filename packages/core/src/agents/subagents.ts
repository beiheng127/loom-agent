/**
 * 子 Agent 委派（层4）。
 *
 * 对标 DeepSeek Harness 的两组插件：
 *   - dsh-tool-subagent        每个委派目标挂一个实例，toolName 必须互不相同；
 *                              persona / toolFilter / maxDepth 按实例固定；
 *                              maxDepth 超限时工具仍可见、调用时返回错误结果。
 *   - dsh-tool-subagent-control send_message（steering，只回 messageId，不回内容）、
 *                              interrupt_agent（只停当前轮次）、
 *                              list_agents（inactive 不代表完成）。
 *
 * 与 DSH 的差异（如实写在 docs 里，不假装一样）：
 *   - DSH 的后台子 agent 归父级的通用 Job 接口管理（job_output / job_kill）；
 *     这里统一走 list_agents + send_message 回读，不额外引 Job 体系。
 *   - DSH 的 steering 在「最近步骤边界」投递；这里一个子 agent 的一轮就是一个
 *     streamText 请求，无法在请求中途注入，所以投递点是「轮次边界」，
 *     即当前轮跑完后自动续跑。这一点在 docs 里明说，不吹成同款。
 */

import type {
  AgentProfile,
  LoopEvent,
  MockScenario,
  ModelConfig,
  RunLoopInput,
  SubagentRecord,
  SubagentSpec,
  SubagentStatus,
  ToolDefinition,
  ToolName,
} from "../types/index.js";
import { getModelConfig } from "../models/registry.js";

/** 委派工具的入参 schema，所有实例共用（DSH 里也是共用一份） */
const SUBAGENT_INPUT_SCHEMA = {
  type: "object" as const,
  properties: {
    goal: {
      type: "string" as const,
      description: "交给子 agent 的完整任务描述。它看不到本次对话，必须自包含。",
    },
    run_in_background: {
      type: "boolean" as const,
      description:
        "true 则不等待，立刻返回 job id，之后用 list_agents 看进度。默认 false（前台等待并返回最终结论）。",
    },
  },
  required: ["goal"],
  additionalProperties: false,
};

/** 子 agent 允许的工具名必须匹配这个形状（与插件工具同一套约束） */
export const TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

let idCounter = 0;
function nextSubagentId(toolName: string): string {
  idCounter += 1;
  return `${toolName}-${Date.now().toString(36)}${idCounter.toString(36)}`;
}

/** 一条投递给子 agent 的消息 */
type InboxItem = {
  messageId: string;
  text: string;
  at: number;
  delivered: boolean;
};

type SubagentRuntime = {
  record: SubagentRecord;
  spec: SubagentSpec;
  aborter: AbortController;
  /** 子 agent 自己的会话历史，用于续跑 */
  history: Array<{ role: "user" | "assistant"; content: string }>;
  inbox: InboxItem[];
  /** 当前是否有轮次在执行 */
  running: boolean;
  /** 后台启动的 promise，仅用于错误捕获，不 await */
  task?: Promise<void>;
};

/**
 * 子 agent 注册表。单一所有者：每条记录归属产出它的那个父级循环，
 * 没有跨父级共享作用域（与 DSH 的 todo 一样不搞 swarm 全局态）。
 */
export class SubagentRegistry {
  private readonly items = new Map<string, SubagentRuntime>();

  register(spec: SubagentSpec, label: string, depth: number): SubagentRuntime {
    const id = nextSubagentId(spec.toolName);
    const record: SubagentRecord = {
      id,
      toolName: spec.toolName,
      label,
      status: "running",
      depth,
      startedAt: Date.now(),
      steps: 0,
    };
    const runtime: SubagentRuntime = {
      record,
      spec,
      aborter: new AbortController(),
      history: [],
      inbox: [],
      running: false,
    };
    this.items.set(id, runtime);
    return runtime;
  }

  get(id: string): SubagentRuntime | undefined {
    return this.items.get(id);
  }

  /** 每行 `<id> [<status>] — <label>`，与 DSH 的 list_agents 输出形状一致 */
  list(scope: { toolName?: string } = {}): SubagentRecord[] {
    const all = [...this.items.values()].map((r) => ({ ...r.record }));
    if (scope.toolName) return all.filter((r) => r.toolName === scope.toolName);
    return all;
  }

  /** 中断一个子 agent 的当前轮次；保留 inbox 与记录 */
  interrupt(id: string): { ok: boolean; error?: string } {
    const r = this.items.get(id);
    if (!r) return { ok: false, error: `unknown agent_id: ${id}` };
    r.aborter.abort();
    r.record.status = "inactive";
    return { ok: true };
  }

  /**
   * 投递一条消息。只返回 messageId，绝不返回回复（DSH 的 steering 语义）。
   * running 时入队，等当前轮结束自动续跑；inactive 时立刻起一轮。
   */
  enqueue(
    id: string,
    text: string,
    resume: (r: SubagentRuntime, text: string) => void,
  ): { ok: boolean; messageId?: string; error?: string; queued?: boolean } {
    const r = this.items.get(id);
    if (!r) return { ok: false, error: `unknown agent_id: ${id}` };
    const messageId = `msg-${Date.now().toString(36)}${idCounter.toString(36)}`;
    const item: InboxItem = { messageId, text, at: Date.now(), delivered: false };
    r.inbox.push(item);
    if (r.running) return { ok: true, messageId, queued: true };
    // 空闲：立刻起一轮。注意必须先标记 delivered，否则这一轮结束后
    // drainInbox 会把同一条消息再投一次（双重投递）。
    item.delivered = true;
    resume(r, text);
    return { ok: true, messageId, queued: false };
  }

  /** 取走未投递的 inbox 文本，拼成下一轮的 goal */
  drainInbox(r: SubagentRuntime): string | null {
    const pending = r.inbox.filter((i) => !i.delivered);
    if (pending.length === 0) return null;
    for (const p of pending) p.delivered = true;
    return pending.map((p) => p.text).join("\n\n");
  }

  size(): number {
    return this.items.size;
  }
}

export type SubagentToolDeps = {
  /** 由 run.ts 注入，避免循环 import */
  runLoop: (input: RunLoopInput) => Promise<string>;
  registry: SubagentRegistry;  /** 父级的工作区 */
  workspaceRoot: string;
  /** 父级允许的工具，子 agent 只能取交集，防止越权提权 */
  parentAllowedTools: ToolName[];
  /** 父级模型 id，子 agent 未指定时继承 */
  parentModelId: string;
  /** 父级 systemPrompt，用于给子 agent 交代来源 */
  parentSystemPrompt: string;
  /** 父级的 readOnly：Ask 模式下子 agent 也必须只读 */
  readOnly: boolean;
  /** 父级当前深度。顶层为 0 */
  depth: number;
  /** 最大深度，默认 1（0 禁止委派） */
  maxDepth: number;
  /** 父级 mock 场景，离线演示时子 agent 继承，避免乱猜 */
  mockScenario?: MockScenario;
  parentSignal?: AbortSignal;
  onEvent?: (e: LoopEvent) => void;
  /** todo 的会话归属：子 agent 各拿自己的 sessionId */
  todoSessionPrefix?: string;
  allowParallelTodo?: boolean;
  /**
   * 子 agent 自己还能派给谁。默认返回空数组 —— 即子 agent 不再往下派。
   * 要开多级委派就显式给这个函数（配合 maxDepth > 1）。
   */
  childSubagents?: (parentSpec: SubagentSpec) => SubagentSpec[];
};

/** 子 agent 的工具 = 父级工具 ∩（显式给的 | 父级全部），永不放权 */
function filterChildTools(
  spec: SubagentSpec,
  parentAllowedTools: ToolName[],
): ToolName[] {
  const requested = spec.allowedTools;
  if (!requested || requested.length === 0) return [...parentAllowedTools];
  return requested.filter((t) => parentAllowedTools.includes(t));
}

function buildChildAgent(
  spec: SubagentSpec,
  deps: SubagentToolDeps,
  id: string,
): AgentProfile {
  return {
    id,
    name: spec.persona.length > 24 ? `${spec.persona.slice(0, 24)}…` : spec.persona,
    systemPrompt: [
      spec.persona,
      "",
      "你是被父级 agent 委派出来的子 agent。你看不到父级的对话与中间步骤，",
      "只能依据上面这段任务描述工作。完成后给出自包含的结论。",
    ].join("\n"),
    allowedTools: filterChildTools(spec, deps.parentAllowedTools),
    defaultModelId: spec.modelId ?? deps.parentModelId,
    skillIds: [],
  };
}

/**
 * 子 agent 的模型配置。
 * 注意 DSH 的已知限制：fork 型子 agent 若覆盖路由会破坏 KV Cache 复用。
 * 这里显式记下：不指定 modelId 时**继承父级 modelId**（复用前缀缓存），
 * 指定了才换路由。
 */
function buildChildModel(spec: SubagentSpec, deps: SubagentToolDeps): ModelConfig {
  const modelId = spec.modelId ?? deps.parentModelId;
  return getModelConfig(modelId);
}

/**
 * 有委派工具时注入的系统提示词 section。
 * DSH 原文只有一句：'Start independent subagent delegations together in one
 * assistant message and continue useful work while they run.'
 * 这里保持同样的克制：只讲怎么用，不复述工具清单。
 */
export function subagentSystemSection(specs: SubagentSpec[]): string {
  if (specs.length === 0) return "";
  const hasBackground = specs.some((s) => s.allowBackground !== false);
  const lines = [
    "\n【子 Agent 委派】你可以把独立的工作整包派给子 agent：",
    "- 子 agent 看不到本次对话，任务描述必须自包含（目标、约束、期望产出）。",
    "- 独立的多份委派，在同一条回复里一起发出去，然后继续做你自己的活。",
  ];
  if (hasBackground) {
    lines.push(
      "- 传 run_in_background: true 可以不等待；之后用 list_agents 看状态，用 send_message 继续派活。",
    );
  }
  lines.push(
    "- 子 agent 的中间步骤不会回到你这里，你只会拿到它最终的结论。",
    "- 不要派一个和你自己完全重复的活；委派的意义是并行或分工。",
  );
  return lines.join("\n");
}

/**
 * 跑子 agent 的一轮。抽出来是为了让「前台调用」和「send_message 唤醒」
 * 走完全相同的路径 —— 两条路径行为不一致是这类系统最常见的坑。
 *
 * 失败处理对标 DSH：前台失败不抛出、不拖垮父级，而是把
 * `Error: <原因>` 当产出返回。
 */
async function runSubagentTurn(
  rt: SubagentRuntime,
  spec: SubagentSpec,
  deps: SubagentToolDeps,
  turnGoal: string,
): Promise<string> {
  rt.running = true;
  rt.record.status = "running";
  const child: RunLoopInput = {
    workspaceRoot: deps.workspaceRoot,
    agent: buildChildAgent(spec, deps, rt.record.id),
    // 子 agent 默认继承父级模型；DSH 明确说路由覆盖会牺牲 KV Cache 复用
    model: buildChildModel(spec, deps),
    skills: [],
    goal: turnGoal,
    maxSteps: spec.maxSteps ?? 5,
    history: [...rt.history],
    readOnly: deps.readOnly,
    mockScenario: deps.mockScenario,
    signal: rt.aborter.signal,
    subagents: deps.childSubagents ? deps.childSubagents(spec) : undefined,
    maxDepth: Math.max(0, deps.maxDepth - deps.depth - 1),
    onEvent: (e) => {
      if (e.type === "usage") rt.record.steps += 1;
      // 子 agent 的中间步骤不进父级事件流，只发它自己的起止（DSH 同款）
      if (e.type === "error") rt.record.error = e.message;
    },
    todo: deps.todoSessionPrefix
      ? {
          sessionId: `${deps.todoSessionPrefix}:${rt.record.id}`,
          allowParallelInProgress: deps.allowParallelTodo ?? true,
        }
      : undefined,
  };

  try {
    const text = await deps.runLoop(child);
    rt.history.push({ role: "user", content: turnGoal });
    rt.history.push({ role: "assistant", content: text });
    rt.record.lastText = text;
    rt.record.status = "inactive";
    rt.record.endedAt = Date.now();
    deps.onEvent?.({
      type: "subagent_end",
      id: rt.record.id,
      toolName: spec.toolName,
      status: "inactive",
      text,
      steps: rt.record.steps,
    });
    // 当前轮跑完后，把排队中的 steering 继续跑掉（投递点是轮次边界）
    const pending = deps.registry.drainInbox(rt);
    if (pending) return await runSubagentTurn(rt, spec, deps, pending);
    return text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    rt.record.status = "failed";
    rt.record.error = message;
    rt.record.endedAt = Date.now();
    deps.onEvent?.({
      type: "subagent_end",
      id: rt.record.id,
      toolName: spec.toolName,
      status: "failed",
      error: message,
      steps: rt.record.steps,
    });
    return `Error: ${message}`;
  } finally {
    rt.running = false;
  }
}

/**
 * 把 SubagentSpec[] 变成工具实例。返回的数组里：
 *   - 每个 spec 一个委派工具（toolName 互不相同）
 *   - 若有 spec，再附 3 个控制工具：send_message / interrupt_agent / list_agents
 */
export function createSubagentTools(
  specs: SubagentSpec[],
  deps: SubagentToolDeps,
): ToolDefinition[] {
  if (specs.length === 0) return [];

  const seen = new Set<string>();
  for (const s of specs) {
    if (!TOOL_NAME_PATTERN.test(s.toolName)) {
      throw new Error(
        `子 agent 工具名不合法：${s.toolName}（需匹配 ${TOOL_NAME_PATTERN}）`,
      );
    }
    if (seen.has(s.toolName)) {
      throw new Error(`子 agent 工具名重复：${s.toolName}`);
    }
    seen.add(s.toolName);
  }

  const delegationTools: ToolDefinition[] = specs.map((spec) => {
    const description =
      spec.description ??
      `${spec.persona}。它看不到本次对话，请把任务描述写成自包含的。`;

    return {
      name: spec.toolName,
      description,
      requiresApproval: false,
      inputSchema: SUBAGENT_INPUT_SCHEMA,
      execute: async (args): Promise<{ ok: boolean; data?: unknown; error?: string }> => {
        const goal = typeof args.goal === "string" ? args.goal.trim() : "";
        if (!goal) {
          return { ok: false, error: "Error: goal must be a non-empty string" };
        }

        // DSH：maxDepth 超限时工具仍可见，调用才报错
        if (deps.depth >= deps.maxDepth) {
          return {
            ok: false,
            error: `Error: 已达委派深度上限 maxDepth=${deps.maxDepth}，不能再派子 agent`,
          };
        }

        const label = goal.length > 60 ? `${goal.slice(0, 60)}…` : goal;
        const rt = deps.registry.register(spec, label, deps.depth + 1);
        deps.onEvent?.({
          type: "subagent_start",
          id: rt.record.id,
          toolName: spec.toolName,
          label,
          depth: deps.depth + 1,
        });

        const background =
          spec.allowBackground !== false && args.run_in_background === true;

        if (background) {
          rt.record.status = "running";
          rt.task = runSubagentTurn(rt, spec, deps, goal).then(() => undefined);
          return {
            ok: true,
            data: {
              agent_id: rt.record.id,
              status: "running" as SubagentStatus,
              note: "后台运行中。用 list_agents 看状态，用 send_message 继续给它派活。",
            },
          };
        }

        const text = await runSubagentTurn(rt, spec, deps, goal);
        const failed = rt.record.status === "failed";
        return {
          ok: !failed,
          data: {
            agent_id: rt.record.id,
            status: rt.record.status,
            steps: rt.record.steps,
            text,
          },
          ...(failed ? { error: text } : {}),
        };
      },
    };
  });

  const controlTools: ToolDefinition[] = [
    {
      name: "list_agents",
      description:
        "列出已派出的子 agent：每行 `<id> [<status>] — <label>`。status 为 inactive 只表示当前没有轮次在执行，不代表任务完成。",
      requiresApproval: false,
      inputSchema: {
        type: "object",
        properties: {
          scope: {
            type: "string",
            description: "只列某个委派工具派出的子 agent；不传则列全部",
          },
        },
        required: [],
        additionalProperties: false,
      },
      execute: async (args) => {
        const records = deps.registry.list(
          typeof args.scope === "string" && args.scope
            ? { toolName: args.scope }
            : {},
        );
        return {
          ok: true,
          data: {
            agents: records,
            lines: records.map((r) => `${r.id} [${r.status}] — ${r.label}`),
          },
        };
      },
    },
    {
      name: "send_message",
      description:
        "给一个已存在的子 agent 追加一条消息（steering）。只返回 messageId，绝对不会返回它的回复——想看结果就之后用 list_agents。目标在最近的轮次边界收到消息；若它当前空闲，会立刻起一轮。",
      requiresApproval: false,
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "list_agents 给出的 id" },
          message: { type: "string", description: "要投递的完整消息" },
        },
        required: ["agent_id", "message"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const agentId = String(args.agent_id ?? "");
        const message = String(args.message ?? "");
        if (!message.trim()) {
          return { ok: false, error: "Error: message must be a non-empty string" };
        }
        const rt = deps.registry.get(agentId);
        if (!rt) return { ok: false, error: `Error: unknown agent_id: ${agentId}` };
        const res = deps.registry.enqueue(agentId, message, (r, text) => {
          // 目标空闲：立刻起一轮（running 时不用管，drainInbox 会接手）
          void runSubagentTurn(r, r.spec, deps, text);
        });
        if (!res.ok) return { ok: false, error: res.error };
        return {
          ok: true,
          data: { messageId: res.messageId, queued: res.queued },
        };
      },
    },
    {
      name: "interrupt_agent",
      description:
        "中断某个子 agent 的当前轮次。只停当前这一步，它的收件箱与已产出的内容都保留。",
      requiresApproval: false,
      inputSchema: {
        type: "object",
        properties: {
          agent_id: { type: "string", description: "list_agents 给出的 id" },
        },
        required: ["agent_id"],
        additionalProperties: false,
      },
      execute: async (args) => {
        const agentId = String(args.agent_id ?? "");
        const res = deps.registry.interrupt(agentId);
        if (!res.ok) return { ok: false, error: `Error: ${res.error}` };
        return { ok: true, data: { agent_id: agentId, status: "inactive" } };
      },
    },
  ];

  return [...delegationTools, ...controlTools];
}
