import type { ToolContext, ToolResult } from "../types/index.js";
import { getDefaultJobStore, type JobView } from "../jobs/store.js";

/**
 * 后台 job 的三个工具（对标 DSH 的 job_list / job_output / job_kill）。
 *
 * 为什么不塞进 run_safe_cmd 的返回值里一起做：
 * 启动（要审批、要写盘）与读取（只读、随时可调）是两种权限，
 * 分开放模型才有机会「先启动，干别的，再回来收结果」。
 */

function summaryOf(job: JobView): Record<string, unknown> {
  return {
    id: job.id,
    status: job.status,
    command: job.command,
    pid: job.pid,
    exitCode: job.exitCode ?? null,
    elapsedMs: job.elapsedMs,
    truncated: job.truncated,
    tail: job.tail,
  };
}

const STATUS_CN: Record<JobView["status"], string> = {
  running: "在跑",
  done: "正常结束",
  failed: "失败退出",
  killed: "被杀掉",
};

export async function jobListTool(
  _args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const store = getDefaultJobStore();
  const jobs = store.list();
  const running = jobs.filter((j) => j.status === "running").length;
  return {
    ok: true,
    data: {
      jobs: jobs.map(summaryOf),
      running,
      note:
        jobs.length === 0
          ? "还没有后台 job。run_safe_cmd 传 background:true 并经人工批准后才会起一个。"
          : `共 ${jobs.length} 个（在跑 ${running} 个），已结束的只保留最近若干条。`,
    },
  };
}

export async function jobOutputTool(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const store = getDefaultJobStore();
  const jobId = typeof args.jobId === "string" && args.jobId.trim() ? args.jobId.trim() : undefined;
  const wait = args.wait === true;
  const timeoutRaw = Number(args.timeoutMs);
  const timeoutMs =
    Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.min(timeoutRaw, 30000) : 1000;

  const target = jobId ?? store.latest()?.id;
  if (!target) {
    return {
      ok: false,
      error: "没有后台 job 可读：先用 run_safe_cmd 带 background:true 启动一个",
    };
  }

  const result = await store.read(target, { wait, timeoutMs });
  if (!result) {
    const known = store.list().map((j) => j.id);
    return {
      ok: false,
      error: `没有这个 job：${target}${known.length ? `（现有：${known.join(", ")}）` : ""}`,
    };
  }

  const { job, output, running } = result;
  return {
    ok: true,
    data: {
      jobId: job.id,
      status: job.status,
      statusText: STATUS_CN[job.status],
      running,
      exitCode: job.exitCode ?? null,
      elapsedMs: job.elapsedMs,
      truncated: job.truncated,
      // 自上次读取以来的**新增**输出；游标已经在 store 里推进
      output,
      hint: running
        ? wait
          ? `等了 ${timeoutMs}ms 它还没结束，过一会儿再读一次或 job_kill 收尾`
          : "还在跑；想等它结束就传 wait:true"
        : job.status === "done"
          ? "已结束，这是最后一段输出"
          : `异常收尾（${STATUS_CN[job.status]}），看上面的输出定位`,
    },
  };
}

export async function jobKillTool(
  args: Record<string, unknown>,
  _ctx: ToolContext,
): Promise<ToolResult> {
  const store = getDefaultJobStore();
  const jobId = typeof args.jobId === "string" ? args.jobId.trim() : "";
  if (!jobId) {
    const running = store.list().filter((j) => j.status === "running");
    return {
      ok: false,
      error: running.length
        ? `jobId 必填；在跑的有：${running.map((j) => j.id).join(", ")}`
        : "jobId 必填；现在没有在跑的 job",
    };
  }

  const before = store.get(jobId);
  if (!before) {
    return { ok: false, error: `没有这个 job：${jobId}` };
  }
  if (before.status !== "running") {
    return {
      ok: true,
      data: {
        jobId,
        status: before.status,
        killed: false,
        note: `它已经结束了（${STATUS_CN[before.status]}），没有可杀的东西`,
      },
    };
  }

  const killed = store.kill(jobId);
  return {
    ok: killed,
    error: killed ? undefined : `杀 ${jobId} 失败（进程可能刚好已经退出）`,
    data: {
      jobId,
      killed,
      note: killed
        ? "已杀掉（Windows 上走 taskkill /T /F，连孙进程一起收，不然管道会被占着不放）"
        : "进程可能刚好已经退出，读一次 job_output 看真实状态",
    },
  };
}
