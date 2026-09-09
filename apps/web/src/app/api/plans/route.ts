import { listPlans } from "@loom/core";
import { defaultPlanStore } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 最近 Plan 运行记录（服务端持久化） */
export async function GET() {
  const storePath = defaultPlanStore();
  return Response.json({
    plans: listPlans(storePath),
    storePath,
  });
}
