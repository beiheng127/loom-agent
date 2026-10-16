import type { MockScenario, RunLoopInput, ToolResult } from "../types/index.js";
/**
 * 单 Agent ReAct 循环。
 * - 有真实模型：用 AI SDK streamText + 手工工具协议（token 级 text_delta）
 * - mock：按 scenario 跑确定性脚本（可选分片 text_delta）
 */
export declare function runAgentLoop(input: RunLoopInput): Promise<string>;
export declare function resolveMockScenario(input: {
    explicit?: MockScenario;
    agentId: string;
    modelId: string;
    goal: string;
    allowedTools: string[];
}): MockScenario;
export type { ToolResult };
