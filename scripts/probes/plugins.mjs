#!/usr/bin/env node
/**
 * 插件探针：把仓库 plugins/ 下的真插件加载起来，用**仓库根目录**当工作区跑一遍，
 * 打印人类可读的真实输出（不是断言，断言在 packages/core/test/plugins-real.test.mjs）。
 *
 * 用途：演示插件系统不是 hello-world —— 每个插件都能在真实仓库上说出具体数字。
 * 用法：node scripts/probes/plugins.mjs [工作区路径]
 */

import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  loadLoomPlugins,
  pluginToolsToDefinitions,
} from "../../packages/core/dist/index.js";

const ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const WORKSPACE = path.resolve(process.argv[2] ?? ROOT);

const plugins = await loadLoomPlugins({ root: path.join(ROOT, "plugins") });
console.log(`[plugins] 工作区: ${WORKSPACE}`);
console.log(
  `[plugins] 加载 ${plugins.length} 个插件 / ${plugins.reduce((n, p) => n + p.tools.length, 0)} 个工具`,
);
for (const p of plugins) {
  console.log(
    `  - ${p.manifest.name}@${p.manifest.version}  ${p.tools.map((t) => t.name).join(", ")}` +
      (p.error ? `  ✗ ${p.error}` : ""),
  );
}

const defs = pluginToolsToDefinitions(plugins);
const call = (name, args) => {
  const def = defs.find((d) => d.name === name);
  if (!def) throw new Error(`插件工具 ${name} 不存在`);
  return def.execute(args, { workspaceRoot: WORKSPACE });
};

console.log("\n=== docs_link_check ===");
const docs = await call("docs_link_check", {});
console.log(
  `扫描 ${docs.data.scannedFiles} 个文档 / 校验 ${docs.data.linksChecked} 条链接 / 跳过 ${docs.data.linksSkipped} 条外部或锚点`,
);
console.log(`断链 ${docs.data.brokenCount} 条`);
for (const b of docs.data.broken.slice(0, 10)) {
  console.log(`  ${b.file}:${b.line}  ->  ${b.target}`);
}
if (docs.data.brokenCount > 10) console.log(`  … 其余 ${docs.data.brokenCount - 10} 条省略`);

console.log("\n=== docs_link_report（审批门禁，不落盘）===");
const report = await call("docs_link_report", {});
console.log(
  `ok=${report.ok} requiresApproval=${report.requiresApproval} pendingWrite.path=${report.pendingWrite?.path} 内容 ${report.pendingWrite?.content.length ?? 0} 字符`,
);
console.log(
  `文件是否已存在: ${(await import("node:fs")).existsSync(path.join(WORKSPACE, report.pendingWrite.path))}`,
);

console.log("\n=== deps_audit ===");
const deps = await call("deps_audit", {});
console.log(
  `包 ${deps.data.summary.packages} 个 / 源码文件 ${deps.data.summary.filesScanned} 个 / missing ${deps.data.summary.missing} / unused ${deps.data.summary.unused} / unusedDev ${deps.data.summary.unusedDev}`,
);
for (const p of deps.data.packages) {
  console.log(
    `  ${p.dir.padEnd(14)} files=${String(p.filesScanned).padStart(3)} imports=${String(p.importsSeen).padStart(3)} missing=[${p.missing.join(", ")}] unused=[${p.unused.join(", ")}] unusedDev=[${p.unusedDev.join(", ")}]`,
  );
}

console.log("\n=== git_summary ===");
const git = await call("git_summary", { logCount: 3 });
if (!git.data.isRepo) {
  console.log(`isRepo=false  reason=${git.data.reason}`);
  console.log(`hint: ${git.data.hint}`);
} else {
  const g = git.data;
  console.log(
    `分支 ${g.branch ?? "(未提交过)"}  改动 ${g.dirty.total}（staged ${g.dirty.staged} / unstaged ${g.dirty.unstaged} / untracked ${g.dirty.untracked}）  ${g.upstream.note}`,
  );
  console.log(`仓库根: ${g.repo.toplevel}  ${g.repo.note}`);
  console.log(`改动目录: ${g.topDirs.map((d) => `${d.dir}(${d.count})`).join(" ")}`);
  for (const c of g.recentCommits) console.log(`  ${c.hash} ${c.date} ${c.subject}`);
}
