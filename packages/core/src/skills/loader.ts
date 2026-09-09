import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillMeta } from "../types/index.js";

type Frontmatter = {
  name?: string;
  description?: string;
};

function splitFrontmatter(raw: string): { meta: Frontmatter; body: string } {
  if (!raw.startsWith("---\n")) {
    return { meta: {}, body: raw };
  }
  const end = raw.indexOf("\n---\n", 4);
  if (end === -1) return { meta: {}, body: raw };
  const yamlBlock = raw.slice(4, end);
  const body = raw.slice(end + 5);
  const meta = (parseYaml(yamlBlock) ?? {}) as Frontmatter;
  return { meta, body };
}

export async function loadSkillsFromDir(
  skillsRoot: string,
): Promise<SkillMeta[]> {
  const root = path.resolve(skillsRoot);
  let entries: string[] = [];
  try {
    entries = await fs.readdir(root);
  } catch {
    return [];
  }

  const skills: SkillMeta[] = [];
  for (const id of entries) {
    const dir = path.join(root, id);
    const skillFile = path.join(dir, "SKILL.md");
    try {
      const st = await fs.stat(dir);
      if (!st.isDirectory()) continue;
      const raw = await fs.readFile(skillFile, "utf8");
      const { meta, body } = splitFrontmatter(raw);
      skills.push({
        id,
        name: meta.name?.trim() || id,
        description: meta.description?.trim() || "",
        body: body.trim(),
        dir,
      });
    } catch {
      /* skip invalid skill dirs */
    }
  }
  return skills;
}

export function skillsToSystemBlock(skills: SkillMeta[]): string {
  if (skills.length === 0) return "";
  return skills
    .map(
      (s) =>
        `## Skill: ${s.name} (${s.id})\n${s.description}\n\n${s.body}`,
    )
    .join("\n\n---\n\n");
}
