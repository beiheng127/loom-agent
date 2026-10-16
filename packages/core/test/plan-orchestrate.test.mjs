/**
 * Plan 编排的回归测试。
 *
 * 重点不是"跑完没报错"，而是有依赖的编排真的按批跑、上游结论真的流到下游、
 * 上游挂了真的不再烧 token、失败真的重试。所以大部分用例用**假 runner**
 * 直接把调度器当纯函数测，只有最后两个用真 mock 模型端到端跑。
 */

import assert from "node:assert/strict";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";

import {
  chainDemoWorkers,
  defaultDemoWorkers,
  PlanDependencyError,
  runParallelPlan,
  runPlanScheduler,
  topoBatches,
  workersForPlanPreset,
  workersForPlanPresetAuto,
} from "../dist/index.js";

/** 按 workers 造一个和它等长的 Plan（调度器要求数量一致） */
function planFor(workers) {
  return {
    id: "plan-test",
    goal: "测试目标",
    createdAt: Date.now(),
    steps: workers.map((w, i) => ({
      id: `s${i}`,
      title: w.title,
      goal: w.goal,
      agentId: w.agentId,
      modelId: w.modelId,
      status: "pending",
    })),
  };
}

const W = (title, dependsOn) => ({
  title,
  agentId: "reader",
  modelId: "mock-local",
  goal: `做 ${title}`,
  ...(dependsOn ? { dependsOn } : {}),
});

// ---------------------------------------------------------------- 拓扑分层

test("topoBatches：链式依赖 → 每一步一批", () => {
  const batches = topoBatches([W("A"), W("B", [0]), W("C", [1])]);
  assert.deepEqual(batches, [[0], [1], [2]]);
});

test("topoBatches：钻石依赖 → 中间两个同批并行", () => {
  // A → (B, C) → D
  const batches = topoBatches([
    W("A"),
    W("B", [0]),
    W("C", [0]),
    W("D", [1, 2]),
  ]);
  assert.deepEqual(batches, [[0], [1, 2], [3]]);
});

test("topoBatches：全无依赖 → 一批跑完", () => {
  assert.deepEqual(topoBatches([W("A"), W("B"), W("C")]), [[0, 1, 2]]);
});

test("topoBatches：成环 → PlanDependencyError 点名绕不出来", () => {
  assert.throws(
    () => topoBatches([W("A", [1]), W("B", [0])]),
    (err) => {
      assert.ok(err instanceof PlanDependencyError);
      assert.match(err.message, /成环/);
      assert.match(err.message, /W1/);
      assert.match(err.message, /W2/);
      return true;
    },
  );
});

test("topoBatches：越界 / 依赖自己 / 非整数 → 跑之前就炸", () => {
  assert.throws(() => topoBatches([W("A", [5])]), /只有 1 个 Worker/);
  assert.throws(() => topoBatches([W("A", [0])]), /依赖了自己/);
  assert.throws(() => topoBatches([W("A", [0.5])]), /不是整数下标/);
  assert.throws(() => topoBatches([W("A", ["0"])]), /不是整数下标/);
});

// ---------------------------------------------------------------- 调度器

test("调度器：批间串行、同批并行（用时间线验证，不看实现）", async () => {
  const workers = [W("A"), W("B"), W("C", [0])];
  const events = [];
  const { batches } = await runPlanScheduler({
    plan: planFor(workers),
    workers,
    retryDelayMs: 0,
    run: async ({ step }) => {
      events.push(`start:${step.title}`);
      await new Promise((r) => setTimeout(r, 20));
      events.push(`end:${step.title}`);
      return `${step.title} 的结论`;
    },
  });

  assert.deepEqual(
    batches.map((b) => b.stepIds.length),
    [2, 1],
  );
  // A、B 同一批：两个 start 都排在任意 end 之前
  const firstEnd = events.findIndex((e) => e.startsWith("end:"));
  const startsBefore = events.slice(0, firstEnd).filter((e) => e.startsWith("start:"));
  assert.equal(startsBefore.length, 2);
  // C 必须等 A 结束（A 是 C 的直接上游）
  assert.ok(events.indexOf("start:C") > events.indexOf("end:A"));
});

test("调度器：上游结论摘要真的拼进下游（带上限）", async () => {
  const workers = [W("A"), W("B", [0])];
  const long = "甲".repeat(600);
  const seen = {};
  const { texts } = await runPlanScheduler({
    plan: planFor(workers),
    workers,
    retryDelayMs: 0,
    run: async ({ step, upstream }) => {
      seen[step.title] = upstream;
      return step.title === "A" ? long : "B 的结论";
    },
  });

  assert.equal(seen.A, ""); // 没有上游
  assert.match(seen.B, /\[上游 A 的结论\]/);
  // 单条上限 400 字符，600 字的结论必须被截断
  assert.ok(seen.B.includes("甲".repeat(400)));
  assert.ok(!seen.B.includes("甲".repeat(401)));
  assert.equal(texts.get("s0"), long);
});

test("调度器：passUpstreamResults=false → 下游拿不到上游", async () => {
  const workers = [W("A"), W("B", [0])];
  const seen = {};
  await runPlanScheduler({
    plan: planFor(workers),
    workers,
    retryDelayMs: 0,
    passUpstreamResults: false,
    run: async ({ step, upstream }) => {
      seen[step.title] = upstream;
      return "ok";
    },
  });
  assert.equal(seen.B, "");
});

test("调度器：失败重试到成功，attempts 记在 step 上", async () => {
  const workers = [W("A")];
  const plan = planFor(workers);
  let calls = 0;
  const { batches } = await runPlanScheduler({
    plan,
    workers,
    maxRetries: 2,
    retryDelayMs: 0,
    run: async () => {
      calls += 1;
      if (calls < 3) throw new Error(`第 ${calls} 次炸了`);
      return "第三次成功";
    },
  });
  assert.equal(calls, 3);
  assert.equal(plan.steps[0].status, "done");
  assert.equal(plan.steps[0].attempts, 3);
  assert.equal(plan.steps[0].resultPreview, "第三次成功");
  assert.equal(batches.length, 1);
});

test("调度器：maxRetries=0 → 一次就失败，不再重试", async () => {
  const workers = [W("A")];
  const plan = planFor(workers);
  let calls = 0;
  await runPlanScheduler({
    plan,
    workers,
    maxRetries: 0,
    retryDelayMs: 0,
    run: async () => {
      calls += 1;
      throw new Error("就是不行");
    },
  });
  assert.equal(calls, 1);
  assert.equal(plan.steps[0].status, "failed");
  assert.equal(plan.steps[0].attempts, 1);
  assert.match(plan.steps[0].error, /就是不行/);
});

test("调度器：上游失败 → 下游 skipped 且一次都不跑", async () => {
  const workers = [W("A"), W("B", [0]), W("C", [1])];
  const plan = planFor(workers);
  const ran = [];
  await runPlanScheduler({
    plan,
    workers,
    maxRetries: 0,
    retryDelayMs: 0,
    run: async ({ step }) => {
      ran.push(step.title);
      throw new Error("A 挂了");
    },
  });

  assert.deepEqual(ran, ["A"]); // B、C 根本没跑
  assert.equal(plan.steps[0].status, "failed");
  assert.equal(plan.steps[1].status, "skipped");
  assert.equal(plan.steps[2].status, "skipped");
  assert.match(plan.steps[1].error, /上游没成功/);
  assert.equal(plan.steps[1].attempts, undefined);
});

test("调度器：取消 → 已发出去的那批标 cancelled，后面不跑", async () => {
  const workers = [W("A"), W("B", [0])];
  const plan = planFor(workers);
  const ctrl = new AbortController();
  await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    signal: ctrl.signal,
    run: async () => {
      ctrl.abort();
      throw new Error("被中断了");
    },
  });
  assert.equal(plan.steps[0].status, "cancelled");
  assert.equal(plan.steps[1].status, "cancelled");
});

test("调度器：step 上带着批次号和上游 step id（给 UI 看的）", async () => {
  const workers = [W("A"), W("B", [0])];
  const plan = planFor(workers);
  await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    run: async () => "ok",
  });
  assert.equal(plan.steps[0].batch, 0);
  assert.equal(plan.steps[0].dependsOnIds.length, 0);
  assert.equal(plan.steps[1].batch, 1);
  assert.deepEqual(plan.steps[1].dependsOnIds, ["s0"]);
});

// ---------------------------------------------------------------- 端到端

test("runParallelPlan：链式预设跑通，批次 1→1→1，merged 带状态行", async () => {
  const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loom-plan-"));
  const skillsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loom-skills-"));
  const workers = chainDemoWorkers("验证编排");
  try {
    const { plan, merged, batches } = await runParallelPlan({
      workspaceRoot,
      goal: "验证编排",
      skillsRoot,
      workers,
      maxRetries: 0,
    });

    assert.deepEqual(
      batches.map((b) => b.stepIds.length),
      [1, 1, 1],
    );
    assert.equal(plan.steps.length, 3);
    assert.equal(plan.steps[0].status, "done");
    // 串行链：下游依赖上游，全部成功
    assert.equal(plan.steps[1].status, "done");
    assert.equal(plan.steps[2].status, "done");
    assert.match(merged, /批次：1 → 1 → 1/);
    assert.match(merged, /## C1 · 结构/);
    // C3 是 editor + write_file 剧本，必然产生一个待审批写入
    assert.ok(plan.steps[2].resultPreview.length > 0);
  } finally {
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
    await fsp.rm(skillsRoot, { recursive: true, force: true });
  }
});

test("runParallelPlan：异构预设 + 同批并行，写文件进 pendingWrites", async () => {
  const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loom-plan-"));
  const skillsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loom-skills-"));
  try {
    const { plan, batches, pendingWrites } = await runParallelPlan({
      workspaceRoot,
      goal: "验证 HITL",
      skillsRoot,
      workers: workersForPlanPreset("hetero", "验证 HITL"),
      maxRetries: 0,
    });
    assert.equal(batches.length, 1);
    assert.equal(batches[0].stepIds.length, 2);
    assert.equal(pendingWrites.length, 1);
    assert.match(pendingWrites[0].path, /notes/);
    assert.ok(plan.steps.every((s) => s.status === "done"));
  } finally {
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
    await fsp.rm(skillsRoot, { recursive: true, force: true });
  }
});

test("预设工厂：chain 在 mock 与真模型两条路上都带对依赖", () => {
  const mock = workersForPlanPreset("chain", "目标");
  assert.equal(mock.length, 3);
  assert.equal(mock[0].dependsOn, undefined);
  assert.deepEqual(mock[1].dependsOn, [0]);
  assert.deepEqual(mock[2].dependsOn, [1]);
  // 每一批都只有一步：这是"流水线"而不是"扇出"
  assert.equal(topoBatches(mock).length, 3);

  const real = workersForPlanPresetAuto(
    "chain",
    "目标",
    { reader: "deepseek-chat", auditor: "deepseek-chat", editor: "deepseek-chat" },
  );
  assert.deepEqual(real.map((w) => w.dependsOn), [undefined, [0], [1]]);
  assert.equal(topoBatches(real).length, 3);

  // 默认预设仍是同批并行，不会被这次改动带歪
  const homo = workersForPlanPreset("homo", "目标");
  assert.equal(topoBatches(homo).length, 1);
  assert.equal(defaultDemoWorkers("目标").length, 2);
});
