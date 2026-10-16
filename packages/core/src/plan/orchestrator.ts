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
  signal?: AbortSignal;
  onStep?: (step: PlanStep) => void;
};

/** 一批并行执行的 Worker（按下标） */
export type PlanBatchIndex = number[];

export type PlanBatch = { index: number; stepIds: string[] };

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

/** 按依赖分层：同层并行、层间串行。成环直接抛 PlanDependencyError */
export function topoBatches(workers: PlanWorkerDef[]): PlanBatchIndex[] {
  const deps = normalizeAllDeps(workers);
  const remaining = new Set(deps.map((_, i) => i));
  const batches: PlanBatchIndex[] = [];
  while (remaining.size > 0) {
    const layer = [...remaining].filter((i) =>
      deps[i]!.every((d) => !remaining.has(d)),
    );
    if (layer.length === 0) {
      const stuck = [...remaining].map((i) => label(workers, i)).join(" → ");
      throw new PlanDependencyError(`Plan 依赖成环，绕不出来：${stuck}`);
    }
    batches.push(layer.sort((a, b) => a - b));
    for (const i of layer) remaining.delete(i);
  }
  return batches;
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
 * Plan 调度器：**这里才是「编排」**，run 回调只负责「怎么跑一步」。
 *
 * 1. 按依赖分批发（同批 `Promise.all` 并行，批间串行）
 * 2. 上游失败/跳过/取消 → 下游直接 `skipped`，不浪费 token
 * 3. 失败的步按 maxRetries 重试（attempts 记在 step 上）
 * 4. 开关打开时把上游结论摘要拼进下游的 `upstream`（数据流，不是各跑各的）
 * 5. signal 中断 → 剩余步骤标 cancelled
 *
 * 跟执行解耦是为了能拿假 runner 单测编排本身（拓扑/跳过/重试/取消）。
 */
export async function runPlanScheduler(input: {
  plan: Plan;
  workers: PlanWorkerDef[];
  run: PlanStepRunner;
  maxRetries?: number;
  retryDelayMs?: number;
  passUpstreamResults?: boolean;
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
  const passUpstream = input.passUpstreamResults !== false;

  const deps = normalizeAllDeps(workers);
  const levels = (() => {
    // topoBatches 自己会再洗一次依赖；这里复用已洗好的结果，少一次越界报错的重复路径
    const remaining = new Set(deps.map((_, i) => i));
    const out: PlanBatchIndex[] = [];
    while (remaining.size > 0) {
      const layer = [...remaining].filter((i) =>
        deps[i]!.every((d) => !remaining.has(d)),
      );
      if (layer.length === 0) {
        throw new PlanDependencyError(
          `Plan 依赖成环，绕不出来：${[...remaining]
            .map((i) => label(workers, i))
            .join(" → ")}`,
        );
      }
      out.push(layer.sort((a, b) => a - b));
      for (const i of layer) remaining.delete(i);
    }
    return out;
  })();

  const texts = new Map<string, string>();
  const batches: PlanBatch[] = [];

  for (const [batchIndex, level] of levels.entries()) {
    batches.push({
      index: batchIndex,
      stepIds: level.map((i) => plan.steps[i]!.id),
    });

    for (const i of level) {
      const step = plan.steps[i]!;
      step.batch = batchIndex;
      step.dependsOnIds = deps[i]!.map((d) => plan.steps[d]!.id);
    }

    if (input.signal?.aborted) {
      for (const i of level) {
        const step = plan.steps[i]!;
        step.status = "cancelled";
        step.error = "已取消（这一批没开始跑）";
        onStep?.(step);
      }
      continue;
    }

    await Promise.all(
      level.map(async (i) => {
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

        for (let attempt = 1; attempt <= attemptsMax; attempt += 1) {
          step.attempts = attempt;
          step.status = "running";
          step.startedAt = step.startedAt ?? Date.now();
          step.error = undefined;
          onStep?.(step);
          try {
            const text = await run({ step, index: i, attempt, upstream });
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
      }),
    );
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
