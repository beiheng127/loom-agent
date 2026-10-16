// 上下文压缩探针：验证压缩真的触发、摘要真的走了一次模型调用。
// 用法（仓库根目录）：node scripts/probes/compact.mjs
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { resolveAgent, runAgentLoop, compactHistory } = await import(
  pathToFileURL(path.join(ROOT, "packages/core/dist/index.js")).href
);
const { MockLanguageModelV3 } = await import("ai/test");

// --- 1) 压缩真的触发：造一段很长的历史，故意超过 contextWindow*0.8
const long = "这是一段用于把上下文压力推高的历史消息，重复填充内容。".repeat(60);
const history = [];
for (let i = 0; i < 12; i++) {
  history.push({ role: i % 2 === 0 ? "user" : "assistant", content: `第${i}轮：${long}` });
}
const evs = [];
const agent = resolveAgent("reader", path.join(ROOT, "data/loom-store/agents.json"));
await runAgentLoop({
  workspaceRoot: path.join(ROOT, "data/workspaces/sample"),
  agent,
  model: { id: "mock-local", provider: "mock", model: "mock-v1", contextWindow: 4000 },
  skills: [],
  goal: "总结这个仓库",
  history,
  onEvent: (e) => evs.push(e),
});
const c = evs.find((e) => e.type === "compacted");
console.log("compacted:", JSON.stringify(c));

// --- 2) 摘要真的调了模型：用一个可观测的 mock 模型，看它收到的是不是摘要请求
// 注意 generateText 走的是 doGenerate（不是 doStream）。实测：doStreamCalls=0, doGenerateCalls=1。
let summarizerCalls = 0;
let promptSeen = "";
const summarizer = new MockLanguageModelV3({
  doGenerate: async (opts) => {
    summarizerCalls++;
    promptSeen = JSON.stringify(opts.prompt).slice(0, 160);
    return {
      content: [{ type: "text", text: "《历史摘要》：用户要求总结仓库；已确认结论 X；待办 Y。" }],
      finishReason: { unified: "stop", raw: "stop" },
      usage: {
        inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
        outputTokens: { total: 10, text: 10, reasoning: 0 },
      },
      warnings: [],
    };
  },
});
const msgs = history.map((h) => ({ role: h.role, content: h.content }));
const res = await compactHistory({ messages: msgs, model: summarizer, contextWindow: 4000 });
console.log(
  "\ncompactHistory:",
  JSON.stringify({
    compacted: res.compacted,
    dropped: res.compactedCount,
    retained: res.retainedCount,
    released: res.releasedTokens,
    threshold: res.thresholdTokens,
    pressure: res.pressureTokens,
    reason: res.reason,
  }),
);
console.log("summarizer 被调用次数:", summarizerCalls);
console.log(
  "首条消息 role/content 前缀:",
  res.messages[0].role,
  JSON.stringify(res.messages[0].content).slice(0, 90),
);
console.log(
  "保留尾部是否逐字:",
  res.messages.slice(1).every((m, i) => m.content === msgs[res.compactedCount + i].content),
);

// --- 3) 宽字符估算：同样的对话，老口径（一律 chars/4）会把压力算成 1/4
const { estimateTextTokens, estimateMessagesTokens } = await import(
  pathToFileURL(path.join(ROOT, "packages/core/dist/index.js")).href
);
const chars = msgs.reduce((n, m) => n + String(m.content).length, 0);
console.log("\n--- 宽窄估算 ---");
console.log("汉字段 40 字：", estimateTextTokens("汉".repeat(40)), "token（老口径 10）");
console.log("ASCII 40 字：", estimateTextTokens("a".repeat(40)), "token（与老口径一致）");
console.log(
  "本探针那段中文历史：老口径",
  Math.ceil(chars / 4),
  "token → 新口径",
  estimateMessagesTokens(msgs),
  "token",
);

// 边界案例：老口径够不着阈值、新口径够得着——这就是「漏触发」
const border = [];
for (let i = 0; i < 12; i++) {
  border.push({ role: i % 2 === 0 ? "user" : "assistant", content: `第${i}轮：` + long.slice(0, 700) });
}
const borderChars = border.reduce((n, m) => n + m.content.length, 0);
const threshold = 4000 * 0.8;
console.log(
  "边界案例（12 条 × 700 中文字）宽窄估算：老口径",
  Math.ceil(borderChars / 4),
  "→ 新口径",
  estimateMessagesTokens(border),
  `（阈值 ${threshold}）`,
);
console.log(
  "老口径会不会触发：",
  Math.ceil(borderChars / 4) > threshold ? "会" : "不会（对话会一路堆到真窗口边上才动手）",
  "｜新口径：",
  estimateMessagesTokens(border) > threshold ? "会" : "不会",
);
