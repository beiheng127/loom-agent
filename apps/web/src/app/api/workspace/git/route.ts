import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { defaultWorkspace } from "@/lib/paths";

const execFileAsync = promisify(execFile);

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 轻量 git status（对齐 Claude Code「先看仓库状态」） */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace = path.resolve(
    url.searchParams.get("workspace") || defaultWorkspace(),
  );
  try {
    const { stdout: branchOut } = await execFileAsync(
      "git",
      ["-C", workspace, "rev-parse", "--abbrev-ref", "HEAD"],
      { timeout: 4000 },
    );
    const { stdout: statusOut } = await execFileAsync(
      "git",
      ["-C", workspace, "status", "--porcelain"],
      { timeout: 4000 },
    );
    const lines = statusOut
      .split("\n")
      .map((l) => l.trimEnd())
      .filter(Boolean);
    return Response.json({
      ok: true,
      branch: branchOut.trim(),
      dirty: lines.length,
      sample: lines.slice(0, 12),
    });
  } catch {
    return Response.json({
      ok: false,
      branch: null,
      dirty: 0,
      sample: [],
      hint: "非 git 仓库或未安装 git",
    });
  }
}
