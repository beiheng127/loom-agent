/**
 * 真实插件回归测试：直接加载仓库 `plugins/` 目录，跑插件工具的 execute。
 *
 * 为什么单独立一个文件：其它测试用的是内存里现造的假插件，只能证明"加载器逻辑对"；
 * 这个文件证明的是"仓库里这几个真插件真的能跑出正确结果"——
 * 插件是 .mjs，tsc 管不到，没有这层测试它们就没有任何回归网。
 */

import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  loadLoomPlugins,
  mergePluginTools,
  pluginToolsToDefinitions,
} from "../dist/index.js";

const execFileAsync = promisify(execFile);
const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../../..",
);
const PLUGINS_ROOT = path.join(REPO_ROOT, "plugins");

const EXPECTED_PLUGINS = [
  "deps-plugin",
  "docs-plugin",
  "git-plugin",
  "hello-plugin",
];
const EXPECTED_TOOLS = [
  "deps_audit",
  "docs_link_check",
  "docs_link_report",
  "git_summary",
  "hello_echo",
  "repo_wordcount",
];

let cached = null;

/** 加载一次真插件，全文件共用（每个用例重新加载纯属浪费） */
async function realPlugins() {
  if (!cached) {
    cached = await loadLoomPlugins({ root: PLUGINS_ROOT });
  }
  return cached;
}

async function realToolDefs() {
  return pluginToolsToDefinitions(await realPlugins());
}

async function toolDef(name) {
  const defs = await realToolDefs();
  const def = defs.find((d) => d.name === name);
  assert.ok(def, `没找到插件工具 ${name}`);
  return def;
}

/** 建一个临时目录当工作区 */
async function tmpWorkspace() {
  return fsp.mkdtemp(path.join(os.tmpdir(), "loom-plugin-"));
}

async function writeFile(abs, content) {
  await fsp.mkdir(path.dirname(abs), { recursive: true });
  await fsp.writeFile(abs, content, "utf8");
}

async function gitAvailable() {
  try {
    await execFileAsync("git", ["--version"]);
    return true;
  } catch {
    return false;
  }
}

test("仓库自带插件全部加载成功，工具名与预期一致", async () => {
  const plugins = await realPlugins();
  assert.deepEqual(
    plugins.map((p) => p.manifest.name).sort(),
    EXPECTED_PLUGINS,
  );
  // 任何一个插件带 error 都说明加载链出了岔子（失败只写 error 不抛）
  assert.deepEqual(
    plugins.filter((p) => p.error).map((p) => `${p.manifest.name}: ${p.error}`),
    [],
  );
  const toolNames = plugins.flatMap((p) => p.tools.map((t) => t.name)).sort();
  assert.deepEqual(toolNames, EXPECTED_TOOLS);
  // 每个工具都得有输入 schema，否则模型看不见参数
  for (const plugin of plugins) {
    for (const tool of plugin.tools) {
      assert.equal(
        tool.inputSchema?.type,
        "object",
        `${tool.name} 缺少 object 输入 schema`,
      );
    }
  }
});

test("插件的 requiresApproval 原样映射到 ToolDefinition", async () => {
  const defs = await realToolDefs();
  const approvalFlags = Object.fromEntries(
    defs.map((d) => [d.name, d.requiresApproval]),
  );
  assert.equal(approvalFlags.docs_link_report, true);
  assert.equal(approvalFlags.docs_link_check, false);
  assert.equal(approvalFlags.deps_audit, false);
  assert.equal(approvalFlags.git_summary, false);
});

test("重名去重：内置优先，插件之间先发现者优先", async () => {
  const plugins = await realPlugins();
  const { added, skipped } = mergePluginTools(["deps_audit"], plugins);
  assert.deepEqual(
    skipped.map((s) => s.name),
    ["deps_audit"],
  );
  assert.equal(skipped[0].reason, "与内置工具同名");
  assert.ok(!added.some((t) => t.name === "deps_audit"));
  // 没被顶掉的都还在
  assert.deepEqual(
    added.map((t) => t.name).sort(),
    ["docs_link_check", "docs_link_report", "git_summary", "hello_echo", "repo_wordcount"],
  );
});

test("deps_audit：报出「用了没声明」和「声明了没用」，内置模块与相对路径不算", async () => {
  const ws = await tmpWorkspace();
  await writeFile(
    path.join(ws, "package.json"),
    JSON.stringify({
      name: "fixture",
      dependencies: { "@fixture/declared-used": "^1.0.0", "@fixture/declared-unused": "^2.0.0" },
      devDependencies: { typescript: "^5.8.3" },
    }),
  );
  await writeFile(
    path.join(ws, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { paths: { "@/*": ["./src/*"] } } }),
  );
  await writeFile(
    path.join(ws, "src", "a.ts"),
    [
      'import { x } from "@fixture/declared-used";',
      'import other from "@fixture/used-undeclared";',
      'import helper from "@/lib/helper.js";',
      'import fs from "node:fs";',
      'import os from "os";',
      'import local from "./local.js";',
      "const key = n => `./x-${n}.js`;",
      "const dyn = await import(key(1));",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(ws, "src", "local.ts"), "export default 1;\n");
  // 归档目录（历史源码副本，如 docs/_snapshot）不该被当成这个包的源码
  await writeFile(
    path.join(ws, "src", "_snapshot", "old.ts"),
    'import archived from "@fixture/from-snapshot";\n',
  );

  const def = await toolDef("deps_audit");
  const result = await def.execute({}, { workspaceRoot: ws });

  assert.equal(result.ok, true);
  const pkg = result.data.packages.find((p) => p.name === "fixture");
  assert.ok(pkg, "没扫到 fixture 包");
  assert.deepEqual(pkg.missing, ["@fixture/used-undeclared"]);
  assert.deepEqual(pkg.unused, ["@fixture/declared-unused"]);
  // typescript 在 devDependencies 里但没人 import；它在工具链白名单里，不该报
  assert.deepEqual(pkg.unusedDev, []);
  assert.equal(pkg.importsSeen, 2, "只该认出 declared-used 与 used-undeclared");
  // tsconfig 里的 @/* 是路径别名，不是「用了没声明的包」
  assert.ok(!pkg.missing.includes("@/lib/helper.js"), "@/ 别名被误报成依赖");
  assert.deepEqual(pkg.aliases, ["@/"]);
  assert.ok(
    !pkg.missing.includes("@fixture/from-snapshot"),
    "_ 开头的归档目录被扫进来了",
  );
  assert.equal(result.data.summary.missing, 1);
});

test("deps_audit：宽松正则误报的形态一个都不能中（注释/字符串/多行导入/副作用导入）", async () => {
  const ws = await tmpWorkspace();
  await writeFile(
    path.join(ws, "package.json"),
    JSON.stringify({ name: "syntax", dependencies: { "@fixture/multiline": "^1.0.0" } }),
  );
  await writeFile(
    path.join(ws, "src", "b.ts"),
    [
      "// 这段注释里写着 import 和 from 两个词，后面还有引号 \" 故意钓鱼",
      "/* import c from \"@fixture/comment-fake\"; */",
      "import {",
      "  alpha,",
      "  beta,",
      "} from \"@fixture/multiline\";",
      "import \"@fixture/side-effect\";",
      "const legacy = require(\"@fixture/legacy\");",
      "const css = await import(\"./styles.css\");",
      "const words = \"import fake from \\\"@fixture/inside-string\\\"\";",
      "",
    ].join("\n"),
  );

  const def = await toolDef("deps_audit");
  const result = await def.execute({}, { workspaceRoot: ws });
  const pkg = result.data.packages.find((p) => p.name === "syntax");

  // 多行命名的 from、副作用 import、require 三种必须认出来
  assert.deepEqual(pkg.missing.sort(), [
    "@fixture/legacy",
    "@fixture/side-effect",
  ]);
  // 注释里的、字符串里的、动态非字面量的都不该被当成依赖
  assert.ok(!pkg.missing.includes("@fixture/comment-fake"));
  assert.ok(!pkg.missing.includes("@fixture/inside-string"));
  // 声明了的多行导入包不该被算成 unused
  assert.deepEqual(pkg.unused, []);
  assert.ok(
    result.data.packages.every((p) => p.missing.every((m) => !m.includes("\n"))),
    "说明符里不该出现换行（那是宽松正则吃穿行的旧 bug）",
  );
});

test("deps_audit 能在真实 monorepo 上跑完并看见 workspace 包名", async () => {
  const def = await toolDef("deps_audit");
  const result = await def.execute({ maxFiles: 5000 }, { workspaceRoot: REPO_ROOT });
  assert.equal(result.ok, true);
  const dirs = result.data.packages.map((p) => p.dir);
  assert.ok(dirs.includes("."), `根包没被扫到：${dirs.join(", ")}`);
  assert.ok(dirs.includes("packages/core"), `packages/core 没被扫到：${dirs.join(", ")}`);
  // @loom/core 是 workspace 内部包，apps/web 引用它不该被算成「用了没声明」
  const web = result.data.packages.find((p) => p.dir === "apps/web");
  assert.ok(web, "apps/web 没被扫到");
  assert.ok(
    !web.missing.includes("@loom/core"),
    `workspace 内部包被误报 missing：${web.missing.join(", ")}`,
  );
});

test("docs_link_check：只报真的断链，外部链接/锚点跳过", async () => {
  const ws = await tmpWorkspace();
  await writeFile(
    path.join(ws, "docs", "a.md"),
    [
      "# A",
      "[好链接](./b.md)",
      "[断链](./missing.md)",
      "[外部](https://example.com/x.md)",
      "[锚点](#a)",
      "[带锚点的深链](sub/c.md#sec)",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(ws, "docs", "b.md"), "# B\n");
  await writeFile(path.join(ws, "docs", "sub", "c.md"), "# C\n");

  const def = await toolDef("docs_link_check");
  const result = await def.execute({}, { workspaceRoot: ws });

  assert.equal(result.data.scannedFiles, 3);
  assert.equal(result.data.linksChecked, 3, "好链接/断链/带锚点深链共 3 条");
  assert.equal(result.data.linksSkipped, 2, "外部链接与锚点被跳过");
  assert.equal(result.data.brokenCount, 1);
  assert.deepEqual(result.data.broken, [
    { file: "docs/a.md", line: 3, target: "./missing.md" },
  ]);
});

test("docs_link_check：代码里的 ](...) 不算链接（围栏块 / 行内反引号）", async () => {
  const ws = await tmpWorkspace();
  await writeFile(
    path.join(ws, "docs", "code.md"),
    [
      "# 教人写正则",
      "",
      "```js",
      "// 围栏块里的假链接：[假](./nope.md)",
      "const re = /\\[([^\\]]*)\\]\\(([^)]+)\\)/;",
      "```",
      "",
      "行内 code span 里的正则 `[\"']([^\"']+)[\"']` 也不该被当成链接。",
      "",
      "双反引号包住单反引号也一样：`` `[\"']([^\"']+)[\"']` `` 不是链接。",
      "",
      "[真链接](./real.md)",
      "",
    ].join("\n"),
  );
  await writeFile(path.join(ws, "docs", "real.md"), "# real\n");

  const def = await toolDef("docs_link_check");
  const result = await def.execute({}, { workspaceRoot: ws });

  assert.equal(result.data.brokenCount, 0, `误报了：${JSON.stringify(result.data.broken)}`);
  assert.equal(result.data.linksChecked, 1, "只有真链接该被校验");
});

test("docs_link_report：自己不落盘，把 pendingWrite 交给审批队列", async () => {
  const ws = await tmpWorkspace();
  await writeFile(
    path.join(ws, "docs", "a.md"),
    "# A\n[断链](./nope.md)\n",
  );

  const def = await toolDef("docs_link_report");
  const result = await def.execute({}, { workspaceRoot: ws });

  // 走的是 pluginToolsToDefinitions 的包装：{ ok:boolean } 形状原样透传，
  // 所以 requiresApproval / pendingWrite 这两个门禁字段必须活着到 run.ts
  assert.equal(result.ok, true);
  assert.equal(result.requiresApproval, true);
  assert.equal(result.pendingWrite.path, "docs-link-report.md");
  assert.match(result.pendingWrite.content, /Markdown 断链报告/);
  assert.match(result.pendingWrite.content, /\.\/nope\.md/);
  assert.equal(result.data.brokenCount, 1);
  // 关键断言：没审批就绝不能有文件
  assert.equal(fs.existsSync(path.join(ws, "docs-link-report.md")), false);

  const bad = await def.execute({ out: "report.txt" }, { workspaceRoot: ws });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /\.md/);
});

test("git_summary：非仓库目录返回 isRepo:false，不抛错", async () => {
  const ws = await tmpWorkspace();
  const def = await toolDef("git_summary");
  const result = await def.execute({}, { workspaceRoot: ws });
  assert.equal(result.ok, true);
  assert.equal(result.data.isRepo, false);
  assert.ok(result.data.reason.length > 0);
});

test("git_summary：真仓库里给出分支、改动分桶与最近提交", async (t) => {
  if (!(await gitAvailable())) {
    t.skip("环境里没有 git");
    return;
  }
  const ws = await tmpWorkspace();
  const git = (args) => execFileAsync("git", args, { cwd: ws });
  await git(["init", "-b", "main"]);
  await git(["config", "user.email", "test@example.com"]);
  await git(["config", "user.name", "test"]);
  await git(["config", "commit.gpgsign", "false"]);
  await writeFile(path.join(ws, "tracked.ts"), "export const a = 1;\n");
  await git(["add", "-A"]);
  await git(["commit", "-m", "init fixture", "--no-verify"]);

  // 改一个已跟踪文件 + 新增一个未跟踪文件
  await writeFile(path.join(ws, "tracked.ts"), "export const a = 2;\n");
  await writeFile(path.join(ws, "fresh.md"), "# new\n");

  const def = await toolDef("git_summary");
  const result = await def.execute({ logCount: 3 }, { workspaceRoot: ws });

  const data = result.data;
  assert.equal(data.isRepo, true);
  assert.equal(data.branch, "main");
  assert.equal(data.dirty.total, 2);
  assert.equal(data.dirty.untracked, 1);
  assert.equal(data.dirty.unstaged, 1);
  assert.equal(data.dirty.clean, false);
  assert.equal(data.recentCommits[0].subject, "init fixture");
  assert.equal(data.upstream.tracked, false, "没 push 过就没有上游");
  assert.ok(data.files.includes("fresh.md"));
});
