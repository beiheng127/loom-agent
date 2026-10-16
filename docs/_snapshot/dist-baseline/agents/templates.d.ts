import type { AgentProfile } from "../types/index.js";
export type AgentTemplate = {
    id: string;
    name: string;
    blurb: string;
    profile: Omit<AgentProfile, "id" | "name"> & {
        name?: string;
    };
};
/** 一键生成自定义 Agent 的模板（写入 loom-store，不覆盖内置） */
export declare const AGENT_TEMPLATES: AgentTemplate[];
export declare function templateToProfile(templateId: string, nameOverride?: string): AgentProfile;
