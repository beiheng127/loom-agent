import type { AgentProfile, ToolName } from "../types/index.js";
export declare const BUILTIN_AGENTS: AgentProfile[];
/** @deprecated 请用 resolveAgent(storePath) 以包含自定义 Agent */
export declare function getAgent(id: string): AgentProfile;
export declare function createAgentProfile(input: {
    id: string;
    name: string;
    systemPrompt: string;
    allowedTools?: ToolName[];
    defaultModelId?: string;
    skillIds?: string[];
}): AgentProfile;
/** 从内置 Agent 克隆为可编辑草稿（仍需 upsert 才持久化） */
export declare function cloneAgentAsCustom(source: AgentProfile, nameSuffix?: string): AgentProfile;
