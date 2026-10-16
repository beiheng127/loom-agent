import type { MockScenario } from "../types/index.js";
import type { PlanWorkerDef } from "../plan/orchestrator.js";
export type DemoKind = "run" | "plan";
export type DemoRecipe = {
    id: string;
    step: 1 | 2 | 3 | 4;
    title: string;
    subtitle: string;
    proves: string;
    kind: DemoKind;
    /** 预计秒数（文案用） */
    etaSec: number;
    run?: {
        goal: string;
        agentId: string;
        modelId: string;
        mockScenario?: MockScenario;
    };
    plan?: {
        goal: string;
        preset: "homo" | "hetero" | "triple" | "custom";
        workers?: PlanWorkerDef[];
    };
};
/** 上手路径：按 step 顺序点即可理解系统 */
export declare const DEMO_RECIPES: DemoRecipe[];
/** 有云端 Key 时 Demo 应改走真模型，剥离 mockScenario */
export declare function resolveDemoRunForEnvironment(run: NonNullable<DemoRecipe["run"]>): {
    goal: string;
    agentId: string;
    modelId: string;
    mockScenario?: MockScenario;
};
export declare function getDemoRecipe(id: string): DemoRecipe | undefined;
/** 离线 mock Worker 预设（preferReal:false 强制） */
export declare function workersForPlanPresetMock(preset: string, goal: string): PlanWorkerDef[];
/**
 * Plan Worker 工厂。
 * - 默认 preferReal=true：有 Key 用真模型，否则 mock
 * - preferReal=false：强制离线 demo 脚本
 */
export declare function workersForPlanPreset(preset: string, goal: string, options?: {
    preferReal?: boolean;
}): PlanWorkerDef[];
/**
 * Key 就绪时用真实模型跑 Plan；否则回落 mock workers。
 * 角色偏好：reader→ollama/deepseek，auditor/editor→deepseek（再回落 openai/ollama）。
 * 不带 mockScenario，走真实 generate/stream 路径。
 */
export declare function workersForPlanPresetAuto(preset: string, goal: string): PlanWorkerDef[];
/** 是否有任一非 mock 模型就绪（供 UI / meta） */
export declare function hasReadyRealModel(): boolean;
export declare function tripleDemoWorkers(goal: string): PlanWorkerDef[];
