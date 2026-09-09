export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 拒绝写入：MVP 仅确认丢弃，不落盘 */
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    path?: string;
  };
  return Response.json({
    ok: true,
    rejected: true,
    path: body.path ?? null,
    message: "已拒绝写入，未修改磁盘",
  });
}
