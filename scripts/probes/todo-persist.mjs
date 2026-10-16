#!/usr/bin/env node
/**
 * 探针：todo 事件日志真的落盘、真的能跨进程回放。
 *
 * 用法（必须分两次跑，第二次是全新进程）：
 *   node scripts/probes/todo-persist.mjs write     # 进程 A：写 3 次 todo_write
 *   node scripts/probes/todo-persist.mjs replay    # 进程 B：空内存，只靠文件恢复
 *   node scripts/probes/todo-persist.mjs show      # 看日志文件原文
 *   node scripts/probes/todo-persist.mjs clean     # 删掉本次探针的日志
 *
 * 为什么要两个进程：内存版 store 在同一进程里怎么读都有值，
 * 「重启后还在不在」只有在**新进程**里才问得出答案。
 */

import { existsSync, readFileSync, rmSync } from "node:fs";

import { createFileTodoStore, findWorkspaceRoot, resolveTodoStoreDir } from "../../packages/core/dist/index.js";

const SESSION = "probe-todo";
const dir = resolveTodoStoreDir();
const store = createFileTodoStore({ dir });
const file = store.filePath(SESSION);
const action = process.argv[2] ?? "write";

const root = findWorkspaceRoot(process.cwd());
console.log(`仓库根   : ${root ?? "(没找到 workspaces，退化到 cwd)"}`);
console.log(`日志目录 : ${dir}`);
console.log(`会话文件 : ${file}\n`);

if (action === "write") {
  rmSync(file, { force: true });
  store.startTurn(SESSION);
  store.write(SESSION, [
    { content: "读 README 摸清架构", status: "completed" },
    { content: "给 todo 加落盘", status: "in_progress" },
    { content: "补跨进程回放测试", status: "pending" },
  ]);
  store.startTurn(SESSION);
  store.write(SESSION, [
    { content: "读 README 摸清架构", status: "completed" },
    { content: "给 todo 加落盘", status: "completed" },
    { content: "补跨进程回放测试", status: "in_progress" },
  ]);
  store.endTurn(SESSION);
  console.log(`✓ 两次 todo_write 已落盘（本进程内存里也有）`);
  console.log(`  文件存在 : ${existsSync(file)}`);
  console.log(`  文件行数 : ${readFileSync(file, "utf8").trim().split("\n").length}`);
  console.log(`  写盘告警 : ${store.warnings().length === 0 ? "无" : store.warnings().join(" | ")}`);
  console.log(`\n下一步（换一个进程）： node scripts/probes/todo-persist.mjs replay`);
} else if (action === "replay") {
  if (!existsSync(file)) {
    console.error(`✗ 没有日志文件，先跑 write：${file}`);
    process.exit(1);
  }
  const projection = store.projection(SESSION);
  const events = store.events(SESSION);
  console.log("全新进程、内存全空，只读文件：");
  console.log(`  回放事件数 : ${events.length}`);
  console.log(`  恢复的 turn : ${projection?.turn ?? "(无)"}`);
  console.log(`  恢复的清单 :`);
  for (const t of projection?.todos ?? []) {
    console.log(`    - [${t.status}] ${t.content}`);
  }
  // 恢复之后继续写，验证是「追加」而不是覆盖
  const event = store.write(SESSION, [
    ...(projection?.todos ?? []).map((t) => ({ ...t, status: "completed" })),
    { content: "验证追加而非覆盖", status: "pending" },
  ]);
  const lines = readFileSync(file, "utf8").trim().split("\n").length;
  console.log(`\n✓ 恢复后继续写：turn=${event.turn}，文件行数=${lines}（旧行还在 → 追加模式）`);
  console.log(`  写盘告警 : ${store.warnings().length === 0 ? "无" : store.warnings().join(" | ")}`);
} else if (action === "show") {
  if (!existsSync(file)) {
    console.error(`✗ 没有日志文件：${file}`);
    process.exit(1);
  }
  console.log(readFileSync(file, "utf8").trim());
} else if (action === "clean") {
  rmSync(file, { force: true });
  console.log(`✓ 已删除 ${file}`);
} else {
  console.error(`未知动作：${action}（可用：write / replay / show / clean）`);
  process.exit(2);
}
