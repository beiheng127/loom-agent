import {
  deleteSession,
  getSession,
  upsertSession,
  type StoredSessionMessage,
} from "@loom/core";
import { defaultSessionStore } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const session = getSession(defaultSessionStore(), id);
  if (!session) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  return Response.json({ session });
}

export async function PUT(req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const body = (await req.json()) as {
    title?: string;
    mode?: "ask" | "agent" | "plan";
    thread?: StoredSessionMessage[];
    updatedAt?: number;
  };

  if (!body.mode || !Array.isArray(body.thread)) {
    return Response.json(
      { error: "mode 与 thread 必填" },
      { status: 400 },
    );
  }

  const session = upsertSession(defaultSessionStore(), {
    id,
    title: body.title ?? "Untitled",
    mode: body.mode,
    thread: body.thread,
    updatedAt: body.updatedAt,
  });
  return Response.json({ ok: true, session });
}

export async function DELETE(_req: Request, ctx: Ctx) {
  const { id } = await ctx.params;
  const ok = deleteSession(defaultSessionStore(), id);
  if (!ok) {
    return Response.json({ error: "session not found" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
