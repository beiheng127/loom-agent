#!/usr/bin/env node
/**
 * 探针：插件「热加载」到底是不是真的
 *
 * 背景：Node 的 ESM 缓存按 URL 存，同一个入口第二次 `import()` 直接返回旧模块。
 * 早先 registry.ts 只写 `import(pathToFileURL(entry))`，于是 Studio 里改插件代码
 * 必须重启才生效——但那会被当成「热加载」，是假的。
 *
 * 这个探针就是拆穿/守住它的：改一行插件源码（改工具名）→ 不重启 → 再问 /api/meta。
 * 工具名跟着变 = 真热加载；没变 = 又退回重启才生效。
 *
 * 用法：先起 Studio（默认 3010），再 `node scripts/probes/plugin-hot.mjs`。
 * 探针会在 finally 里把源文件恢复原样（并校验恢复成功）。
 */

import fs from "node:fs/promises";
import path from "node:path";

const BASE = process.env.LOOM_BASE ?? "http://127.0.0.1:3010";
const PLUGIN_DIR = "deps-plugin";
const ENTRY = "index.mjs";
const FROM = 'name: "deps_audit"';
const TO = 'name: "deps_audit_hotprobe"';

let pass = 0;
let fail = 0;

function ok(msg) {
  pass += 1;
  console.log(`PASS  ${msg}`);
}

function no(msg) {
  fail += 1;
  console.log(`FAIL  ${msg}`);
}

async function meta() {
  const res = await fetch(`${BASE}/api/meta`);
  if (!res.ok) throw new Error(`GET /api/meta -> ${res.status}`);
  return res.json();
}

/** 把插件源码里的工具名换成 TO，并把 mtime 往前推（复现「刚存盘」） */
async function renameTool(entryPath, from, to) {
  const before = await fs.readFile(entryPath, "utf8");
  if (!before.includes(from)) {
    throw new Error(`源码里找不到 ${from}（插件改过了？）`);
  }
  const after = before.replace(from, to);
  if (after === before) throw new Error("替换没生效，探针逻辑有问题");
  await fs.writeFile(entryPath, after);
  const future = new Date(Date.now() + 2000);
  await fs.utimes(entryPath, future, future);
  return before;
}

// /api/meta 里既有内置工具名数组（toolNames），也有插件清单 harness.plugins[].tools
const toolNames = (m) => [
  ...(m.toolNames ?? []).map(String),
  ...(m.harness?.plugins ?? []).flatMap((p) => (p.tools ?? []).map(String)),
];

async function main() {
  const first = await meta();
  const pluginsRoot = first.harness?.pluginsRoot;
  if (!pluginsRoot) throw new Error("/api/meta 没给 harness.pluginsRoot");
  const entryPath = path.join(pluginsRoot, PLUGIN_DIR, ENTRY);
  const model = first.preferredModelId ?? "?";

  ok(`Studio 在 ${BASE}（默认模型 ${model}），插件根目录 ${pluginsRoot}`);

  const names0 = toolNames(first);
  if (!names0.includes("deps_audit")) {
    no(`初始工具表里没有 deps_audit：${names0.join(", ")}`);
    return;
  }
  ok(`改之前：/api/meta 有 deps_audit（共 ${names0.length} 个工具）`);

  let original = null;
  try {
    original = await renameTool(entryPath, FROM, TO);
    ok(`改源码：${FROM} → ${TO}（mtime 往前推 2 秒），不重启 Studio`);

    const second = await meta();
    const names1 = toolNames(second);

    if (names1.includes("deps_audit_hotprobe") && !names1.includes("deps_audit")) {
      ok("不重启就拿到了新工具名 —— 真热加载（mtime 破 ESM 缓存生效）");
    } else if (names1.includes("deps_audit")) {
      no(
        `改完还是旧工具名（${names1.join(", ")}）—— 模块缓存没打破，热加载是假的，得重启才生效`,
      );
    } else {
      no(`工具表变成一个都没见过的样子：${names1.join(", ")}`);
    }
  } finally {
    if (original !== null) {
      await fs.writeFile(entryPath, original);
      const back = await fs.readFile(entryPath, "utf8");
      if (back === original) {
        ok("已把插件源码恢复原样（回读一致）");
      } else {
        no("插件源码恢复失败，请手工检查 " + entryPath);
      }
    }
  }

  console.log(`\n# plugin-hot: ${pass} pass, ${fail} fail`);
  process.exitCode = fail === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(`探针自己挂了：${err.stack ?? err}`);
  process.exitCode = 1;
});
