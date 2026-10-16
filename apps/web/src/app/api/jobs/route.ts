import { getDefaultJobStore } from "@loom/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 后台 job 列表：给 UI 看，也给「批准完不用去终端等」用 */
export async function GET() {
  const store = getDefaultJobStore();
  const jobs = store.list();
  return Response.json({
    jobs,
    running: jobs.filter((j) => j.status === "running").length,
  });
}

/** 杀一个还在跑的 job（UI 上的「停」按钮） */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { jobId?: string };
  const jobId = body.jobId?.trim();
  if (!jobId) return Response.json({ error: "jobId 必填" }, { status: 400 });
  const store = getDefaultJobStore();
  const before = store.get(jobId);
  if (!before) return Response.json({ error: `没有这个 job：${jobId}` }, { status: 404 });
  const killed = before.status === "running" ? store.kill(jobId) : false;
  return Response.json({
    jobId,
    killed,
    job: store.get(jobId) ?? before,
    note:
      before.status === "running"
        ? killed
          ? "已发 SIGTERM"
          : "进程可能刚好已经退出"
        : `它已经结束了（${before.status}）`,
  });
}
