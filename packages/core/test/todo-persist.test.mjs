/**
 * 层5：todo 落盘 —— 事件日志写进 JSONL，重启后回放恢复。
 *
 * 这些用例真开临时目录真读真写（不 mock fs），因为要证明的恰恰是
 * 「换一个进程/换一个 store 实例，投影还在」这件事 —— 内存版做不到。
 */

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import test from "node:test";

import {
  createFileTodoStore,
  findWorkspaceRoot,
  parseTodoEventLine,
  resolveTodoStoreDir,
  todoLogFileName,
} from "../dist/index.js";

const TMP_ROOT = mkdtempSync(join(tmpdir(), "loom-todo-"));
let counter = 0;
function freshDir() {
  counter += 1;
  const dir = join(TMP_ROOT, `case-${counter}`);
  return dir;
}

test.after(() => {
  rmSync(TMP_ROOT, { recursive: true, force: true });
});

test("todo-file.1 写一次就落一行 JSONL，内容与返回值一致", () => {
  const dir = freshDir();
  const store = createFileTodoStore({ dir });
  store.startTurn("s1");
  const event = store.write("s1", [
    { content: "读 README", status: "completed" },
    { content: "写测试", status: "in_progress" },
  ]);

  const file = store.filePath("s1");
  assert.equal(file, join(dir, "s1.jsonl"));
  assert.ok(existsSync(file), "日志文件应当已经存在");
  const lines = readFileSync(file, "utf8").trim().split("\n");
  assert.equal(lines.length, 1, "一次 write 只落一行");
  const parsed = JSON.parse(lines[0]);
  assert.equal(parsed.type, "todo/write");
  assert.equal(parsed.sessionId, "s1");
  assert.equal(parsed.turn, 1);
  assert.equal(parsed.at, event.at);
  assert.deepEqual(parsed.todos, [
    { content: "读 README", status: "completed" },
    { content: "写测试", status: "in_progress" },
  ]);
});

test("todo-file.2 换个 store 实例（等价于重启）能回放投影和 turn", () => {
  const dir = freshDir();
  const first = createFileTodoStore({ dir });
  first.startTurn("s1");
  first.write("s1", [{ content: "A", status: "in_progress" }]);
  first.startTurn("s1");
  first.write("s1", [
    { content: "A", status: "completed" },
    { content: "B", status: "pending" },
  ]);
  assert.equal(first.events("s1").length, 2);

  // 全新实例，内存全空 —— 只能靠文件
  const second = createFileTodoStore({ dir });
  const projection = second.projection("s1");
  assert.ok(projection, "重启后应当能拿到投影");
  assert.equal(projection.turn, 2, "turn 应当从最后一条事件恢复");
  assert.deepEqual(projection.todos, [
    { content: "A", status: "completed" },
    { content: "B", status: "pending" },
  ]);
  assert.equal(second.events("s1").length, 2, "历史事件全部回放出来");
});

test("todo-file.3 回放后继续写是追加（不覆盖旧日志）", () => {
  const dir = freshDir();
  const first = createFileTodoStore({ dir });
  first.startTurn("s1");
  first.write("s1", [{ content: "一", status: "pending" }]);

  const second = createFileTodoStore({ dir });
  second.startTurn("s1"); // 恢复后 turn 从 1 → 2
  const event = second.write("s1", [{ content: "二", status: "in_progress" }]);
  assert.equal(event.turn, 2, "回合号接在恢复出来的 turn 之后");

  const lines = readFileSync(second.filePath("s1"), "utf8").trim().split("\n");
  assert.equal(lines.length, 2, "旧行必须还在 —— 日志只追加");
  assert.equal(JSON.parse(lines[0]).todos[0].content, "一");
  assert.equal(JSON.parse(lines[1]).todos[0].content, "二");
});

test("todo-file.4 投影清空只发生在 startTurn，重启后不凭空清空", () => {
  const dir = freshDir();
  const first = createFileTodoStore({ dir });
  first.startTurn("s1");
  first.write("s1", [{ content: "A", status: "pending" }]);
  first.endTurn("s1");

  const resumed = createFileTodoStore({ dir });
  resumed.endTurn("s1"); // 只 end，不该动投影
  assert.deepEqual(
    resumed.projection("s1").todos.map((t) => t.content),
    ["A"],
    "本轮结束保留清单（对标 DSH turn/end）",
  );
  resumed.startTurn("s1"); // 下一轮开始才清
  assert.equal(resumed.projection("s1").todos, null);
  assert.deepEqual(
    resumed.events("s1").map((e) => e.todos[0].content),
    ["A"],
    "清空投影不等于删日志",
  );
});

test("todo-file.5 坏行被跳过并记 warning，好行照常回放", () => {
  const dir = freshDir();
  const seed = createFileTodoStore({ dir });
  seed.write("s1", [{ content: "保留我", status: "pending" }]);
  const file = seed.filePath("s1");
  writeFileSync(
    file,
    [
      readFileSync(file, "utf8").trim(),
      "这不是 JSON",
      JSON.stringify({ type: "todo/write", sessionId: "s1", todos: "坏的" }),
      JSON.stringify({
        type: "todo/write",
        sessionId: "s1",
        at: 123,
        turn: 5,
        todos: [{ content: "好行", status: "completed" }],
      }),
      "",
    ].join("\n"),
    "utf8",
  );

  const store = createFileTodoStore({ dir });
  const events = store.events("s1");
  assert.equal(events.length, 2, "两条好行（原始 + 末尾），两条坏行跳过");
  assert.equal(store.projection("s1").turn, 5);
  assert.deepEqual(store.projection("s1").todos, [{ content: "好行", status: "completed" }]);
  const warnings = store.warnings();
  assert.equal(warnings.length, 1, "坏行只报一条（去重）");
  assert.match(warnings[0], /2 行无法解析/);
});

test("todo-file.6 sessionId 里的目录分隔符不会跑出日志目录", () => {
  assert.equal(todoLogFileName("sub/../../etc/passwd"), "sub_.._.._etc_passwd.jsonl");
  assert.equal(todoLogFileName("plan:worker#3"), "plan_worker_3.jsonl");
  assert.equal(todoLogFileName(""), "session.jsonl");

  const dir = freshDir();
  const store = createFileTodoStore({ dir });
  store.write("../../escape", [{ content: "x", status: "pending" }]);
  const file = store.filePath("../../escape");
  assert.ok(file.startsWith(dir + sep), `文件必须留在日志目录内：${file}`);
  assert.ok(existsSync(file));
});

test("todo-file.7 写不进去时降级为内存，不抛异常", () => {
  // 把 dir 指到一个「文件」下面，mkdir 必然失败
  const dir = freshDir();
  const blocker = join(TMP_ROOT, "blocker-file");
  writeFileSync(blocker, "我是文件不是目录", "utf8");
  const store = createFileTodoStore({ dir: join(blocker, "todos") });
  store.startTurn("s1");
  const event = store.write("s1", [{ content: "还是能写", status: "pending" }]);
  assert.equal(event.turn, 1, "写盘失败不影响返回值");
  assert.deepEqual(store.projection("s1").todos, [{ content: "还是能写", status: "pending" }]);
  assert.equal(store.warnings().length, 1);
  assert.match(store.warnings()[0], /写失败/);
});

test("todo-file.8 独立会话互不干扰（一会话一文件）", () => {
  const dir = freshDir();
  const store = createFileTodoStore({ dir });
  store.startTurn("a");
  store.write("a", [{ content: "甲", status: "pending" }]);
  store.write("b", [{ content: "乙", status: "in_progress" }]);

  const reloaded = createFileTodoStore({ dir });
  assert.deepEqual(reloaded.projection("a").todos, [{ content: "甲", status: "pending" }]);
  assert.deepEqual(reloaded.projection("b").todos, [{ content: "乙", status: "in_progress" }]);
  assert.equal(reloaded.events("a").length, 1);
  assert.notEqual(reloaded.filePath("a"), reloaded.filePath("b"));
});

test("todo-file.9 默认目录解析：环境变量 > 仓库根 > cwd", () => {
  const cwd = process.cwd();
  const previous = process.env.LOOM_TODO_DIR;
  try {
    delete process.env.LOOM_TODO_DIR;
    const resolved = resolveTodoStoreDir(cwd);
    const root = findWorkspaceRoot(cwd);
    assert.ok(root, "本仓库根应当有 workspaces 声明");
    assert.equal(resolved, join(root, "data", "loom-store", "todos"));

    process.env.LOOM_TODO_DIR = join(cwd, "custom-todos");
    assert.equal(resolveTodoStoreDir(cwd), join(cwd, "custom-todos"), "环境变量优先");
  } finally {
    if (previous === undefined) delete process.env.LOOM_TODO_DIR;
    else process.env.LOOM_TODO_DIR = previous;
  }
});

test("todo-file.10 新会话首次写盘会建目录（懒创建，不预先污染仓库）", () => {
  const dir = freshDir();
  assert.equal(existsSync(dir), false, "构造 store 不该建目录");
  const store = createFileTodoStore({ dir });
  store.startTurn("s1");
  assert.equal(existsSync(dir), false, "startTurn 也不建");
  store.write("s1", [{ content: "第一次落盘才建", status: "pending" }]);
  assert.equal(existsSync(dir), true, "write 时才创建目录");
});

test("todo-file.11 parseTodoEventLine 只认完整合法的事件行", () => {
  assert.equal(parseTodoEventLine(""), null);
  assert.equal(parseTodoEventLine("{"), null);
  assert.equal(parseTodoEventLine(JSON.stringify({ type: "other" })), null);
  assert.equal(
    parseTodoEventLine(JSON.stringify({ type: "todo/write", sessionId: "s" })),
    null,
    "缺 todos 不算事件",
  );
  assert.equal(
    parseTodoEventLine(
      JSON.stringify({
        type: "todo/write",
        sessionId: "s",
        todos: [{ content: "x", status: "doing" }],
      }),
    ),
    null,
    "非法 status 整行丢掉",
  );
  const ok = parseTodoEventLine(
    JSON.stringify({
      type: "todo/write",
      sessionId: "s",
      todos: [{ content: "x", status: "pending" }],
    }),
  );
  assert.ok(ok);
  assert.equal(ok.turn, 1, "缺 turn 时兜底为 1");
  assert.equal(typeof ok.at, "number");
});
