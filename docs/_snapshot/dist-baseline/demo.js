import path from "node:path";
import { fileURLToPath } from "node:url";
import { defaultDemoWorkers, heteroDemoWorkers, runParallelPlan, } from "./plan/orchestrator.js";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const workspace = path.resolve(__dirname, "../../../data/workspaces/sample");
const skillsRoot = path.resolve(__dirname, "../skills");
async function main() {
    console.log("Loom Agent · Plan Board 演示（mock，无需 API Key）\n");
    console.log(`workspace: ${workspace}\n`);
    const goal = "快速了解该示例项目能做什么，并列出入口文件";
    console.log("— 同质双线程 —");
    await runParallelPlan({
        workspaceRoot: workspace,
        goal,
        skillsRoot,
        workers: defaultDemoWorkers(goal),
        onStep: (s) => {
            const dur = s.startedAt && s.endedAt ? `${s.endedAt - s.startedAt}ms` : "";
            console.log(`• ${s.status.padEnd(8)} ${s.title} ${dur}`);
        },
    });
    console.log("\n— 异构并行（Reader + Editor HITL）—");
    const { plan, pendingWrites } = await runParallelPlan({
        workspaceRoot: workspace,
        goal,
        skillsRoot,
        workers: heteroDemoWorkers(goal),
        onStep: (s) => {
            const dur = s.startedAt && s.endedAt ? `${s.endedAt - s.startedAt}ms` : "";
            console.log(`• ${s.status.padEnd(8)} ${s.title} ${dur}`);
        },
    });
    console.log(`\n计划 ${plan.id} 完成；pendingWrites=${pendingWrites.length}（演示审批队列，未落盘）`);
    for (const w of pendingWrites) {
        console.log(`  · ${w.path} (from step ${w.stepId})`);
    }
}
main().catch((e) => {
    console.error(e);
    process.exitCode = 1;
});
