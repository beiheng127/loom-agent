#!/usr/bin/env node
/**
 * 探针：后台 job 通道（对标 DSH 的 jobs）
 *
 * 要证明的四件事：
 *   1. start 立刻返回，不阻塞（长命令不再占着循环等超时）
 *   2. 输出可以事后读，而且第二次读只给新增部分（游标语义）
 *   3. kill 真能收掉（Windows 上要杀整棵树，不然孙进程占着管道，
 *      状态会永远停在 running）
 *   4. 后台不是绕过白名单的后门
 *
 * 纯库级：不用起 Studio、不用 API key。
 * 用法：node scripts/probes/jobs.mjs
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const { createJobStore, applyApprovedCmd, isSafeCommand } = await import(
  pathToFileURL(path.join(REPO, "packages", "core", "dist", "index.js")).href
);

let pass = 0;
let fail = 0;
const ok = (m) => {
  pass += 1;
  console.log(`PASS  ${m}`);
};
const no = (m) => {
  fail += 1;
  console.log(`FAIL  ${m}`);
};

const TMP = mkdtempSync(path.join(tmpdir(), "loom-jobs-probe-"));
const write = (name, body) => {
  const file = path.join(TMP, `${name}.mjs`);
  writeFileSync(file, body, "utf8");
  return `node ${file}`;
};
const TWO = write(
  "two",
  'console.log("first");\nsetTimeout(() => { console.log("second"); }, 700);\n',
);
const LONG = write(
  "long",
  'console.log("started");\nsetTimeout(() => { console.log("never"); }, 60000);\n',
);

const store = createJobStore();

async function readUntil(pattern, id, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let acc = "";
  while (Date.now() < deadline) {
    const res = await store.read(id, { wait: true, timeoutMs: 200 });
    if (res) {
      acc += res.output;
      if (pattern.test(acc)) return acc;
    }
  }
  throw new Error(`等不到 ${pattern}`);
}

try {
  console.log(`工作目录：${process.cwd()}`);
  console.log(`临时脚本：${TMP}\n`);

  // 1. 启动不阻塞
  const t0 = Date.now();
  const job = store.start(LONG, { cwd: REPO });
  const startMs = Date.now() - t0;
  if (job.status === "running" && job.pid) {
    ok(`start 立刻返回：id=${job.id} pid=${job.pid} 耗时 ${startMs}ms（命令要跑 60s）`);
  } else {
    no(`start 没有立刻返回 running 句柄：${JSON.stringify(job)}`);
  }

  // 2. 输出事后读 + 游标
  const first = await readUntil(/started/, job.id);
  if (/started/.test(first)) ok(`job_output 读到第一段输出：${JSON.stringify(first.trim())}`);
  else no("读不到第一段输出");

  const rewind = await store.read(job.id, { wait: true, timeoutMs: 300 });
  if (rewind.output === "") ok("第二次读只给新增（游标语义成立，没有重复吐）");
  else no(`第二次读又吐了旧内容：${JSON.stringify(rewind.output.slice(0, 80))}`);

  // 3. kill 要真收掉
  const killed = store.kill(job.id);
  await store.drain(8000);
  const view = store.get(job.id);
  if (killed && view.status === "killed") {
    ok(`kill 生效：status=${view.status}（还在 running 就说明孙进程占着管道）`);
  } else {
    no(`kill 之后状态不对：killed=${killed} status=${view?.status}`);
  }

  // 4. 自然结束 + 退出码
  const done = store.start(TWO, { cwd: REPO });
  const legacy = await readUntil(/first/, done.id);
  if (/first/.test(legacy)) ok("新 job 的 stdout 能读到");
  const rest = await store.read(done.id, { wait: true, timeoutMs: 6000 });
  if (rest.output.includes("second") && rest.job.status === "done" && rest.job.exitCode === 0) {
    ok("跑完：status=done exit=0，且两段输出各自只读一次");
  } else {
    no(`收尾不对：${JSON.stringify({ out: rest.output, status: rest.job.status, code: rest.job.exitCode })}`);
  }

  // 5. 后台不是绕过白名单的后门
  if (isSafeCommand("rm -rf /") === false) ok("白名单判定：rm -rf / 被拒");
  else no("rm -rf / 竟然在白名单里");
  const denied = await applyApprovedCmd(REPO, "rm -rf /", { background: true });
  if (denied.ok === false && !denied.jobId) ok("带 background 也过不了白名单，没有留下 job");
  else no(`后台模式绕过了白名单：${JSON.stringify(denied)}`);

  // 6. 真起一个 git job（走完整链路）
  const git = await applyApprovedCmd(REPO, "git status", { background: true });
  if (git.ok && git.jobId) ok(`git status 后台启动：jobId=${git.jobId}，请求立刻返回`);
  else no(`git status 后台启动失败：${JSON.stringify(git)}`);
  if (git.jobId) {
    const res = await createJobStoreCheck(git.jobId);
    if (res) ok(res);
    else no("git job 读不到输出");
  }

  async function createJobStoreCheck(jobId) {
    const { getDefaultJobStore } = await import(
      pathToFileURL(path.join(REPO, "packages", "core", "dist", "index.js")).href
    );
    const def = getDefaultJobStore();
    const out = await def.read(jobId, { wait: true, timeoutMs: 15000 });
    if (!out) return null;
    return `默认单例里读到 git job：status=${out.job.status} 输出 ${out.output.trim().split("\n").length} 行`;
  }

  // 7. 列表给的是人话
  const listed = store.list();
  if (listed.length >= 2) ok(`job_list 看得到 ${listed.length} 个 job（含已结束的）`);
  else no(`列表少了：${listed.length}`);
  console.log(
    "\n" + listed.map((j) => `  ${j.id.padEnd(8)} ${j.status.padEnd(7)} ${j.command}`).join("\n"),
  );
} finally {
  rmSync(TMP, { recursive: true, force: true });
}

console.log(`\n${pass} pass / ${fail} fail`);
process.exit(fail === 0 ? 0 : 1);
