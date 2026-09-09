import { undoApprovedWrite } from "@loom/core";
import { defaultWorkspace } from "@/lib/paths";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  const body = (await req.json()) as {
    workspace?: string;
    path?: string;
    previous?: string | null;
    created?: boolean;
  };
  if (!body.path) {
    return Response.json({ error: "path 必填" }, { status: 400 });
  }
  const workspaceRoot = path.resolve(body.workspace || defaultWorkspace());
  await undoApprovedWrite(
    workspaceRoot,
    body.path,
    body.previous ?? null,
    Boolean(body.created),
  );
  return Response.json({ ok: true, path: body.path });
}
