import { spawn } from "node:child_process";
/** 默认只读 git 命令；可用 LOOM_SAFE_CMDS 追加（逗号分隔完整命令前缀） */
export const DEFAULT_SAFE_CMD_PREFIXES = [
    "git status",
    "git diff",
    "git log -n",
    "git log --oneline -n",
];
export function listSafeCmdPrefixes() {
    const extra = (process.env.LOOM_SAFE_CMDS ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
    const merged = [...DEFAULT_SAFE_CMD_PREFIXES, ...extra];
    return [...new Set(merged)];
}
export function isSafeCommand(command) {
    const normalized = command.trim().replace(/\s+/g, " ");
    if (!normalized || normalized.includes("|") || normalized.includes(";") || normalized.includes("&") || normalized.includes("`") || normalized.includes("$(") || normalized.includes("\n")) {
        return false;
    }
    return listSafeCmdPrefixes().some((prefix) => normalized === prefix ||
        normalized.startsWith(`${prefix} `) ||
        // allow `git log -n 20` when prefix is `git log -n`
        (prefix.endsWith(" -n") &&
            new RegExp(`^${escapeRegExp(prefix)}\\s+\\d+`).test(normalized)));
}
function escapeRegExp(s) {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/**
 * 提议执行白名单命令（不立刻跑）。批准后走 applyApprovedCmd。
 */
export async function runSafeCmdTool(args, _ctx) {
    try {
        const command = String(args.command ?? "").trim();
        if (!command)
            return { ok: false, error: "command 必填" };
        if (!isSafeCommand(command)) {
            return {
                ok: false,
                error: `命令不在白名单：${command}。允许前缀：${listSafeCmdPrefixes().join(" | ")}`,
            };
        }
        return {
            ok: true,
            requiresApproval: true,
            pendingCmd: { command },
            data: {
                message: "命令需人工确认后才会在工作区执行",
                command,
                whitelist: listSafeCmdPrefixes(),
            },
        };
    }
    catch (err) {
        return {
            ok: false,
            error: err instanceof Error ? err.message : String(err),
        };
    }
}
export async function applyApprovedCmd(workspaceRoot, command, options) {
    const trimmed = command.trim();
    if (!isSafeCommand(trimmed)) {
        return {
            ok: false,
            command: trimmed,
            stdout: "",
            stderr: "",
            exitCode: null,
            error: "命令不在白名单，已拒绝执行",
        };
    }
    const timeoutMs = options?.timeoutMs ?? Number(process.env.LOOM_CMD_TIMEOUT_MS ?? 15000);
    const maxOut = options?.maxOutputChars ?? 8000;
    return new Promise((resolve) => {
        const child = spawn(trimmed, {
            cwd: workspaceRoot,
            shell: true,
            env: { ...process.env, PATH: process.env.PATH },
        });
        let stdout = "";
        let stderr = "";
        let settled = false;
        const finish = (result) => {
            if (settled)
                return;
            settled = true;
            resolve(result);
        };
        const timer = setTimeout(() => {
            child.kill("SIGTERM");
            finish({
                ok: false,
                command: trimmed,
                stdout: stdout.slice(0, maxOut),
                stderr: stderr.slice(0, maxOut),
                exitCode: null,
                error: `超时（${timeoutMs}ms）`,
            });
        }, timeoutMs);
        child.stdout?.on("data", (buf) => {
            if (stdout.length < maxOut)
                stdout += buf.toString("utf8");
        });
        child.stderr?.on("data", (buf) => {
            if (stderr.length < maxOut)
                stderr += buf.toString("utf8");
        });
        child.on("error", (err) => {
            clearTimeout(timer);
            finish({
                ok: false,
                command: trimmed,
                stdout: stdout.slice(0, maxOut),
                stderr: stderr.slice(0, maxOut),
                exitCode: null,
                error: err.message,
            });
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            finish({
                ok: code === 0,
                command: trimmed,
                stdout: stdout.slice(0, maxOut),
                stderr: stderr.slice(0, maxOut),
                exitCode: code,
                error: code === 0 ? undefined : `exit ${code}`,
            });
        });
    });
}
