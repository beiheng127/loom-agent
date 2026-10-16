import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
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

test("24. estimateTokens 与 DSH 同源：4 字符 ≈ 1 token", async () => {
  const { estimateTokens } = await import("../dist/loop/mock.js");
  assert.equal(estimateTokens(""), 0);
  assert.equal(estimateTokens("abcd"), 1);
  assert.equal(estimateTokens("a".repeat(40)), 10);
  assert.equal(estimateTokens("一".repeat(9)), 3);
});
