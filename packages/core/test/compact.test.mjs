/**
 * compact.ts 单测：只跑编译产物 ../dist/loop/compact.js。
 * 运行：在 packages/core 下 `node --test "test/*.test.mjs"`。
 * 摘要模型用 ai/test 的 MockLanguageModelV3（本仓库 ai 为 v6，v3 流协议）。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MockLanguageModelV3 } from "ai/test";
import {
  COMPACT_DEFAULTS,
  compactHistory,
  estimateMessagesTokens,
  estimateTextTokens,
} from "../dist/loop/compact.js";

/* ---------------- mock 模型 ---------------- */

/** v3 usage 形状：inputTokens/outputTokens 都是对象，字段名见 @ai-sdk/provider 的 LanguageModelV3Usage */
function usage(input, output) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

function streamOf(parts) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(parts[i++]);
    },
  });
}

/**
 * 固定回一段文本的摘要模型。
 * 注意：`generateText` 走的是 **doGenerate**（实测：doStreamCalls=0, doGenerateCalls=1），
 * 所以这里必须实现 doGenerate；不实现 doStream，若 SDK 真的去流式就会抛 Not implemented。
 */
function summaryModel(text, onPrompt) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "summary-mock",
    doGenerate: async (options) => {
      onPrompt?.(options);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(100, 20),
        warnings: [],
      };
    },
  });
}

/** 一调就抛错的摘要模型（同样挂在 doGenerate 上） */
function failingModel(message) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "failing-mock",
    doGenerate: async () => {
      throw new Error(message);
    },
  });
}

/** 保留一段 doStream 版本，仅用于核实「generateText 不走 doStream」这一事实 */
function streamingOnlyModel(text) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "stream-only-mock",
    doStream: async () => ({
      stream: streamOf([
        { type: "text-start", id: "s1" },
        { type: "text-delta", id: "s1", delta: text },
        { type: "text-end", id: "s1" },
        { type: "finish", finishReason: { unified: "stop", raw: "stop" }, usage: usage(100, 20) },
      ]),
    }),
  });
}

/* ---------------- 造消息 ---------------- */

const user = (text) => ({ role: "user", content: text });
const assistant = (text) => ({ role: "assistant", content: text });

/** 一条 user 消息，正文凑到约 tokens*4 字符 */
function bulkyUser(tokens, tag) {
  return user(`${tag} ` + "x".repeat(tokens * 4 - tag.length - 1));
}

/** 基准窗口：W=1000, O=100, B=0 → 阈值 floor(min(1000*ratio, 900)) */
const WINDOW = { contextWindow: 1000, maxOutputTokens: 100, headroomTokens: 0 };

/* ---------------- 1. 低于阈值 ---------------- */

test("1. 低于阈值：不压缩，compacted=false，messages 原样", async () => {
  const messages = [bulkyUser(50, "a"), bulkyUser(50, "b"), bulkyUser(50, "c")];
  const before = estimateMessagesTokens(messages);
  const model = failingModel("不该被调用");

  const res = await compactHistory({
    ...WINDOW,
    messages,
    model,
    thresholdRatio: 0.8, // 阈值 800，压力 150
  });

  assert.equal(res.compacted, false);
  assert.equal(res.pressureTokens, before);
  assert.equal(res.thresholdTokens, 800);
  assert.deepEqual(res.messages, messages);
  assert.equal(res.messages.length, 3);
  assert.equal(res.compactedCount, 0);
  assert.equal(res.releasedTokens, 0);
  assert.equal(res.retainedCount, 3);
  assert.match(res.reason, /未触发/);
  assert.equal(model.doGenerateCalls.length, 0, "未触发时不该调模型");
});

/* ---------------- 2. 高于阈值 ---------------- */

test("2. 高于阈值：压缩，摘要消息在首位，尾部逐字保留", async () => {
  const messages = [];
  for (let i = 0; i < 20; i += 1) messages.push(bulkyUser(50, `m${i}`));
  const before = estimateMessagesTokens(messages);
  const summaryText = "目标：重构 loop；结论：已确认；文件：src/loop/run.ts；待办：补测";
  let promptSeen = "";
  const model = summaryModel(summaryText, (options) => {
    promptSeen = JSON.stringify(options);
  });

  const res = await compactHistory({
    ...WINDOW,
    messages,
    model,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
  });

  assert.equal(res.compacted, true);
  assert.ok(before > res.thresholdTokens, `压力 ${before} 应超阈值 ${res.thresholdTokens}`);
  assert.equal(res.reason, undefined);
  assert.ok(res.compactedCount > 0, `compactedCount=${res.compactedCount}`);

  // 摘要消息在首位，且是规定的包裹形式
  assert.equal(res.messages[0].role, "user");
  assert.equal(res.messages[0].content, `<context_summary>\n${summaryText}\n</context_summary>`);
  assert.equal(res.summary, summaryText);

  // 尾部逐字保留：同一批对象引用，且是原数组的后缀
  assert.equal(res.messages.length, res.retainedCount + 1);
  assert.equal(res.retainedCount, 2, `retainRatio 0.16 → 保留 2 条，实得 ${res.retainedCount}`);
  assert.deepEqual(res.messages.slice(1), messages.slice(-res.retainedCount));
  for (let i = 1; i < res.messages.length; i += 1) {
    assert.equal(res.messages[i], messages[messages.length - res.messages.length + i]);
  }

  // 释放 token 为正，且等于前后估算差
  assert.equal(res.releasedTokens, before - estimateMessagesTokens(res.messages));
  assert.ok(res.releasedTokens > 0, `releasedTokens=${res.releasedTokens}`);

  // 摘要提示词确实带上了被裁掉的历史
  assert.equal(model.doGenerateCalls.length, 1);
  assert.ok(promptSeen.includes("【旧消息开始】"), "提示词应带旧消息区段");
  assert.ok(promptSeen.includes("m0 "), "提示词应含最旧一条");
  assert.ok(promptSeen.includes("800"), "提示词要求不超过 800 字");
});

/* ---------------- 3. 保留边界安全 ---------------- */

test("3. 保留边界安全：不从 tool 边界切开，配对完整", async () => {
  const toolCallPart = {
    type: "tool-call",
    toolCallId: "call_1",
    toolName: "read_file",
    input: { path: "a.md" },
  };
  const toolResultPart = {
    type: "tool-result",
    toolCallId: "call_1",
    toolName: "read_file",
    output: { type: "text", value: "ok" },
  };
  const messages = [
    bulkyUser(750, "old1"),
    assistant("旧回答一 " + "y".repeat(750 * 4 - 6)),
    bulkyUser(750, "old2"),
    assistant("旧回答二 " + "y".repeat(750 * 4 - 6)),
    bulkyUser(750, "old3"),
    { role: "assistant", content: [toolCallPart] },
    { role: "tool", content: [toolResultPart] },
    bulkyUser(50, "now"),
  ];
  const pairStart = 5;
  const model = summaryModel("摘要");
  const res = await compactHistory({
    ...WINDOW,
    messages,
    model,
    thresholdRatio: 0.8,
    retainRatio: 0.09, // 预算 900*0.09=81：恰好停在 tool 消息上（50+27=77≤81<99）
  });

  assert.equal(res.compacted, true);
  assert.equal(res.retainedCount, 4, `实得 ${res.retainedCount}`);

  // 尾部第一条必须是 user，绝不能是 tool
  assert.equal(res.messages[1].role, "user");
  assert.notEqual(res.messages[1].role, "tool");

  // tool-call / tool-result 配对完整且相邻
  const keptAssistant = res.messages.find(
    (m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((p) => p.type === "tool-call"),
  );
  assert.ok(keptAssistant, "带 tool-call 的 assistant 应整体保留");
  const idx = res.messages.indexOf(keptAssistant);
  assert.equal(res.messages[idx + 1].role, "tool");
  assert.equal(res.messages[idx + 1].content[0].toolCallId, "call_1");

  // 被裁掉的那一段不能含 tool 消息
  const dropped = messages.slice(0, res.compactedCount);
  assert.ok(!dropped.some((m) => m.role === "tool"), "被裁区间不含 tool 消息");
  assert.equal(messages[pairStart].role, "assistant");

  // 整段历史里没有任何 user 消息 → 没有可安全保留的边界
  const noBoundary = await compactHistory({
    ...WINDOW,
    messages: [
      assistant("z".repeat(4000)),
      { role: "assistant", content: [toolCallPart] },
      { role: "tool", content: [toolResultPart] },
    ],
    model,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
  });
  assert.equal(noBoundary.compacted, false);
  assert.equal(noBoundary.reason, "找不到可安全保留的边界");
  assert.equal(noBoundary.messages.length, 3, "messages 原样返回");
});

/* ---------------- 4. 摘要失败降级 ---------------- */

test("4. 摘要模型抛错：compacted=false，reason 非空，messages 原样", async () => {
  const messages = [];
  for (let i = 0; i < 20; i += 1) messages.push(bulkyUser(50, `m${i}`));
  const model = failingModel("model exploded");

  const res = await compactHistory({
    ...WINDOW,
    messages,
    model,
    thresholdRatio: 0.8,
    retainRatio: 0.16,
  });

  assert.equal(res.compacted, false);
  assert.equal(res.compactedCount, 0);
  assert.equal(res.releasedTokens, 0);
  assert.equal(res.retainedCount, messages.length);
  assert.ok(res.reason && res.reason.length > 0, "reason 不能为空");
  assert.match(res.reason, /摘要生成失败/);
  assert.match(res.reason, /model exploded/);
  assert.deepEqual(res.messages, messages);
  assert.equal(res.messages.length, 20);
  assert.equal(model.doGenerateCalls.length, 1, "确实尝试过调模型");
});

/* ---------------- 5. token 估算数学 ---------------- */

test("5. estimateMessagesTokens：窄字符 4 字符 ≈ 1 token，含数组 content", () => {
  assert.equal(estimateMessagesTokens([]), 0);
  assert.equal(estimateMessagesTokens([user("")]), 0);
  assert.equal(estimateMessagesTokens([user("abcd")]), 1);
  assert.equal(estimateMessagesTokens([user("a".repeat(40))]), 10);
  assert.equal(
    estimateMessagesTokens([user("一".repeat(9))]),
    9,
    "汉字 1 字符 ≈ 1 token（不是 4 字符）——中文本按 4 估会低估算压力 3 倍",
  );

  // 数组 content：文本 part 取 text.length
  assert.equal(
    estimateMessagesTokens([
      user([
        { type: "text", text: "abcd" },
        { type: "text", text: "efgh" },
      ]),
    ]),
    2,
  );

  // 逐条向上取整再求和（不是先求和再取整）
  assert.equal(estimateMessagesTokens([user("abcd"), user("abcd"), user("abcd")]), 3);
  assert.equal(estimateMessagesTokens([user("abc"), user("abc")]), 2, "3+3 字符 → 1+1");

  // 非文本 part（tool-call）按其 JSON 串长度估算
  const part = { type: "tool-call", toolCallId: "c1", toolName: "read_file", input: { path: "a.md" } };
  assert.equal(estimateMessagesTokens([{ role: "assistant", content: [part] }]), Math.ceil(JSON.stringify(part).length / 4));

  // 默认常量与 DSH dsh-token-meter 同源
  assert.equal(COMPACT_DEFAULTS.charsPerToken, 4);
  assert.deepEqual(COMPACT_DEFAULTS, {
    thresholdRatio: 0.8,
    retainRatio: 0.16,
    headroomTokens: 65536,
    maxOutputTokens: 8192,
    charsPerToken: 4,
  });
});

/* ---------------- 6. 自定义比例生效 ---------------- */

test("6. 自定义 thresholdRatio / retainRatio 生效", async () => {
  const messages = [];
  for (let i = 0; i < 10; i += 1) messages.push(bulkyUser(50, `m${i}`));
  const pressure = estimateMessagesTokens(messages);
  const model = summaryModel("摘要");

  // 阈值 0.8 → 800：压力 500 不触发
  const loose = await compactHistory({ ...WINDOW, messages, model, thresholdRatio: 0.8 });
  assert.equal(loose.thresholdTokens, 800);
  assert.equal(loose.compacted, false);

  // 阈值 0.4 → 400：同样压力触发
  const strict = await compactHistory({
    ...WINDOW,
    messages,
    model,
    thresholdRatio: 0.4,
    retainRatio: 0.16,
  });
  assert.equal(strict.thresholdTokens, 400);
  assert.ok(pressure > strict.thresholdTokens);
  assert.equal(strict.compacted, true);
  assert.ok(strict.compactedCount > 0);

  // retainRatio 变大 → 保留更多尾部
  const small = await compactHistory({
    ...WINDOW,
    messages,
    model,
    thresholdRatio: 0.4,
    retainRatio: 0.16, // 预算 144 → 保留 2 条
  });
  const big = await compactHistory({
    ...WINDOW,
    messages,
    model,
    thresholdRatio: 0.4,
    retainRatio: 0.48, // 预算 432 → 保留 8 条
  });
  assert.equal(small.retainedCount, 2, `实得 ${small.retainedCount}`);
  assert.equal(big.retainedCount, 8, `实得 ${big.retainedCount}`);
  assert.ok(big.retainedCount > small.retainedCount);
  assert.ok(big.compactedCount < small.compactedCount);
  assert.ok(big.releasedTokens < small.releasedTokens);

  // 阈值公式上限受 W - O - B 约束：B 很大时阈值被压到很小
  const squeezed = await compactHistory({
    messages,
    model,
    contextWindow: 1000,
    maxOutputTokens: 100,
    headroomTokens: 600, // min(800, 1000-100-600=300) = 300
    thresholdRatio: 0.8,
    retainRatio: 0.16,
  });
  assert.equal(squeezed.thresholdTokens, 300);
  assert.equal(squeezed.compacted, true);
});

/* ---------------- 7. 小窗口：默认值必须跟着窗口收缩 ---------------- */

test("7. 小窗口下默认 maxOutputTokens/headroom 跟着收缩，阈值不为 0", async () => {
  // 回归用例：DSH 的默认 O=8192、B=65536 是按 128k+ 窗口定的。
  // 原样套到 W=4000 上，`W - O - B` 为负 → 阈值被夹到 0 → 每轮都触发压缩，
  // 甚至在没有可压缩内容时也反复判断。实测：修复前 thresholdTokens === 0。
  const messages = [bulkyUser(50, "a"), bulkyUser(50, "b")];
  const model = summaryModel("摘要");

  const small = await compactHistory({ messages, model, contextWindow: 4000 });
  // W=4000：O 与 B 都收缩到 1000 → min(4000*0.8, 4000-1000-1000) = 2000
  assert.equal(small.thresholdTokens, 2000, `实得 ${small.thresholdTokens}`);
  assert.ok(small.thresholdTokens > 0, "小窗口下阈值必须为正，否则压缩语义失效");

  // 显式传入的值是调用方的明确意图，不被窗口改写
  const explicit = await compactHistory({
    messages,
    model,
    contextWindow: 4000,
    maxOutputTokens: 100,
    headroomTokens: 500,
  });
  // min(3200, 4000-100-500) = 3200
  assert.equal(explicit.thresholdTokens, 3200, `实得 ${explicit.thresholdTokens}`);
});

/* ---------------- 8. CJK：宽字符不能按 4 字符/token 估 ---------------- */

/** 中文消息：`tokens` 个汉字（宽字符 1 字符 ≈ 1 token） */
function bulkyChinese(tokens, tag) {
  return user(`${tag} ` + "汉".repeat(Math.max(0, tokens - tag.length - 1)));
}

test("8. estimateTextTokens：宽窄分开算，纯 ASCII 的结果与老口径一致", () => {
  assert.equal(estimateTextTokens(""), 0);
  assert.equal(estimateTextTokens("abcd"), 1);
  assert.equal(estimateTextTokens("a".repeat(40)), 10);
  assert.equal(estimateTextTokens("汉".repeat(40)), 40, "40 个汉字 ≈ 40 token，不是 10");
  assert.equal(estimateTextTokens("汉字abc"), 3, "2 个宽字符 + 3 个窄字符(→1)");
  assert.equal(estimateTextTokens("，！？"), 3, "全角标点也按宽字符算");
  assert.equal(estimateTextTokens("あいう"), 3, "假名同理");

  // 混合文本：宽字符部分不被 4 除
  const mixed = estimateTextTokens("汉".repeat(100) + "x".repeat(400));
  assert.equal(mixed, 200, `100 + 400/4 = 200，实得 ${mixed}`);
});

test("9. 中文长会话：该触发压缩就必须触发（老口径会漏）", async () => {
  // 同样的对话，老口径（一律 chars/4）只估出 1/4 的压力。
  const messages = [];
  for (let i = 0; i < 20; i += 1) messages.push(bulkyChinese(50, `第${i}轮`));
  const chars = messages.reduce((n, m) => n + String(m.content).length, 0);
  const oldEstimate = Math.ceil(chars / 4);
  const newEstimate = estimateMessagesTokens(messages);
  assert.ok(
    newEstimate > oldEstimate * 3,
    `中文 50 字/条 × 20 条：老口径 ${oldEstimate}、新口径 ${newEstimate}（应至少 3 倍）`,
  );

  // 阈值 800：老口径 250 根本不触发 → 对话会一路堆到真窗口边上才动手
  const model = summaryModel("目标：中文长会话；结论：已压缩；待办：无");
  const res = await compactHistory({ ...WINDOW, messages, model, thresholdRatio: 0.8, retainRatio: 0.16 });
  assert.equal(res.thresholdTokens, 800);
  assert.equal(res.compacted, true, `压力 ${res.pressureTokens} 应超过阈值 800（老口径 ${oldEstimate} 会漏）`);
  assert.equal(res.pressureTokens, newEstimate);
  assert.ok(res.messages[0].content.startsWith("<context_summary>"));
});
