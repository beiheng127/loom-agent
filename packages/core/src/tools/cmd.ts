import { spawn } from "node:child_process";
import { getDefaultJobStore, type JobStore } from "../jobs/store.js";
import type { ToolContext, ToolResult } from "../types/index.js";

/** 默认只读 git 命令；可用 LOOM_SAFE_CMDS 追加（逗号分隔完整命令前缀） */
export const DEFAULT_SAFE_CMD_PREFIXES = [
  "git status",
  "git diff",
  "git log -n",
  "git log --oneline -n",
] as const;

export function listSafeCmdPrefixes(): string[] {
  const extra = (process.env.LOOM_SAFE_CMDS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...DEFAULT_SAFE_CMD_PREFIXES, ...extra];
  return [...new Set(merged)];
}

/**
 * 危险字符：出现任一即拒绝。
 *
 * 这里同时拦管道/拼接（`|` `;` `&` 反引号 `$(`）与**重定向**（`>` `<`）。
 * 重定向是曾经的漏洞：`git status > evil.txt` 能通过前缀校验，而
 * applyApprovedCmd 用 shell:true 执行，于是白名单命令变成任意路径写文件。
 * 另有换行与制表符：它们能让一条命令在多行 shell 语义下变成两条。
 */
const DANGEROUS_CHARS = ["|", ";", "&", "`", "$(", ">", "<", "\n", "\r"] as const;

export function isSafeCommand(command: string): boolean {
  const normalized = command.trim().replace(/\s+/g, " ");
  if (!normalized) return false;
  if (DANGEROUS_CHARS.some((ch) => normalized.includes(ch))) return false;
  return listSafeCmdPrefixes().some(
    (prefix) =>
      normalized === prefix ||
      normalized.startsWith(`${prefix} `) ||
      // allow `git log -n 20` when prefix is `git log -n`
      (prefix.endsWith(" -n") &&
        new RegExp(`^${escapeRegExp(prefix)}\\s+\\d+`).test(normalized)),
  );
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * 提议执行白名单命令（不立刻跑）。批准后走 applyApprovedCmd。
 */
export async function runSafeCmdTool(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const command = String(args.command ?? "").trim();
    if (!command) return { ok: false, error: "command 必填" };
    if (!isSafeCommand(command)) {
      return {
        ok: false,
        error: `命令不在白名单：${command}。允许前缀：${listSafeCmdPrefixes().join(" | ")}`,
      };
    }
    const background = args.background === true;
    return {
      ok: true,
      requiresApproval: true,
      pendingCmd: background ? { command, background: true } : { command },
      data: {
        message: background
          ? "命令需人工确认后才会在工作区**后台**执行；批准后拿 jobId，用 job_output 取输出"
          : "命令需人工确认后才会在工作区执行",
        command,
        background,
        whitelist: listSafeCmdPrefixes(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type CmdExecResult = {
  ok: boolean;
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  /** 后台模式下返回的 job 句柄；用 job_output / job_kill 操作它 */
  jobId?: string;
  background?: boolean;
};

export async function applyApprovedCmd(
  workspaceRoot: string,
  command: string,
  options?: {
    timeoutMs?: number;
    maxOutputChars?: number;
    /** 后台跑：立刻返回 jobId，不占着循环等它结束 */
    background?: boolean;
    /** 测试注入 job store；默认进程单例 */
    store?: JobStore;
  },
): Promise<CmdExecResult> {
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

  // 后台跑道不是绕过审批的后门：白名单与人工批准都在前面已经过了一遍，
  // 这里只是把「等它跑完」换成「把句柄交出去」。
  if (options?.background) {
    const store = options.store ?? getDefaultJobStore();
    const job = store.start(trimmed, { cwd: workspaceRoot });
    return {
      ok: true,
      command: trimmed,
      stdout: "",
      stderr: "",
      exitCode: null,
      jobId: job.id,
      background: true,
    };
  }

  const timeoutMs = options?.timeoutMs ?? Number(process.env.LOOM_CMD_TIMEOUT_MS ?? 15000);
  const maxOut = options?.maxOutputChars ?? 8000;

  return new Promise((resolve) => {
    // shell:true 是为了让白名单前缀里的参数（`git log -n 20`）按预期展开。
    // 它的安全性完全依赖上面的 isSafeCommand —— 所以危险字符表里
    // 必须有重定向与拼接类字符，改动那张表等于改动这里的攻击面。
    const child = spawn(trimmed, {
      cwd: workspaceRoot,
      shell: true,
      env: { ...process.env, PATH: process.env.PATH },
    });

    let stdout = "";
    let stderr = "";
    let settled = false;

    const finish = (result: CmdExecResult) => {
      if (settled) return;
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

    child.stdout?.on("data", (buf: Buffer) => {
      if (stdout.length < maxOut) stdout += buf.toString("utf8");
    });
    child.stderr?.on("data", (buf: Buffer) => {
      if (stderr.length < maxOut) stderr += buf.toString("utf8");
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
