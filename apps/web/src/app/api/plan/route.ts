import {
  appendPlanRecord,
  BUILTIN_AGENTS,
  describePlannerResult,
  makePlannerJudge,
  makePlannerReplanner,
  planWorkers,
  PlanDependencyError,
  preferredComposerModelId,
  runParallelPlan,
  workersForPlanPreset,
  type Plan,
  type PlanBatch,
  type PlanStep,
  type PlanWorkerDef,
} from "@loom/core";
import {
  defaultAgentStore,
  defaultCustomSkillsRoot,
  defaultPlanStore,
  defaultSkillsRoot,
  defaultWorkspace,
} from "@/lib/paths";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    goal?: string;
    workspace?: string;
    preset?: "homo" | "hetero" | "triple" | "chain" | "custom";
    workers?: PlanWorkerDef[];
    /** false 时强制离线 mock workers */
    preferReal?: boolean;
    /** 每个 Worker 失败后的额外重试次数（0 = 不重试），默认 1 */
    maxRetries?: number;
    /** true = 先让模型把目标拆成 Worker（失败自动回落预设，不返回 500） */
    planner?: boolean;
    /** 规划用的模型 id；不给就用当前首选真模型 */
    plannerModelId?: string;
    /**
     * 同批最多同时跑几个（默认 0 = 不限）。一批 8 个全开会把 API 打爆。
     */
    maxConcurrency?: number;
    /**
     * 失败重规划：某步重试也挂了，让模型重排剩下没跑的步（要真模型，默认 false）。
     */
    replan?: boolean;
    /** best-of-N：每步跑几个候选再让模型挑（1 = 不择优，默认 1） */
    bestOf?: number;
  };
  const goal = (body.goal ?? "").trim() || "探索工作区并总结";
  const workspaceRoot = path.resolve(body.workspace || defaultWorkspace());
  const steps: PlanStep[] = [];
  const preset = body.preset ?? "homo";
  /** 真模型 id（拆步 / 择优 / 重规划共用）；没有真模型时这些开关一律不开 */
  const modelId =
    body.plannerModelId?.trim() || preferredComposerModelId() || undefined;

  let workers: PlanWorkerDef[];
  if (preset === "custom" && Array.isArray(body.workers) && body.workers.length) {
    workers = body.workers;
  } else if (Array.isArray(body.workers) && body.workers.length && !body.preset) {
    workers = body.workers;
  } else {
    workers = workersForPlanPreset(preset, goal, {
      preferReal: body.preferReal,
    });
  }

  // 模型拆步（可选）：成了就用模型给的清单，不成就留着预设，并把原因带回去
  let plannerNote: {
    ok: boolean;
    modelId: string | null;
    summary: string;
    workers: number;
    reason?: string;
    notes?: string[];
  } | null = null;
  if (body.planner === true && preset !== "custom" && !(Array.isArray(body.workers) && body.workers.length)) {
    const planned = await planWorkers({
      goal,
      modelId,
      maxWorkers: 4,
      allowedAgentIds: BUILTIN_AGENTS.map((a) => a.id),
      signal: req.signal,
    });
    if (planned.ok) {
      workers = planned.workers;
      plannerNote = {
        ok: true,
        modelId: modelId ?? null,
        summary: describePlannerResult(planned),
        workers: planned.workers.length,
        notes: planned.notes,
      };
    } else {
      plannerNote = {
        ok: false,
        modelId: modelId ?? null,
        summary: describePlannerResult(planned),
        workers: workers.length,
        reason: planned.reason,
      };
    }
  }

  let plan: Plan;
  let merged: string;
  let pendingWrites: Array<{ path: string; content: string; stepId: string }>;
  let batches: PlanBatch[];
  /** 重规划过程的说明（成功换了几步 / 为什么没换），回给 UI 看 */
  const replanNotes: string[] = [];
  const bestOf =
    typeof body.bestOf === "number" && Number.isFinite(body.bestOf)
      ? Math.max(1, Math.min(4, Math.trunc(body.bestOf)))
      : 1;
  try {
    const out = await runParallelPlan({
      workspaceRoot,
      goal,
      skillsRoot: defaultSkillsRoot(),
      customSkillsRoot: defaultCustomSkillsRoot(),
      agentStorePath: defaultAgentStore(),
      workers: bestOf > 1 ? workers.map((w) => ({ ...w, bestOf })) : workers,
      maxRetries:
        typeof body.maxRetries === "number" && Number.isFinite(body.maxRetries)
          ? Math.max(0, Math.min(5, Math.trunc(body.maxRetries)))
          : 1,
      maxConcurrency:
        typeof body.maxConcurrency === "number" &&
        Number.isFinite(body.maxConcurrency)
          ? Math.max(0, Math.min(8, Math.trunc(body.maxConcurrency)))
          : 0,
      // 重规划要烧 token：只有显式要、且确实有真模型时才接上
      replan:
        body.replan === true && modelId
          ? makePlannerReplanner({
              modelId,
              maxWorkers: Math.max(4, workers.length),
              allowedAgentIds: BUILTIN_AGENTS.map((a) => a.id),
              signal: req.signal,
              onNote: (n) => replanNotes.push(n),
            })
          : undefined,
      judge:
        bestOf > 1 && modelId
          ? makePlannerJudge({ modelId, signal: req.signal })
          : undefined,
      signal: req.signal,
      onStep: (s) => {
        const idx = steps.findIndex((x) => x.id === s.id);
        if (idx === -1) steps.push({ ...s });
        else steps[idx] = { ...s };
      },
    });
    plan = out.plan;
    merged = out.merged;
    pendingWrites = out.pendingWrites;
    batches = out.batches;
  } catch (err) {
    // 依赖写歪了（成环/越界/依赖自己）是**请求本身**的问题，不该给 500
    if (err instanceof PlanDependencyError) {
      return Response.json({ error: err.message, details: steps }, { status: 400 });
    }
    const message = err instanceof Error ? err.message : String(err);
    return Response.json({ error: message }, { status: 500 });
  }
  const record = appendPlanRecord(defaultPlanStore(), {
    id: plan.id,
    goal,
    preset,
    steps: plan.steps.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      agentId: s.agentId,
      modelId: s.modelId,
      resultPreview: s.resultPreview,
      error: s.error,
      attempts: s.attempts,
    })),
    merged,
    createdAt: plan.createdAt,
  });

  return Response.json({
    plan,
    steps: plan.steps,
    merged,
    pendingWrites,
    workspaceRoot,
    preset,
    workers,
    batches,
    planner: plannerNote,
    replan:
      body.replan === true
        ? { enabled: Boolean(modelId), notes: replanNotes }
        : undefined,
    bestOf: bestOf > 1 ? bestOf : undefined,
    record,
  });
}
