import fs from "node:fs";
import path from "node:path";

/** 与 Studio LoomShell Session 对齐的持久化形状 */
export type StoredSessionMessage = {
  kind: string;
  id: string;
  at: number;
  text?: string;
  streaming?: boolean;
  name?: string;
  args?: Record<string, unknown>;
  ok?: boolean;
  preview?: string;
  phase?: string;
  path?: string;
  content?: string;
  diff?: string;
  additions?: number;
  deletions?: number;
};

export type StoredSession = {
  id: string;
  title: string;
  mode: "ask" | "agent" | "plan";
  thread: StoredSessionMessage[];
  updatedAt: number;
};

const MAX_SESSIONS = 16;
const MAX_MESSAGES = 80;

function ensureDir(filePath: string) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
}

export function defaultSessionStorePath(repoRoot: string) {
  return path.join(repoRoot, "data/loom-store/sessions.json");
}

function readStore(storePath: string): StoredSession[] {
  try {
    if (!fs.existsSync(storePath)) return [];
    const raw = JSON.parse(fs.readFileSync(storePath, "utf8")) as {
      sessions?: StoredSession[];
    };
    return Array.isArray(raw.sessions) ? raw.sessions : [];
  } catch {
    return [];
  }
}

function writeStore(storePath: string, sessions: StoredSession[]) {
  ensureDir(storePath);
  fs.writeFileSync(
    storePath,
    JSON.stringify({ sessions, updatedAt: Date.now() }, null, 2),
    "utf8",
  );
}

export function listSessions(storePath: string): StoredSession[] {
  return readStore(storePath)
    .slice()
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function getSession(
  storePath: string,
  id: string,
): StoredSession | null {
  return readStore(storePath).find((s) => s.id === id) ?? null;
}

export function upsertSession(
  storePath: string,
  input: {
    id: string;
    title: string;
    mode: "ask" | "agent" | "plan";
    thread: StoredSessionMessage[];
    updatedAt?: number;
  },
): StoredSession {
  const sessions = readStore(storePath);
  const row: StoredSession = {
    id: input.id,
    title: (input.title || "Untitled").slice(0, 48),
    mode: input.mode,
    thread: (input.thread ?? []).slice(-MAX_MESSAGES),
    updatedAt: input.updatedAt ?? Date.now(),
  };
  const next = [row, ...sessions.filter((s) => s.id !== row.id)].slice(
    0,
    MAX_SESSIONS,
  );
  writeStore(storePath, next);
  return row;
}

export function deleteSession(storePath: string, id: string): boolean {
  const sessions = readStore(storePath);
  const next = sessions.filter((s) => s.id !== id);
  if (next.length === sessions.length) return false;
  writeStore(storePath, next);
  return true;
}
