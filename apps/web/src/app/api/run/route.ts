import {
  applyApprovedWrite,
  listAllSkills,
  listModelsWithAvailability,
  resolveAgent,
  runAgentLoop,
  unifiedDiff,
  summarizeDiff,
  type LoopEvent,
  type MockScenario,
} from "@loom/core";
import {
  defaultAgentStore,
  defaultCustomSkillsRoot,
  defaultSkillsRoot,
  defaultWorkspace,
} from "@/lib/paths";
import { loadPluginTools } from "@/lib/harness";
import fs from "node:fs/promises";
import path from "node:path";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function resolveIn(root: string, rel: string) {
  const base = path.resolve(root);
  const target = path.resolve(base, rel);
  if (target !== base && !target.startsWith(base + path.sep)) {
    throw new Error("路径越界");
  }
  return target;
}

export async function POST(req: Request) {
  const body = (await req.json()) as {
    goal?: string;
    workspace?: string;
    agentId?: string;
    modelId?: string;
    autoApproveWrites?: boolean;
    mockScenario?: MockScenario;
    temperature?: number;
    skillIds?: string[];
    readOnly?: boolean;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    contextFiles?: Array<{ path: string; content: string }>;
    /** harness：会话归属（todo 投影 / 后续持久化都用它） */
    sessionId?: string;
    /** harness：是否加载 plugins/ 下的插件工具，默认 true */
    plugins?: boolean;
    /** harness：显式覆盖 token 预算（不传则按模型 contextWindow 自动压缩） */
    budget?: { maxSteps?: number; maxTokens?: number; contextWindow?: number };
  };

  const goalBase = (body.goal ?? "").trim();
  if (!goalBase) {
    return Response.json({ error: "goal 必填" }, { status: 400 });
  }

  let goal = goalBase;
  if (body.contextFiles?.length) {
    const ctx = body.contextFiles
      .slice(0, 4)
      .map(
        (f) =>
          `【@${f.path}】\n\`\`\`\n${f.content.slice(0, 6000)}\n\`\`\``,
      )
      .join("\n\n");
    goal = `${goalBase}\n\n---\n已附加上下文文件：\n${ctx}`;
  }

  const workspaceRoot = path.resolve(body.workspace || defaultWorkspace());
  const store = defaultAgentStore();
  let agent;
  try {
    agent = resolveAgent(body.agentId || "reader", store);
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 400 },
    );
  }

  const modelId = body.modelId || agent.defaultModelId;
  const models = listModelsWithAvailability();
  const modelRow = models.find((m) => m.id === modelId);
  if (!modelRow) {
    return Response.json({ error: `未知模型 ${modelId}` }, { status: 400 });
  }
  if (!modelRow.availability.ready) {
    return Response.json(
      {
        error: modelRow.availability.reason,
        hint: "可改选 mock-local / mock-editor，或配置对应 API Key 后重启",
      },
      { status: 400 },
    );
  }

  const skills = await listAllSkills(
    defaultSkillsRoot(),
    defaultCustomSkillsRoot(),
  );
  const events: LoopEvent[] = [];
  const pendingWrites: Array<{
    path: string;
    content: string;
    diff?: string;
    additions?: number;
    deletions?: number;
  }> = [];
  const pendingCmds: Array<{ command: string }> = [];

  const agentForRun =
    body.skillIds !== undefined
      ? { ...agent, skillIds: body.skillIds }
      : agent;

  // 层6：加载插件工具（失败隔离，不影响主循环）
  const pluginLoad = body.plugins === false
    ? { plugins: [], tools: [], warnings: [] }
    : await loadPluginTools();

  try {
    const answer = await runAgentLoop({
      workspaceRoot,
      agent: agentForRun,
      model: modelRow,
      skills,
      goal,
      signal: req.signal,
      mockScenario: body.mockScenario,
      temperature: body.temperature,
      history: body.history,
      readOnly: body.readOnly,
      extraTools: pluginLoad.tools,
      budget: body.budget,
      todo: body.sessionId
        ? { sessionId: body.sessionId, allowParallelInProgress: true }
        : undefined,
      onEvent: (e) => {
        events.push(e);
        if (e.type === "approval_needed") {
          if (e.kind === "cmd") {
            pendingCmds.push({ command: e.command ?? e.path });
          } else {
            pendingWrites.push({ path: e.path, content: e.content });
          }
        }
      },
    });

    for (const w of pendingWrites) {
      let before = "";
      try {
        before = await fs.readFile(
          resolveIn(workspaceRoot, w.path),
          "utf8",
        );
      } catch {
        before = "";
      }
      const diff = unifiedDiff(w.path, before, w.content);
      const stats = summarizeDiff(diff);
      w.diff = diff;
      w.additions = stats.additions;
      w.deletions = stats.deletions;
    }

    if (body.autoApproveWrites) {
      for (const w of pendingWrites) {
        await applyApprovedWrite(workspaceRoot, w.path, w.content);
      }
    }

    return Response.json({
      answer,
      events,
      pendingWrites: body.autoApproveWrites ? [] : pendingWrites,
      pendingCmds,
      agent: agentForRun.id,
      skillIds: agentForRun.skillIds,
      model: modelRow.id,
      workspaceRoot,
      plugins: pluginLoad.plugins.map((p) => ({
        name: p.manifest.name,
        version: p.manifest.version,
        tools: p.tools.map((t) => t.name),
        error: p.error,
      })),
      pluginWarnings: pluginLoad.warnings,
    });
  } catch (e) {
    return Response.json(
      { error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
