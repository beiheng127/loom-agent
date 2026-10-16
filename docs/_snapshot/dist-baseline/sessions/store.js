import fs from "node:fs";
import path from "node:path";
const MAX_SESSIONS = 16;
const MAX_MESSAGES = 80;
function ensureDir(filePath) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
}
export function defaultSessionStorePath(repoRoot) {
    return path.join(repoRoot, "data/loom-store/sessions.json");
}
function readStore(storePath) {
    try {
        if (!fs.existsSync(storePath))
            return [];
        const raw = JSON.parse(fs.readFileSync(storePath, "utf8"));
        return Array.isArray(raw.sessions) ? raw.sessions : [];
    }
    catch {
        return [];
    }
}
function writeStore(storePath, sessions) {
    ensureDir(storePath);
    fs.writeFileSync(storePath, JSON.stringify({ sessions, updatedAt: Date.now() }, null, 2), "utf8");
}
export function listSessions(storePath) {
    return readStore(storePath)
        .slice()
        .sort((a, b) => b.updatedAt - a.updatedAt);
}
export function getSession(storePath, id) {
    return readStore(storePath).find((s) => s.id === id) ?? null;
}
export function upsertSession(storePath, input) {
    const sessions = readStore(storePath);
    const row = {
        id: input.id,
        title: (input.title || "Untitled").slice(0, 48),
        mode: input.mode,
        thread: (input.thread ?? []).slice(-MAX_MESSAGES),
        updatedAt: input.updatedAt ?? Date.now(),
    };
    const next = [row, ...sessions.filter((s) => s.id !== row.id)].slice(0, MAX_SESSIONS);
    writeStore(storePath, next);
    return row;
}
export function deleteSession(storePath, id) {
    const sessions = readStore(storePath);
    const next = sessions.filter((s) => s.id !== id);
    if (next.length === sessions.length)
        return false;
    writeStore(storePath, next);
    return true;
}
