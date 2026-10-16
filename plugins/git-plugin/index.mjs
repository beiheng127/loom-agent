/**
 * git-plugin —— 只读的仓库状态工具
 *
 * 为什么需要它：内置工具里没有 git。Agent 想「先看仓库状态再决定改什么」时，
 * 唯一的路子是 run_safe_cmd（要审批、输出是一坨原始文本）。这个插件把
 * git 的输出**解析成结构**再交给模型：分支、领先/落后、按状态分桶的改动文件、
 * 改动最集中的目录、最近几条提交。
 *
 * 三条硬约束：
 * 1. 只读。只跑 `rev-parse` / `status` / `log` / `rev-list`，不碰 commit/add/checkout。
 * 2. 不用 shell。execFile + 参数数组，工作区里出现 `; rm -rf /` 这种目录名也注入不了。
 * 3. 非 git 仓库 / 没装 git 都返回 ok:true + isRepo:false + 一句原因，不抛错 ——
 *    插件工具抛错会被包成 ok:false，模型会以为"工具坏了"，而这里其实是"没仓库"。
 */

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** 单条 git 命令超时（大仓库 status 也会慢，但不该挂住 Agent 循环） */
const GIT_TIMEOUT_MS = 5000;
/** stdout 上限，防止 log --stat 之类炸内存 */
const MAX_BUFFER = 2 * 1024 * 1024;
/** 报告里最多列几个改动文件 / 几个目录 / 几条提交 */
const MAX_FILES_LISTED = 40;
const MAX_DIRS_LISTED = 12;
const MAX_COMMITS_DEFAULT = 5;
const MAX_COMMITS_CAP = 20;

/** 跑一条 git 命令；失败不抛，返回 { ok, stdout | error } */
async function git(cwd, args) {
  try {
    const { stdout } = await execFileAsync("git", args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      windowsHide: true,
    });
    return { ok: true, stdout: stdout ?? "" };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/** 把 args.path 解析到工作区内；越界就退回工作区根（插件不该被 `../..` 带出去） */
function resolveInRoot(workspaceRoot, rel) {
  const root = path.resolve(workspaceRoot);
  const target = path.resolve(root, typeof rel === "string" && rel ? rel : ".");
  const withSep = root.endsWith(path.sep) ? root : root + path.sep;
  if (target !== root && !target.startsWith(withSep)) return root;
  return target;
}

/** 解析 `git status --porcelain` 的每一行：XY <path> */
function parseStatus(stdout) {
  const staged = [];
  const unstaged = [];
  const untracked = [];
  for (const raw of stdout.split("\n")) {
    if (!raw.trim()) continue;
    const x = raw[0] ?? " ";
    const y = raw[1] ?? " ";
    // 重命名行是 `R  old -> new`，取箭头右边才是现在的路径
    let file = raw.slice(3).trim();
    const arrow = file.indexOf(" -> ");
    if (arrow >= 0) file = file.slice(arrow + 4);
    file = file.replace(/^"|"$/g, "");
    if (x === "?" && y === "?") untracked.push(file);
    else {
      if (x !== " ") staged.push({ file, code: x });
      if (y !== " ") unstaged.push({ file, code: y });
    }
  }
  return { staged, unstaged, untracked };
}

/** 改动最集中的顶层目录：root 下第一段路径，没有斜杠的算 "(根目录)" */
function topDirs(files) {
  const counter = new Map();
  for (const f of files) {
    const norm = f.replace(/\\/g, "/");
    const seg = norm.includes("/") ? norm.split("/")[0] : "(根目录)";
    counter.set(seg, (counter.get(seg) ?? 0) + 1);
  }
  return [...counter.entries()]
    .map(([dir, count]) => ({ dir, count }))
    .sort((a, b) => b.count - a.count || a.dir.localeCompare(b.dir))
    .slice(0, MAX_DIRS_LISTED);
}

export const tools = [
  {
    name: "git_summary",
    description:
      "汇总当前工作区的 git 状态：分支、领先/落后上游多少提交、按 staged/unstaged/untracked 分桶的改动文件、改动最集中的目录、最近几条提交。只读；非 git 仓库或未安装 git 时返回 isRepo:false 与原因，不报错。",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对工作区根目录的子目录，只看这个范围，默认 .（工作区根）",
        },
        logCount: {
          type: "number",
          description: `最近提交条数，1-${MAX_COMMITS_CAP}，默认 ${MAX_COMMITS_DEFAULT}`,
        },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const cwd = resolveInRoot(
        ctx.workspaceRoot,
        typeof args.path === "string" ? args.path : ".",
      );

      const probe = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
      const inside = probe.ok && probe.stdout.trim() === "true";
      if (!inside) {
        const noGit =
          !probe.ok && /ENOENT|not recognized|not found/i.test(probe.error ?? "");
        return {
          ok: true,
          data: {
            isRepo: false,
            cwd,
            reason: noGit
              ? "找不到 git 可执行文件（PATH 里没有 git）"
              : "该目录不在 git 工作树内",
            hint: noGit
              ? "装上 git 后重试"
              : "需要在仓库根执行 git init；初始化前这个工具帮不上忙",
          },
        };
      }

      const requested = Number(args.logCount);
      const logCount =
        Number.isFinite(requested) && requested >= 1
          ? Math.min(Math.floor(requested), MAX_COMMITS_CAP)
          : MAX_COMMITS_DEFAULT;

      // \x1f 是 ASCII 单元分隔符：提交信息里带 | 也不会把字段切错
      const [branchRes, statusRes, logRes, trackRes, stashRes, topRes] =
        await Promise.all([
          git(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]),
          git(cwd, ["status", "--porcelain=v1", "-uall"]),
          git(cwd, [
            "log",
            `-n`,
            String(logCount),
            "--date=short",
            "--pretty=format:%h\x1f%ad\x1f%s",
          ]),
          git(cwd, ["rev-list", "--left-right", "--count", "@{upstream}...HEAD"]),
          git(cwd, ["stash", "list"]),
          git(cwd, ["rev-parse", "--show-toplevel"]),
        ]);

      // HEAD 还没提交过（刚 init）时 `--abbrev-ref HEAD` 会失败而不是返回 main，
      // 这时给 null + 一句原因，别编一个分支名出来
      const branch = branchRes.ok ? branchRes.stdout.trim() : null;
      const unborn = !branchRes.ok;
      const toplevel = topRes.ok ? topRes.stdout.trim() : null;
      const workspaceRootAbs = path.resolve(ctx.workspaceRoot);
      const isWorkspaceRoot = toplevel !== null && path.resolve(toplevel) === workspaceRootAbs;
      const buckets = parseStatus(statusRes.ok ? statusRes.stdout : "");
      const allChanged = [
        ...buckets.staged.map((e) => e.file),
        ...buckets.unstaged.map((e) => e.file),
        ...buckets.untracked,
      ];

      let ahead = null;
      let behind = null;
      if (trackRes.ok) {
        const [behindRaw, aheadRaw] = trackRes.stdout.trim().split(/\s+/);
        const b = Number(behindRaw);
        const a = Number(aheadRaw);
        if (Number.isFinite(a) && Number.isFinite(b)) {
          ahead = a;
          behind = b;
        }
      }

      const commits = logRes.ok
        ? logRes.stdout
            .split("\n")
            .map((line) => line.trim())
            .filter(Boolean)
            .map((line) => {
              const [hash = "", date = "", subject = ""] = line.split("\x1f");
              return { hash, date, subject };
            })
        : [];

      return {
        ok: true,
        data: {
          isRepo: true,
          cwd,
          branch,
          unborn,
          detached: branch === "HEAD",
          repo: {
            // 工作区可能只是某个外层仓库的子目录（比如 ~/Desktop 被 init 过）：
            // 这种情况 status 会带上外层仓库的上下文，必须让模型看见 toplevel
            toplevel,
            isWorkspaceRoot,
            note: isWorkspaceRoot
              ? "工作区本身就是仓库根"
              : toplevel
                ? `工作区只是外层仓库的子目录，仓库根在 ${toplevel}`
                : "拿不到仓库根路径",
          },
          upstream: {
            // null 表示这个分支没有上游（还没 push 过），不是"和上游一样"
            tracked: trackRes.ok ? branch !== "HEAD" : false,
            ahead,
            behind,
            note: trackRes.ok
              ? ahead === 0 && behind === 0
                ? "与上游一致"
                : `领先 ${ahead}、落后 ${behind}`
              : "没有上游分支（或上游已删除）",
          },
          dirty: {
            total: allChanged.length,
            staged: buckets.staged.length,
            unstaged: buckets.unstaged.length,
            untracked: buckets.untracked.length,
            clean: allChanged.length === 0,
          },
          stashes: stashRes.ok
            ? stashRes.stdout.trim()
              ? stashRes.stdout.trim().split("\n").length
              : 0
            : null,
          topDirs: topDirs(allChanged),
          files: allChanged.slice(0, MAX_FILES_LISTED),
          filesTruncated: allChanged.length > MAX_FILES_LISTED,
          recentCommits: commits,
          limits: {
            gitTimeoutMs: GIT_TIMEOUT_MS,
            filesListed: MAX_FILES_LISTED,
            logCount,
          },
        },
      };
    },
  },
];

export default { tools };
