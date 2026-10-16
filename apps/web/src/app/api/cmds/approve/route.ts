import { applyApprovedCmd } from "@loom/core";
import { defaultWorkspace } from "@/lib/paths";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    workspace?: string;
    command?: string;
    /** 后台模式：立刻返回 jobId，不占着这次请求等它跑完 */
    background?: boolean;
  };
  if (!body.command?.trim()) {
    return Response.json({ error: "command 必填" }, { status: 400 });
  }
  const workspaceRoot = path.resolve(body.workspace || defaultWorkspace());
  const result = await applyApprovedCmd(workspaceRoot, body.command.trim(), {
    background: body.background === true,
  });
  if (!result.ok && result.error?.includes("白名单")) {
    return Response.json(result, { status: 400 });
  }
  return Response.json(result);
}
