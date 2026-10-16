/**
 * 层5：todo 的落盘事件日志 —— 把 `createTodoStore()` 的内存日志换成 JSONL 文件。
 *
 * 为什么要这一层：`todo.ts` 的四条设计承诺里有两条（「日志承载状态」和
 * 「重启后恢复」）在纯内存实现下只兑现了一半 —— 事件确实是状态本体，
 * 但它随着进程一起死。DSH 把事件写进会话日志文件，重启 `dsh` 还能回放；
 * 这里的问题一直记在 `docs/PROGRESS.md` 的「后续功能 #3」。
 *
 * 落地方式刻意保持小：
 * - **一会话一文件**：`<dir>/<sessionId 转义>.jsonl`，一行一条 `todo/write` 事件，
 *   只追加（`appendFileSync`），永不改写 —— 日志语义不因为落盘而变。
 * - **懒加载**：某个 sessionId 第一次被碰到才读它那份文件。整个仓库一份日志
 *   在启动时全读进来是没必要的开销，也让「单会话所有权」变得模糊。
 * - **内存是热路径**：读进内存后，投影/日志查询都走内存（`events()` 就是日志本身），
 *   落盘只发生在 `write()` 那一下，不改变任何调用方语义。
 * - **写不进去也不崩**：磁盘只读/满盘时降级为纯内存并记一条 warning。
 *   todo 清单是给模型看的工作记忆，不值得为它把整轮 agent 循环打断。
 *
 * 与 DSH 的剩余差距（如实标）：DSH 的事件和会话消息在同一条日志里，
 * 所以「第几轮」由会话日志本身给出；这里是独立的 todo 日志文件，
 * turn 号来自 `startTurn` 的本地计数 —— 重启后靠回放的最后一条事件恢复。
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TodoItem, TodoProjection, TodoStore, TodoWriteEvent } from "./todo.js";

export type FileTodoStore = TodoStore & {
  /** 会话日志文件所在目录 */
  readonly dir: string;
  /** 某个会话的日志文件路径（测试与排障用） */
  filePath(sessionId: string): string;
  /** 读盘/写盘里被容忍掉的问题（坏行、写失败），只增不减 */
  warnings(): readonly string[];
};

/** sessionId → 安全文件名：只留 `[A-Za-z0-9._-]`，其余转 `_`，并限长 */
export function todoLogFileName(sessionId: string): string {
  const safe = sessionId.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);
  return `${safe || "session"}.jsonl`;
}

/**
 * 解析一行 JSONL。坏行返回 null（调用方记 warning 跳过），
 * 而不是抛异常 —— 日志里混进半行不该让整个会话恢复失败。
 */
export function parseTodoEventLine(line: string): TodoWriteEvent | null {
  const text = line.trim();
  if (text === "") return null;
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  const obj = raw as Record<string, unknown>;
  if (obj.type !== "todo/write") return null;
  if (typeof obj.sessionId !== "string" || !Array.isArray(obj.todos)) return null;
  const at = typeof obj.at === "number" ? obj.at : Date.now();
  const turn = typeof obj.turn === "number" && obj.turn > 0 ? obj.turn : 1;
  const todos: TodoItem[] = [];
  for (const entry of obj.todos) {
    if (typeof entry !== "object" || entry === null) return null;
    const { content, status } = entry as { content?: unknown; status?: unknown };
    if (typeof content !== "string" || typeof status !== "string") return null;
    if (status !== "pending" && status !== "in_progress" && status !== "completed") return null;
    todos.push({ content, status });
  }
  return { type: "todo/write", sessionId: obj.sessionId, at, turn, todos };
}

/**
 * 落盘版 todo store。接口与 `createTodoStore()` 完全相同，
 * 所以 `runAgentLoop` / `createTodoWriteTool` 一行都不用改。
 */
export function createFileTodoStore(options: { dir: string }): FileTodoStore {
  const dir = options.dir;
  const logs = new Map<string, TodoWriteEvent[]>();
  const projections = new Map<string, TodoProjection>();
  const hydrated = new Set<string>();
  const warned = new Set<string>();
  let dirReady = false;

  /** 同一个问题只记一条（Set 去重），不刷屏 */
  const warn = (message: string): void => {
    warned.add(message);
  };

  const filePath = (sessionId: string): string => join(dir, todoLogFileName(sessionId));

  /** 首次碰到某个会话时把它的 JSONL 读回内存 */
  const hydrate = (sessionId: string): void => {
    if (hydrated.has(sessionId)) return;
    hydrated.add(sessionId);
    const file = filePath(sessionId);
    if (!existsSync(file)) return;
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch (err) {
      warn(`todo 日志读失败（降级为内存）：${file} —— ${(err as Error).message}`);
      return;
    }
    const list: TodoWriteEvent[] = [];
    let badLines = 0;
    for (const line of text.split(/\r?\n/)) {
      const event = parseTodoEventLine(line);
      if (event) list.push(event);
      else if (line.trim() !== "") badLines += 1;
    }
    if (badLines > 0) warn(`todo 日志有 ${badLines} 行无法解析，已跳过：${file}`);
    if (list.length === 0) return;
    logs.set(sessionId, list);
    const last = list[list.length - 1];
    projections.set(sessionId, {
      sessionId,
      turn: last.turn,
      todos: last.todos.map((t) => ({ content: t.content, status: t.status })),
    });
  };

  const ensure = (sessionId: string): TodoProjection => {
    hydrate(sessionId);
    let p = projections.get(sessionId);
    if (!p) {
      p = { sessionId, turn: 0, todos: null };
      projections.set(sessionId, p);
    }
    return p;
  };

  const append = (event: TodoWriteEvent): void => {
    try {
      if (!dirReady) {
        mkdirSync(dir, { recursive: true });
        dirReady = true;
      }
      appendFileSync(filePath(event.sessionId), `${JSON.stringify(event)}\n`, "utf8");
    } catch (err) {
      warn(`todo 日志写失败（本轮只留内存）：${filePath(event.sessionId)} —— ${(err as Error).message}`);
    }
  };

  return {
    dir,
    filePath,

    startTurn(sessionId: string): void {
      const p = ensure(sessionId);
      p.turn += 1;
      // 对标 DSH：下一轮次开始时投影清空，首次写入前为 null。
      // 注意这里只清内存投影，历史事件仍在文件里 —— 日志是状态本体。
      p.todos = null;
    },

    endTurn(sessionId: string): void {
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
      p.todos = event.todos.map((t) => ({ content: t.content, status: t.status }));
      append(event);
      return event;
    },

    projection(sessionId: string): TodoProjection | null {
      hydrate(sessionId);
      return projections.get(sessionId) ?? null;
    },

    events(sessionId?: string): readonly TodoWriteEvent[] {
      if (sessionId !== undefined) {
        hydrate(sessionId);
        return logs.get(sessionId) ?? [];
      }
      // 不带 sessionId 的「全量」只在内存里聚合：跨会话回放需要读目录下所有文件，
      // 当前没有任何调用方需要它，不做没人用的昂贵语义。
      const all: TodoWriteEvent[] = [];
      for (const list of logs.values()) all.push(...list);
      return all;
    },

    reset(): void {
      // 只清内存；磁盘上的日志是持久事实，测试用临时目录、不靠 reset 清理文件
      logs.clear();
      projections.clear();
      hydrated.clear();
    },

    warnings(): readonly string[] {
      return [...warned];
    },
  };
}
