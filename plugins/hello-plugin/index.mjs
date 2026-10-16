/**
 * hello-plugin —— loom-agent 最小示例插件
 *
 * 纯 ESM，只依赖 node: 内置模块（node:fs/promises、node:path），不依赖任何 npm 包。
 * 导出 `{ tools: [...] }`（也支持 `export default { tools: [...] }`，两种加载器都认）。
 *
 * 工具名约定：小写字母开头，只含小写字母/数字/下划线，且自带命名空间前缀（hello_ / repo_），
 * 避免和内置工具（list_dir、read_file…）或其它插件撞名 —— 撞名时内置优先，插件工具会被丢弃。
 */

import fs from "node:fs/promises";
import path from "node:path";

/** 递归统计时的安全上限：最多看这么多文件，避免在真实大仓库里跑爆 */
const MAX_FILES = 500;
/** 递归深度上限 */
const MAX_DEPTH = 8;
/** 只统计这些后缀 */
const COUNTED_EXTENSIONS = new Set([".ts", ".tsx", ".md"]);
/** 跳过这些目录，避免把 node_modules / dist 也算进去 */
const SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next"]);

/** 把根目录内的相对路径解析成绝对路径；越界就钳回根目录 */
function resolveInRoot(workspaceRoot, rel) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, rel ?? ".");
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(withSep)) return root;
  return target;
}

/** 递归收集待统计的文件（带上限保护） */
async function collectFiles(dir, depth, acc) {
  if (depth > MAX_DEPTH || acc.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 无权限/不存在就当空目录跳过，不抛
  }
  for (const entry of entries) {
    if (acc.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      await collectFiles(full, depth + 1, acc);
    } else if (entry.isFile()) {
      if (COUNTED_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) acc.push(full);
    }
  }
}

export const tools = [
  {
    name: "hello_echo",
    description: "回显传入的文本，并带上插件名（示例插件的最小工具）",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        text: { type: "string", description: "要回显的文本" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    async execute(args, _ctx) {
      const text = typeof args.text === "string" ? args.text : "";
      return { ok: true, data: { echo: text, plugin: "hello-plugin" } };
    },
  },
  {
    name: "repo_wordcount",
    description:
      "递归统计工作区内 .ts/.tsx/.md 文件的字符数与文件数（最多 500 个文件、8 层深）",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对工作区根目录的起点目录，默认 .",
        },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const start = resolveInRoot(ctx.workspaceRoot, typeof args.path === "string" ? args.path : ".");
      const acc = [];
      await collectFiles(start, 0, acc);
      let chars = 0;
      for (const file of acc) {
        try {
          chars += (await fs.readFile(file, "utf8")).length;
        } catch {
          /* 单个文件读不了就跳过 */
        }
      }
      return { ok: true, data: { files: acc.length, chars } };
    },
  },
];

export default { tools };
