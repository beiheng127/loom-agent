import fs from "node:fs";
import path from "node:path";
import { parse as parseYaml } from "yaml";
import type { SkillMeta } from "../types/index.js";
import { loadSkillsFromDir } from "./loader.js";

export type StoredSkill = SkillMeta & {
  builtin: boolean;
};

type Frontmatter = {
  name?: string;
  description?: string;
};

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function slugifyId(raw: string): string {
  const s = raw
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff]+/gi, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 48);
  return s || `skill-${Date.now().toString(36)}`;
}

export function defaultCustomSkillsRoot(repoRoot: string) {
  return path.join(repoRoot, "data/loom-store/skills");
}

export function parseSkillMarkdown(raw: string): {
  name: string;
  description: string;
  body: string;
} {
  let meta: Frontmatter = {};
  let body = raw;
  if (raw.startsWith("---\n")) {
    const end = raw.indexOf("\n---\n", 4);
    if (end !== -1) {
      meta = (parseYaml(raw.slice(4, end)) ?? {}) as Frontmatter;
      body = raw.slice(end + 5);
    }
  }
  return {
    name: meta.name?.trim() || "",
    description: meta.description?.trim() || "",
    body: body.trim(),
  };
}

export function formatSkillMarkdown(input: {
  name: string;
  description: string;
  body: string;
}): string {
  const name = input.name.trim() || "untitled";
  const description = input.description.trim();
  const body = input.body.trim();
  return `---\nname: ${JSON.stringify(name)}\ndescription: ${JSON.stringify(description)}\n---\n\n${body}\n`;
}

export async function listAllSkills(
  builtinRoot: string,
  customRoot: string,
): Promise<StoredSkill[]> {
  const builtin = await loadSkillsFromDir(builtinRoot);
  const custom = await loadSkillsFromDir(customRoot);
  const builtinIds = new Set(builtin.map((s) => s.id));
  return [
    ...builtin.map((s) => ({ ...s, builtin: true as const })),
    ...custom
      .filter((s) => !builtinIds.has(s.id))
      .map((s) => ({ ...s, builtin: false as const })),
  ];
}

export async function upsertCustomSkill(
  customRoot: string,
  input: {
    id?: string;
    name: string;
    description?: string;
    body: string;
  },
  opts?: { builtinIds?: Set<string> },
): Promise<StoredSkill> {
  const name = input.name.trim();
  if (!name) throw new Error("Skill 名称不能为空");
  const body = input.body.trim();
  if (!body) throw new Error("Skill 正文不能为空");

  const id = slugifyId(input.id?.trim() || name);
  if (opts?.builtinIds?.has(id)) {
    throw new Error(`不能覆盖内置 Skill：${id}`);
  }

  const dir = path.join(path.resolve(customRoot), id);
  ensureDir(dir);
  const markdown = formatSkillMarkdown({
    name,
    description: input.description ?? "",
    body,
  });
  fs.writeFileSync(path.join(dir, "SKILL.md"), markdown, "utf8");

  return {
    id,
    name,
    description: (input.description ?? "").trim(),
    body,
    dir,
    builtin: false,
  };
}

export function deleteCustomSkill(customRoot: string, id: string): boolean {
  const safe = id.replace(/[/\\]/g, "");
  if (!safe || safe !== id) throw new Error("非法 Skill id");
  const dir = path.join(path.resolve(customRoot), safe);
  if (!fs.existsSync(dir)) return false;
  fs.rmSync(dir, { recursive: true, force: true });
  return true;
}

/** 从粘贴的 SKILL.md 全文导入；可指定 id */
export async function importSkillMarkdown(
  customRoot: string,
  markdown: string,
  preferredId?: string,
  opts?: { builtinIds?: Set<string> },
): Promise<StoredSkill> {
  const parsed = parseSkillMarkdown(markdown);
  if (!parsed.body && !parsed.name) {
    throw new Error("无法解析 Skill：请粘贴含 frontmatter 的 SKILL.md");
  }
  const name = parsed.name || preferredId || "imported-skill";
  return upsertCustomSkill(
    customRoot,
    {
      id: preferredId || slugifyId(name),
      name,
      description: parsed.description,
      body: parsed.body || "(empty)",
    },
    opts,
  );
}
