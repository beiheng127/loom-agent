import { listSessions } from "@loom/core";
import { defaultSessionStore } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const storePath = defaultSessionStore();
  return Response.json({
    sessions: listSessions(storePath),
    storePath,
  });
}
