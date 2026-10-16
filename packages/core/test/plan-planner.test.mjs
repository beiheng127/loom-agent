/**
 * planner.ts 单测：模型拆步 + 三道校验（形状 / 上限 / 依赖）。
 * 只跑编译产物 ../dist/plan/planner.js；模型用 ai/test 的 MockLanguageModelV3。
 *
 * 这些用例的立场：**规划失败必须是可预期的返回，不是异常、也不是半份清单**。
 * 所以「成环 / 越界 / 自依赖 / 不吐 JSON / 空 workers」全部断言 ok:false + reason 关键词。
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { MockLanguageModelV3 } from "ai/test";
import {
  describePlannerResult,
  extractJsonBlock,
  normalizePlannerDrafts,
  PLANNER_DEFAULTS,
  PlanPlannerError,
  planWorkers,
} from "../dist/plan/planner.js";

/* ---------------- mock 模型 ---------------- */

/** v3 usage 形状（同 compact.test.mjs）：inputTokens/outputTokens 都是对象 */
function usage(input, output) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/** `generateText` 走 doGenerate；onPrompt 用来核实提示词里真的带了目标与协议 */
function textModel(text, onPrompt) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "planner-mock",
    doGenerate: async (options) => {
      onPrompt?.(options);
      return {
        content: [{ type: "text", text }],
        finishReason: { unified: "stop", raw: "stop" },
        usage: usage(100, 40),
        warnings: [],
      };
    },
  });
}

function failingModel(message) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "planner-boom",
    doGenerate: async () => {
      throw new Error(message);
    },
  });
}

/** AI SDK v6 把 system / prompt 交给 doGenerate 时可能是消息数组，摊平成文本再断言 */
function flatten(value) {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => {
        if (typeof item === "string") return item;
        const content = item?.content;
        if (typeof content === "string") return content;
        if (Array.isArray(content)) return content.map((c) => c?.text ?? "").join("\n");
        return String(item?.text ?? "");
      })
      .join("\n");
  }
  return String(value ?? "");
}

const planJson = (workers) => JSON.stringify({ workers });
const GOOD = planJson([
  { title: "读结构", goal: "列出目录", agentId: "reader" },
  { title: "查风险", goal: "在结构结论上查风险", agentId: "auditor", dependsOn: [0] },
  { title: "写纪要", goal: "汇总成纪要", agentId: "editor", dependsOn: [1] },
]);

/* ---------------- 提示词 ---------------- */

test("planner.1 提示词带上了总目标、JSON 协议与 Agent 白名单", async () => {
  let seen = null;
  const out = await planWorkers({
    goal: "给 loom-agent 补一道门禁",
    languageModel: textModel(GOOD, (o) => (seen = o)),
    allowedAgentIds: ["reader", "auditor", "editor"],
  });
  assert.equal(out.ok, true);
  // v6 把 system 折进 prompt 的第一条 system 消息里，所以这里摊平后一起断言
  const all = flatten(seen.prompt) + "\n" + flatten(seen.system);
  assert.match(all, /给 loom-agent 补一道门禁/);
  assert.match(all, /JSON/);
  assert.match(all, /reader \/ auditor \/ editor/);
  assert.ok(seen.temperature === PLANNER_DEFAULTS.temperature, "规划温度应为 0");
});

/* ---------------- 正常路径 ---------------- */

test("planner.2 三 Worker 两条依赖 → 分两批，dependsOn 原样透传", async () => {
  const out = await planWorkers({ goal: "随便", languageModel: textModel(GOOD) });
  assert.equal(out.ok, true);
  assert.equal(out.source, "llm");
  assert.equal(out.workers.length, 3);
  assert.deepEqual(out.workers[0].dependsOn, undefined);
  assert.deepEqual(out.workers[1].dependsOn, [0]);
  assert.deepEqual(out.workers[2].dependsOn, [1]);
  assert.deepEqual(
    out.batches.map((b) => b.length),
    [1, 1, 1],
    "链式依赖应分成三批",
  );
  assert.ok(out.elapsedMs >= 0);
  assert.match(describePlannerResult(out), /3 个 Worker/);
});

test("planner.3 无依赖的两步被分到同一批（这才是「能并行」）", async () => {
  const out = await planWorkers({
    goal: "随便",
    languageModel: textModel(
      planJson([
        { title: "A", goal: "看结构" },
        { title: "B", goal: "读 README" },
      ]),
    ),
  });
  assert.equal(out.ok, true);
  assert.deepEqual(
    out.batches.map((b) => b.length),
    [2],
  );
});

test("planner.4 模型套了 ```json 围栏、还带客套话 → 照样抠得出来", async () => {
  const noisy = `好的，我来拆一下：\n\`\`\`json\n${GOOD}\n\`\`\`\n需要我调整吗？`;
  const out = await planWorkers({ goal: "随便", languageModel: textModel(noisy) });
  assert.equal(out.ok, true);
  assert.equal(out.workers.length, 3);
});

/* ---------------- 失败路径：都必须是 ok:false ---------------- */

test("planner.5 没给模型（mock 规划不了）→ ok:false 且说清为什么", async () => {
  const out = await planWorkers({ goal: "随便", modelId: "mock-local" });
  assert.equal(out.ok, false);
  assert.match(out.reason, /mock/);
  assert.match(describePlannerResult(out), /规划失败/);
});

test("planner.6 模型吐废话不吐 JSON → ok:false，reason 带原文开头", async () => {
  const out = await planWorkers({
    goal: "随便",
    languageModel: textModel("我觉得这个任务挺复杂的，先看看目录吧。"),
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /JSON/);
  assert.match(out.reason, /我觉得这个任务挺复杂的/);
});

test("planner.7 JSON 里 workers 是空数组 → ok:false（不许把空清单当成功）", async () => {
  const out = await planWorkers({ goal: "随便", languageModel: textModel(planJson([])) });
  assert.equal(out.ok, false);
  assert.match(out.reason, /空数组/);
});

test("planner.8 缺字段 / 不是对象 → 整份拒掉", async () => {
  const noTitle = await planWorkers({
    goal: "随便",
    languageModel: textModel(planJson([{ goal: "没有标题" }])),
  });
  assert.equal(noTitle.ok, false);
  assert.match(noTitle.reason, /缺 title/);

  const notObject = await planWorkers({
    goal: "随便",
    languageModel: textModel(planJson(["就把目标抄一遍"])),
  });
  assert.equal(notObject.ok, false);
  assert.match(notObject.reason, /不是对象/);
});

test("planner.9 依赖越界 / 依赖自己 → 拒掉并说清下标范围", async () => {
  const outOfRange = await planWorkers({
    goal: "随便",
    languageModel: textModel(
      planJson([
        { title: "A", goal: "a" },
        { title: "B", goal: "b", dependsOn: [9] },
      ]),
    ),
  });
  assert.equal(outOfRange.ok, false);
  assert.match(outOfRange.reason, /只有 2 个 Worker/);

  const self = await planWorkers({
    goal: "随便",
    languageModel: textModel(planJson([{ title: "A", goal: "a", dependsOn: [0] }])),
  });
  assert.equal(self.ok, false);
  assert.match(self.reason, /依赖自己/);
});

test("planner.10 依赖成环（0→1→0）→ 被 topoBatches 拦下", async () => {
  const out = await planWorkers({
    goal: "随便",
    languageModel: textModel(
      planJson([
        { title: "A", goal: "a", dependsOn: [1] },
        { title: "B", goal: "b", dependsOn: [0] },
      ]),
    ),
  });
  assert.equal(out.ok, false);
  assert.match(out.reason, /成环/);
});

test("planner.11 模型调用抛错 → ok:false，不冒泡成 500", async () => {
  const out = await planWorkers({ goal: "随便", languageModel: failingModel("502 Bad Gateway") });
  assert.equal(out.ok, false);
  assert.match(out.reason, /模型调用失败/);
  assert.match(out.reason, /502 Bad Gateway/);
});

/* ---------------- 可修复的问题：修 + 记 note ---------------- */

test("planner.12 超出上限截断、agentId 不在白名单回落，两件事都记进 notes", async () => {
  const out = await planWorkers({
    goal: "随便",
    maxWorkers: 2,
    allowedAgentIds: ["reader", "auditor"],
    languageModel: textModel(
      planJson([
        { title: "A", goal: "a", agentId: "reader" },
        { title: "B", goal: "b", agentId: "黑客" },
        { title: "C", goal: "c", agentId: "auditor" },
      ]),
    ),
  });
  assert.equal(out.ok, true);
  assert.equal(out.workers.length, 2);
  assert.equal(out.workers[1].agentId, "reader", "不在白名单的 agentId 应回落默认");
  assert.equal(out.notes.length, 2);
  assert.match(out.notes.join("\n"), /超过上限 2/);
  assert.match(out.notes.join("\n"), /不在列表里/);
  assert.equal(describePlannerResult(out), `模型拆出 2 个 Worker，批次 2（${out.elapsedMs}ms）；附注 2 条`);
});

/* ---------------- 纯函数单测 ---------------- */

test("planner.13 extractJsonBlock：整体 / 围栏 / 首尾大括号三种抠法都通，空串抛错", () => {
  assert.deepEqual(extractJsonBlock('{"workers":[]}'), { workers: [] });
  assert.deepEqual(extractJsonBlock('```json\n{"workers":[1]}\n```'), { workers: [1] });
  assert.deepEqual(extractJsonBlock('前缀 {"a":1} 后缀'), { a: 1 });
  assert.throws(() => extractJsonBlock("   "), PlanPlannerError);
});

test("planner.14 normalizePlannerDrafts：裸数组也收，重复依赖去重并排序", () => {
  const { workers, notes } = normalizePlannerDrafts(
    [{ title: "A", goal: "a" }, { title: "B", goal: "b", dependsOn: [0, 0] }],
    {},
  );
  assert.equal(notes.length, 0);
  assert.deepEqual(workers[1].dependsOn, [0]);
  assert.equal(workers[1].modelId, "mock-local", "没给 modelId 应回落默认");
});
