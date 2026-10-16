export type StoredPlanStepSummary = {
    id: string;
    title: string;
    status: string;
    agentId: string;
    modelId: string;
    resultPreview?: string;
    error?: string;
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
export declare function defaultPlanStorePath(repoRoot: string): string;
export declare function listPlans(storePath: string): StoredPlanRecord[];
export declare function appendPlanRecord(storePath: string, input: {
    id: string;
    goal: string;
    preset: string;
    steps: StoredPlanStepSummary[];
    merged?: string;
    createdAt?: number;
}): StoredPlanRecord;
