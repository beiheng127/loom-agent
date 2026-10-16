import { defaultPluginsRoot } from "@/lib/paths";
import { loadPluginTools } from "@/lib/harness";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 层6：列出 plugins/ 下的插件与它们提供的工具（供 UI 显示 / 排错） */
export async function GET() {
  const root = defaultPluginsRoot();
  const loaded = await loadPluginTools();

  return Response.json({
    root,
    plugins: loaded.plugins.map((p) => ({
      name: p.manifest.name,
      version: p.manifest.version,
      description: p.manifest.description,
      author: p.manifest.author,
      enabled: p.manifest.enabled !== false,
      dir: p.dir,
      tools: p.tools.map((t) => ({
        name: t.name,
        description: t.description,
        requiresApproval: t.requiresApproval ?? false,
      })),
      error: p.error,
    })),
    warnings: loaded.warnings,
  });
}

/** 建一个插件骨架：POST { name } —— 只写 manifest 与入口占位，不覆盖已有目录 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: string };
  const name = (body.name ?? "").trim();
  if (!/^[a-z][a-z0-9_-]*$/.test(name)) {
    return Response.json(
      { error: "name 需匹配 ^[a-z][a-z0-9_-]*$（小写字母开头）" },
      { status: 400 },
    );
  }

  const dir = path.join(defaultPluginsRoot(), name);
  try {
    await fs.access(dir);
    return Response.json({ error: `插件目录已存在：${name}` }, { status: 409 });
  } catch {
    /* 不存在才继续 */
  }

  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    path.join(dir, "loom-plugin.json"),
    JSON.stringify(
      {
        name,
        version: "0.1.0",
        description: "由 Loom 生成的插件骨架",
        main: "index.mjs",
        enabled: true,
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
  await fs.writeFile(
    path.join(dir, "index.mjs"),
    `// Loom 插件入口。改完保存，下一次运行自动生效（不缓存）。
export const tools = [
  {
    name: "${name.replace(/-/g, "_")}_hello",
    description: "示例工具：回显 text，并报出当前工作区",
    inputSchema: {
      type: "object",
      properties: { text: { type: "string", description: "要回显的文本" } },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      return {
        ok: true,
        data: { echo: args.text, workspaceRoot: ctx.workspaceRoot },
      };
    },
  },
];
`,
    "utf8",
  );

  return Response.json({ ok: true, dir, name });
}
