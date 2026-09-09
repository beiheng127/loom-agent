import {
  deleteCustomSkill,
  importSkillMarkdown,
  listAllSkills,
  loadSkillsFromDir,
  upsertCustomSkill,
} from "@loom/core";
import {
  defaultCustomSkillsRoot,
  defaultSkillsRoot,
} from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function builtinIdSet(skills: Array<{ id: string; builtin?: boolean }>) {
  return new Set(skills.filter((s) => s.builtin).map((s) => s.id));
}

export async function GET() {
  const skills = await listAllSkills(
    defaultSkillsRoot(),
    defaultCustomSkillsRoot(),
  );
  return Response.json({
    skillsRoot: defaultSkillsRoot(),
    customSkillsRoot: defaultCustomSkillsRoot(),
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      body: s.body,
      bodyPreview: s.body.slice(0, 480),
      chars: s.body.length,
      builtin: s.builtin,
    })),
  });
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    action?: "upsert" | "import";
    id?: string;
    name?: string;
    description?: string;
    body?: string;
    markdown?: string;
  };

  const existing = await listAllSkills(
    defaultSkillsRoot(),
    defaultCustomSkillsRoot(),
  );
  const builtinIds = builtinIdSet(existing);
  const customRoot = defaultCustomSkillsRoot();

  try {
    if (body.action === "import" || body.markdown) {
      const skill = await importSkillMarkdown(
        customRoot,
        body.markdown || "",
        body.id,
        { builtinIds },
      );
      return Response.json({ ok: true, skill });
    }

    const skill = await upsertCustomSkill(
      customRoot,
      {
        id: body.id,
        name: body.name || "",
        description: body.description,
        body: body.body || "",
      },
      { builtinIds },
    );
    return Response.json({ ok: true, skill });
  } catch (err) {
    return Response.json(
      { error: err instanceof Error ? err.message : String(err) },
      { status: 400 },
    );
  }
}

export async function DELETE(req: Request) {
  const body = (await req.json().catch(() => null)) as { id?: string } | null;
  const id = body?.id?.trim();
  if (!id) {
    return Response.json({ error: "缺少 id" }, { status: 400 });
  }

  const builtin = await loadSkillsFromDir(defaultSkillsRoot());
  if (builtin.some((s) => s.id === id)) {
    return Response.json(
      { error: "内置 Skill 不能删除，可复制后编辑" },
      { status: 400 },
    );
  }

  const ok = deleteCustomSkill(defaultCustomSkillsRoot(), id);
  if (!ok) {
    return Response.json({ error: "Skill 不存在" }, { status: 404 });
  }
  return Response.json({ ok: true });
}
