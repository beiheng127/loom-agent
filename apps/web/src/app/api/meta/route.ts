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
  defaultPluginsRoot,
  defaultSkillsRoot,
  defaultWorkspace,
} from "@/lib/paths";
import { loadPluginTools } from "@/lib/harness";

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
  const pluginLoad = await loadPluginTools();

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
      "todo_write",
      "job_list",
      "job_output",
      "job_kill",
    ],
    harness: {
      pluginsRoot: defaultPluginsRoot(),
      plugins: pluginLoad.plugins.map((p) => ({
        name: p.manifest.name,
        version: p.manifest.version,
        enabled: p.manifest.enabled !== false,
        tools: p.tools.map((t) => t.name),
        error: p.error,
      })),
      pluginWarnings: pluginLoad.warnings,
      // 委派工具按 Agent 档案注入，这里汇总出「每个 Agent 能派哪些子 agent」，
      // 让 UI 不必硬编码，也让「这个 Agent 有没有委派能力」一眼可查。
      delegation: listAllAgents(defaultAgentStore())
        .filter((a) => (a.subagents?.length ?? 0) > 0)
        .map((a) => ({
          agentId: a.id,
          maxDepth: a.maxDepth ?? 1,
          tools: (a.subagents ?? []).map((s) => ({
            toolName: s.toolName,
            persona: s.persona,
            allowedTools: s.allowedTools ?? [],
            maxSteps: s.maxSteps ?? 5,
          })),
        })),
      notes: [
        "todo_write / 子 agent 委派工具由运行时按 Agent 档案注入，不在静态工具目录里",
        "上下文压缩按模型 contextWindow 自动触发",
      ],
    },
    plannedTools: listPlannedTools(),
    capabilitySettings: capabilitySettingsSnapshot(),
    planPresets: [
      { id: "homo", label: "双线程 · 结构 + README" },
      { id: "hetero", label: "异构 · 阅读 + 写入（需确认）" },
      { id: "triple", label: "三线程 · 结构 + 审计 + 写入" },
      { id: "chain", label: "串行流水线 · 结构 → 审计 → 纪要（有依赖）" },
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
