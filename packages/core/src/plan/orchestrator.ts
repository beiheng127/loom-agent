import { nanoid } from "nanoid";
import { resolveAgent } from "../agents/store.js";
import { runAgentLoop } from "../loop/run.js";
import { getModelConfig } from "../models/registry.js";
import { loadSkillsFromDir } from "../skills/loader.js";
import { listAllSkills } from "../skills/store.js";
import type {
  MockScenario,
  Plan,
  PlanStep,
  SkillMeta,
} from "../types/index.js";

export type PlanWorkerDef = {
  agentId: string;
  modelId: string;
  title: string;
  goal: string;
  mockScenario?: MockScenario;
  /**
   * 依赖哪些 Worker（**下标**，0 基，指向同一个 workers 数组）。
   * 不填 = 第一批并行跑；填了 = 等上游跑完再跑，且上游结论摘要会拼进本步的 goal。
   */
  dependsOn?: number[];
  /**
   * best-of-N：同一个目标并行跑 N 个候选，再由 `judge` 挑一个。默认 1（不择优）。
   * 注意这是**烧 N 倍 token 换质量**的开关，不是默认值。
   */
  bestOf?: number;
};

export type RunPlanInput = {
  workspaceRoot: string;
  goal: string;
  workers: PlanWorkerDef[];
  skillsRoot: string;
  /** 用户自定义 Skills 目录（与内置合并） */
  customSkillsRoot?: string;
  /** 自定义 Agent 存储路径 */
  agentStorePath?: string;
  /** 每个 Worker 失败后的额外重试次数（默认 1 → 最多跑 2 次） */
  maxRetries?: number;
  /** 重试间隔（毫秒，默认 150；测试里传 0） */
  retryDelayMs?: number;
  /** 默认 true：把直接上游的结论摘要拼进下游 goal（真编排的「数据流」） */
  passUpstreamResults?: boolean;
  /**
   * **同批最多同时跑几个**（默认 0 = 不限）。
   * 一批 8 个候选全开会把 API 打爆 / 触发限流，这个闸门就是给"并发"设上限的。
   */
  maxConcurrency?: number;
  /**
   * **失败重规划**：某个 Worker 重试也失败时，请 LLM 重新拆剩下没跑的步（默认 false）。
   * 会烧 token，所以要显式打开。传 `replan` 回调就自动打开。
   */
  replan?: PlanReplanner;
  /** 最多重规划几次（默认 1；到顶就不再问，剩下的照旧跳过） */
  maxReplans?: number;
  /** best-of-N 的裁判；不传 = 用了 bestOf 也退回第 1 个候选 */
  judge?: PlanJudge;
  signal?: AbortSignal;
  onStep?: (step: PlanStep) => void;
};

/** 一批并行执行的 Worker（按下标） */
export type PlanBatchIndex = number[];

export type PlanBatch = { index: number; stepIds: string[] };

/**
 * 失败重规划：某步重试也失败时，让它重新给出**剩下没跑的步骤**。
 *
 * 为什么回调而不是内置：内置就要在 core 里硬编码一个模型调用 + prompt，
 * 测试和离线场景都会被拖下水。回调让你想接 LLM 就接，想用假数据测编排也行。
 *
 * 返回的 Worker 只替换**未开始**的那些步（已 done / failed 的原地保留），
 * 返回的依赖下标按新数组算。返回 null = 放弃重规划，剩下步照旧跳过。
 */
export type PlanReplanner = (input: {
  goal: string;
  /** 失败的那一步 */
  failed: PlanWorkerDef;
  failedIndex: number;
  error: string;
  /** 当前整份 Worker 列表（含已跑完的） */
  workers: PlanWorkerDef[];
  /**
   * 只重排这些下标（还没开始跑的），返回的新数组按这个顺序补齐。
   * 数量对不上 → 整个重规划作废（宁可照旧跳过，也别跑一份乱的）。
   */
  remaining: number[];
}) => Promise<PlanWorkerDef[] | null>;

/** 依赖写歪了（成环 / 越界 / 依赖自己）时抛这个，信息里点名是哪几个 Worker */
export class PlanDependencyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanDependencyError";
  }
}

/**
 * 把 `dependsOn` 洗成可信的下标数组：
 * 越界、依赖自己、非整数一律抛错（宁可在跑之前炸，也别跑到一半发现编排是错的）。
 */
function normalizeDeps(
  deps: number[] | undefined,
  self: number,
  total: number,
  workers: PlanWorkerDef[],
): number[] {
  if (deps === undefined || deps === null) return [];
  if (!Array.isArray(deps)) {
    throw new PlanDependencyError(`Worker ${self + 1} 的 dependsOn 不是数组`);
  }
  const out: number[] = [];
  for (const raw of deps) {
    if (!Number.isInteger(raw)) {
      throw new PlanDependencyError(
        `Worker ${self + 1} 的依赖 ${JSON.stringify(raw)} 不是整数下标`,
      );
    }
    if (raw < 0 || raw >= total) {
      throw new PlanDependencyError(
        `Worker ${self + 1} 依赖下标 ${raw}，但只有 ${total} 个 Worker（下标 0..${total - 1}）`,
      );
    }
    if (raw === self) {
      throw new PlanDependencyError(
        `Worker ${self + 1}「${workers[self]?.title ?? ""}」依赖了自己`,
      );
    }
    if (!out.includes(raw)) out.push(raw);
  }
  return out.sort((a, b) => a - b);
}

function normalizeAllDeps(workers: PlanWorkerDef[]): number[][] {
  return workers.map((w, i) => normalizeDeps(w.dependsOn, i, workers.length, workers));
}

const label = (workers: PlanWorkerDef[], i: number) =>
  `W${i + 1}「${workers[i]?.title ?? ""}」`;

/**
 * 分层核心：同层并行、层间串行。成环直接抛 PlanDependencyError。
 *
 * 单独拎出来是因为重规划会改图——改完要拿**已洗好的依赖**重算剩余层级，
 * 再走一遍 `normalizeAllDeps` 的报错路径就绕远了。
 */
function topoLayers(
  deps: number[][],
  workers: PlanWorkerDef[],
): PlanBatchIndex[] {
  const remaining = new Set(deps.map((_, i) => i));
  const out: PlanBatchIndex[] = [];
  while (remaining.size > 0) {
    const layer = [...remaining].filter((i) =>
      deps[i]!.every((d) => !remaining.has(d)),
    );
    if (layer.length === 0) {
      const stuck = [...remaining].map((i) => label(workers, i)).join(" → ");
      throw new PlanDependencyError(`Plan 依赖成环，绕不出来：${stuck}`);
    }
    out.push(layer.sort((a, b) => a - b));
    for (const i of layer) remaining.delete(i);
  }
  return out;
}

/** 按依赖分层：同层并行、层间串行。成环直接抛 PlanDependencyError */
export function topoBatches(workers: PlanWorkerDef[]): PlanBatchIndex[] {
  return topoLayers(normalizeAllDeps(workers), workers);
}

export type PlanStepRunner = (input: {
  step: PlanStep;
  /** 这个 step 在 workers 里的下标 */
  index: number;
  /** 第几次尝试（1 起） */
  attempt: number;
  /** 直接上游的结论摘要（没开或没上游时是空串） */
  upstream: string;
}) => Promise<string>;

/**
 * best-of-N 的裁判：从 N 个候选结论里挑一个，返回**所选候选的下标**。
 * 返回越界值 / 负数 → 退回第 0 个，并在 step.error 里写明。
 * 回调抛错 → 那一步按"择优失败"处理，退回第 0 个候选（跑出来的东西不扔，只是没挑）。
 */
export type PlanJudge = (input: {
  step: PlanStep;
  /** 这一步的目标 */
  goal: string;
  /** N 个候选结论，与下标一一对应 */
  candidates: string[];
}) => Promise<number> | number;

/** 单条上游结论最多带多少字符，全部上游合计最多多少（别把下游 prompt 撑爆） */
const DIGEST_PER_DEP = 400;
const DIGEST_TOTAL = 1200;

function upstreamDigest(
  deps: number[],
  plan: Plan,
  texts: Map<string, string>,
): string {
  const parts: string[] = [];
  let total = 0;
  for (const d of deps) {
    const step = plan.steps[d];
    if (!step) continue;
    const text = texts.get(step.id);
    if (!text) continue;
    const chunk = `[上游 ${step.title} 的结论]\n${text.trim().slice(0, DIGEST_PER_DEP)}`;
    if (total + chunk.length > DIGEST_TOTAL) break;
    parts.push(chunk);
    total += chunk.length;
  }
  return parts.join("\n\n");
}

const sleep = (ms: number) =>
  ms <= 0 ? Promise.resolve() : new Promise((r) => setTimeout(r, ms));

/**
 * 有上限的并发 map：`limit <= 0` 时退化成 `Promise.all`（不限流），
 * 否则同一时刻最多 `limit` 个在跑，跑完一个补一个。
 *
 * 为什么不用 `Promise.all(items.map(...))` 了事：best-of-N 一下开 8 个候选，
 * 或者一批 20 个 Worker，全开会把 API 打爆。**并发上限是真编排的一部分**。
 */
export async function mapWithConcurrency<T>(
  items: number[],
  limit: number,
  fn: (i: number) => Promise<T>,
): Promise<void> {
  if (limit <= 0 || items.length <= limit) {
    await Promise.all(items.map((i) => fn(i)));
    return;
  }
  const queue = [...items];
  let active = 0;
  await new Promise<void>((resolve) => {
    const kick = () => {
      while (active < limit && queue.length > 0) {
        const i = queue.shift()!;
        active += 1;
        // 单步失败由调用方记在 step 上（重试 / skipped），这里只保证闸门继续放行
        fn(i)
          .catch(() => undefined)
          .finally(() => {
            active -= 1;
            kick();
            if (active === 0 && queue.length === 0) resolve();
          });
      }
      if (active === 0 && queue.length === 0) resolve();
    };
    kick();
  });
}

/**
 * Plan 调度器：**这里才是「编排」**，run 回调只负责「怎么跑一步」。
 *
 * 1. 按依赖分批：同批并行、批间串行（每批开始时才算下一批，方便重规划改图）
 * 2. 上游失败/跳过/取消 → 下游直接 `skipped`，不浪费 token
 * 3. 失败的步按 maxRetries 重试（attempts 记在 step 上）
 * 4. 开关打开时把上游结论摘要拼进下游的 `upstream`（数据流，不是各跑各的）
 * 5. `bestOf > 1` 的步并行跑 N 个候选再交给 `judge` 挑一个
 * 6. 重试也失败的步，若给了 `replan`，让它重排剩下没跑的步，然后接着调度
 * 7. signal 中断 → 剩余步骤标 cancelled
 *
 * 跟执行解耦是为了能拿假 runner 单测编排本身（拓扑/跳过/重试/取消/择优/重规划）。
 *
 * 注意：重规划是**就地改写你传进来的 workers 数组**（下标一一对应），
 * 这样执行侧按 `workers[index]` 取工具/剧本时能自动看到新的那一步。
 */
export async function runPlanScheduler(input: {
  plan: Plan;
  workers: PlanWorkerDef[];
  run: PlanStepRunner;
  maxRetries?: number;
  retryDelayMs?: number;
  passUpstreamResults?: boolean;
  maxConcurrency?: number;
  replan?: PlanReplanner;
  /** 最多重规划几次（默认 1；到顶就不再问，剩下的照旧跳过） */
  maxReplans?: number;
  /** best-of-N 的裁判；不传 = 用了 bestOf 也退回第 1 个候选 */
  judge?: PlanJudge;
  onStep?: (step: PlanStep) => void;
  signal?: AbortSignal;
}): Promise<{ batches: PlanBatch[]; texts: Map<string, string> }> {
  const { plan, workers, run, onStep } = input;
  if (plan.steps.length !== workers.length) {
    throw new Error(
      `Plan 的 steps(${plan.steps.length}) 与 workers(${workers.length}) 数量不一致`,
    );
  }
  const maxRetries = Math.max(0, input.maxRetries ?? 1);
  const retryDelayMs = Math.max(0, input.retryDelayMs ?? 150);
  const maxConcurrency = Math.max(0, input.maxConcurrency ?? 0);
  const passUpstream = input.passUpstreamResults !== false;
  const judge = input.judge;

  /** 重规划要能改 workers 和依赖，所以这两份是「当前真相」，可写 */
  let activeWorkers: PlanWorkerDef[] = workers;
  let deps = normalizeAllDeps(workers);
  /** 重规划过的次数（记在 plan 上给 UI 看，也防无限重规划） */
  let replans = 0;
  const maxReplans = Math.max(1, input.maxReplans ?? 1);
  const levels = topoLayers(deps, activeWorkers);
  const texts = new Map<string, string>();
  const batches: PlanBatch[] = [];
  let done = new Set<number>();
  let cursor = 0;

  const runOne = async (i: number): Promise<void> => {
    const step = plan.steps[i]!;
    const dependsOn = deps[i]!;

    const broken = dependsOn.filter((d) => {
      const status = plan.steps[d]!.status;
      return status === "failed" || status === "skipped" || status === "cancelled";
    });
    if (broken.length > 0) {
      step.status = "skipped";
      step.error = `上游没成功，跳过不跑：${broken
        .map((d) => plan.steps[d]!.title)
        .join("、")}`;
      step.endedAt = Date.now();
      onStep?.(step);
      return;
    }
    if (input.signal?.aborted) {
      step.status = "cancelled";
      step.error = "已取消";
      onStep?.(step);
      return;
    }

    const upstream = passUpstream ? upstreamDigest(dependsOn, plan, texts) : "";
    const attemptsMax = maxRetries + 1;
    const bestOf = Math.max(1, Math.floor(activeWorkers[i]!.bestOf ?? 1));
    step.candidates = bestOf;

    for (let attempt = 1; attempt <= attemptsMax; attempt += 1) {
      step.attempts = attempt;
      step.status = "running";
      step.startedAt = step.startedAt ?? Date.now();
      step.error = undefined;
      onStep?.(step);
      try {
        const text =
          bestOf > 1
            ? await runBestOfN({ i, step, bestOf, upstream })
            : await run({ step, index: i, attempt, upstream });
        texts.set(step.id, text);
        step.status = "done";
        step.resultPreview = text.slice(0, 400);
        step.endedAt = Date.now();
        onStep?.(step);
        return;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const aborted = input.signal?.aborted === true;
        if (attempt < attemptsMax && !aborted) {
          step.error = `第 ${attempt} 次失败，准备重试：${message}`;
          onStep?.(step);
          await sleep(retryDelayMs);
          continue;
        }
        step.status = aborted ? "cancelled" : "failed";
        step.error = message;
        step.endedAt = Date.now();
        onStep?.(step);
        return;
      }
    }
  };

  /** best-of-N：并行跑 N 个候选（也过并发闸门），再由 judge 挑一个 */
  const runBestOfN = async (args: {
    i: number;
    step: PlanStep;
    bestOf: number;
    upstream: string;
  }): Promise<string> => {
    const { i, step, bestOf, upstream } = args;
    const slots = Array.from({ length: bestOf }, (_, k) => k);
    const candidates: string[] = new Array(bestOf).fill("");
    const errors: string[] = new Array(bestOf).fill("");

    await mapWithConcurrency(slots, maxConcurrency, async (k) => {
      try {
        candidates[k] = await run({ step, index: i, attempt: k + 1, upstream });
      } catch (err) {
        errors[k] = err instanceof Error ? err.message : String(err);
      }
    });

    const ok = candidates
      .map((c, k) => ({ k, c }))
      .filter((x) => x.c.length > 0 || errors[x.k] === "");
    if (ok.length === 0) {
      throw new Error(
        `best-of-${bestOf} 全部失败：${errors.map((e, k) => `#${k + 1} ${e}`).join(" | ")}`,
      );
    }
    // 失败的候选留空串会让裁判瞎挑，索性只把跑出来的交给它
    const pooled = ok.map((x) => x.c);
    let picked = 0;
    /** 只有裁判真的挑过才写 selectedCandidate——不然「跑了 N 个」会被读成「择优成功」 */
    let judged = false;
    if (judge && pooled.length > 1) {
      try {
        const raw = await judge({ step, goal: step.goal, candidates: pooled });
        judged = true;
        picked = Number.isInteger(raw) ? raw : 0;
        if (picked < 0 || picked >= pooled.length) {
          step.error = `择优给了越界下标 ${picked}（共 ${pooled.length} 个候选），退回第 1 个`;
          picked = 0;
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        step.error = `择优失败，退回第 1 个候选：${message}`;
        picked = 0;
      }
    } else if (pooled.length < bestOf) {
      step.error = `${bestOf} 个候选里只跑出 ${pooled.length} 个（其余失败），用跑出来的第 1 个`;
    } else if (bestOf > 1 && !judge) {
      step.error = `跑了 ${bestOf} 个候选但没接裁判（judge），默认取第 1 个`;
    }
    if (judged) step.selectedCandidate = picked;
    return pooled[picked] ?? "";
  };

  /** 重规划：把「还没开始」的步交给回调重写，并就地改 workers / deps */
  const tryReplan = async (failedIndex: number): Promise<boolean> => {
    if (!input.replan || replans >= maxReplans) return false;
    const remaining = activeWorkers
      .map((_, i) => i)
      .filter((i) => !done.has(i) && plan.steps[i]!.status === "pending");
    if (remaining.length === 0) return false;

    replans += 1;
    let next: PlanWorkerDef[] | null = null;
    try {
      next = await input.replan({
        goal: plan.goal,
        failed: activeWorkers[failedIndex]!,
        failedIndex,
        error: plan.steps[failedIndex]!.error ?? "未知错误",
        workers: activeWorkers,
        remaining,
      });
    } catch (err) {
      next = null;
      const message = err instanceof Error ? err.message : String(err);
      plan.steps[failedIndex]!.error = `重规划回调自己炸了：${message}`;
    }
    if (!next || next.length !== remaining.length) {
      // 数量对不上就作废，宁可照旧跳过，也别跑一份和 steps 对不上的编排
      return false;
    }
    for (const [slot, i] of remaining.entries()) {
      activeWorkers[i] = next[slot]!;
      const step = plan.steps[i]!;
      step.title = next[slot]!.title;
      step.goal = next[slot]!.goal;
      step.agentId = next[slot]!.agentId;
      step.modelId = next[slot]!.modelId;
    }
    deps = normalizeAllDeps(activeWorkers);
    return true;
  };

  while (cursor < levels.length) {
    const level = levels[cursor]!;
    cursor += 1;
    batches.push({
      index: batches.length,
      stepIds: level.map((i) => plan.steps[i]!.id),
    });

    for (const i of level) {
      const step = plan.steps[i]!;
      step.batch = batches.length - 1;
      step.dependsOnIds = deps[i]!.map((d) => plan.steps[d]!.id);
    }

    if (input.signal?.aborted) {
      for (const i of level) {
        const step = plan.steps[i]!;
        step.status = "cancelled";
        step.error = "已取消（这一批没开始跑）";
        step.endedAt = Date.now();
        onStep?.(step);
        done.add(i);
      }
      continue;
    }

    await mapWithConcurrency(level, maxConcurrency, runOne);
    for (const i of level) done.add(i);

    // 这一批里若有步彻底失败，先问重规划；改了图就重算剩余层级
    const failed = level.find((i) => plan.steps[i]!.status === "failed");
    if (failed !== undefined) {
      const changed = await tryReplan(failed);
      if (changed) {
        // 重算层级，但只留没跑过的下标——改图后层级里可能夹着已完成的步，重跑就重复烧 token
        const rest = topoLayers(deps, activeWorkers)
          .map((layer) => layer.filter((i) => !done.has(i)))
          .filter((layer) => layer.length > 0);
        levels.splice(cursor, levels.length - cursor, ...rest);
        continue;
      }
    }
  }

  // 重规划改图后可能漏掉个别步（依赖没连上 / 层级重算尾巴），兜底标跳过别留 pending
  for (let i = 0; i < plan.steps.length; i += 1) {
    const step = plan.steps[i]!;
    if (step.status === "pending" || step.status === "running") {
      step.status = "skipped";
      step.error = step.error ?? "编排结束后仍未执行（上游失败或重规划未覆盖到）";
      step.endedAt = Date.now();
      onStep?.(step);
    }
  }

  return { batches, texts };
}

/**
 * 多 Worker 执行计划：
 * 1. 构造 Plan Board 步骤
 * 2. 交给 `runPlanScheduler`（按依赖分批 + 失败重试 + 上游摘要下沉）
 * 3. 汇总结果
 */
export async function runParallelPlan(input: RunPlanInput): Promise<{
  plan: Plan;
  merged: string;
  pendingWrites: Array<{ path: string; content: string; stepId: string }>;
  batches: PlanBatch[];
}> {
  const skills: SkillMeta[] = input.customSkillsRoot
    ? await listAllSkills(input.skillsRoot, input.customSkillsRoot)
    : await loadSkillsFromDir(input.skillsRoot);
  const plan: Plan = {
    id: nanoid(),
    goal: input.goal,
    createdAt: Date.now(),
    steps: input.workers.map((w) => ({
      id: nanoid(),
      title: w.title,
      goal: w.goal,
      agentId: w.agentId,
      modelId: w.modelId,
      status: "pending" as const,
    })),
  };

  const pendingWrites: Array<{ path: string; content: string; stepId: string }> =
    [];

  const { batches, texts } = await runPlanScheduler({
    plan,
    workers: input.workers,
    maxRetries: input.maxRetries,
    retryDelayMs: input.retryDelayMs,
    passUpstreamResults: input.passUpstreamResults,
    maxConcurrency: input.maxConcurrency,
    replan: input.replan,
    maxReplans: input.maxReplans,
    judge: input.judge,
    signal: input.signal,
    onStep: input.onStep,
    run: ({ step, index, upstream }) => {
      const worker = input.workers[index]!;
      return runAgentStep({
        step,
        worker,
        workspaceRoot: input.workspaceRoot,
        skills,
        agentStorePath: input.agentStorePath,
        signal: input.signal,
        goal: upstream ? `${step.goal}\n\n${upstream}` : step.goal,
        onPendingWrite: (w) => {
          pendingWrites.push({ ...w, stepId: step.id });
        },
      });
    },
  });

  const statusLine = (step: PlanStep): string => {
    const bits: string[] = [step.status];
    if (step.attempts !== undefined && step.attempts > 1) {
      bits.push(`重试 ${step.attempts - 1} 次`);
    }
    return bits.join(" · ");
  };

  const merged = [
    `# Plan ${plan.id}`,
    `目标：${plan.goal}`,
    `批次：${batches.map((b) => b.stepIds.length).join(" → ")}（同批并行，批间串行）`,
    "",
    ...plan.steps.map((step) => {
      const text = texts.get(step.id);
      const head = `## ${step.title} (${step.agentId} / ${step.modelId})`;
      const meta = [`状态：${statusLine(step)}`];
      if (step.candidates !== undefined && step.candidates > 1) {
        // 挑不出来的时候也要说清楚，别让人把「跑了 3 个」读成「择优成功」
        meta.push(
          step.selectedCandidate === undefined
            ? `择优：跑了 ${step.candidates} 个候选，没挑（默认取第 1 个）`
            : `择优：从 ${step.candidates} 个候选里选了第 ${(step.selectedCandidate ?? 0) + 1} 个`,
        );
      }
      if (step.error) meta.push(`原因：${step.error}`);
      return `${head}\n${meta.join("\n")}\n\n${text ?? "（未执行）"}`;
    }),
  ].join("\n");

  return { plan, merged, pendingWrites, batches };
}

/** 一步 = 跑一次 Agent 循环；状态/重试归调度器管，这里只管把活儿干完 */
async function runAgentStep(input: {
  step: PlanStep;
  worker: PlanWorkerDef;
  workspaceRoot: string;
  skills: SkillMeta[];
  agentStorePath?: string;
  signal?: AbortSignal;
  goal: string;
  onPendingWrite?: (w: { path: string; content: string }) => void;
}): Promise<string> {
  const { step, worker, workspaceRoot, skills, agentStorePath, signal, goal } =
    input;
  const agent = resolveAgent(step.agentId, agentStorePath);
  const model = getModelConfig(step.modelId);
  return runAgentLoop({
    workspaceRoot,
    agent,
    model,
    skills,
    goal,
    maxSteps: 5,
    signal,
    mockScenario: worker.mockScenario,
    onEvent: (e) => {
      if (e.type === "approval_needed") {
        input.onPendingWrite?.({ path: e.path, content: e.content });
      }
    },
  });
}

/** 同质双线程（都用 mock 探索，故事弱但稳） */
export function defaultDemoWorkers(goal: string): PlanWorkerDef[] {
  return [
    {
      agentId: "reader",
      modelId: "mock-local",
      title: "线程 A · 结构探索",
      goal: `探索工作区目录结构，服务总目标：${goal}`,
      mockScenario: "structure_focus",
    },
    {
      agentId: "reader",
      modelId: "mock-local",
      title: "线程 B · README 精读",
      goal: `阅读 README.md 并提炼要点，服务总目标：${goal}`,
      mockScenario: "readme_focus",
    },
  ];
}

/** 异构并行：只读探索 + 改码工提出写文件（HITL） */
export function heteroDemoWorkers(goal: string): PlanWorkerDef[] {
  return [
    {
      agentId: "reader",
      modelId: "mock-local",
      title: "Reader · 结构",
      goal: `列出目录与入口，服务：${goal}`,
      mockScenario: "structure_focus",
    },
    {
      agentId: "editor",
      modelId: "mock-editor",
      title: "Editor · 提议写入",
      goal: `为「${goal}」起草一份 notes 备忘并走 write_file 审批`,
      mockScenario: "write_hitl",
    },
  ];
}

/**
 * 串行流水线：结构 → 审计 → 纪要，后一步依赖前一步。
 * 这是「编排」和「扇出」的区别：批间有顺序，下游拿得到上游的结论。
 */
export function chainDemoWorkers(goal: string): PlanWorkerDef[] {
  return [
    {
      agentId: "reader",
      modelId: "mock-local",
      title: "C1 · 结构",
      goal: `列出目录与入口，服务：${goal}`,
      mockScenario: "structure_focus",
    },
    {
      agentId: "auditor",
      modelId: "mock-local",
      title: "C2 · 审计（依赖 C1）",
      goal: `在 C1 结论的基础上查风险痕迹，服务：${goal}`,
      dependsOn: [0],
      mockScenario: "grep_audit",
    },
    {
      agentId: "editor",
      modelId: "mock-editor",
      title: "C3 · 纪要（依赖 C2）",
      goal: `把 C1/C2 的结论写成一份 notes 备忘并走 write_file 审批：${goal}`,
      dependsOn: [1],
      mockScenario: "write_hitl",
    },
  ];
}
