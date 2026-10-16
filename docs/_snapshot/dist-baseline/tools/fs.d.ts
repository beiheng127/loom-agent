import type { ToolContext, ToolResult } from "../types/index.js";
/** 防止路径逃逸出 workspace */
export declare function resolveInWorkspace(workspaceRoot: string, relativeOrAbsolute: string): string;
export declare function listDir(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
export declare function readFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
export declare function grepFiles(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
export declare function writeFileTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
export type AppliedWriteResult = {
    path: string;
    /** 写入前原文；新建文件时为 null */
    previous: string | null;
    created: boolean;
};
export declare function applyApprovedWrite(workspaceRoot: string, rel: string, content: string): Promise<AppliedWriteResult>;
/** 撤回一次已批准写入：新建则删除，否则恢复原文 */
export declare function undoApprovedWrite(workspaceRoot: string, rel: string, previous: string | null, created: boolean): Promise<void>;
