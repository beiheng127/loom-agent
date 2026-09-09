import { applyApprovedWrite } from "@loom/core";
import { defaultWorkspace } from "@/lib/paths";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    workspace?: string;
    path?: string;
    content?: string;
  };
  if (!body.path || body.content == null) {
    return Response.json({ error: "path/content 必填" }, { status: 400 });
  }
  const workspaceRoot = path.resolve(body.workspace || defaultWorkspace());
  const result = await applyApprovedWrite(workspaceRoot, body.path, body.content);
  return Response.json({
    ok: true,
    path: result.path,
    previous: result.previous,
    created: result.created,
  });
}
