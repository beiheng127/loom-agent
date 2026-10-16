import fs from "node:fs";
import path from "node:path";

export type StoredPlanStepSummary = {
  id: string;
  title: string;
  status: string;
  agentId: string;
  modelId: string;
  resultPreview?: string;
  error?: string;
  /** 实际跑了几次（含重试） */
  attempts?: number;
};

/** 轻量 Plan 运行记录（Board 历史） */
export type StoredPlanRecord = {
  id: string;
  goal: string;
  preset: string;
  steps: StoredPlanStepSummary[];
  merged?: string;
  createdAt: number;
  threads: number;
};

const MAX_PLANS = 24;

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function defaultPlanStorePath(repoRoot: string) {
  return path.join(repoRoot, "data/loom-store/plans.json");
}

function readStore(storePath: string): StoredPlanRecord[] {
  try {
    if (!fs.existsSync(storePath)) return [];
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      plans?: StoredPlanRecord[];
    };
    return Array.isArray(raw.plans) ? raw.plans : [];
  } catch {
    return [];
  }
}

function writeStore(storePath: string, plans: StoredPlanRecord[]) {
  ensureDir(storePath);
  fs.writeFileSync(
    storePath,
    JSON.stringify({ plans, updatedAt: Date.now() }, null, 2),
    "utf8",
  );
}

export function listPlans(storePath: string): StoredPlanRecord[] {
  return readStore(storePath)
    .slice()
    .sort((a, b) => b.createdAt - a.createdAt);
}

export function appendPlanRecord(
  storePath: string,
  input: {
    id: string;
    goal: string;
    preset: string;
    steps: StoredPlanStepSummary[];
    merged?: string;
    createdAt?: number;
  },
): StoredPlanRecord {
  const plans = readStore(storePath);
  const row: StoredPlanRecord = {
    id: input.id,
    goal: input.goal,
    preset: input.preset,
    steps: input.steps.map((s) => ({
      id: s.id,
      title: s.title,
      status: s.status,
      agentId: s.agentId,
      modelId: s.modelId,
      resultPreview: s.resultPreview?.slice(0, 400),
      error: s.error,
      attempts: s.attempts,
    })),
    merged: input.merged?.slice(0, 4000),
    createdAt: input.createdAt ?? Date.now(),
    threads: input.steps.length,
  };
  const next = [row, ...plans.filter((p) => p.id !== row.id)].slice(
    0,
    MAX_PLANS,
  );
  writeStore(storePath, next);
  return row;
}
