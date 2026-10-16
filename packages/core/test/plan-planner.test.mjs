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
  buildJudgePrompt,
  buildReplanPrompt,
  describePlannerResult,
  extractJsonBlock,
  extractJudgeIndex,
  makePlannerJudge,
  makePlannerReplanner,
  normalizePlannerDrafts,
  PLANNER_DEFAULTS,
  PlanPlannerError,
  planWorkers,
} from "../dist/plan/planner.js";
import {
  runPlanScheduler,
  topoBatches,
} from "../dist/plan/orchestrator.js";

/* ---------------- 断言小工具 ---------------- */

/**
 * 这个文件的后半段（judge / replanner）断言的是**编排行为**，不是提示词字符串，
 * 所以写一两个句子级的断言就够了：能看见失败步和剩余步、数量约束、下标范围。
 */
const has = (text, needle, what) =>
  assert.ok(text.includes(needle), `${what} 里应该出现「${needle}」：\n${text}`);

/* ---------------- mock 模型 ---------------- */

/** v3 usage 形状（同 compact.test.mjs）：inputTokens/outputTokens 都是对象 */
function usage(input, output) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/** `generateText` 走 doGenerate；onPrompt 用来核实提示词里真的带了目标与协议 */
function textModel(textOrFn, onPrompt) {
  return new MockLanguageModelV3({
    provider: "test",
    modelId: "planner-mock",
    doGenerate: async (options) => {
      onPrompt?.(options);
      const text =
        typeof textOrFn === "function" ? textOrFn(options) : textOrFn;
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

/* ---------------- best-of-N 裁判 ---------------- */

test("planner.15 buildJudgePrompt：把目标与每份候选都摊给模型，并约束下标范围", () => {
  const { system, prompt } = buildJudgePrompt({
    goal: "写一份架构说明",
    candidates: ["第一份", "第二份", "第三份"],
  });
  has(system, "0..2", "裁判 system");
  has(system, '{"index":0}', "裁判 system");
  has(prompt, "写一份架构说明", "裁判 prompt");
  has(prompt, "### 候选 0", "裁判 prompt");
  has(prompt, "### 候选 2", "裁判 prompt");
});

test("planner.16 extractJudgeIndex：裸数字 / JSON / 越界 / 垃圾 四种输入", () => {
  assert.equal(extractJudgeIndex("2", 3), 2);
  assert.equal(extractJudgeIndex('{"index": 1}', 3), 1);
  assert.equal(extractJudgeIndex('```json\n{"index":2}\n```', 3), 2);
  assert.equal(extractJudgeIndex("5", 3), null, "越界一律 null");
  assert.equal(extractJudgeIndex('{"index":-1}', 3), null, "负数一律 null");
  assert.equal(extractJudgeIndex("我觉得都差不多", 3), null);
});

test("planner.17 makePlannerJudge：模型挑了第 2 份 → 调度器就用第 2 份做结论", async () => {
  const judge = makePlannerJudge({ languageModel: textModel('{"index":1}') });
  const workers = [
    { agentId: "reader", modelId: "mock-local", title: "A", goal: "a", bestOf: 3 },
  ];
  const plan = {
    id: "p",
    goal: "挑最好的那份",
    createdAt: Date.now(),
    steps: workers.map((w, i) => ({ ...w, id: `s${i}`, status: "pending" })),
  };
  let n = 0;
  const { texts } = await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    judge,
    run: async () => `第 ${(n += 1)} 份`,
  });
  assert.equal(texts.get("s0"), "第 2 份");
  assert.equal(plan.steps[0].selectedCandidate, 1);
});

test("planner.18 makePlannerJudge：模型吐出垃圾 → 抛错让调度器退回第 1 份（不假装择优）", async () => {
  const judge = makePlannerJudge({ languageModel: textModel("都挺好的吧") });
  const workers = [
    { agentId: "reader", modelId: "mock-local", title: "A", goal: "a", bestOf: 2 },
  ];
  const plan = {
    id: "p",
    goal: "挑最好的那份",
    createdAt: Date.now(),
    steps: workers.map((w, i) => ({ ...w, id: `s${i}`, status: "pending" })),
  };
  let n = 0;
  const { texts } = await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    judge,
    run: async () => `第 ${(n += 1)} 份`,
  });
  assert.equal(texts.get("s0"), "第 1 份", "择优失败必须退回跑出来的第 1 份");
  assert.match(plan.steps[0].error, /裁判没给出合法下标/);
});

test("planner.19 makePlannerJudge：只有 1 个候选 / 没有模型 → 不烧钱直接返回 0", async () => {
  let called = 0;
  const spy = makePlannerJudge({
    languageModel: textModel(() => {
      called += 1;
      return '{"index":0}';
    }),
  });
  assert.equal(
    await spy({ step: {}, goal: "g", candidates: ["only one"] }),
    0,
  );
  assert.equal(called, 0);

  const noModel = makePlannerJudge({});
  assert.equal(await noModel({ step: {}, goal: "g", candidates: ["a", "b"] }), 0);
});

/* ---------------- 失败重规划 ---------------- */

test("planner.20 buildReplanPrompt：把失败步、失败原因、已完成、待重排都摊开", () => {
  const { system, prompt } = buildReplanPrompt({
    goal: "重构并发布",
    failedTitle: "改代码",
    failedGoal: "把 A 换成 B",
    error: "写文件被拒绝",
    doneTitles: ["读代码"],
    remainingTitles: ["补测试", "发版"],
  });
  has(system, "正好 2 条 Worker", "重规划 system");
  has(system, "不许依赖失败的那一步", "重规划 system");
  has(prompt, "重构并发布", "重规划 prompt");
  has(prompt, "改代码", "重规划 prompt");
  has(prompt, "写文件被拒绝", "重规划 prompt");
  has(prompt, "读代码", "重规划 prompt");
  has(prompt, "补测试", "重规划 prompt");
  has(prompt, "发版", "重规划 prompt");
});

test("planner.21 makePlannerReplanner：模型给了正好 N 条 → 剩余步真的被换掉", async () => {
  const replan = makePlannerReplanner({
    languageModel: textModel(
      planJson([
        { title: "换个法子补测试", goal: "跳过失败路径，只测新接口" },
        { title: "直接发版", goal: "打 tag 并写 changelog", dependsOn: [0] },
      ]),
    ),
  });
  const workers = [
    { agentId: "reader", modelId: "mock-local", title: "读代码", goal: "r" },
    { agentId: "editor", modelId: "mock-local", title: "改代码", goal: "c", dependsOn: [0] },
    { agentId: "editor", modelId: "mock-local", title: "补测试", goal: "t", dependsOn: [1] },
    { agentId: "editor", modelId: "mock-local", title: "发版", goal: "p", dependsOn: [2] },
  ];
  const plan = {
    id: "p",
    goal: "重构并发布",
    createdAt: Date.now(),
    steps: workers.map((w, i) => ({ ...w, id: `s${i}`, status: "pending" })),
  };
  const ran = [];
  await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    maxRetries: 0,
    replan,
    run: async ({ step }) => {
      ran.push(step.title);
      if (step.title === "改代码") throw new Error("写文件被拒绝");
      return "ok";
    },
  });

  assert.equal(plan.steps[1].status, "failed");
  // 换出来的两步都不依赖失败步，所以真的跑了
  assert.deepEqual(ran, ["读代码", "改代码", "换个法子补测试", "直接发版"]);
  assert.equal(plan.steps[2].title, "换个法子补测试");
  assert.equal(plan.steps[3].title, "直接发版");
  assert.equal(plan.steps[3].status, "done");
});

test("planner.22 makePlannerReplanner：模型给的数量不对 → null，调度器照旧跳过", async () => {
  const notes = [];
  const replan = makePlannerReplanner({
    languageModel: textModel(planJson([{ title: "只给一个", goal: "x" }])),
    onNote: (n) => notes.push(n),
  });
  // A → B → C：A 失败时 B、C 都还没跑（remaining = 2），模型只给 1 条就对不上
  const workers = [
    { agentId: "reader", modelId: "mock-local", title: "A", goal: "a" },
    { agentId: "reader", modelId: "mock-local", title: "B", goal: "b", dependsOn: [0] },
    { agentId: "reader", modelId: "mock-local", title: "C", goal: "c", dependsOn: [1] },
  ];
  const plan = {
    id: "p",
    goal: "目标",
    createdAt: Date.now(),
    steps: workers.map((w, i) => ({ ...w, id: `s${i}`, status: "pending" })),
  };
  await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    maxRetries: 0,
    replan,
    run: async ({ step }) => {
      if (step.title === "A") throw new Error("A 挂了");
      return "ok";
    },
  });
  assert.equal(plan.steps[1].title, "B", "数量对不上就不许改写");
  assert.equal(plan.steps[2].title, "C");
  assert.equal(plan.steps[1].status, "skipped");
  assert.match(notes.join("\n"), /作废/);
});

test("planner.24 makePlannerReplanner：新步不沿用失败步的模型（否则会再撞同一堵墙）", async () => {
  const replan = makePlannerReplanner({
    modelId: "deepseek-chat",
    languageModel: textModel(
      // 模型偷懒不写 modelId → 走默认值
      planJson([{ title: "换个模型重来", goal: "用能用的模型再试一次" }]),
    ),
  });
  const next = await replan({
    goal: "g",
    failed: {
      agentId: "reader",
      modelId: "openai-mini", // ← 失败的那一步用的模型（没配 Key）
      title: "A",
      goal: "a",
    },
    failedIndex: 0,
    error: "缺少环境变量 OPENAI_API_KEY",
    workers: [],
    remaining: [1],
  });
  assert.equal(next.length, 1);
  assert.equal(
    next[0].modelId,
    "deepseek-chat",
    "重规划出来的步必须换掉失败步的模型，用重规划自己这个（刚跑通的）模型",
  );

  // 模型照抄了失败步的模型 → 就地换掉
  const copied = makePlannerReplanner({
    modelId: "deepseek-chat",
    languageModel: textModel(
      planJson([{ title: "照抄", goal: "x", modelId: "openai-mini" }]),
    ),
  });
  const fixed = await copied({
    goal: "g",
    failed: {
      agentId: "reader",
      modelId: "openai-mini",
      title: "A",
      goal: "a",
    },
    failedIndex: 0,
    error: "x",
    workers: [],
    remaining: [1],
  });
  assert.equal(fixed[0].modelId, "deepseek-chat", "照抄失败模型也要换掉");
});

test("planner.23 makePlannerReplanner：没模型 / 模型报错 → null 且记 note，不抛给调度器", async () => {
  const notes = [];
  const noModel = makePlannerReplanner({ onNote: (n) => notes.push(n) });
  assert.equal(
    await noModel({
      goal: "g",
      failed: { agentId: "reader", modelId: "mock-local", title: "A", goal: "a" },
      failedIndex: 0,
      error: "x",
      workers: [],
      remaining: [1],
    }),
    null,
  );

  const boom = makePlannerReplanner({
    languageModel: new MockLanguageModelV3({
      provider: "test",
      modelId: "boom",
      doGenerate: async () => {
        throw new Error("500 upstream");
      },
    }),
    onNote: (n) => notes.push(n),
  });
  assert.equal(
    await boom({
      goal: "g",
      failed: { agentId: "reader", modelId: "mock-local", title: "A", goal: "a" },
      failedIndex: 0,
      error: "x",
      workers: [],
      remaining: [1],
    }),
    null,
  );
  assert.ok(notes.length >= 1);
  assert.match(notes.join("\n"), /模型调用失败/);
});
