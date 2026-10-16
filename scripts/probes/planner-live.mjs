#!/usr/bin/env node
/**
 * 真模型 × 动态拆步探针：让**真模型**自己把一句总目标拆成带依赖的 Worker 清单，再把这份清单跑完。
 *
 * 为什么单开一个：scripts/probes/http.mjs 里那条 planner 断言只能证明「没真模型时会回落」，
 * 证明不了「模型真能拆出可用的清单」。packages/core/test/plan-planner.test.mjs 用的是假模型，
 * 只到「解析 + 校验」这一层。
 *
 * 需要至少一个真 Key（DEEPSEEK_API_KEY / OPENAI_API_KEY）。没 Key 就自己跳过，不算失败。
 * 用法：node scripts/probes/planner-live.mjs [模型id]
 */

const BASE = process.env.LOOM_BASE ?? "http://127.0.0.1:3010";
const MODEL =
  process.argv[2] ??
  (process.env.DEEPSEEK_API_KEY
    ? "deepseek-chat"
    : process.env.OPENAI_API_KEY
      ? "openai-mini"
      : null);

if (!MODEL) {
  console.log("[planner-live] 没有 DEEPSEEK_API_KEY / OPENAI_API_KEY，跳过（这一条必须真模型）");
  process.exit(0);
}

const fail = (msg) => {
  console.log(`FAIL  ${msg}`);
  process.exitCode = 1;
};
const pass = (msg) => console.log(`PASS  ${msg}`);

/** 预设 hetero 的标题：用来证明模型是**自己**拆的，不是把预设抄了一遍 */
const PRESET_TITLES = ["Reader · 结构", "Editor · 提议写入"];

const GOAL =
  "给 loom-agent 的 README 做一次体检：先确认文档里的链接有没有死链，再核对安装步骤与 package.json 的脚本是否一致，最后整理一份待修清单。";

try {
  await fetch(`${BASE}/api/meta`).then((r) => r.json());
} catch (e) {
  fail(`连不上 ${BASE}（先 npm run studio）：${e.message}`);
  process.exit(1);
}
pass(`服务在 ${BASE}`);

// ---- 让真模型拆步；Worker 本身跑 mock（离线、快），要验的是「清单」这一环 ----
const t0 = Date.now();
const res = await fetch(`${BASE}/api/plan`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({
    goal: GOAL,
    preset: "hetero",
    preferReal: false,
    planner: true,
    plannerModelId: MODEL,
    maxRetries: 0,
  }),
});
const json = await res.json().catch(() => null);
const ms = Date.now() - t0;

if (res.status !== 200) {
  fail(`POST /api/plan status=${res.status} body=${JSON.stringify(json).slice(0, 300)}`);
  process.exit(1);
}
pass(`POST /api/plan 200（${ms}ms）规划模型=${MODEL}`);
console.log(`      planner: ${json.planner?.summary ?? "(无)"}`);

if (!json.planner?.ok) {
  fail(`规划没成功：${json.planner?.reason ?? "没有 planner 字段"}`);
} else {
  pass(`模型拆步成功，产出 ${json.planner.workers} 个 Worker`);
}

const workers = json.workers ?? [];
if (workers.length < 2) fail(`只有 ${workers.length} 个 Worker，拆步没起作用`);
else pass(`Worker 清单长度 ${workers.length}（≥2）`);

const fromPreset = JSON.stringify(workers.map((w) => w.title)) === JSON.stringify(PRESET_TITLES);
if (fromPreset) fail("清单和预设 hetero 一模一样，说明模型没参与或结果被覆盖了");
else pass("清单不是预设的翻版（标题不同）");

const depCount = workers.filter((w) => (w.dependsOn ?? []).length > 0).length;
const batchShape = (json.batches ?? []).map((b) => b.stepIds.length).join(" → ");
console.log(`      批次：${batchShape || "(无)"}；带依赖的 Worker：${depCount} 个`);
for (const [i, w] of workers.entries()) {
  console.log(
    `      W${i} ${w.title}｜agent=${w.agentId} model=${w.modelId}｜依赖=[${(w.dependsOn ?? []).join(",")}]`,
  );
}

if (!(json.batches ?? []).length) fail("响应里没有 batches（调度器没拿到依赖信息）");

const steps = json.steps ?? [];
if (steps.length !== workers.length) {
  fail(`steps(${steps.length}) 与 workers(${workers.length}) 对不上`);
} else if (!steps.every((s) => s.status === "done")) {
  fail(`有步骤没跑完：${steps.map((s) => `${s.title}=${s.status}`).join(", ")}`);
} else {
  pass(`模型拆出的 ${steps.length} 步全部跑完（状态 done）`);
}

console.log(
  process.exitCode
    ? "\n# planner-live: 有失败"
    : "\n# planner-live: 端到端通过（总目标 → 模型拆步 → 调度器分批 → 全部跑完）",
);
