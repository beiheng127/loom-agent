import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 解析 monorepo 根（package.json name === loom-agent）。
 * 不用依赖编译后的 import.meta.url（Next 打包后路径会漂）。
 */
export function agentRepoRoot() {
  if (process.env.LOOM_ROOT) {
    return path.resolve(process.env.LOOM_ROOT);
  }

  let dir = process.cwd();
  for (let i = 0; i < 10; i++) {
    const pkgPath = path.join(dir, "package.json");
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
          name?: string;
        };
        if (pkg.name === "loom-agent") return dir;
      } catch {
        // ignore malformed package.json
      }
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // 源码回退：apps/web/src/lib → 上四级
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "../../../..");
}

export function defaultWorkspace() {
  return path.join(agentRepoRoot(), "data/workspaces/sample");
}

export function defaultSkillsRoot() {
  return path.join(agentRepoRoot(), "packages/core/skills");
}

/** 用户新建 / 导入的 Skill（可写，不覆盖内置包） */
export function defaultCustomSkillsRoot() {
  return path.join(agentRepoRoot(), "data/loom-store/skills");
}

export function defaultAgentStore() {
  return path.join(agentRepoRoot(), "data/loom-store/agents.json");
}

export function defaultSessionStore() {
  return path.join(agentRepoRoot(), "data/loom-store/sessions.json");
}

export function defaultPlanStore() {
  return path.join(agentRepoRoot(), "data/loom-store/plans.json");
}
