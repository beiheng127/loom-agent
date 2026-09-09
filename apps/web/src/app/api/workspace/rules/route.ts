import fs from "node:fs/promises";
import path from "node:path";
import { defaultWorkspace } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 对齐 Cursor Rules / Claude CLAUDE.md：工作区约定注入 Agent */
export async function GET(req: Request) {
  const url = new URL(req.url);
  const workspace = path.resolve(
    url.searchParams.get("workspace") || defaultWorkspace(),
  );
  const candidates = [
    ".loom/RULES.md",
    ".loom/rules.md",
    "LOOM.md",
    "AGENTS.md",
  ];
  for (const rel of candidates) {
    try {
      const full = path.join(workspace, rel);
      const content = await fs.readFile(full, "utf8");
      return Response.json({
        found: true,
        path: rel,
        content: content.slice(0, 12000),
        chars: content.length,
      });
    } catch {
      /* try next */
    }
  }
  return Response.json({
    found: false,
    path: null,
    content: "",
    hint: "可在工作区添加 .loom/RULES.md（类似 .cursorrules）",
  });
}
