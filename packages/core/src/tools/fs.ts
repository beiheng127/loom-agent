import fs from "node:fs/promises";
import path from "node:path";
import type { ToolContext, ToolResult } from "../types/index.js";

/** 防止路径逃逸出 workspace */
export function resolveInWorkspace(
  workspaceRoot: string,
  relativeOrAbsolute: string,
): string {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, relativeOrAbsolute);
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error(`路径越界：${relativeOrAbsolute}`);
  }
  return target;
}

export async function listDir(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const rel = String(args.path ?? ".");
    const dir = resolveInWorkspace(ctx.workspaceRoot, rel);
    const entries = await fs.readdir(dir, { withFileTypes: true });
    const items = entries.slice(0, 200).map((e) => ({
      name: e.name,
      type: e.isDirectory() ? "dir" : "file",
    }));
    return { ok: true, data: { path: rel, items } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function readFileTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const rel = String(args.path ?? "");
    if (!rel) return { ok: false, error: "path 必填" };
    const file = resolveInWorkspace(ctx.workspaceRoot, rel);
    const raw = await fs.readFile(file, "utf8");
    const max = Number(args.maxChars ?? 12000);
    const content =
      raw.length > max
        ? `${raw.slice(0, max)}\n\n…(截断，共 ${raw.length} 字符)`
        : raw;
    return { ok: true, data: { path: rel, content } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function grepFiles(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const query = String(args.query ?? "");
    if (!query) return { ok: false, error: "query 必填" };
    const rel = String(args.path ?? ".");
    const root = resolveInWorkspace(ctx.workspaceRoot, rel);
    const hits: Array<{ file: string; line: number; text: string }> = [];

    async function walk(dir: string) {
      if (hits.length >= 40) return;
      const entries = await fs.readdir(dir, { withFileTypes: true });
      for (const e of entries) {
        if (hits.length >= 40) break;
        if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") {
          continue;
        }
        const full = path.join(dir, e.name);
        if (e.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!/\.(ts|tsx|js|jsx|md|json|mjs|cjs|css|py|go|rs)$/i.test(e.name)) {
          continue;
        }
        const text = await fs.readFile(full, "utf8").catch(() => "");
        const lines = text.split("\n");
        lines.forEach((line, i) => {
          if (hits.length >= 40) return;
          if (line.toLowerCase().includes(query.toLowerCase())) {
            hits.push({
              file: path.relative(ctx.workspaceRoot, full),
              line: i + 1,
              text: line.trim().slice(0, 200),
            });
          }
        });
      }
    }

    await walk(root);
    return { ok: true, data: { query, hits } };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function writeFileTool(
  args: Record<string, unknown>,
  ctx: ToolContext,
): Promise<ToolResult> {
  try {
    const rel = String(args.path ?? "");
    const content = String(args.content ?? "");
    if (!rel) return { ok: false, error: "path 必填" };
    // 校验可写路径合法，但不立即写入
    resolveInWorkspace(ctx.workspaceRoot, rel);
    return {
      ok: true,
      requiresApproval: true,
      pendingWrite: { path: rel, content },
      data: { message: "写操作需人工批准后才会落盘" },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

export type AppliedWriteResult = {
  path: string;
  /** 写入前原文；新建文件时为 null */
  previous: string | null;
  created: boolean;
};

export async function applyApprovedWrite(
  workspaceRoot: string,
  rel: string,
  content: string,
): Promise<AppliedWriteResult> {
  const file = resolveInWorkspace(workspaceRoot, rel);
  let previous: string | null = null;
  let created = false;
  try {
    previous = await fs.readFile(file, "utf8");
  } catch {
    created = true;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, content, "utf8");
  return { path: rel, previous, created };
}

/** 撤回一次已批准写入：新建则删除，否则恢复原文 */
export async function undoApprovedWrite(
  workspaceRoot: string,
  rel: string,
  previous: string | null,
  created: boolean,
): Promise<void> {
  const file = resolveInWorkspace(workspaceRoot, rel);
  if (created || previous == null) {
    try {
      await fs.unlink(file);
    } catch {
      /* already gone */
    }
    return;
  }
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, previous, "utf8");
}
