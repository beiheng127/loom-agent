/**
 * docs-plugin —— Markdown 断链体检 + 报告落盘（走审批门禁）
 *
 * 两个工具，正好演示插件系统的两端：
 * - `docs_link_check` 是纯读工具：不写盘、不需要审批，模型可以随便调。
 * - `docs_link_report` 是**写工具**：它自己不写文件，而是返回
 *   `{ ok:true, requiresApproval:true, pendingWrite:{ path, content } }`，
 *   和内置的 write_file 走完全同一条 HITL 队列（run.ts 里靠 results 里的
 *   requiresApproval + pendingWrite 触发 approval_needed 事件 →
 *   /api/writes/approve 才真正落盘）。插件作者不需要自己实现审批 UI，
 *   也不该绕过它：这是"插件工具和内置工具同一套门禁"的证明。
 *
 * 链接判定规则（只处理相对路径，外部链接不算断链）：
 * - 跳过 http/https/mailto 等带 scheme 的、以 # 开头的锚点、站点绝对路径 /foo；
 * - `a.md#section` 只校验 `a.md`；`%20` 之类的百分号编码会先解码；
 * - 相对当前 md 文件所在目录解析；文件或目录不存在才算断链；
 * - 围栏代码块整块不扫、行内 `` `code` `` 先抠掉——文档里教人写链接/写正则的那一行，
 *   否则会自己报自己断链（README 的插件章节真踩过，探针里锁住了）。
 */

import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";

/** 扫描上限：真实大仓库里不能把整个盘读完 */
const MAX_FILES = 400;
const MAX_LINKS = 5000;
const MAX_DEPTH = 10;
const MAX_BROKEN_LISTED = 100;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  "out",
  "coverage",
  ".turbo",
  ".cache",
]);
const DOC_EXTENSIONS = new Set([".md", ".mdx"]);
/** 带 scheme 的链接（http:, mailto:, tel: …）一律当外部链接 */
const SCHEME_RE = /^[a-z][a-z0-9+.-]*:/i;

/** 把相对路径解析到工作区内；越界就钳回根目录 */
function resolveInRoot(workspaceRoot, rel) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, typeof rel === "string" && rel ? rel : ".");
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(withSep)) return root;
  return target;
}

/** 相对工作区根的 posix 风格路径，报告里用这个（跨平台一致） */
function relPosix(workspaceRoot, abs) {
  return path.relative(path.resolve(workspaceRoot), abs).split(path.sep).join("/");
}

/**
 * 抠掉一行的行内 code span，返回剩下的文字（长度无关，只用来找链接）。
 * 按 CommonMark 的规矩：起止反引号串长度必须相同，所以 `` `a` ``（双反引号包住单反引号）
 * 也能整体抠掉——README/PLUGINS 里教人写正则时正好是这种写法。
 */
function stripCodeSpans(line) {
  let out = "";
  let i = 0;
  while (i < line.length) {
    if (line[i] !== "`") {
      out += line[i++];
      continue;
    }
    let n = 0;
    while (line[i + n] === "`") n++;
    const close = line.indexOf("`".repeat(n), i + n);
    if (close === -1) {
      i += n; // 没有配对的收尾，反引号本身丢掉
      continue;
    }
    i = close + n;
    out += " ";
  }
  return out;
}

/** 递归收集 .md/.mdx */
async function collectDocs(dir, depth, acc) {
  if (depth > MAX_DEPTH || acc.length >= MAX_FILES) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return; // 读不了的目录直接跳过，不抛
  }
  for (const entry of entries) {
    if (acc.length >= MAX_FILES) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      await collectDocs(full, depth + 1, acc);
    } else if (entry.isFile() && DOC_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      acc.push(full);
    }
  }
}

/**
 * 扫一遍并返回断链清单。`docs_link_check` 和 `docs_link_report` 共用这一份，
 * 避免"检查说没断链、报告里又列了断链"这种两个工具结论不一致的坑。
 */
async function scanLinks(workspaceRoot, startDir) {
  const files = [];
  await collectDocs(startDir, 0, files);

  let linksChecked = 0;
  let linksSkipped = 0;
  const broken = [];
  const truncated = { files: files.length >= MAX_FILES, links: false };

  for (const absFile of files) {
    let text;
    try {
      text = await fsp.readFile(absFile, "utf8");
    } catch {
      continue;
    }
    const lines = text.split(/\r?\n/);
    // 代码里的 `](...)` 不是链接：围栏块整块跳过，行内 code span 先抠掉再扫。
    // 不这么做的话，文档里教人写正则/写 Markdown 的那一行就会自己报自己断链。
    let fenceChar = "";
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^\s{0,3}(`{3,}|~{3,})/);
      if (fence) {
        const ch = fence[1][0];
        if (!fenceChar) fenceChar = ch;
        else if (fenceChar === ch) fenceChar = "";
        continue;
      }
      if (fenceChar) continue;
      // 先抠 ``双反引号`` span（Markdown 用它来包住含单反引号的代码），再抠 `普通` span
      const scannable = stripCodeSpans(line);
      // [文本](目标 "可选标题")；目标里不含空格和右括号
      const re = /\[[^\]]*\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/g;
      let m;
      while ((m = re.exec(scannable)) !== null) {
        const raw = m[1];
        if (linksChecked >= MAX_LINKS) {
          truncated.links = true;
          break;
        }
        if (
          !raw ||
          raw.startsWith("#") ||
          raw.startsWith("/") ||
          raw.startsWith("<") ||
          SCHEME_RE.test(raw)
        ) {
          linksSkipped++;
          continue;
        }
        linksChecked++;
        const withoutFragment = raw.split("#")[0].split("?")[0];
        let target = withoutFragment;
        try {
          target = decodeURIComponent(withoutFragment);
        } catch {
          // 编码坏了就用原串，反正只会导致"多报一条断链"，不会漏报
        }
        if (!target) {
          linksSkipped++;
          continue;
        }
        const resolved = path.resolve(path.dirname(absFile), target);
        let exists = false;
        try {
          exists = fs.existsSync(resolved);
        } catch {
          exists = false;
        }
        if (!exists) {
          broken.push({
            file: relPosix(workspaceRoot, absFile),
            line: i + 1,
            target: raw,
          });
        }
      }
      if (truncated.links) break;
    }
    if (truncated.links) break;
  }

  return {
    scannedFiles: files.length,
    linksChecked,
    linksSkipped,
    broken,
    brokenTruncated: broken.length > MAX_BROKEN_LISTED,
    truncated,
  };
}

function renderReport(workspaceRoot, startDir, scan) {
  const listed = scan.broken.slice(0, MAX_BROKEN_LISTED);
  const lines = [
    "# Markdown 断链报告",
    "",
    `- 工作区：\`${path.resolve(workspaceRoot)}\``,
    `- 扫描起点：\`${relPosix(workspaceRoot, startDir) || "."}\``,
    `- 扫描文件：${scan.scannedFiles} 个（.md/.mdx）`,
    `- 校验链接：${scan.linksChecked} 条（另有 ${scan.linksSkipped} 条外部链接/锚点被跳过）`,
    `- 断链：${scan.broken.length} 条`,
    `- 生成方式：plugins/docs-plugin 的 docs_link_report，经审批门禁落盘`,
    "",
  ];
  if (scan.broken.length === 0) {
    lines.push("没有发现断链。", "");
  } else {
    lines.push("| 文件 | 行 | 目标 |", "| --- | --- | --- |");
    for (const b of listed) {
      lines.push(`| \`${b.file}\` | ${b.line} | \`${b.target}\` |`);
    }
    lines.push("");
    if (scan.broken.length > listed.length) {
      lines.push(
        `> 只列了前 ${listed.length} 条，共 ${scan.broken.length} 条。`,
        "",
      );
    }
  }
  if (scan.truncated.files || scan.truncated.links) {
    lines.push(
      `> 本轮触到扫描上限（文件 ${MAX_FILES} / 链接 ${MAX_LINKS}），结果可能不完整。`,
      "",
    );
  }
  return lines.join("\n");
}

export const tools = [
  {
    name: "docs_link_check",
    description:
      "扫描工作区内 Markdown（.md/.mdx）的相对链接，列出指向不存在文件的断链（文件、行号、目标）。只读，不写盘。最多扫 400 个文档、5000 条链接。",
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
      const start = resolveInRoot(
        ctx.workspaceRoot,
        typeof args.path === "string" ? args.path : ".",
      );
      const scan = await scanLinks(ctx.workspaceRoot, start);
      return {
        ok: true,
        data: {
          root: path.resolve(ctx.workspaceRoot),
          scannedFiles: scan.scannedFiles,
          linksChecked: scan.linksChecked,
          linksSkipped: scan.linksSkipped,
          brokenCount: scan.broken.length,
          broken: scan.broken.slice(0, MAX_BROKEN_LISTED),
          brokenTruncated: scan.brokenTruncated,
          truncated: scan.truncated,
        },
      };
    },
  },
  {
    name: "docs_link_report",
    description:
      "扫描 Markdown 断链后生成一份报告文件（默认 docs-link-report.md）。这个工具自己不写盘：它把待写内容交给审批队列，用户批准后才落盘。",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对工作区根目录的扫描起点，默认 .",
        },
        out: {
          type: "string",
          description: "报告文件路径（相对工作区根目录，必须以 .md 结尾），默认 docs-link-report.md",
        },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const start = resolveInRoot(
        ctx.workspaceRoot,
        typeof args.path === "string" ? args.path : ".",
      );
      const outRel =
        typeof args.out === "string" && args.out.trim()
          ? args.out.trim()
          : "docs-link-report.md";
      if (!outRel.toLowerCase().endsWith(".md")) {
        return { ok: false, error: "out 必须以 .md 结尾" };
      }
      const outAbs = resolveInRoot(ctx.workspaceRoot, outRel);
      if (path.resolve(outAbs) === path.resolve(ctx.workspaceRoot)) {
        return { ok: false, error: "out 不能是工作区根目录本身" };
      }

      const scan = await scanLinks(ctx.workspaceRoot, start);
      const content = renderReport(ctx.workspaceRoot, start, scan);
      return {
        ok: true,
        requiresApproval: true,
        pendingWrite: {
          path: relPosix(ctx.workspaceRoot, outAbs),
          content,
        },
        data: {
          brokenCount: scan.broken.length,
          scannedFiles: scan.scannedFiles,
          linksChecked: scan.linksChecked,
          awaitingApproval: true,
        },
      };
    },
  },
];

export default { tools };
