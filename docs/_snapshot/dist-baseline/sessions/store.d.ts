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
export declare function defaultSessionStorePath(repoRoot: string): string;
export declare function listSessions(storePath: string): StoredSession[];
export declare function getSession(storePath: string, id: string): StoredSession | null;
export declare function upsertSession(storePath: string, input: {
    id: string;
    title: string;
    mode: "ask" | "agent" | "plan";
    thread: StoredSessionMessage[];
    updatedAt?: number;
}): StoredSession;
export declare function deleteSession(storePath: string, id: string): boolean;
