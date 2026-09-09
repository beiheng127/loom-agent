import {
  listAllAgents,
  listAllSkills,
  listModelsWithAvailabilityAsync,
  preferredComposerModelId,
  preferredRealModelRoles,
  providerLabel,
  DEMO_RECIPES,
  AGENT_TEMPLATES,
  workersForPlanPreset,
  listPlannedTools,
  capabilitySettingsSnapshot,
} from "@loom/core";
import {
  defaultAgentStore,
  defaultCustomSkillsRoot,
  defaultSkillsRoot,
  defaultWorkspace,
} from "@/lib/paths";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  const skills = await listAllSkills(
    defaultSkillsRoot(),
    defaultCustomSkillsRoot(),
  );
  const modelsRaw = await listModelsWithAvailabilityAsync();
  const models = modelsRaw.map((m) => ({
    id: m.id,
    provider: m.provider,
    model: m.model,
    baseURL: m.baseURL,
    apiKeyEnv: m.apiKeyEnv,
    blurb: m.blurb,
    temperature: m.temperature,
    label: providerLabel(m.provider),
    availability: m.availability,
  }));

  const planPreview = workersForPlanPreset("hetero", "preview");
  const roles = preferredRealModelRoles(modelsRaw);

  return Response.json({
    workspaceDefault: defaultWorkspace(),
    skillsRoot: defaultSkillsRoot(),
    customSkillsRoot: defaultCustomSkillsRoot(),
    agentStorePath: defaultAgentStore(),
    agents: listAllAgents(defaultAgentStore()),
    models,
    preferredModelId: preferredComposerModelId(modelsRaw),
    planAutoRoles: roles,
    planPresetPreview: planPreview.map((w) => ({
      title: w.title,
      agentId: w.agentId,
      modelId: w.modelId,
    })),
    skills: skills.map((s) => ({
      id: s.id,
      name: s.name,
      description: s.description,
      builtin: s.builtin,
    })),
    toolNames: [
      "list_dir",
      "read_file",
      "grep_files",
      "write_file",
      "fetch_url",
      "web_search",
      "run_safe_cmd",
    ],
    plannedTools: listPlannedTools(),
    capabilitySettings: capabilitySettingsSnapshot(),
    planPresets: [
      { id: "homo", label: "双线程 · 结构 + README" },
      { id: "hetero", label: "异构 · 阅读 + 写入（需确认）" },
      { id: "triple", label: "三线程 · 结构 + 审计 + 写入" },
      { id: "custom", label: "自定义 Worker" },
    ],
    demos: DEMO_RECIPES,
    templates: AGENT_TEMPLATES.map((t) => ({
      id: t.id,
      name: t.name,
      blurb: t.blurb,
      defaultModelId: t.profile.defaultModelId,
      skillIds: t.profile.skillIds,
      allowedTools: t.profile.allowedTools,
    })),
  });
}
