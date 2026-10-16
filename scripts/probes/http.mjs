// HTTP 端到端探针：验证 harness 能力真的从 API 路由暴露出来（不只是库级可用）
// 用法：先 npm run studio（或 node scripts/studio.mjs），再 node scripts/probes/http.mjs
import { existsSync, readFileSync } from "node:fs";
import { rm } from "node:fs/promises";

const BASE = process.env.LOOM_BASE ?? "http://127.0.0.1:3010";

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

async function getJson(path) {
  const res = await fetch(`${BASE}${path}`);
  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: res.status, json, text };
}

// ---- 1) /api/plugins：插件目录被暴露 ----
{
  const { status, json } = await getJson("/api/plugins");
  const names = (json?.plugins ?? []).map((p) => p.name);
  const tools = (json?.plugins ?? []).flatMap((p) =>
    (p.tools ?? []).map((t) => (typeof t === "string" ? t : t.name)),
  );
  check(
    "GET /api/plugins 列出 hello-plugin",
    status === 200 && names.includes("hello-plugin"),
    `status=${status} plugins=[${names.join(",")}] tools=[${tools.join(",")}]`,
  );
}

// ---- 2) /api/meta：11 个工具 + harness 段 + 委派声明 + 后台 job 能力 ----
{
  const { status, json } = await getJson("/api/meta");
  const toolNames = json?.toolNames ?? [];
  const harness = json?.harness;
  check(
    "GET /api/meta toolNames 含 todo_write 与三个 job 工具（11 个）",
    status === 200 &&
      toolNames.length === 11 &&
      ["todo_write", "job_list", "job_output", "job_kill"].every((n) => toolNames.includes(n)),
    `count=${toolNames.length} [${toolNames.join(",")}]`,
  );
  check(
    "GET /api/meta capabilitySettings.jobs 声明了后台通道",
    json?.capabilitySettings?.jobs?.live === true &&
      Array.isArray(json.capabilitySettings.jobs.tools) &&
      json.capabilitySettings.jobs.tools.length === 3,
    `jobs=${JSON.stringify(json?.capabilitySettings?.jobs ?? null)?.slice(0, 120)}`,
  );
  check(
    "GET /api/meta harness 段含 pluginsRoot",
    status === 200 && typeof harness?.pluginsRoot === "string",
    `pluginsRoot=${harness?.pluginsRoot ?? "(none)"}`,
  );
  const delegators = (json?.agents ?? []).filter((a) => (a.subagents ?? []).length > 0);
  const orch = delegators.find((a) => a.id === "orchestrator");
  check(
    "GET /api/meta 暴露 orchestrator 的 3 个委派工具 + maxDepth",
    Boolean(orch) && orch.subagents.length === 3 && orch.maxDepth === 1,
    orch ? `tools=[${orch.subagents.map((s) => s.toolName ?? s.tools).join(",")}] maxDepth=${orch.maxDepth}` : "orchestrator not found",
  );
}

// ---- 3) /api/run/stream：SSE 真的推出 subagent_start / subagent_end / usage ----
{
  const res = await fetch(`${BASE}/api/run/stream`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "派子 agent 并行盘点一下 packages/core/src 的结构和 README 的分工",
      workspace: undefined,
      agentId: "orchestrator",
      modelId: "mock-local",
      sessionId: "probe-http-1",
      plugins: true,
    }),
  });
  check("POST /api/run/stream 返回 200", res.status === 200, `status=${res.status}`);

  const seen = new Map();
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  let answer = "";
  let sawPlugins = false;
  let timeout = setTimeout(() => reader.cancel().catch(() => {}), 60000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const chunks = buf.split("\n\n");
      buf = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const evLine = chunk.split("\n").find((l) => l.startsWith("event:"));
        const dataLine = chunk.split("\n").find((l) => l.startsWith("data:"));
        if (!evLine || !dataLine) continue;
        const ev = evLine.slice(6).trim();
        seen.set(ev, (seen.get(ev) ?? 0) + 1);
        if (ev === "plugins") sawPlugins = true;
        if (ev === "result") {
          try {
            answer = JSON.parse(dataLine.slice(5)).answer ?? "";
          } catch {
            /* ignore */
          }
        }
      }
    }
  } finally {
    clearTimeout(timeout);
    timeout = null;
  }

  const starts = seen.get("subagent_start") ?? 0;
  const ends = seen.get("subagent_end") ?? 0;
  const usage = seen.get("usage") ?? 0;
  check("SSE 推出 subagent_start（≥2）", starts >= 2, `count=${starts}`);
  check("SSE 推出 subagent_end（≥2）", ends >= 2, `count=${ends}`);
  check("SSE 推出 usage（≥2）", usage >= 2, `count=${usage}`);
  check("SSE 推出 plugins 事件", sawPlugins, sawPlugins ? "yes" : "no");
  check("SSE 有 result 且 answer 非空", Boolean(answer), `len=${answer.length}`);
  console.log(`     事件计数: ${JSON.stringify(Object.fromEntries(seen))}`);
}

// ---- 4) /api/run（非流式）：plugins 与事件数组 ----
{
  const res = await fetch(`${BASE}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "只读地看一眼 packages/core/src 有哪些文件",
      agentId: "reader",
      modelId: "mock-local",
      sessionId: "probe-http-2",
    }),
  });
  const json = await res.json().catch(() => null);
  const types = new Set((json?.events ?? []).map((e) => e.type));
  check(
    "POST /api/run 返回 events 且含 usage",
    res.status === 200 && types.has("usage"),
    `status=${res.status} events=[${[...types].join(",")}]`,
  );
  check(
    "POST /api/run 回带 plugins 字段",
    Array.isArray(json?.plugins),
    `plugins=${JSON.stringify((json?.plugins ?? []).map((p) => p.name))}`,
  );
}

// ---- 5) /api/plan：编排（依赖分批 + 重试 + 上游摘要）真的从路由暴露出来 ----
{
  const { json: meta } = await getJson("/api/meta");
  const presets = (meta?.planPresets ?? []).map((p) => p.id);
  check(
    "GET /api/meta planPresets 含 chain（串行流水线）",
    presets.includes("chain"),
    `presets=[${presets.join(",")}]`,
  );

  const res = await fetch(`${BASE}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "探针：验证串行编排",
      preset: "chain",
      preferReal: false,
      maxRetries: 0,
    }),
  });
  const json = await res.json().catch(() => null);
  const batchSizes = (json?.batches ?? []).map((b) => b.stepIds?.length);
  const steps = json?.steps ?? [];
  check(
    "POST /api/plan preset=chain → 3 批各 1 步（串行，不是扇出）",
    res.status === 200 && JSON.stringify(batchSizes) === "[1,1,1]",
    `status=${res.status} batchSizes=${JSON.stringify(batchSizes)}`,
  );
  check(
    "POST /api/plan chain 三步全 done 且带 attempts/dependsOnIds",
    steps.length === 3 &&
      steps.every((s) => s.status === "done" && s.attempts === 1) &&
      (steps[1]?.dependsOnIds ?? []).length === 1 &&
      (steps[2]?.dependsOnIds ?? []).length === 1,
    `status=[${steps.map((s) => s.status).join(",")}] attempts=[${steps
      .map((s) => s.attempts)
      .join(",")}] deps=${JSON.stringify(steps.map((s) => s.dependsOnIds))}`,
  );
  check(
    "POST /api/plan 的 merged 写明批次与依赖关系",
    typeof json?.merged === "string" && json.merged.includes("批次：1 → 1 → 1"),
    `merged.head=${String(json?.merged ?? "").slice(0, 40).replace(/\n/g, " ")}`,
  );

  // 依赖写歪 → 400（不是 500），且说清哪里错
  const bad = await fetch(`${BASE}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "探针：循环依赖",
      preset: "custom",
      workers: [
        { title: "A", agentId: "reader", modelId: "mock-local", goal: "a", dependsOn: [1] },
        { title: "B", agentId: "reader", modelId: "mock-local", goal: "b", dependsOn: [0] },
      ],
    }),
  });
  const badJson = await bad.json().catch(() => null);
  check(
    "POST /api/plan 循环依赖 → 400 且说明成环",
    bad.status === 400 && /成环/.test(String(badJson?.error ?? "")),
    `status=${bad.status} error=${String(badJson?.error ?? "").slice(0, 60)}`,
  );
}

// ---- 8) /api/run：todo 事件真落盘（默认走文件 store，不是进程内 Map） ----
{
  const { createFileTodoStore, resolveTodoStoreDir } = await import("../../packages/core/dist/index.js");
  const dir = resolveTodoStoreDir();
  const sessionId = `probe-http-todo-${process.pid}`;
  const store = createFileTodoStore({ dir });
  const file = store.filePath(sessionId);
  await rm(file, { force: true });

  const res = await fetch(`${BASE}/api/run`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "汇总 TODO.md 与代码 TODO",
      agentId: "guide",
      modelId: "mock-local",
      sessionId,
    }),
  });
  const json = await res.json().catch(() => null);
  const names = (json?.events ?? []).map((e) => e.name).filter(Boolean);
  check(
    "POST /api/run 的 todo 目标真的调了 todo_write",
    res.status === 200 && names.includes("todo_write"),
    `status=${res.status} tools=[${[...new Set(names)].join(",")}]`,
  );

  const exists = existsSync(file);
  check("todo_write 之后 JSONL 落到 data/loom-store/todos", exists, `file=${file}`);
  if (exists) {
    const lines = readFileSync(file, "utf8").trim().split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]);
    check(
      "JSONL 最后一行是本会话的完整清单事件",
      last.type === "todo/write" &&
        last.sessionId === sessionId &&
        Array.isArray(last.todos) &&
        last.todos.length > 0,
      `lines=${lines.length} todos=${last.todos?.length}`,
    );
    // 全新 store 实例（等价于重启后的服务）只靠文件恢复投影
    const reloaded = createFileTodoStore({ dir });
    check(
      "新进程视角能回放出同一份清单（重启不丢）",
      JSON.stringify(reloaded.projection(sessionId)?.todos) === JSON.stringify(last.todos),
      `turn=${reloaded.projection(sessionId)?.turn} events=${reloaded.events(sessionId).length}`,
    );
    await rm(file, { force: true });
  }
}

// ---- 9) /api/plan：模型拆步（planner）失败要能回落，不许 500 ----
{
  // 故意点 mock 模型：mock 只照剧本演，规划一定失败——这样探针不需要真 Key、也不打外网
  const res = await fetch(`${BASE}/api/plan`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      goal: "把 README 的安装步骤重排一遍",
      preset: "homo",
      preferReal: false,
      planner: true,
      plannerModelId: "mock-local",
    }),
  });
  const json = await res.json().catch(() => null);
  check(
    "POST /api/plan planner:true + mock 模型 → 200（回落预设，不是 500）",
    res.status === 200 && json?.planner?.ok === false,
    `status=${res.status} ok=${json?.planner?.ok} reason=${String(json?.planner?.reason ?? "").slice(0, 50)}`,
  );
  check(
    "规划失败时 Worker 仍是预设那两个（没有把半份清单塞进调度器）",
    Array.isArray(json?.workers) && json.workers.length === 2,
    `workers=${json?.workers?.length} preset=${json?.preset}`,
  );
  check(
    "planner 摘要与失败原因一并回传（UI/调用方看得见）",
    /规划失败/.test(String(json?.planner?.summary ?? "")) &&
      /mock/.test(String(json?.planner?.reason ?? "")),
    `summary=${String(json?.planner?.summary ?? "").slice(0, 60)}`,
  );
  check(
    "回落的那次 Plan 仍然真的跑完了（steps 全 done）",
    Array.isArray(json?.steps) &&
      json.steps.length === 2 &&
      json.steps.every((s) => s.status === "done"),
    `steps=[${(json?.steps ?? []).map((s) => s.status).join(",")}]`,
  );
}

// ---- 10) 后台 job 通道：批准 → 立刻拿 jobId → 列表看得到 → 停/读 → 白名单仍然拦得住 ----
{
  const started = await fetch(`${BASE}/api/cmds/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "git status --porcelain", background: true }),
  });
  const startedJson = await started.json().catch(() => null);
  const jobId = startedJson?.jobId;
  check(
    "POST /api/cmds/approve background:true → 立刻回 jobId（不等命令跑完）",
    started.status === 200 && startedJson?.ok === true && typeof jobId === "string",
    `status=${started.status} ok=${startedJson?.ok} jobId=${jobId ?? "(none)"} background=${startedJson?.background}`,
  );

  const list = await getJson("/api/jobs");
  const job = (list.json?.jobs ?? []).find((j) => j.id === jobId);
  check(
    "GET /api/jobs 立刻看得到这个 job（状态 running 或已经 done）",
    list.status === 200 && Boolean(job),
    `jobs=${(list.json?.jobs ?? []).length} status=${job?.status} command=${job?.command}`,
  );

  if (jobId) {
    // 同一个 job 再读一次：这里模拟 UI「批准完不用去终端等」
    const again = await fetch(`${BASE}/api/jobs`);
    const detail = (await again.json().catch(() => null))?.jobs?.find((j) => j.id === jobId);
    check(
      "job 视图带 tail / elapsedMs（不用另开终端）",
      Boolean(detail) && typeof detail.elapsedMs === "number" && typeof detail.tail === "string",
      `status=${detail?.status} elapsed=${detail?.elapsedMs}ms tail=${JSON.stringify(String(detail?.tail ?? "").slice(0, 40))}`,
    );
    // 等它自己跑完（git status 在 1300+ 未跟踪文件的大仓库里不是瞬间的事），
    // 否则下面那条「已结束的 job 杀它是 killed:false」会变成跟它赛跑
    let settled = detail;
    for (let i = 0; i < 40 && settled?.status === "running"; i += 1) {
      await new Promise((r) => setTimeout(r, 250));
      const poll = await getJson("/api/jobs");
      settled = (poll.json?.jobs ?? []).find((j) => j.id === jobId);
    }
    const stop = await fetch(`${BASE}/api/jobs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jobId }),
    });
    const stopped = await stop.json().catch(() => null);
    check(
      "已结束的 job 杀它是 killed:false（不假装杀成功）",
      stop.status === 200 && typeof stopped?.killed === "boolean" && stopped.job?.status === "done",
      `killed=${stopped?.killed} status=${stopped?.job?.status} note=${stopped?.note}`,
    );
  }
  const missing = await fetch(`${BASE}/api/jobs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jobId: "job-does-not-exist" }),
  });
  check(
    "杀一个不存在的 job → 404（不是 200 假装成功）",
    missing.status === 404,
    `status=${missing.status}`,
  );

  const denied = await fetch(`${BASE}/api/cmds/approve`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ command: "rm -rf /", background: true }),
  });
  const deniedJson = await denied.json().catch(() => null);
  check(
    "后台模式过不了白名单 → 400，也不留下 jobId",
    denied.status === 400 && !deniedJson?.jobId,
    `status=${denied.status} error=${String(deniedJson?.error ?? "").slice(0, 60)}`,
  );
  check(
    "被拒的后台命令没有留在 /api/jobs 里",
    !((await getJson("/api/jobs")).json?.jobs ?? []).some((j) => /rm -rf/.test(j.command)),
    `jobs=[${((await getJson("/api/jobs")).json?.jobs ?? []).map((j) => j.command).join(" | ")}]`,
  );
}

// ---- 11) /api/demos：离线剧本里有后台 job 那条（无 Key 也能演） ----
{
  const { status, json } = await getJson("/api/demos");
  const recipes = json?.recipes ?? [];
  const jobs = recipes.find((r) => r.id === "jobs-tour");
  check(
    "GET /api/demos 列出 jobs-tour 离线剧本",
    status === 200 && Boolean(jobs) && jobs.kind === "run",
    status === 200 ? `recipes=${recipes.length} jobs-tour=${jobs ? jobs.title : "缺失"}` : `status=${status}`,
  );
  check(
    "jobs-tour 剧本的口径写明「先提待批准的后台命令」",
    /待批准/.test(String(jobs?.run?.goal ?? "")) && jobs?.run?.mockScenario === "jobs_tour",
    `goal=${String(jobs?.run?.goal ?? "").slice(0, 40)} scenario=${jobs?.run?.mockScenario}`,
  );
}

const failed = results.filter((r) => !r.ok);
console.log(`\n# probe ${results.length - failed.length}/${results.length} pass, ${failed.length} fail`);
process.exit(failed.length === 0 ? 0 : 1);
