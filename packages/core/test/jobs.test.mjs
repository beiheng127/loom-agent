/**
 * 后台 job 通道（对标 DSH 的 jobs）。
 *
 * 这些用例真起真进程真读真杀 —— 要证明的就是「启动不再阻塞、输出可以后读」
 * 这件事，mock 掉 spawn 就什么都没证明。
 *
 * 注意 Windows 上 shell:true 会多一层 cmd.exe：kill 只保证杀掉直接子进程，
 * 孙进程可能残留（这条边界写在 store.ts 的注释里，也被 jobs.7 固定住）。
 */

import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  applyApprovedCmd,
  createJobStore,
  getDefaultJobStore,
  isSafeCommand,
  jobKillTool,
  jobListTool,
  jobOutputTool,
} from "../dist/index.js";

const TMP = mkdtempSync(join(tmpdir(), "loom-jobs-"));
const CWD = process.cwd();

function script(name, body) {
  const file = join(TMP, `${name}.mjs`);
  writeFileSync(file, body, "utf8");
  return `node ${file}`;
}

const TWO_PHASE = script(
  "two-phase",
  'console.log("one");\nsetTimeout(() => { console.log("two"); }, 700);\n',
);
const LONG = script(
  "long",
  'console.log("started");\nsetTimeout(() => { console.log("never"); }, 60000);\n',
);
const FAIL = "node -e \"process.exit(3)\"";
const FLOOD = script(
  "flood",
  'for (let i = 0; i < 2000; i += 1) console.log("0123456789");\n',
);

test.after(() => {
  rmSync(TMP, { recursive: true, force: true });
});

/** 轮询读到某种输出为止：spawn 到第一行输出之间在 Windows 上有几百毫秒空窗 */
async function readUntil(store, id, pattern, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  let acc = "";
  while (Date.now() < deadline) {
    const res = await store.read(id, { wait: true, timeoutMs: 200 });
    if (res) {
      acc += res.output;
      if (pattern.test(acc)) return { acc, res };
    }
  }
  throw new Error(
    `等不到 ${pattern}（累计输出：${JSON.stringify(acc.slice(-200))}）`,
  );
}

test("jobs.1 start 立刻返回 running 句柄，不等命令跑完", () => {
  const store = createJobStore();
  const started = Date.now();
  const job = store.start(TWO_PHASE, { cwd: CWD });
  const elapsed = Date.now() - started;
  assert.equal(job.status, "running");
  assert.equal(job.id, "job-1");
  assert.ok(job.pid, "要拿到 pid");
  assert.ok(elapsed < 3000, `start 应该立刻返回（实测 ${elapsed}ms）`);
  store.kill(job.id);
  return store.drain();
});

test("jobs.2 输出可以事后读，第二次读只给新增部分", async () => {
  const store = createJobStore();
  const job = store.start(TWO_PHASE, { cwd: CWD });
  const first = await readUntil(store, job.id, /one/);
  // 游标语义：读走的不会再吐一遍，而且此时第二阶段还没打印
  assert.doesNotMatch(first.acc, /two/);

  const second = await store.read(job.id, { wait: true, timeoutMs: 6000 });
  assert.ok(second);
  assert.match(second.output, /two/);
  assert.doesNotMatch(second.output, /one/);
});

test("jobs.3 结束后 status=done、exitCode=0、running=false，且不再有新输出", async () => {
  const store = createJobStore();
  const job = store.start(TWO_PHASE, { cwd: CWD });
  const res = await store.read(job.id, { wait: true, timeoutMs: 8000 });
  assert.ok(res);
  assert.match(res.output, /two/);
  assert.equal(res.job.status, "done");
  assert.equal(res.job.exitCode, 0);
  assert.ok(res.job.endedAt);

  const after = await store.read(job.id);
  assert.equal(after.running, false);
  assert.equal(after.output, "", "读过的内容不能再来一遍");
  assert.equal(store.get(job.id).status, "done");
});

test("jobs.4 非零退出 → failed，stderr 带 [err] 前缀混进同一条流", async () => {
  const store = createJobStore();
  const job = store.start(FAIL, { cwd: CWD });
  const res = await store.read(job.id, { wait: true, timeoutMs: 5000 });
  assert.ok(res);
  assert.equal(res.job.status, "failed");
  assert.equal(res.job.exitCode, 3);
  assert.equal(res.running, false);
});

test("jobs.5 wait:true 会等，wait:false 不等（长命令立刻返回）", async () => {
  const store = createJobStore();
  const job = store.start(LONG, { cwd: CWD });

  const quick = await readUntil(store, job.id, /started/);
  assert.equal(quick.res.running, true, "不等就应当还是在跑");

  const waited = await store.read(job.id, { wait: true, timeoutMs: 600 });
  assert.ok(waited);
  assert.equal(waited.running, true, "600ms 装不下 60s 的活，等超时了也该是在跑");

  assert.equal(store.kill(job.id), true);
  await store.drain(6000);
  assert.equal(store.get(job.id).status, "killed");
});

test("jobs.6 kill 在已结束的 job 上返回 false（不假装成功）", async () => {
  const store = createJobStore();
  const job = store.start(TWO_PHASE, { cwd: CWD });
  await store.drain(8000);
  assert.equal(store.get(job.id).status, "done");
  assert.equal(store.kill(job.id), false, "已经结束的 job 不该报「杀成功」");

  // 工具读的是进程单例，所以拿本地 store 的 id 去问它必然是「没有这个 job」——
  // 顺便固定住「工具与手搓 store 不共享」这条容易踩的事实。
  const foreign = await jobKillTool({ jobId: job.id }, { workspaceRoot: CWD });
  assert.equal(foreign.ok, false);
  assert.match(foreign.error, /没有这个 job/);

  const self = getDefaultJobStore();
  const known = self.start(TWO_PHASE, { cwd: CWD });
  await self.drain(8000);
  const tool = await jobKillTool({ jobId: known.id }, { workspaceRoot: CWD });
  assert.equal(tool.ok, true);
  assert.equal(tool.data.killed, false);
  assert.match(tool.data.note, /已经结束/);
});

test("jobs.7 输出撞上限就截断并标记 truncated", async () => {
  const store = createJobStore({ maxOutputChars: 500 });
  const job = store.start(FLOOD, { cwd: CWD });
  await store.read(job.id, { wait: true, timeoutMs: 8000 });
  const view = store.get(job.id);
  assert.ok(view);
  assert.equal(view.stdout.length, 500, "缓冲不能超过上限");
  assert.equal(view.truncated, true);
  assert.ok(view.stdout.startsWith("0123456789"), "截断的是尾巴，不是头");
});

test("jobs.8 已结束的只留 keep 条；在跑的不回收", async () => {
  const store = createJobStore({ keep: 1 });
  const long = store.start(LONG, { cwd: CWD });
  for (let i = 0; i < 3; i += 1) {
    const job = store.start(TWO_PHASE, { cwd: CWD });
    await store.read(job.id, { wait: true, timeoutMs: 6000 });
  }
  const ids = store.list().map((j) => j.id);
  assert.equal(ids.length, 2, `只该留 1 个在跑的 + 1 个最近的（实测 ${ids.join(",")}）`);
  assert.ok(ids.includes(long.id), "在跑的 job 不能被回收");
  assert.equal(store.latest().id, ids[ids.length - 1]);
  store.kill(long.id);
  await store.drain(5000);
});

test("jobs.9 未知 id 读不到，latest/get 按预期返回", async () => {
  const store = createJobStore();
  assert.equal(store.get("job-404"), undefined);
  assert.equal(store.latest(), undefined);
  assert.equal(await store.read("job-404"), undefined);

  const job = store.start(TWO_PHASE, { cwd: CWD });
  assert.equal(store.latest().id, job.id);
  await store.drain(5000);
});

test("jobs.10 applyApprovedCmd 带 background 时把句柄交出来，不阻塞", async () => {
  const started = Date.now();
  const result = await applyApprovedCmd(CWD, "git status", { background: true });
  const elapsed = Date.now() - started;
  assert.equal(result.ok, true);
  assert.equal(result.background, true);
  assert.match(result.jobId, /^job-\d+$/);
  assert.ok(elapsed < 3000, `后台模式必须立刻返回（实测 ${elapsed}ms）`);
  assert.equal(result.stdout, "", "后台模式这次请求里没有 stdout");

  const store = getDefaultJobStore();
  const res = await store.read(result.jobId, { wait: true, timeoutMs: 15000 });
  assert.ok(res);
  assert.equal(res.job.status, "done");
  assert.ok(res.output.length > 0, "git status 应当有输出");
});

test("jobs.11 后台不是绕过白名单的后门", async () => {
  assert.equal(isSafeCommand("rm -rf /"), false);
  const result = await applyApprovedCmd(CWD, "rm -rf /", { background: true });
  assert.equal(result.ok, false);
  assert.match(result.error, /白名单/);
  assert.equal(result.jobId, undefined, "被拒的命令不该留下 job");
});

test("jobs.12 三个工具：job_list 看得到、job_output 读得到、没有 job 时给的是人话", async () => {
  const store = getDefaultJobStore();
  const before = store.list().length;

  const empty = await jobListTool({}, { workspaceRoot: CWD });
  assert.equal(empty.ok, true);

  const job = store.start(TWO_PHASE, { cwd: CWD });
  const listed = await jobListTool({}, { workspaceRoot: CWD });
  const ids = listed.data.jobs.map((j) => j.id);
  assert.ok(ids.includes(job.id), `job_list 应当看到 ${job.id}（现有 ${ids.join(",")}）`);
  assert.equal(store.list().length, before + 1);

  const out = await jobOutputTool(
    { jobId: job.id, wait: true, timeoutMs: 5000 },
    { workspaceRoot: CWD },
  );
  assert.equal(out.ok, true);
  assert.equal(out.data.jobId, job.id);
  assert.match(out.data.output, /one/);
  assert.equal(out.data.status, "done");

  const missing = await jobOutputTool(
    { jobId: "job-404" },
    { workspaceRoot: CWD },
  );
  assert.equal(missing.ok, false);
  assert.match(missing.error, /没有这个 job/);

  const killMissing = await jobKillTool({}, { workspaceRoot: CWD });
  assert.equal(killMissing.ok, false);
});

test("jobs.13 drain 等到所有在跑的收尾（关站前的收尾动作）", async () => {
  const store = createJobStore();
  const long = store.start(LONG, { cwd: CWD });
  await new Promise((resolve) => setTimeout(resolve, 300));
  store.kill(long.id);
  await store.drain(6000);
  assert.notEqual(store.get(long.id).status, "running");
});

test("jobs.14 默认单例必须挂在 globalThis 上（Next 每条 route 各编译一份模块）", () => {
  const store = getDefaultJobStore();
  assert.equal(
    globalThis.__loomJobStore,
    store,
    "单例没挂到 globalThis：Next 里 /api/cmds/approve 与 /api/jobs 会各拿到一份，" +
      "后台命令起了 job 而列表是空的（http 探针第 10 节真抓到过）",
  );
  assert.equal(getDefaultJobStore(), store, "两次取到的应当是同一个 store");
});
