/**
 * 层5：todo_write —— 会话级待办清单
 *
 * 对标 dsh-tool-todo，四条设计承诺逐条落地：
 *
 * 1. **整表替换**：每次调用覆盖整份清单，没有部分更新、没有逐项编辑、没有回读工具。
 *    模型必须把「当前全部待办」一次说清，这反而逼它维护一个自洽的清单。
 * 2. **日志承载状态**：清单本身不存在服务里，存在的是一条条 `todo/write` 事件；
 *    投影（`projection()`）只是最新一条事件的值。持久性、回放、恢复都来自日志。
 *    与 DSH 的差距：DSH 把事件写进会话日志文件，这里的事件日志在进程内存里，
 *    重启即丢——如实标为已知差距，不假装等价。
 * 3. **单一所有者**：清单属于调用它的那个 agent 会话（`sessionId`）。
 *    子 agent 各拿自己的 sessionId，彼此看不见；不搞跨会话共享的 swarm 全局态。
 *    非 agent 调用方（拿不到 sessionId 的）直接拒绝，不做匿名兜底。
 * 4. **部署策略而非编码规则**：`allowParallelInProgress` 是部署选择——可能并发干活的
 *    agent（subagent / 后台命令 / 工作流扇出）设 true，需要单活跃项纪律的设 false。
 *    校验逻辑跟随它，但持久化日志的不变式刻意不跟随：日志如实记录输入，不因策略改写成"合法"。
 */

import type { JSONSchema7 } from "ai";
import type { ToolDefinition, ToolResult } from "../types/index.js";

export type TodoStatus = "pending" | "in_progress" | "completed";

export type TodoItem = {
  content: string;
  status: TodoStatus;
};

/** 事件日志里的一条。`todos` 是本次写入的完整清单（整表替换） */
export type TodoWriteEvent = {
  type: "todo/write";
  sessionId: string;
  at: number;
  /** 第几个轮次写入的，从 1 开始 */
  turn: number;
  todos: TodoItem[];
};

/**
 * 会话投影。`todos` 为 null 表示本轮还没写入过（首次写入前）。
 * 下一轮次开始时清空，`endTurn` 保留刚完成的清单。
 */
export type TodoProjection = {
  sessionId: string;
  turn: number;
  todos: TodoItem[] | null;
};

export type TodoStore = {
  /** 轮次开始：投影清空（对标 DSH「下一轮次开始时清空」） */
  startTurn(sessionId: string): void;
  /** 轮次结束：保留当前清单（对标 DSH `turn/end` 保留刚完成的清单） */
  endTurn(sessionId: string): void;
  /** 整表替换，返回落下的那条事件 */
  write(sessionId: string, todos: TodoItem[]): TodoWriteEvent;
  /** 当前投影；没有则 null */
  projection(sessionId: string): TodoProjection | null;
  /** 事件日志（可按会话过滤）。日志只追加，永不修改 */
  events(sessionId?: string): readonly TodoWriteEvent[];
  /** 测试缝：清空全部会话 */
  reset(): void;
};

const VALID_STATUS: readonly TodoStatus[] = ["pending", "in_progress", "completed"];

/** `todo_write` 的参数 schema。整表替换，所以只有 `todos` 一个字段 */
export const TODO_WRITE_SCHEMA: JSONSchema7 = {
  type: "object",
  properties: {
    todos: {
      type: "array",
      description: "完整的待办清单；每次调用都会整表替换，不是增量更新",
      items: {
        type: "object",
        properties: {
          content: { type: "string", description: "待办内容，非空" },
          status: {
            type: "string",
            enum: ["pending", "in_progress", "completed"],
            description: "pending 待办 / in_progress 进行中 / completed 已完成",
          },
        },
        required: ["content", "status"],
        additionalProperties: false,
      },
    },
  },
  required: ["todos"],
  additionalProperties: false,
};

/**
 * 校验一份清单。返回 `{ ok: true, todos }` 或 `{ ok: false, error }`。
 *
 * 错误文本与 DSH 逐字对齐，方便把模型的行为对起来：
 * - `Error: invalid todo: \`content\` must be a non-empty string`
 * - `Error: invalid todos: duplicate content "<content>"`
 * - `Error: invalid todos: at most one task may be in_progress (got <n>)`
 */
export function validateTodos(
  input: unknown,
  options: { allowParallelInProgress: boolean },
): { ok: true; todos: TodoItem[] } | { ok: false; error: string } {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { ok: false, error: "Error: invalid todos: expected an object" };
  }
  const raw = (input as { todos?: unknown }).todos;
  if (!Array.isArray(raw)) {
    return { ok: false, error: "Error: invalid todos: `todos` must be an array" };
  }

  const todos: TodoItem[] = [];
  const seen = new Set<string>();
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return { ok: false, error: "Error: invalid todo: `content` must be a non-empty string" };
    }
    const content = (entry as { content?: unknown }).content;
    const status = (entry as { status?: unknown }).status;
    if (typeof content !== "string" || content.trim() === "") {
      return { ok: false, error: "Error: invalid todo: `content` must be a non-empty string" };
    }
    if (typeof status !== "string" || !VALID_STATUS.includes(status as TodoStatus)) {
      return {
        ok: false,
        error: `Error: invalid todo: \`status\` must be one of ${VALID_STATUS.join(", ")}`,
      };
    }
    const trimmed = content.trim();
    if (seen.has(trimmed)) {
      return { ok: false, error: `Error: invalid todos: duplicate content "${trimmed}"` };
    }
    seen.add(trimmed);
    todos.push({ content: trimmed, status: status as TodoStatus });
  }

  if (!options.allowParallelInProgress) {
    const inProgress = todos.filter((t) => t.status === "in_progress").length;
    if (inProgress > 1) {
      return {
        ok: false,
        error: `Error: invalid todos: at most one task may be in_progress (got ${inProgress})`,
      };
    }
  }

  return { ok: true, todos };
}

/** DSH 同款成功文案：`Updated todo list: <p> pending, <i> in progress, <c> completed.` */
export function summarizeTodoList(todos: readonly TodoItem[]): string {
  let pending = 0;
  let inProgress = 0;
  let completed = 0;
  for (const t of todos) {
    if (t.status === "pending") pending += 1;
    else if (t.status === "in_progress") inProgress += 1;
    else completed += 1;
  }
  return `Updated todo list: ${pending} pending, ${inProgress} in progress, ${completed} completed.`;
}

/** 进程内事件日志 + 投影。测试可用 `reset()` 清干净 */
export function createTodoStore(): TodoStore {
  const logs = new Map<string, TodoWriteEvent[]>();
  const projections = new Map<string, TodoProjection>();

  const ensure = (sessionId: string): TodoProjection => {
    let p = projections.get(sessionId);
    if (!p) {
      p = { sessionId, turn: 0, todos: null };
      projections.set(sessionId, p);
    }
    return p;
  };

  return {
    startTurn(sessionId: string): void {
      const p = ensure(sessionId);
      p.turn += 1;
      // 对标 DSH：下一轮次开始时投影清空，首次写入前为 null
      p.todos = null;
    },

    endTurn(sessionId: string): void {
      // 保留刚完成的清单，什么都不用做 —— 语义靠 startTurn 清、write 写
      ensure(sessionId);
    },

    write(sessionId: string, todos: TodoItem[]): TodoWriteEvent {
      const p = ensure(sessionId);
      const event: TodoWriteEvent = {
        type: "todo/write",
        sessionId,
        at: Date.now(),
        turn: Math.max(1, p.turn),
        todos: todos.map((t) => ({ content: t.content, status: t.status })),
      };
      const list = logs.get(sessionId);
      if (list) list.push(event);
      else logs.set(sessionId, [event]);
      // 投影只是最新一条事件的值 —— 这就是「日志承载状态」
      p.todos = event.todos.map((t) => ({ content: t.content, status: t.status }));
      return event;
    },

    projection(sessionId: string): TodoProjection | null {
      return projections.get(sessionId) ?? null;
    },

    events(sessionId?: string): readonly TodoWriteEvent[] {
      if (sessionId !== undefined) return logs.get(sessionId) ?? [];
      const all: TodoWriteEvent[] = [];
      for (const list of logs.values()) all.push(...list);
      return all;
    },

    reset(): void {
      logs.clear();
      projections.clear();
    },
  };
}

/**
 * 造 `todo_write` 工具。
 *
 * 拒绝路径对标 DSH：拿不到会话归属（`sessionId` 为空）直接报
 * `Error: todo_write requires an owning agent session`，不做匿名兜底 ——
 * 没有所有者的清单到不了任何人的上下文里，写它只是污染日志。
 */
export function createTodoWriteTool(deps: {
  store: TodoStore;
  allowParallelInProgress: boolean;
  sessionId: string;
}): ToolDefinition {
  const { store, allowParallelInProgress, sessionId } = deps;

  return {
    name: "todo_write",
    description: [
      "写入/更新本次任务的待办清单。每次调用都会整表替换，请把完整的清单一次给全。",
      "status 用 pending / in_progress / completed。",
      allowParallelInProgress
        ? "允许多项同时 in_progress。"
        : "同一时刻最多一项 in_progress。",
    ].join(""),
    requiresApproval: false,
    inputSchema: TODO_WRITE_SCHEMA,
    execute: async (args: Record<string, unknown>): Promise<ToolResult> => {
      if (!sessionId || sessionId.trim() === "") {
        return { ok: false, error: "Error: todo_write requires an owning agent session" };
      }

      const checked = validateTodos(args, { allowParallelInProgress });
      if (!checked.ok) {
        return { ok: false, error: checked.error };
      }

      // 取写入前的事件条数，用于在 data 里回带本次是第几次写入
      const before = store.events(sessionId).length;
      const event = store.write(sessionId, checked.todos);

      return {
        ok: true,
        data: {
          message: summarizeTodoList(checked.todos),
          turn: event.turn,
          writes: before + 1,
          todos: checked.todos,
        },
      };
    },
  };
}
