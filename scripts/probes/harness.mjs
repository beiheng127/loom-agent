// 库级端到端探针：插件加载 → 委派工具可见 → 子 agent 真被派出 → 结果回流 → 计量逐步上报。
// 用法（仓库根目录）：node scripts/probes/harness.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { loadLoomPlugins, pluginToolsToDefinitions, resolveAgent, runAgentLoop } = await import(
  pathToFileURL(path.join(ROOT, "packages/core/dist/index.js")).href
);

const plugins = await loadLoomPlugins({
  root: path.join(ROOT, "plugins"),
  log: (m) => console.log("  log:", m),
});
console.log(
  "plugins:",
  plugins.map((p) => ({ name: p.manifest.name, tools: p.tools.map((t) => t.name), error: p.error })),
);
const defs = pluginToolsToDefinitions(plugins);
console.log("plugin tool defs:", defs.map((d) => d.name));

// 用 orchestrator（带 3 个子 agent）跑一次 delegate_fanout 剧本，看委派工具是否真的被调用
const agent = resolveAgent("orchestrator", path.join(ROOT, "data/loom-store/agents.json"));
console.log("orchestrator subagents:", agent.subagents?.map((s) => s.toolName));
const events = [];
const answer = await runAgentLoop({
  workspaceRoot: path.join(ROOT, "data/workspaces/sample"),
  agent,
  model: { id: "mock-local", provider: "mock", model: "mock-v1", contextWindow: 32000 },
  skills: [],
  goal: "请派子 agent 并行盘点这个项目，分头勘察结构并汇总",
  extraTools: defs,
  history: [
    { role: "user", content: "先热身读一下 README" },
    { role: "assistant", content: "已读。" },
  ],
  budget: { contextWindow: 2000 },
  onEvent: (e) => events.push(e),
  todo: { sessionId: "probe-session", allowParallelInProgress: true },
});
console.log("\n--- event types ---");
console.log([...new Set(events.map((e) => e.type))].join(", "));
console.log(
  "counts:",
  JSON.stringify(events.reduce((a, e) => ((a[e.type] = (a[e.type] || 0) + 1), a), {})),
);
console.log(
  "subagent_start:",
  events.filter((e) => e.type === "subagent_start").map((e) => e.toolName),
);
console.log(
  "subagent_end statuses:",
  events.filter((e) => e.type === "subagent_end").map((e) => e.status),
);
console.log("tool_call names:", events.filter((e) => e.type === "tool_call").map((e) => e.name));
console.log(
  "compacted:",
  events
    .filter((e) => e.type === "compacted")
    .map((e) => ({ c: e.compactedCount, rel: e.releasedTokens, reason: e.reason })),
);
console.log("usage steps:", events.filter((e) => e.type === "usage").length);
console.log("\nanswer:\n" + answer);
