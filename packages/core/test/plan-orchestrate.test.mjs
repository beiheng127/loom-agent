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

// ---------------------------------------------------------------- 并发闸门

test("并发闸门：maxConcurrency=0 表示不限（同批全部同时开跑）", async () => {
  const workers = [W("A"), W("B"), W("C"), W("D")];
  let live = 0;
  let peak = 0;
  await runPlanScheduler({
    plan: planFor(workers),
    workers,
    retryDelayMs: 0,
    maxConcurrency: 0,
    run: async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 25));
      live -= 1;
      return "ok";
    },
  });
  assert.equal(peak, 4);
});

test("并发闸门：maxConcurrency=2 → 同批峰值不超过 2，且全都跑完", async () => {
  const workers = [W("A"), W("B"), W("C"), W("D"), W("E")];
  const plan = planFor(workers);
  let live = 0;
  let peak = 0;
  await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    maxConcurrency: 2,
    run: async () => {
      live += 1;
      peak = Math.max(peak, live);
      await new Promise((r) => setTimeout(r, 20));
      live -= 1;
      return "ok";
    },
  });
  assert.equal(peak, 2);
  assert.ok(plan.steps.every((s) => s.status === "done"));
});

test("并发闸门：某一步失败不会把整批卡死（闸门继续放行）", async () => {
  const workers = [W("A"), W("B"), W("C")];
  const plan = planFor(workers);
  await runPlanScheduler({
    plan,
    workers,
    maxRetries: 0,
    retryDelayMs: 0,
    maxConcurrency: 1,
    run: async ({ step }) => {
      if (step.title === "B") throw new Error("B 炸了");
      return "ok";
    },
  });
  assert.equal(plan.steps[0].status, "done");
  assert.equal(plan.steps[1].status, "failed");
  assert.equal(plan.steps[2].status, "done");
});

// ---------------------------------------------------------------- best-of-N

test("best-of-N：跑满 N 个候选，judge 挑中的那个成为最终结论", async () => {
  const workers = [{ ...W("A"), bestOf: 3 }];
  const plan = planFor(workers);
  const calls = [];
  const { texts } = await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    judge: ({ candidates }) => {
      // 专挑最长的那个，验证「结论真的来自被选中的候选」
      return candidates.reduce(
        (best, c, k) => (c.length > candidates[best].length ? k : best),
        0,
      );
    },
    run: async ({ attempt }) => {
      calls.push(attempt);
      return "候选".repeat(attempt); // 第 1 个最短，第 3 个最长
    },
  });
  assert.deepEqual(calls, [1, 2, 3]);
  assert.equal(plan.steps[0].status, "done");
  assert.equal(plan.steps[0].candidates, 3);
  assert.equal(plan.steps[0].selectedCandidate, 2);
  assert.equal(texts.get("s0"), "候选".repeat(3));
});

test("best-of-N：没传 judge → 退回第 1 个候选并在 error 里说清楚", async () => {
  const workers = [{ ...W("A"), bestOf: 2 }];
  const plan = planFor(workers);
  const { texts } = await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    run: async ({ attempt }) => `候选${attempt}`,
  });
  assert.equal(texts.get("s0"), "候选1");
  // 没裁判就不写 selectedCandidate：别让「跑了 2 个」被读成「择优成功」
  assert.equal(plan.steps[0].selectedCandidate, undefined);
  assert.match(plan.steps[0].error, /没接裁判/);
});

test("best-of-N：judge 越界 / 抛错 → 都退回第 1 个候选且写明原因", async () => {
  const mk = async (judge) => {
    const workers = [{ ...W("A"), bestOf: 3 }];
    const plan = planFor(workers);
    const { texts } = await runPlanScheduler({
      plan,
      workers,
      retryDelayMs: 0,
      judge,
      run: async ({ attempt }) => `候选${attempt}`,
    });
    return { text: texts.get("s0"), step: plan.steps[0] };
  };

  const bad = await mk(() => 99);
  assert.equal(bad.text, "候选1");
  assert.match(bad.step.error, /越界下标 99/);

  const boom = await mk(() => {
    throw new Error("裁判自己炸了");
  });
  assert.equal(boom.text, "候选1");
  assert.match(boom.step.error, /择优失败/);
});

test("best-of-N：候选全失败 → 整步 failed（不许拿空串当结论）", async () => {
  const workers = [{ ...W("A"), bestOf: 2 }];
  const plan = planFor(workers);
  await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    judge: () => 0,
    run: async () => {
      throw new Error("模型 500");
    },
  });
  assert.equal(plan.steps[0].status, "failed");
  assert.match(plan.steps[0].error, /模型 500/);
});

test("best-of-N：部分候选失败 → 用跑出来的那个，error 说明少了几份", async () => {
  const workers = [{ ...W("A"), bestOf: 3 }];
  const plan = planFor(workers);
  const { texts } = await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    run: async ({ attempt }) => {
      if (attempt === 1) throw new Error("限流");
      return `候选${attempt}`;
    },
  });
  assert.equal(plan.steps[0].status, "done");
  assert.equal(texts.get("s0"), "候选2");
  assert.match(plan.steps[0].error, /只跑出 2 个/);
});

test("best-of-N：bestOf=1 → 行为与不开完全一致（默认值不烧钱）", async () => {
  const workers = [{ ...W("A"), bestOf: 1 }];
  const plan = planFor(workers);
  let calls = 0;
  await runPlanScheduler({
    plan,
    workers,
    retryDelayMs: 0,
    judge: () => 0,
    run: async () => {
      calls += 1;
      return "ok";
    },
  });
  assert.equal(calls, 1);
  assert.equal(plan.steps[0].candidates, 1);
  assert.equal(plan.steps[0].selectedCandidate, undefined);
});

// ---------------------------------------------------------------- 失败重规划

/**
 * 注意：重规划只管**还没开始**的步。同批的步早就一起开跑了，改不动——
 * 所以下面这些用例都得用**链式依赖**（A → B → C），让 B/C 真的还在 pending。
 * 这不是实现偷懒：已经烧掉的 token 收不回来，重排只在"还没跑"的地方才有意义。
 */
test("重规划：上游彻底失败 → 还没跑的步被换掉并接着跑完", async () => {
  const workers = [W("A"), W("B", [0]), W("C", [1])];
  const plan = planFor(workers);
  const ran = [];
  await runPlanScheduler({
    plan,
    workers,
    maxRetries: 0,
    retryDelayMs: 0,
    replan: async ({ failed, failedIndex, remaining }) => {
      assert.equal(failedIndex, 0);
      assert.match(failed.title, /A/);
      assert.deepEqual(remaining, [1, 2]);
      // 关键：重排时把对失败步的依赖摘掉，剩下的才跑得下去
      return [W("B′"), { ...W("C′"), dependsOn: [1] }];
    },
    run: async ({ step }) => {
      ran.push(step.title);
      if (step.title === "A") throw new Error("A 真的不行");
      return `${step.title} 成了`;
    },
  });

  assert.deepEqual(ran, ["A", "B′", "C′"]);
  assert.equal(plan.steps[0].status, "failed");
  assert.equal(plan.steps[1].status, "done");
  assert.equal(plan.steps[2].status, "done");
  // 步的标题/目标被就地改写了（UI 看的是 step，不是 workers）
  assert.equal(plan.steps[1].title, "B′");
  assert.equal(plan.steps[2].title, "C′");
});

test("重规划：新步仍依赖失败步 → 照旧 skipped（重规划不豁免上游失败）", async () => {
  const workers = [W("A"), W("B", [0])];
  const plan = planFor(workers);
  const ran = [];
  await runPlanScheduler({
    plan,
    workers,
    maxRetries: 0,
    retryDelayMs: 0,
    replan: async () => [{ ...W("B′"), dependsOn: [0] }],
    run: async ({ step }) => {
      ran.push(step.title);
      if (step.title === "A") throw new Error("A 挂了");
      return "ok";
    },
  });
  assert.deepEqual(ran, ["A"]);
  assert.equal(plan.steps[1].title, "B′");
  assert.equal(plan.steps[1].status, "skipped");
  assert.match(plan.steps[1].error, /上游没成功/);
});

test("重规划：同批的步已经在跑了 → 改不动，重规划不该被调用", async () => {
  const workers = [W("A"), W("B")];
  const plan = planFor(workers);
  let asked = 0;
  await runPlanScheduler({
    plan,
    workers,
    maxRetries: 0,
    retryDelayMs: 0,
    replan: async () => {
      asked += 1;
      return [];
    },
    run: async ({ step }) => {
      if (step.title === "A") throw new Error("A 挂了");
      return "ok";
    },
  });
  assert.equal(asked, 0); // 没有「还没开始」的步可重排
  assert.equal(plan.steps[1].status, "done"); // B 照原样跑完了
});

test("重规划：返回数量对不上 → 作废，剩下的照旧跳过", async () => {
  const workers = [W("A"), W("B", [0])];
  const plan = planFor(workers);
  await runPlanScheduler({
    plan,
    workers,
    maxRetries: 0,
    retryDelayMs: 0,
    replan: async () => [W("X"), W("Y"), W("Z")], // 要 1 个给了 3 个
    run: async ({ step }) => {
      if (step.title === "A") throw new Error("A 挂了");
      return "ok";
    },
  });
  assert.equal(plan.steps[1].title, "B"); // 没被改写
  assert.equal(plan.steps[1].status, "skipped");
});

test("重规划：回调自己抛错 → 记在失败步上，不连累别的步", async () => {
  const workers = [W("A"), W("B", [0])];
  const plan = planFor(workers);
  await runPlanScheduler({
    plan,
    workers,
    maxRetries: 0,
    retryDelayMs: 0,
    replan: async () => {
      throw new Error("replan 服务 500");
    },
    run: async () => {
      throw new Error("A 挂了");
    },
  });
  assert.equal(plan.steps[0].status, "failed");
  assert.match(plan.steps[0].error, /重规划回调自己炸了/);
});

test("重规划：maxReplans 到顶就不再问（默认 1 次）", async () => {
  const workers = [W("A"), W("B", [0]), W("C", [1])];
  const plan = planFor(workers);
  let asked = 0;
  await runPlanScheduler({
    plan,
    workers,
    maxRetries: 0,
    retryDelayMs: 0,
    replan: async () => {
      asked += 1;
      return [W(`B${asked}`), { ...W(`C${asked}`), dependsOn: [1] }];
    },
    run: async ({ step }) => {
      if (step.title === "A") throw new Error("A 挂了");
      if (step.title.startsWith("B")) throw new Error("换汤不换药");
      return "ok";
    },
  });
  assert.equal(asked, 1); // B1 再失败也不问第二次
  assert.equal(plan.steps[1].status, "failed");
  // C1 依赖 B1（failed）→ 跳过，不留 pending
  assert.equal(plan.steps[2].status, "skipped");
});

test("重规划：结束后不允许留 pending/running 的步", async () => {
  const workers = [W("A"), W("B", [0])];
  const plan = planFor(workers);
  await runPlanScheduler({
    plan,
    workers,
    maxRetries: 0,
    retryDelayMs: 0,
    replan: async () => null, // 明确放弃
    run: async ({ step }) => {
      if (step.title === "A") throw new Error("A 挂了");
      return "ok";
    },
  });
  assert.ok(
    plan.steps.every((s) => s.status !== "pending" && s.status !== "running"),
    `仍有待跑的步：${JSON.stringify(plan.steps.map((s) => s.status))}`,
  );
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

test("runParallelPlan：bestOf=2 + judge → merged 里写明挑了第几个候选", async () => {
  const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loom-plan-"));
  const skillsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loom-skills-"));
  const workers = defaultDemoWorkers("验证择优").map((w) => ({ ...w, bestOf: 2 }));
  try {
    const { plan, merged } = await runParallelPlan({
      workspaceRoot,
      goal: "验证择优",
      skillsRoot,
      workers,
      maxRetries: 0,
      judge: () => 1, // 专挑第 2 个候选，验证文案跟着走
    });
    assert.equal(plan.steps[0].candidates, 2);
    assert.equal(plan.steps[0].selectedCandidate, 1);
    assert.match(merged, /择优：从 2 个候选里选了第 2 个/);
  } finally {
    await fsp.rm(workspaceRoot, { recursive: true, force: true });
    await fsp.rm(skillsRoot, { recursive: true, force: true });
  }
});

test("runParallelPlan：bestOf=2 但没 judge → merged 写明「跑了 2 个候选，没挑」", async () => {
  const workspaceRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loom-plan-"));
  const skillsRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "loom-skills-"));
  const workers = defaultDemoWorkers("验证择优").map((w) => ({ ...w, bestOf: 2 }));
  try {
    const { plan, merged } = await runParallelPlan({
      workspaceRoot,
      goal: "验证择优",
      skillsRoot,
      workers,
      maxRetries: 0,
    });
    assert.equal(plan.steps[0].candidates, 2);
    assert.equal(plan.steps[0].selectedCandidate, undefined);
    assert.match(merged, /跑了 2 个候选，没挑/);
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
