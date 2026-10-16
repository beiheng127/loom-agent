import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyApprovedCmd,
  getDefaultJobStore,
  resetDefaultJobStore,
  runAgentLoop,
  BUILTIN_AGENTS,
  BUILTIN_MODELS,
  resolveMockScenario,
  TOOL_CATALOG,
  toolsForAgent,
} from "../dist/index.js";
import { MockLanguageModelV3 } from "ai/test";
import { stepCountIs, streamText, tool, jsonSchema } from "ai";
import { partsStream, scriptedModel, turn, usage } from "./helpers.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const WS = path.join(ROOT, "data/workspaces/sample");

/**
 * todo 现在默认落盘（`data/loom-store/todos/*.jsonl`），跑单测不能往仓库里写。
 * 在第一次用到 todo store 之前把目录指到临时目录 —— 顺带证明
 * `LOOM_TODO_DIR` 这个覆盖开关真的生效。
 */
const TODO_TMP = mkdtempSync(path.join(tmpdir(), "loom-loop-todo-"));
process.env.LOOM_TODO_DIR = TODO_TMP;
test.after(() => rmSync(TODO_TMP, { recursive: true, force: true }));
const agent = (id) => BUILTIN_AGENTS.find((a) => a.id === id);
const model = (id) => BUILTIN_MODELS.find((m) => m.id === id);

async function run(over) {
  const events = [];
  const answer = await runAgentLoop({
    workspaceRoot: WS,
    agent: agent("reader"),
    model: model("mock-local"),
    skills: [],
    goal: "测试",
    maxSteps: 6,
    onEvent: (e) => events.push(e),
    ...over,
  });
  return { answer, events };
}
const of = (events, type) => events.filter((e) => e.type === type);

/* ---------------- 层1：真工具协议 ---------------- */

test("1. 每个工具的 inputSchema 都是合法 JSON Schema", () => {
  const all = Object.values(TOOL_CATALOG);
  assert.ok(all.length >= 7, `工具数 ${all.length}`);
  for (const t of all) {
    assert.equal(t.inputSchema.type, "object", `${t.name} 应为 object`);
    assert.ok(t.inputSchema.properties, `${t.name} 缺 properties`);
    assert.equal(t.inputSchema.additionalProperties, false, `${t.name} 应禁额外字段`);
  }
});

test("2. grep_files 的 schema 字段是 query（不是 pattern）", () => {
  const t = TOOL_CATALOG.grep_files;
  assert.ok(t.inputSchema.properties.query, "grep_files 必须有 query");
  assert.deepEqual(t.inputSchema.required, ["query"]);
});

test("3. catalog 不再导出 formatToolsForPrompt", async () => {
  const mod = await import("../dist/tools/catalog.js");
  assert.equal(mod.formatToolsForPrompt, undefined);
});

test("4. toolsForAgent 只返回白名单里的工具", () => {
  const list = toolsForAgent(["list_dir", "grep_files"]);
  assert.deepEqual(list.map((t) => t.name).sort(), ["grep_files", "list_dir"]);
});

test("5. 工具调用走原生协议：tool_call / tool_result 事件成对出现", async () => {
  const { events } = await run({ goal: "探索结构" });
  const calls = of(events, "tool_call");
  const results = of(events, "tool_result");
  assert.ok(calls.length >= 2, `应有多次工具调用，实得 ${calls.length}`);
  assert.equal(calls.length, results.length);
  assert.ok(calls.some((c) => c.name === "list_dir"));
});

test("6. tool_call 的 args 是已解析对象（不是 JSON 字符串）", async () => {
  const { events } = await run({ goal: "探索结构" });
  const call = of(events, "tool_call").find((c) => c.name === "list_dir");
  assert.equal(typeof call.args, "object");
  assert.equal(call.args.path, ".");
});

test("7. tool_input_delta 事件带增量分片（协议级流式）", async () => {
  const { events } = await run({ goal: "探索结构" });
  assert.ok(of(events, "tool_input_delta").length > 0);
});

/* ---------------- 层2：计量 ---------------- */

test("8. 每一步都有 usage 事件，且字段完整", async () => {
  const { events } = await run({ goal: "探索结构" });
  const usages = of(events, "usage");
  assert.ok(usages.length >= 2, `应有多步 usage，实得 ${usages.length}`);
  const first = usages[0].usage;
  for (const k of ["step", "inputTokens", "outputTokens", "totalTokens", "cacheReadTokens", "pressureTokens", "measured"]) {
    assert.ok(k in first, `usage 缺字段 ${k}`);
  }
  assert.equal(first.step, 1);
});

test("9. usage 是真实测量值（MockLanguageModelV3 提供了 usage）", async () => {
  const { events } = await run({ goal: "探索结构" });
  const usages = of(events, "usage");
  assert.ok(usages.every((u) => u.usage.measured === true), "mock 提供了 usage，measured 应为 true");
  assert.ok(usages[0].usage.inputTokens > 0);
});

test("10. done 事件回带完整 usage 数组", async () => {
  const { events } = await run({ goal: "探索结构" });
  const done = of(events, "done")[0];
  const usages = of(events, "usage");
  assert.equal(done.usage.length, usages.length);
  assert.equal(done.usage[0].step, 1);
});

test("11. 传入 languageModel 时 usage 取自该模型（自定义 token 数）", async () => {
  const lm = scriptedModel([
    turn({ text: "只回一句话", usage: usage(1234, 56) }),
  ]);
  const { events } = await run({ languageModel: lm, goal: "随便说说" });
  const u = of(events, "usage")[0].usage;
  assert.equal(u.inputTokens, 1234);
  assert.equal(u.outputTokens, 56);
  assert.equal(u.totalTokens, 1290);
  assert.equal(u.measured, true);
});

test("12. 超 token 预算时提前停止并报错", async () => {
  const lm = scriptedModel([
    turn({
      toolCalls: [{ toolCallId: "c1", toolName: "list_dir", input: { path: "." } }],
      usage: usage(5000, 10),
    }),
    turn({
      toolCalls: [{ toolCallId: "c2", toolName: "list_dir", input: { path: "." } }],
      usage: usage(5000, 10),
    }),
    turn({ text: "结束", usage: usage(1, 1) }),
  ]);
  const { events } = await run({
    languageModel: lm,
    goal: "探",
    budget: { maxSteps: 8, maxTokens: 100 },
  });
  const errs = of(events, "error").map((e) => e.message);
  assert.ok(errs.some((m) => m.includes("超预算")), `应报超预算，实得 ${JSON.stringify(errs)}`);
});

test("13. 不传 budget 时仍受 maxSteps 约束（stopWhen 生效）", async () => {
  let calls = 0;
  const lm = scriptedModel([
    () => {
      calls += 1;
      return turn({
        toolCalls: [{ toolCallId: `c${calls}`, toolName: "list_dir", input: { path: "." } }],
      });
    },
  ]);
  const { events } = await run({ languageModel: lm, goal: "探", maxSteps: 3 });
  assert.equal(of(events, "usage").length, 3, "恰好跑 3 步");
});

/* ---------------- 单步 / 多步语义 ---------------- */

test("14. 只显式传 stopWhen 才多步：默认 stepCountIs(1) 的对照", async () => {
  const lm = new MockLanguageModelV3({
    doStream: async () => ({
      stream: partsStream(
        turn({ toolCalls: [{ toolCallId: "x", toolName: "list_dir", input: { path: "." } }] }),
      ),
    }),
    doGenerate: async () => { throw new Error("no"); },
  });
  // 不传 stopWhen：SDK 默认只跑一步
  const res = streamText({
    model: lm,
    prompt: "hi",
    tools: {
      list_dir: tool({
        description: "x",
        inputSchema: jsonSchema({ type: "object", properties: {} }),
        execute: async () => ({ ok: true }),
      }),
    },
  });
  const events = [];
  for await (const p of res.fullStream) events.push(p.type);
  assert.ok(events.includes("tool-call"));
  assert.ok(!events.includes("text-delta"), "默认单步：工具结果不会被喂回模型");
});

/* ---------------- 层1-C：mock 走同一条真路径 ---------------- */

test("15. mock 也是一条真路径：仍产出 tool_call/usage 事件", async () => {
  const { events, answer } = await run({ goal: "探索一下这个项目的结构" });
  assert.ok(of(events, "tool_call").length >= 2);
  assert.ok(of(events, "usage").length >= 2);
  assert.ok(answer.length > 0);
});

test("16. mock 的写入会转成 approval_needed（write）", async () => {
  const { events } = await run({
    agent: agent("editor"),
    model: model("mock-editor"),
    goal: "帮我写一份会话简报",
  });
  const ap = of(events, "approval_needed");
  assert.equal(ap.length, 1);
  assert.equal(ap[0].kind, "write");
  assert.equal(ap[0].path, "notes/session-brief.md");
});

test("17. mock 的命令会转成 approval_needed（cmd）", async () => {
  const { events } = await run({
    agent: agent("editor"),
    model: model("mock-editor"),
    goal: "跑一下 git status 命令",
  });
  const ap = of(events, "approval_needed");
  assert.equal(ap.length, 1);
  assert.equal(ap[0].kind, "cmd");
  assert.equal(ap[0].command, "git status");
});

test("18. multi_write 产出两个待批准写入", async () => {
  const { events } = await run({
    agent: agent("editor"),
    model: model("mock-editor"),
    goal: "创建两个文件并更新 changelog",
  });
  assert.equal(of(events, "approval_needed").length, 2);
});

test("19. readOnly 下写入工具被摘掉，调用被挡在 SDK 之前", async () => {
  const lm = scriptedModel([
    turn({ toolCalls: [{ toolCallId: "w1", toolName: "write_file", input: { path: "x.md", content: "hi" } }] }),
    turn({ text: "被挡了" }),
  ]);
  const { events } = await run({
    languageModel: lm,
    agent: agent("editor"),
    goal: "写文件",
    readOnly: true,
  });
  const res = of(events, "tool_result")[0];
  assert.equal(res.result.ok, false);
  // readOnly 时 write_file 不在 ToolSet 里，SDK 直接判为不可用工具
  assert.match(res.result.error, /unavailable tool|Ask 模式/);
  assert.equal(of(events, "approval_needed").length, 0);
  // 且文件确实没被写
  const fs = await import("node:fs");
  assert.equal(fs.existsSync(path.join(WS, "x.md")), false);
});

/* ---------------- 回归：原 24 场景的路由 ---------------- */

test("20. resolveMockScenario 覆盖关键场景", () => {
  const cases = [
    ["探索一下这个项目的结构", "reader", "structure_focus"],
    ["讲讲 README", "reader", "readme_focus"],
    ["审计一下 TODO 和密钥", "auditor", "grep_audit"],
    ["帮我写一份会话简报", "editor", "write_hitl"],
    ["创建两个文件并更新 changelog", "editor", "multi_write"],
    ["跑一下 git status 命令", "editor", "cmd_hitl"],
    ["看一下 docs 架构", "reader", "docs_focus"],
    ["看下 package.json 依赖", "reader", "package_focus"],
    ["读一下 .loom 规则", "reader", "rules_focus"],
  ];
  for (const [goal, agentId, want] of cases) {
    const a = agent(agentId);
    const got = resolveMockScenario({
      agentId,
      modelId: modelIdOf(agentId),
      goal,
      allowedTools: a.allowedTools,
    });
    assert.equal(got, want, `「${goal}」应为 ${want}，实得 ${got}`);
  }
  function modelIdOf(agentId) {
    return agentId === "editor" ? "mock-editor" : "mock-local";
  }
});

test("21. fetch_url_stub 走离线桩，不发起真实 HTTP", async () => {
  const { events } = await run({ goal: "用 fetch_url 抓取 http 页面" });
  const fetchResult = of(events, "tool_result").find((e) => e.name === "fetch_url");
  assert.ok(fetchResult, "应调用 fetch_url");
  assert.equal(fetchResult.result.data.stub, true);
});

test("22. 未知工具的调用不会让整个 loop 崩掉", async () => {
  const lm = scriptedModel([
    turn({ toolCalls: [{ toolCallId: "z", toolName: "no_such_tool", input: {} }] }),
    turn({ text: "我换个方式" }),
  ]);
  const { events, answer } = await run({ languageModel: lm, goal: "试错" });
  assert.ok(answer.includes("我换个方式") || of(events, "error").length > 0);
});

test("23. 工具 execute 抛错时转成 tool_result(ok=false)，不中断", async () => {
  const lm = scriptedModel([
    turn({ toolCalls: [{ toolCallId: "r", toolName: "read_file", input: { path: "不存在的文件.md" } }] }),
    turn({ text: "读不到就算了" }),
  ]);
  const { events, answer } = await run({ languageModel: lm, goal: "读个不存在的文件" });
  const results = of(events, "tool_result");
  assert.ok(results.length >= 1);
  assert.ok(answer.length > 0);
});

test("24. estimateTokens 与真路径同一个估算器：窄字符 4 字符 ≈ 1 token，汉字 1 字符 ≈ 1 token", async () => {
  const { estimateTokens } = await import("../dist/loop/mock.js");
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(40)), 10);
  assert.equal(estimateTokens("一".repeat(9)), 9, "汉字不能再按 4 字符估，否则离线 Demo 的计量比真模型虚低");
});

test("25. 待办措辞优先走 todo_focus，不被 auditor 的 /TODO/i 截走", () => {
  const a = agent("reader");
  const route = (goal) =>
    resolveMockScenario({
      agentId: "reader",
      modelId: "mock-local",
      goal,
      allowedTools: a.allowedTools,
    });
  assert.equal(route("看看 TODO.md 里的待办清单"), "todo_focus");
  assert.equal(route("帮我列一下待办清单"), "todo_focus");
  // 反之，审计口径不能被 todo 分支抢走
  assert.equal(route("审计一下 TODO 和密钥"), "grep_audit");
});

test("26. 离线 mock 真调 todo_write：整表替换并回带用量文案", async () => {
  const events = [];
  await runAgentLoop({
    workspaceRoot: process.cwd(),
    agent: agent("guide"),
    model: model("mock-local"),
    skills: [],
    goal: "帮我列一下待办清单",
    maxSteps: 6,
    todo: { sessionId: "test-todo-focus", allowParallelInProgress: true },
    onEvent: (e) => events.push(e),
  });
  const calls = of(events, "tool_call").map((e) => e.name);
  assert.ok(calls.includes("todo_write"), `应调用 todo_write，实得 ${calls.join(",")}`);
  const written = of(events, "tool_result").find((e) => e.name === "todo_write");
  assert.ok(written, "应有 todo_write 结果");
  assert.equal(written.result.ok, true);
  assert.match(
    written.result.data.message,
    /^Updated todo list: \d+ pending, \d+ in progress, \d+ completed\.$/,
  );
});

test("26b. 同一轮 todo 真写进了 JSONL 文件（默认落盘，不是进程内 Map）", () => {
  const file = path.join(TODO_TMP, "test-todo-focus.jsonl");
  assert.ok(existsSync(file), `跑完 26 之后应当有日志文件：${file}`);
  const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
  assert.ok(lines.length >= 1, "至少一条事件");
  const last = JSON.parse(lines[lines.length - 1]);
  assert.equal(last.type, "todo/write");
  assert.equal(last.sessionId, "test-todo-focus");
  assert.ok(Array.isArray(last.todos) && last.todos.length > 0);
  assert.ok(last.todos.every((t) => typeof t.content === "string" && t.content.length > 0));
});

test("27. 没有会话归属时不谎称写了 todo（假动作回归）", async () => {
  const events = [];
  const answer = await runAgentLoop({
    workspaceRoot: process.cwd(),
    agent: agent("guide"),
    model: model("mock-local"),
    skills: [],
    goal: "帮我列一下待办清单",
    maxSteps: 6,
    // 刻意不传 todo：todo_write 不会注入，mock 就不许说「已写入 todo 列表」
    onEvent: (e) => events.push(e),
  });
  const calls = of(events, "tool_call").map((e) => e.name);
  assert.ok(!calls.includes("todo_write"), "未注入时不该有 todo_write 调用");
  assert.ok(
    !/写入 todo 列表/.test(answer),
    `没调用就不许声称写入，实得答案：${answer}`,
  );
  assert.match(answer, /没有会话归属/, "应如实说明未注入的原因");
});

test("28. workflow_code 在没真排上写操作时不谎称已提出待批准写入", async () => {
  // 路由事实：带 write_file 的 Agent 说「动手改码」会先进 write_hitl（那一支有 has() 守卫），
  // 能落到 workflow_code 的恰好都是不带 write_file 的 Agent（reader/planner/guide）。
  // 所以这一支的写提案永远排不上 —— 结论就不许说「已提出待批准」。
  const events = [];
  const answer = await runAgentLoop({
    workspaceRoot: process.cwd(),
    agent: agent("reader"),
    model: model("mock-local"),
    skills: [],
    goal: "动手改码：给仓库加一份说明",
    maxSteps: 6,
    onEvent: (e) => events.push(e),
  });
  const calls = of(events, "tool_call").map((e) => e.name);
  assert.ok(!calls.includes("write_file"), "reader 没有 write_file，不该出现写入调用");
  assert.ok(
    !/已提出.*待批准/.test(answer),
    `没有写入调用就不许声称已提出，实得答案：${answer}`,
  );
  assert.match(answer, /本步未强制写盘/, "应如实说明本步没写盘");
});

test("29. 只读模式摘掉 write_file 后，write_hitl 也不谎称已提出写入", async () => {
  const events = [];
  const answer = await runAgentLoop({
    workspaceRoot: process.cwd(),
    agent: agent("editor"),
    model: model("mock-editor"),
    skills: [],
    goal: "动手改码：给仓库加一份说明",
    maxSteps: 6,
    readOnly: true,
    onEvent: (e) => events.push(e),
  });
  const calls = of(events, "tool_call").map((e) => e.name);
  assert.ok(!calls.includes("write_file"), "readOnly 下不该有 write_file 调用");
  assert.ok(
    !/已提出.*待批准/.test(answer),
    `没调用就不许声称已提出写入，实得答案：${answer}`,
  );
});

/* ---------------- 后台 job 的离线演示剧本 ---------------- */

test("30. jobs_tour：还没有 job 时只提一个待批准的后台命令，不假装已经起了", async () => {
  resetDefaultJobStore();
  const events = [];
  const answer = await runAgentLoop({
    workspaceRoot: WS,
    agent: agent("hygienist"),
    model: model("mock-local"),
    skills: [],
    goal: "看看后台 job 怎么用",
    maxSteps: 6,
    onEvent: (e) => events.push(e),
  });
  const calls = of(events, "tool_call").map((e) => e.name);
  assert.deepEqual(calls, ["list_dir", "run_safe_cmd"], `实得调用 ${calls.join(",")}`);
  const approval = of(events, "approval_needed")[0];
  assert.equal(approval?.kind, "cmd");
  assert.equal(
    approval?.background,
    true,
    "后台命令的批准请求必须带 background，否则 approve 路由会当成阻塞命令",
  );
  assert.equal(approval?.command, "git log --oneline -n 5");
  assert.equal(
    getDefaultJobStore().list().length,
    0,
    "没批准之前不许有 job —— 提案不是执行",
  );
  assert.match(answer, /待批准/);
});

test("31. jobs_tour：批准之后第二遍就真去读它（job_list + job_output）", async () => {
  resetDefaultJobStore();
  const store = getDefaultJobStore();
  const started = await applyApprovedCmd(WS, "git log --oneline -n 1", { background: true });
  assert.equal(started.ok, true, `后台启动失败：${started.error}`);
  const finished = await store.read(started.jobId, { wait: true, timeoutMs: 8000 });
  assert.ok(finished, "应当能读到自己刚起的 job");

  const events = [];
  const answer = await runAgentLoop({
    workspaceRoot: WS,
    agent: agent("hygienist"),
    model: model("mock-local"),
    skills: [],
    goal: "看看后台 job 怎么用",
    maxSteps: 6,
    onEvent: (e) => events.push(e),
  });
  const calls = of(events, "tool_call").map((e) => e.name);
  assert.deepEqual(calls, ["list_dir", "job_list", "job_output"], `实得调用 ${calls.join(",")}`);
  const read = of(events, "tool_result").find((e) => e.name === "job_output");
  assert.equal(read?.result?.ok, true, `job_output 应当成功：${read?.result?.error ?? ""}`);
  assert.match(answer, new RegExp(started.jobId), "结论里要点明读的是哪个 job");
  await store.drain(4000);
  resetDefaultJobStore();
});
