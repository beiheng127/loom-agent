#!/usr/bin/env node
/**
 * 真模型 × 插件探针：起服务后，让**真模型**自己决定调用插件工具，看它到底调没调、拿到什么。
 *
 * 为什么单开一个：scripts/probes/http.mjs 用的是 mock 模型（跑不出真实 tool choice），
 * packages/core/test/plugins-real.test.mjs 只到「工具包成 ToolDefinition」这一层。
 * 这一条补的是**端到端**：模型 → tool_call → 插件 execute → tool_result → 模型总结。
 *
 * 需要至少一个真 Key（DEEPSEEK_API_KEY / OPENAI_API_KEY）。没 Key 就自己跳过，不算失败。
 * 用法：node scripts/probes/plugin-live.mjs [工作区路径] [模型id]
 */

const BASE = process.env.LOOM_BASE ?? "http://127.0.0.1:3010";
const WORKSPACE = process.argv[2] ?? process.cwd();
const MODEL =
  process.argv[3] ??
  (process.env.DEEPSEEK_API_KEY
    ? "deepseek-chat"
    : process.env.OPENAI_API_KEY
      ? "openai-mini"
      : null);

if (!MODEL) {
  console.log(
    "[plugin-live] 没有 DEEPSEEK_API_KEY / OPENAI_API_KEY，跳过（这一条必须真模型，mock 跑不出来）",
  );
  process.exit(0);
}

const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  process.exitCode = 1;
};
const pass = (msg) => console.log(`PASS  ${msg}`);

// ---- 1) 先确认服务活着 ----
try {
  const meta = await fetch(`${BASE}/api/meta`).then((r) => r.json());
  const names = meta?.harness?.plugins?.flatMap((p) => p.tools) ?? [];
  pass(`服务在 ${BASE}，已加载插件工具 [${names.join(", ")}]`);
  if (!names.includes("deps_audit")) {
    fail("没有 deps_audit 工具，后面的调用不可能成功");
    process.exit(1);
  }
} catch (e) {
  fail(`连不上 ${BASE}（先 npm run studio）：${e.message}`);
  process.exit(1);
}

// ---- 2) 让真模型自己选工具 ----
const t0 = Date.now();
const res = await fetch(`${BASE}/api/run`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    goal: "用 deps_audit 工具扫一下当前工作区，然后只告诉我：有哪几个包、missing 和 unused 各几条。不要自己读文件，直接用这个工具。",
    workspace: WORKSPACE,
    modelId: MODEL,
    sessionId: `probe-plugin-live-${Date.now()}`,
    plugins: true,
  }),
});
const json = await res.json();
const ms = Date.now() - t0;

if (res.status !== 200) {
  fail(`POST /api/run status=${res.status} body=${JSON.stringify(json).slice(0, 300)}`);
  process.exit(1);
}
pass(`POST /api/run 200（${ms}ms）模型=${MODEL}`);

// ---- 3) 事件里有 tool_call / tool_result，且名字是插件工具 ----
const events = json.events ?? [];
const calls = events.filter((e) => e.type === "tool_call" && e.name);
const results = events.filter((e) => e.type === "tool_result" && e.name);
pass(`事件 ${events.length} 条，tool_call=${calls.length} tool_result=${results.length}`);

const pluginCalls = calls.filter((c) =>
  ["deps_audit", "git_summary", "docs_link_check", "docs_link_report", "hello_echo", "repo_wordcount"].includes(c.name),
);
if (!pluginCalls.length) {
  fail(
    `模型一个插件工具都没调（调的是 [${calls.map((c) => c.name).join(", ") || "无"}]）`,
  );
} else {
  pass(`模型真的调了插件工具：${pluginCalls.map((c) => c.name).join(", ")}`);
}

const badResult = results.find((r) => r.ok === false);
if (badResult) fail(`工具 ${badResult.name} 返回 ok=false：${JSON.stringify(badResult).slice(0, 300)}`);

// ---- 4) 模型拿到结果后真的用上了（答案里有数字，不是空话）----
const answer = String(json.answer ?? "").trim();
if (!answer) fail("answer 是空的");
else {
  const hasNumber = /\d/.test(answer);
  console.log(`      answer(${answer.length} 字): ${answer.replace(/\s+/g, " ").slice(0, 240)}`);
  hasNumber ? pass("答案里带具体数字") : fail(`答案里没有任何数字，可能没读工具结果：${answer.slice(0, 120)}`);
}

console.log(
  process.exitCode ? "\n# plugin-live: 有失败" : "\n# plugin-live: 端到端通过（模型 → 插件 → 模型）",
);
