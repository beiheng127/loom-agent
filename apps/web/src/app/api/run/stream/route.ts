import {
  applyApprovedWrite,
  listAllSkills,
  listModelsWithAvailability,
  resolveAgent,
  runAgentLoop,
  summarizeDiff,
  unifiedDiff,
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

/** Cursor 风格：SSE 推送 phase / tool_call / text_delta / text，前端边跑边渲染 */
export async function POST(req: Request) {
  const body = (await req.json()) as {
    goal?: string;
    workspace?: string;
    agentId?: string;
    modelId?: string;
    mockScenario?: MockScenario;
    temperature?: number;
    skillIds?: string[];
    readOnly?: boolean;
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    autoApproveWrites?: boolean;
    contextFiles?: Array<{ path: string; content: string }>;
    /** harness：会话归属（todo 投影） */
    sessionId?: string;
    /** harness：是否加载 plugins/ 下的插件工具，默认 true */
    plugins?: boolean;
    /** harness：显式覆盖 token 预算 */
    budget?: { maxSteps?: number; maxTokens?: number; contextWindow?: number };
  };

  const goalBase = (body.goal ?? "").trim();
  if (!goalBase) {
    return Response.json({ error: "goal 必填" }, { status: 400 });
  }

  const workspaceRoot = path.resolve(body.workspace || defaultWorkspace());

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

  // 注入工作区 Rules（.loom/RULES.md 等）
  const ruleCandidates = [
    ".loom/RULES.md",
    ".loom/rules.md",
    "LOOM.md",
    "AGENTS.md",
  ];
  for (const rel of ruleCandidates) {
    try {
      const raw = await fs.readFile(path.join(workspaceRoot, rel), "utf8");
      goal = `${goal}\n\n---\n【项目 Rules · ${rel}】\n${raw.slice(0, 8000)}`;
      break;
    } catch {
      /* next */
    }
  }

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
  if (!modelRow?.availability.ready) {
    return Response.json(
      {
        error: modelRow?.availability.reason || `未知模型 ${modelId}`,
        hint: "改用 mock-local / mock-editor",
      },
      { status: 400 },
    );
  }

  const skills = await listAllSkills(
    defaultSkillsRoot(),
    defaultCustomSkillsRoot(),
  );
  const agentForRun =
    body.skillIds !== undefined
      ? { ...agent, skillIds: body.skillIds }
      : agent;

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (event: string, data: unknown) => {
        controller.enqueue(
          encoder.encode(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`),
        );
      };

      const pendingWrites: Array<{
        path: string;
        content: string;
        diff?: string;
        additions?: number;
        deletions?: number;
      }> = [];
      const pendingCmds: Array<{ command: string }> = [];

      // 层6：插件工具随请求加载；失败只报警告，不阻断本次运行
      const pluginLoad = body.plugins === false
        ? { plugins: [], tools: [], warnings: [] as string[] }
        : await loadPluginTools((m) => send("plugin_warning", { message: m }));
      if (pluginLoad.plugins.length) {
        send("plugins", {
          plugins: pluginLoad.plugins.map((p) => ({
            name: p.manifest.name,
            version: p.manifest.version,
            tools: p.tools.map((t) => t.name),
            error: p.error,
          })),
        });
      }

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
          onEvent: (e: LoopEvent) => {
            // 写文件：等循环结束后带 diff 再推一次，避免无 diff 的重复卡片
            if (e.type === "approval_needed" && e.kind !== "cmd") {
              pendingWrites.push({ path: e.path, content: e.content });
              return;
            }
            // 新增的 harness 事件（subagent_* / compacted / usage）原样透传，
            // 前端不认就忽略，认了就渲染 —— 不必改协议。
            send(e.type, e);
            if (e.type === "approval_needed" && e.kind === "cmd") {
              pendingCmds.push({ command: e.command ?? e.path });
            }
          },
        });

        for (const w of pendingWrites) {
          let before = "";
          try {
            before = await fs.readFile(
              path.resolve(workspaceRoot, w.path),
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
          send("approval_needed", {
            type: "approval_needed",
            kind: "write",
            path: w.path,
            content: w.content,
            diff,
            additions: stats.additions,
            deletions: stats.deletions,
          });
        }

        if (body.autoApproveWrites) {
          for (const w of pendingWrites) {
            await applyApprovedWrite(workspaceRoot, w.path, w.content);
          }
        }

        send("result", {
          answer,
          pendingWrites: body.autoApproveWrites ? [] : pendingWrites,
          pendingCmds,
          agent: agentForRun.id,
          skillIds: agentForRun.skillIds,
          model: modelRow.id,
          workspaceRoot,
        });
      } catch (e) {
        send("error", {
          message: e instanceof Error ? e.message : String(e),
        });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
