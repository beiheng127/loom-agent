import {
  appendPlanRecord,
  runParallelPlan,
  workersForPlanPreset,
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
    preset?: "homo" | "hetero" | "triple" | "custom";
    workers?: PlanWorkerDef[];
    /** false 时强制离线 mock workers */
    preferReal?: boolean;
  };
  const goal = (body.goal ?? "").trim() || "探索工作区并总结";
  const workspaceRoot = path.resolve(body.workspace || defaultWorkspace());
  const steps: PlanStep[] = [];
  const preset = body.preset ?? "homo";

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

  const { plan, merged, pendingWrites } = await runParallelPlan({
    workspaceRoot,
    goal,
    skillsRoot: defaultSkillsRoot(),
    customSkillsRoot: defaultCustomSkillsRoot(),
    agentStorePath: defaultAgentStore(),
    workers,
    signal: req.signal,
    onStep: (s) => {
      const idx = steps.findIndex((x) => x.id === s.id);
      if (idx === -1) steps.push({ ...s });
      else steps[idx] = { ...s };
    },
  });

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
    record,
  });
}
