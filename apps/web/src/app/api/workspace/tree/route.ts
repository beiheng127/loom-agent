import fs from "node:fs/promises";
import path from "node:path";
import { defaultWorkspace } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type TreeNode = {
  name: string;
  path: string;
  type: "file" | "dir";
  children?: TreeNode[];
};

const SKIP = new Set([
  "node_modules",
  ".git",
  "dist",
  ".next",
  ".DS_Store",
]);

async function walk(
  abs: string,
  rel: string,
  depth: number,
): Promise<TreeNode[]> {
  if (depth <= 0) return [];
  let entries;
  try {
    entries = await fs.readdir(abs, { withFileTypes: true });
  } catch {
    return [];
  }
  const nodes: TreeNode[] = [];
  for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (SKIP.has(e.name) || e.name.startsWith(".")) {
      if (e.name !== ".env.example") continue;
    }
    const childRel = rel ? `${rel}/${e.name}` : e.name;
    const childAbs = path.join(abs, e.name);
    if (e.isDirectory()) {
      nodes.push({
        name: e.name,
        path: childRel,
        type: "dir",
        children: await walk(childAbs, childRel, depth - 1),
      });
    } else {
      nodes.push({ name: e.name, path: childRel, type: "file" });
    }
  }
  return nodes;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const root = path.resolve(url.searchParams.get("workspace") || defaultWorkspace());
  const depth = Math.min(Number(url.searchParams.get("depth") || 3), 5);
  const nodes = await walk(root, "", depth);
  return Response.json({ workspace: root, nodes });
}
