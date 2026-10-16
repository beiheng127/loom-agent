import type { MockScenario, Plan, PlanStep } from "../types/index.js";
export type PlanWorkerDef = {
    agentId: string;
    modelId: string;
    title: string;
    goal: string;
    mockScenario?: MockScenario;
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
    signal?: AbortSignal;
    onStep?: (step: PlanStep) => void;
};
/**
 * 多 Worker 并行执行计划：
 * 1. 构造 Plan Board 步骤
 * 2. Promise.all 并行跑各 Worker（可不同模型/Agent）
 * 3. 汇总结果
 */
export declare function runParallelPlan(input: RunPlanInput): Promise<{
    plan: Plan;
    merged: string;
    pendingWrites: Array<{
        path: string;
        content: string;
        stepId: string;
    }>;
}>;
/** 同质双线程（都用 mock 探索，故事弱但稳） */
export declare function defaultDemoWorkers(goal: string): PlanWorkerDef[];
/** 异构并行：只读探索 + 改码工提出写文件（HITL） */
export declare function heteroDemoWorkers(goal: string): PlanWorkerDef[];
