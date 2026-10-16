import type { ToolContext, ToolResult } from "../types/index.js";
/** 默认只读 git 命令；可用 LOOM_SAFE_CMDS 追加（逗号分隔完整命令前缀） */
export declare const DEFAULT_SAFE_CMD_PREFIXES: readonly ["git status", "git diff", "git log -n", "git log --oneline -n"];
export declare function listSafeCmdPrefixes(): string[];
export declare function isSafeCommand(command: string): boolean;
/**
 * 提议执行白名单命令（不立刻跑）。批准后走 applyApprovedCmd。
 */
export declare function runSafeCmdTool(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
export type CmdExecResult = {
    ok: boolean;
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    error?: string;
};
export declare function applyApprovedCmd(workspaceRoot: string, command: string, options?: {
    timeoutMs?: number;
    maxOutputChars?: number;
}): Promise<CmdExecResult>;
