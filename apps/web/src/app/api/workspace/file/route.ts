import fs from "node:fs/promises";
import path from "node:path";
import { defaultWorkspace } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveIn(root: string, rel: string) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("路径越界");
  }
  return target;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace = path.resolve(
    url.searchParams.get("workspace") || defaultWorkspace(),
  );
  const rel = url.searchParams.get("path") || "";
  if (!rel) {
    return Response.json({ error: "path 必填" }, { status: 400 });
  }
  try {
    const file = resolveIn(workspace, rel);
    const raw = await fs.readFile(file, "utf8");
    const max = 20000;
    const truncated = raw.length > max;
    return Response.json({
      path: rel,
      content: truncated ? raw.slice(0, max) : raw,
      truncated,
      bytes: raw.length,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
