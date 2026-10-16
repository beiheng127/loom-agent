import { nanoid } from "nanoid";
import { resolveAgent } from "../agents/store.js";
import { runAgentLoop } from "../loop/run.js";
import { getModelConfig } from "../models/registry.js";
import { loadSkillsFromDir } from "../skills/loader.js";
import { listAllSkills } from "../skills/store.js";
/**
 * 多 Worker 并行执行计划：
 * 1. 构造 Plan Board 步骤
 * 2. Promise.all 并行跑各 Worker（可不同模型/Agent）
 * 3. 汇总结果
 */
export async function runParallelPlan(input) {
    const skills = input.customSkillsRoot
        ? await listAllSkills(input.skillsRoot, input.customSkillsRoot)
        : await loadSkillsFromDir(input.skillsRoot);
    const plan = {
        id: nanoid(),
        goal: input.goal,
        createdAt: Date.now(),
        steps: input.workers.map((w) => ({
            id: nanoid(),
            title: w.title,
            goal: w.goal,
            agentId: w.agentId,
            modelId: w.modelId,
            status: "pending",
        })),
    };
    const pendingWrites = [];
    const results = await Promise.all(plan.steps.map((step, i) => runStep({
        step,
        worker: input.workers[i],
        workspaceRoot: input.workspaceRoot,
        skills,
        agentStorePath: input.agentStorePath,
        signal: input.signal,
        onStep: input.onStep,
        onPendingWrite: (w) => {
            pendingWrites.push({ ...w, stepId: step.id });
        },
    }).then((text) => ({ index: i, text }))));
    const merged = [
        `# Plan ${plan.id}`,
        `目标：${plan.goal}`,
        "",
        ...results.map((r) => {
            const step = plan.steps[r.index];
            return `## ${step.title} (${step.agentId} / ${step.modelId})\n状态：${step.status}\n\n${r.text}`;
        }),
    ].join("\n");
    return { plan, merged, pendingWrites };
}
async function runStep(input) {
    const { step, worker, workspaceRoot, skills, agentStorePath, signal, onStep, onPendingWrite, } = input;
    step.status = "running";
    step.startedAt = Date.now();
    onStep?.(step);
    try {
        const agent = resolveAgent(step.agentId, agentStorePath);
        const model = getModelConfig(step.modelId);
        const text = await runAgentLoop({
            workspaceRoot,
            agent,
            model,
            skills,
            goal: step.goal,
            maxSteps: 5,
            signal,
            mockScenario: worker.mockScenario,
            onEvent: (e) => {
                if (e.type === "approval_needed") {
                    onPendingWrite?.({ path: e.path, content: e.content });
                }
            },
        });
        step.status = "done";
        step.resultPreview = text.slice(0, 400);
        step.endedAt = Date.now();
        onStep?.(step);
        return text;
    }
    catch (err) {
        step.status = "failed";
        step.error = err instanceof Error ? err.message : String(err);
        step.endedAt = Date.now();
        onStep?.(step);
        return `失败：${step.error}`;
    }
}
/** 同质双线程（都用 mock 探索，故事弱但稳） */
export function defaultDemoWorkers(goal) {
    return [
        {
            agentId: "reader",
            modelId: "mock-local",
            title: "线程 A · 结构探索",
            goal: `探索工作区目录结构，服务总目标：${goal}`,
            mockScenario: "structure_focus",
        },
        {
            agentId: "reader",
            modelId: "mock-local",
            title: "线程 B · README 精读",
            goal: `阅读 README.md 并提炼要点，服务总目标：${goal}`,
            mockScenario: "readme_focus",
        },
    ];
}
/** 异构并行：只读探索 + 改码工提出写文件（HITL） */
export function heteroDemoWorkers(goal) {
    return [
        {
            agentId: "reader",
            modelId: "mock-local",
            title: "Reader · 结构",
            goal: `列出目录与入口，服务：${goal}`,
            mockScenario: "structure_focus",
        },
        {
            agentId: "editor",
            modelId: "mock-editor",
            title: "Editor · 提议写入",
            goal: `为「${goal}」起草一份 notes 备忘并走 write_file 审批`,
            mockScenario: "write_hitl",
        },
    ];
}
