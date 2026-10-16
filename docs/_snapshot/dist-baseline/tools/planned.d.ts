/**
 * 能力清单：已上线工具 vs 未配置/计划中。
 * 正式执行只走 TOOL_CATALOG；本文件供 meta / Models UI 展示。
 */
export declare const PLANNED_TOOL_NAMES: readonly ["web_search", "fetch_url", "run_safe_cmd"];
export type PlannedToolName = (typeof PLANNED_TOOL_NAMES)[number];
export type ToolCapabilityStatus = "live" | "not_configured" | "planned";
export declare const PLANNED_TOOL_BLURBS: Record<PlannedToolName, {
    description: string;
    requiresApproval: boolean;
    group: "web" | "local";
}>;
/** 已实现并注册进 catalog 的工具 */
export declare const LIVE_EXTENDED_TOOLS: PlannedToolName[];
export declare function isSearchConfigured(): boolean;
export declare function describeCapabilityStatus(name: PlannedToolName): ToolCapabilityStatus;
export declare function listPlannedTools(): {
    status: ToolCapabilityStatus;
    description: string;
    requiresApproval: boolean;
    group: "web" | "local";
    name: "fetch_url" | "web_search" | "run_safe_cmd";
}[];
export declare function capabilitySettingsSnapshot(): {
    search: {
        configured: boolean;
        envHints: string[];
        note: string;
    };
    fetch: {
        live: boolean;
        timeoutMs: number;
        maxChars: number;
        redirect: string;
    };
    safeCmd: {
        live: boolean;
        prefixes: string[];
        envExtra: string;
        timeoutMs: number;
    };
};
