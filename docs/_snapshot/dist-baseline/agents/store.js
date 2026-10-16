import fs from "node:fs";
import path from "node:path";
import { BUILTIN_AGENTS, createAgentProfile } from "./profiles.js";
function ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
export function defaultAgentStorePath(repoRoot) {
    return path.join(repoRoot, "data/loom-store/agents.json");
}
export function loadCustomAgents(storePath) {
    try {
        if (!fs.existsSync(storePath))
            return [];
        const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
        return Array.isArray(raw.agents) ? raw.agents : [];
    }
    catch {
        return [];
    }
}
function saveCustomAgents(storePath, agents) {
    ensureDir(storePath);
    fs.writeFileSync(storePath, JSON.stringify({ agents, updatedAt: Date.now() }, null, 2), "utf8");
}
export function listAllAgents(storePath) {
    const custom = storePath ? loadCustomAgents(storePath) : [];
    const builtinIds = new Set(BUILTIN_AGENTS.map((a) => a.id));
    return [
        ...BUILTIN_AGENTS.map((a) => ({ ...a, builtin: true })),
        ...custom
            .filter((a) => !builtinIds.has(a.id))
            .map((a) => ({ ...a, builtin: false })),
    ];
}
export function resolveAgent(id, storePath) {
    const all = listAllAgents(storePath);
    const found = all.find((a) => a.id === id);
    if (!found)
        throw new Error(`未知 Agent: ${id}`);
    return found;
}
export function upsertCustomAgent(storePath, input) {
    const custom = loadCustomAgents(storePath);
    const id = input.id?.trim() ||
        `custom-${input.name
            .toLowerCase()
            .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
            .replace(/^-|-$/g, "")
            .slice(0, 24)}-${Date.now().toString(36).slice(-4)}`;
    if (BUILTIN_AGENTS.some((a) => a.id === id)) {
        throw new Error(`不能覆盖内置 Agent：${id}`);
    }
    const profile = createAgentProfile({
        id,
        name: input.name.trim(),
        systemPrompt: input.systemPrompt.trim(),
        allowedTools: input.allowedTools,
        defaultModelId: input.defaultModelId,
        skillIds: input.skillIds,
    });
    const idx = custom.findIndex((a) => a.id === id);
    if (idx === -1)
        custom.push(profile);
    else
        custom[idx] = profile;
    saveCustomAgents(storePath, custom);
    return profile;
}
export function deleteCustomAgent(storePath, id) {
    if (BUILTIN_AGENTS.some((a) => a.id === id)) {
        throw new Error(`不能删除内置 Agent：${id}`);
    }
    const custom = loadCustomAgents(storePath);
    const next = custom.filter((a) => a.id !== id);
    if (next.length === custom.length)
        return false;
    saveCustomAgents(storePath, next);
    return true;
}
