export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** 拒绝命令提议（无副作用，与 writes/reject 对称） */
export async function POST(req: Request) {
  const body = (await req.json()) as { command?: string };
  return Response.json({
    ok: true,
    discarded: body.command ?? null,
  });
}
