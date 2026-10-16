import fs from "node:fs";
import path from "node:path";
const MAX_PLANS = 24;
function ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
export function defaultPlanStorePath(repoRoot) {
    return path.join(repoRoot, "data/loom-store/plans.json");
}
function readStore(storePath) {
    try {
        if (!fs.existsSync(storePath))
            return [];
        const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
        return Array.isArray(raw.plans) ? raw.plans : [];
    }
    catch {
        return [];
    }
}
function writeStore(storePath, plans) {
    ensureDir(storePath);
    fs.writeFileSync(storePath, JSON.stringify({ plans, updatedAt: Date.now() }, null, 2), "utf8");
}
export function listPlans(storePath) {
    return readStore(storePath)
        .slice()
        .sort((a, b) => b.createdAt - a.createdAt);
}
export function appendPlanRecord(storePath, input) {
    const plans = readStore(storePath);
    const row = {
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
        })),
        merged: input.merged?.slice(0, 4000),
        createdAt: input.createdAt ?? Date.now(),
        threads: input.steps.length,
    };
    const next = [row, ...plans.filter((p) => p.id !== row.id)].slice(0, MAX_PLANS);
    writeStore(storePath, next);
    return row;
}
