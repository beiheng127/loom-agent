import type { AgentProfile, ToolName } from "../types/index.js";
export type StoredAgent = AgentProfile & {
    builtin?: boolean;
    updatedAt?: number;
};
export declare function defaultAgentStorePath(repoRoot: string): string;
export declare function loadCustomAgents(storePath: string): AgentProfile[];
export declare function listAllAgents(storePath?: string): StoredAgent[];
export declare function resolveAgent(id: string, storePath?: string): AgentProfile;
export declare function upsertCustomAgent(storePath: string, input: {
    id?: string;
    name: string;
    systemPrompt: string;
    allowedTools?: ToolName[];
    defaultModelId?: string;
    skillIds?: string[];
}): AgentProfile;
export declare function deleteCustomAgent(storePath: string, id: string): boolean;
