import { DEMO_RECIPES } from "@loom/core";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    recipes: DEMO_RECIPES,
    guide: [
      { step: 1, title: "先读懂工作区", tip: "点「探索」或「审计」，看事件日志里的工具调用" },
      { step: 2, title: "体验写审批", tip: "点「提议写入」，在右侧批准/拒绝，确认不会偷偷改盘" },
      { step: 3, title: "看 Plan Board", tip: "点「异构并行」或「三线程」，观察多 Agent×模型同时跑" },
      { step: 4, title: "定制 Agent", tip: "到 Agents 页保存自己的 profile，再回 Run 选用" },
    ],
  });
}
