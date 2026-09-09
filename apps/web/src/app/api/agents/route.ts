import {
  AGENT_TEMPLATES,
  cloneAgentAsCustom,
  deleteCustomAgent,
  listAllAgents,
  resolveAgent,
  templateToProfile,
  upsertCustomAgent,
  type ToolName,
} from "@loom/core";
import { defaultAgentStore } from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json({
    agents: listAllAgents(defaultAgentStore()),
    storePath: defaultAgentStore(),
    templates: AGENT_TEMPLATES,
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    action?: "upsert" | "from_template" | "clone";
    id?: string;
    name?: string;
    systemPrompt?: string;
    allowedTools?: ToolName[];
    defaultModelId?: string;
    skillIds?: string[];
    templateId?: string;
    sourceId?: string;
  };

  const store = defaultAgentStore();
  const action = body.action ?? "upsert";

  try {
    if (action === "from_template") {
      if (!body.templateId) {
        return Response.json({ error: "templateId 必填" }, { status: 400 });
      }
      const drafted = templateToProfile(body.templateId, body.name);
      const agent = upsertCustomAgent(store, drafted);
      return Response.json({ ok: true, agent });
    }

    if (action === "clone") {
      if (!body.sourceId) {
        return Response.json({ error: "sourceId 必填" }, { status: 400 });
      }
      const source = resolveAgent(body.sourceId, store);
      const drafted = cloneAgentAsCustom(source);
      const agent = upsertCustomAgent(store, drafted);
      return Response.json({ ok: true, agent });
    }

    if (!body.name?.trim() || !body.systemPrompt?.trim()) {
      return Response.json(
        { error: "name 与 systemPrompt 必填" },
        { status: 400 },
      );
    }

    const agent = upsertCustomAgent(store, {
      id: body.id,
      name: body.name,
      systemPrompt: body.systemPrompt,
      allowedTools: body.allowedTools,
      defaultModelId: body.defaultModelId,
      skillIds: body.skillIds,
    });
    return Response.json({ ok: true, agent });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { id?: string };
  if (!body.id) {
    return Response.json({ error: "id 必填" }, { status: 400 });
  }
  try {
    const ok = deleteCustomAgent(defaultAgentStore(), body.id);
    if (!ok) {
      return Response.json({ error: "未找到自定义 Agent" }, { status: 404 });
    }
    return Response.json({ ok: true });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }
}
