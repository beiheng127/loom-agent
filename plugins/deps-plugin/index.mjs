/**
 * deps-plugin —— package.json 声明 vs 源码真实 import 的差异体检
 *
 * 为什么需要它：monorepo 里最容易烂掉的就是依赖声明。声明了不用的包会拖慢安装、
 * 扩大攻击面；用了没声明的包会在别人机器上装不上（本地因为 hoisting 恰好能跑）。
 * 这两类问题静态看一眼是查不出来的，得真扫一遍源码的 import 说明符。
 *
 * 做法（纯静态、离线、不联网、不装包）：
 * 1. 找 workspace 里的 package：根 package.json + workspaces glob（`packages/*`、`apps/*`）；
 * 2. 每个包里扫 src/app/lib/scripts/test 和根目录的 *config.*，抽出所有 import/require 说明符；
 * 3. 说明符归一成包名：`@scope/name/deep/path` -> `@scope/name`，相对路径和 node: 内置模块排除；
 * 4. 对比 declared（dependencies/devDependencies/peer/optional）：
 *    - `missing`   = 源码用了、四个字段里都没声明（同仓其它包名不算，那是 workspace 内部引用）；
 *    - `unused`    = `dependencies` 里声明了、源码一次都没 import；
 *    - `unusedDev` = devDependencies 里同样没用到，但排掉了类型包和纯 CLI 工具（噪音太大）。
 *
 * 已知局限（写在这里而不是让模型自己猜）：只认静态字面量说明符，
 * `await import(someVar)` 和纯 CLI 调用（如 `tsc` 只写在 npm scripts 里）都看不见 ——
 * 所以 unused 的结论是"疑似"，报告里也这么写。
 */

import fsp from "node:fs/promises";
import path from "node:path";
import { builtinModules } from "node:module";

/** 扫描上限 */
const MAX_FILES_DEFAULT = 2000;
const MAX_FILES_CAP = 20000;
const MAX_DEPTH = 12;
const MAX_LISTED = 30;
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
const SCANNED_DIRS = ["src", "app", "lib", "scripts", "test", "tests"];
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".mts",
  ".cts",
]);
/** 只写在 npm scripts 里、源码根本不 import 的工具链，报出来纯噪音 */
const DEV_TOOL_ALLOWLIST = new Set([
  "typescript",
  "eslint",
  "prettier",
  "rimraf",
  "concurrently",
  "tsx",
  "ts-node",
  "nodemon",
  "cross-env",
  "husky",
  "lint-staged",
  "npm-run-all",
  "vitest",
  "jest",
  "tsup",
  "esbuild",
]);
const BUILTIN_SET = new Set(builtinModules);

async function exists(p) {
  try {
    await fsp.access(p);
    return true;
  } catch {
    return false;
  }
}

async function readJson(p) {
  try {
    return JSON.parse(await fsp.readFile(p, "utf8"));
  } catch {
    return null;
  }
}

/** 说明符 -> 包名；相对路径、绝对路径、内置模块、URL、路径别名一律返回 null */
function toPackageName(spec) {
  if (!spec) return null;
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("\\")) return null;
  if (spec.includes("://")) return null;
  if (spec.startsWith("node:")) return null;
  // `@/x` 是 tsconfig 别名（作用域名是空的，不是合法包名）；`~/x`、`#x` 同理
  if (spec.startsWith("@/") || spec.startsWith("~") || spec.startsWith("#")) return null;
  const parts = spec.split(/[\\/]/);
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
  if (!name || name === "@") return null;
  if (BUILTIN_SET.has(name) || BUILTIN_SET.has(spec)) return null;
  return name;
}

/**
 * 读 tsconfig/jsconfig 的 `compilerOptions.paths`，返回别名前缀列表。
 * 少了这一步，`apps/web` 里的 `@/components`、`@/lib` 会被当成"用了没声明的包"——
 * 实测第一版就是这么误报的。按长度倒序返回，方便用前缀匹配（长前缀优先）。
 */
async function readAliasPrefixes(dirs) {
  const aliases = new Set();
  for (const dir of dirs) {
    for (const file of ["tsconfig.json", "tsconfig.base.json", "jsconfig.json"]) {
      const config = await readJson(path.join(dir, file));
      const paths = config?.compilerOptions?.paths;
      if (!paths || typeof paths !== "object") continue;
      for (const key of Object.keys(paths)) {
        const prefix = key.replace(/\*+$/, "");
        if (prefix) aliases.add(prefix);
      }
    }
  }
  return [...aliases].sort((a, b) => b.length - a.length);
}

/**
 * 从源码里抽 import 说明符。
 *
 * 第一版用的是一条宽松合并正则 `(?:from|import|require)\s*\(?\s*["']([^"']+)["']`，
 * 在真实 apps/web 上炸了：`[^"']+` 允许换行，于是源码里注释/字符串中的一个
 * `import` 字样会一路吃到几十行之后的第一个引号，抽出来一个含 `body.markdown) {`
 * 的"包名"。教训：抽 import 必须**按语法形态分模式**，并且禁止跨行、限制长度。
 *
 * 现在按语法形态分模式，并且两条约束：**必须行首起手**（避免字符串/注释里
 * 的 `import` 字样被当成语句）、**说明符本身不许含换行**（第一版就是靠
 * `[^"']+` 吃穿了十几行）。中间段允许换行（多行命名导入很常见），但用 `;`
 * 和引号锁住——语句结束符都没出现，就不可能跨过一条语句。
 * 五种形态：
 * - `import ... from "x"` / `import type ... from "x"`（含多行命名导入）
 * - `export ... from "x"`
 * - 副作用导入 `import "x"`
 * - 动态 `import("x")` 与 `require("x")`
 * 认不出的（`await import(变量)`）就是要认不出：宁漏勿错。
 */
const SPECIFIER_PATTERNS = [
  /^[ \t]*import\s+(?:type\s+)?[^;"']{0,400}?from\s*["']([^"'\n]+)["']/gm,
  /^[ \t]*export\s+(?:type\s+)?[^;"']{0,400}?from\s*["']([^"'\n]+)["']/gm,
  /^[ \t]*import\s*["']([^"'\n]+)["']/gm,
  /\bimport\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
  /\brequire\s*\(\s*["']([^"'\n]+)["']\s*\)/g,
];

function extractSpecifiers(text) {
  const found = [];
  for (const pattern of SPECIFIER_PATTERNS) {
    for (const m of text.matchAll(pattern)) found.push(m[1]);
  }
  return found;
}

async function collectSourceFiles(dir, depth, acc, limit) {
  if (depth > MAX_DEPTH || acc.length >= limit) return;
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (acc.length >= limit) return;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // 隐藏目录、以及 `_snapshot` / `_raw` 这类归档目录一律不进：
      // docs/_snapshot 里躺着历史源码副本，扫进来会报出一堆假依赖
      if (
        SKIP_DIRS.has(entry.name) ||
        entry.name.startsWith(".") ||
        entry.name.startsWith("_")
      )
        continue;
      await collectSourceFiles(full, depth + 1, acc, limit);
    } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
      acc.push(full);
    }
  }
}

/** 展开 workspaces 里的 `dir/*` 形态（不引第三方 glob 依赖） */
async function expandWorkspaces(root, pkg) {
  const dirs = new Set();
  const patterns = Array.isArray(pkg?.workspaces)
    ? pkg.workspaces
    : Array.isArray(pkg?.workspaces?.packages)
      ? pkg.workspaces.packages
      : ["packages/*", "apps/*"];
  for (const pattern of patterns) {
    const norm = String(pattern).replace(/\\/g, "/").replace(/\/+$/, "");
    if (!norm) continue;
    if (norm.endsWith("/*")) {
      const parent = path.join(root, norm.slice(0, -2));
      let entries = [];
      try {
        entries = await fsp.readdir(parent, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isDirectory()) dirs.add(path.join(parent, entry.name));
      }
    } else {
      dirs.add(path.join(root, norm));
    }
  }
  return [...dirs];
}

/** 扫一个包，返回 { files, usage }（usage: 包名 -> { count, sample }） */
async function scanPackage(pkgDir, limit, aliasPrefixes) {
  const files = [];
  for (const sub of SCANNED_DIRS) {
    const dir = path.join(pkgDir, sub);
    if (await exists(dir)) await collectSourceFiles(dir, 0, files, limit);
  }
  // 包根目录上的源码也要算：Electron 的 main.mjs、server.mjs、index.ts 就住在包根，
  // 只看 src/ 会把 apps/desktop 报成「0 个文件 + electron 声明了没用」（真发生过）
  try {
    const entries = await fsp.readdir(pkgDir, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      if (SOURCE_EXTENSIONS.has(path.extname(entry.name).toLowerCase())) {
        files.push(path.join(pkgDir, entry.name));
      }
    }
  } catch {
    // 读不了包根就只报子目录的结果
  }

  const usage = new Map();
  for (const file of files) {
    let text;
    try {
      text = await fsp.readFile(file, "utf8");
    } catch {
      continue;
    }
    // 按语法形态抽说明符（见 SPECIFIER_PATTERNS 的注释：宽松正则会在真实源码上误报）
    for (const raw of extractSpecifiers(text)) {
      // tsconfig 里声明的路径别名不是 npm 包，先按前缀排掉
      if (aliasPrefixes.some((prefix) => raw.startsWith(prefix))) continue;
      const name = toPackageName(raw);
      if (!name) continue;
      const entry = usage.get(name);
      if (entry) entry.count += 1;
      else usage.set(name, { count: 1, sample: raw });
    }
  }
  return { files: files.map((f) => path.relative(pkgDir, f)), usage };
}

function sortedList(items) {
  return [...items].sort((a, b) => a.localeCompare(b));
}

export const tools = [
  {
    name: "deps_audit",
    description:
      "静态体检 monorepo 依赖声明：逐个 package 对比 package.json 声明与源码真实 import，列出「用了没声明」(missing) 与「声明了没用」(dependencies: unused / devDependencies: unusedDev)。只读、离线、不联网、不装包；只认静态字面量导入，unused 结论是疑似。跳过 node_modules、dist/build、隐藏目录、`_` 开头的归档目录（如 docs/_snapshot），并按各包 tsconfig 的 paths 排除路径别名。",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        maxFiles: {
          type: "number",
          description: `每个包最多扫描的文件数，默认 ${MAX_FILES_DEFAULT}，上限 ${MAX_FILES_CAP}`,
        },
      },
      required: [],
      additionalProperties: false,
    },
    async execute(args, ctx) {
      const root = path.resolve(ctx.workspaceRoot);
      const requested = Number(args.maxFiles);
      const limit =
        Number.isFinite(requested) && requested >= 1
          ? Math.min(Math.floor(requested), MAX_FILES_CAP)
          : MAX_FILES_DEFAULT;

      const rootPkg = await readJson(path.join(root, "package.json"));
      if (!rootPkg) {
        return {
          ok: true,
          data: {
            root,
            packages: [],
            reason: `工作区根目录没有可解析的 package.json（${path.join(root, "package.json")}）`,
          },
        };
      }

      const pkgDirs = [root, ...(await expandWorkspaces(root, rootPkg))];
      const seen = new Set();
      const manifests = [];
      for (const dir of pkgDirs) {
        const abs = path.resolve(dir);
        if (seen.has(abs) || !(await exists(path.join(abs, "package.json")))) continue;
        seen.add(abs);
        const pkg = await readJson(path.join(abs, "package.json"));
        if (pkg) manifests.push({ dir: abs, pkg });
      }

      // 同仓其它包的包名：workspace 内部互相引用，不算 missing
      const workspaceNames = new Set(
        manifests.map((m) => m.pkg.name).filter((n) => typeof n === "string"),
      );

      const packages = [];
      for (const { dir, pkg } of manifests) {
        // 别名可能写在包自己的 tsconfig 里，也可能写在仓库根的 tsconfig 里
        const aliasPrefixes = await readAliasPrefixes([dir, root]);
        const { files, usage } = await scanPackage(dir, limit, aliasPrefixes);
        const deps = Object.keys(pkg.dependencies ?? {});
        const devDeps = Object.keys(pkg.devDependencies ?? {});
        const optional = Object.keys(pkg.optionalDependencies ?? {});
        const peer = Object.keys(pkg.peerDependencies ?? {});
        const declared = new Set([...deps, ...devDeps, ...optional, ...peer]);

        const missing = [];
        for (const [name] of usage) {
          if (declared.has(name) || workspaceNames.has(name)) continue;
          missing.push(name);
        }

        const unused = deps.filter((d) => !usage.has(d));
        const unusedDev = devDeps.filter(
          (d) =>
            !usage.has(d) &&
            !d.startsWith("@types/") &&
            !DEV_TOOL_ALLOWLIST.has(d) &&
            !workspaceNames.has(d),
        );

        packages.push({
          name: typeof pkg.name === "string" ? pkg.name : "(unnamed)",
          dir: path.relative(root, dir).split(path.sep).join("/") || ".",
          filesScanned: files.length,
          importsSeen: usage.size,
          declared: {
            dependencies: deps.length,
            devDependencies: devDeps.length,
            optionalDependencies: optional.length,
            peerDependencies: peer.length,
          },
          missing: sortedList(new Set(missing)),
          unused: sortedList(new Set(unused)),
          unusedDev: sortedList(new Set(unusedDev)),
          aliases: aliasPrefixes,
          missingCount: new Set(missing).size,
          unusedCount: new Set(unused).size,
          unusedDevCount: new Set(unusedDev).size,
        });
      }

      packages.sort((a, b) => a.dir.localeCompare(b.dir));
      const sum = (key) => packages.reduce((acc, p) => acc + p[key], 0);
      return {
        ok: true,
        data: {
          root,
          packages,
          summary: {
            packages: packages.length,
            filesScanned: sum("filesScanned"),
            missing: sum("missingCount"),
            unused: sum("unusedCount"),
            unusedDev: sum("unusedDevCount"),
          },
          caveats: [
            "只认静态字面量导入：await import(变量) 和 npm scripts 里的 CLI 看不见",
            "unused 是疑似清单，不是删除建议：有的包只在运行时被间接加载",
            `每个包最多扫 ${limit} 个文件，触顶时结果不完整`,
          ],
          listedLimit: MAX_LISTED,
        },
      };
    },
  },
];

export default { tools };
