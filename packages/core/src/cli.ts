#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getAgent } from "./agents/profiles.js";
import { runAgentLoop } from "./loop/run.js";
import { getModelConfig, listModels } from "./models/registry.js";
import {
  defaultDemoWorkers,
  runParallelPlan,
} from "./plan/orchestrator.js";
import { loadSkillsFromDir } from "./skills/loader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORE_ROOT = path.resolve(__dirname, "..");
const DEFAULT_SKILLS = path.join(CORE_ROOT, "skills");

function usage() {
  console.log(`Loom Agent CLI

用法:
  loom run  --workspace <dir> --goal <text> [--agent reader] [--model mock-local]
  loom plan --workspace <dir> --goal <text>
  loom models
  loom agents

示例:
  npm run cli -- run --workspace ../../data/workspaces/sample --goal "总结项目"
  npm run demo
`);
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  if (!cmd || cmd === "-h" || cmd === "--help") {
    usage();
    return;
  }

  if (cmd === "models") {
    for (const m of listModels()) {
      console.log(`- ${m.id}  (${m.provider}/${m.model})`);
    }
    return;
  }

  if (cmd === "agents") {
    const { BUILTIN_AGENTS } = await import("./agents/profiles.js");
    for (const a of BUILTIN_AGENTS) {
      console.log(`- ${a.id}: ${a.name} · model=${a.defaultModelId}`);
    }
    return;
  }

  const flags = parseFlags(argv.slice(1));
  const workspace = path.resolve(
    String(flags.workspace || path.join(CORE_ROOT, "../../data/workspaces/sample")),
  );
  const goal = String(flags.goal || "探索这个项目并总结");
  const skillsRoot = String(flags.skills || DEFAULT_SKILLS);

  if (cmd === "run") {
    const agentId = String(flags.agent || "reader");
    const modelId = String(flags.model || "mock-local");
    const agent = getAgent(agentId);
    const model = getModelConfig(modelId);
    const skills = await loadSkillsFromDir(skillsRoot);
    console.log(`[loom] workspace=${workspace}`);
    console.log(`[loom] agent=${agent.id} model=${model.id}`);
    const answer = await runAgentLoop({
      workspaceRoot: workspace,
      agent,
      model,
      skills,
      goal,
      onEvent: (e) => {
        if (e.type === "tool_call") {
          console.log(`  → tool ${e.name}`, JSON.stringify(e.args));
        } else if (e.type === "tool_result") {
          console.log(`  ← ${e.name} ok=${e.result.ok}`);
        } else if (e.type === "approval_needed") {
          console.log(`  ! 待批准写入 ${e.path}`);
        }
      },
    });
    console.log("\n=== Answer ===\n" + answer);
    return;
  }

  if (cmd === "plan") {
    console.log(`[loom] parallel plan · workspace=${workspace}`);
    const { plan, merged } = await runParallelPlan({
      workspaceRoot: workspace,
      goal,
      skillsRoot,
      workers: defaultDemoWorkers(goal),
      onStep: (s) => {
        console.log(`  [${s.status}] ${s.title} (${s.modelId})`);
      },
    });
    console.log(`\nPlan id=${plan.id} steps=${plan.steps.length}`);
    console.log("\n=== Merged ===\n" + merged);
    return;
  }

  usage();
  process.exitCode = 1;
}

function parseFlags(argv: string[]) {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1]!.startsWith("--") ? argv[++i]! : "true";
      out[key] = val;
    }
  }
  return out;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
