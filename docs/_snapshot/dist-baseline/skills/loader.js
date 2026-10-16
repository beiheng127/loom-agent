import fs from "node:fs/promises";
import path from "node:path";
import { parse as parseYaml } from "yaml";
function splitFrontmatter(raw) {
    if (!raw.startsWith("---\n")) {
        return { meta: {}, body: raw };
    }
    const end = raw.indexOf("\n---\n", 4);
    if (end === -1)
        return { meta: {}, body: raw };
    const yamlBlock = raw.slice(4, end);
    const body = raw.slice(end + 5);
    const meta = (parseYaml(yamlBlock) ?? {});
    return { meta, body };
}
export async function loadSkillsFromDir(skillsRoot) {
    const root = path.resolve(skillsRoot);
    let entries = [];
    try {
        entries = await fs.readdir(root);
    }
    catch {
        return [];
    }
    const skills = [];
    for (const id of entries) {
        const dir = path.join(root, id);
        const skillFile = path.join(dir, "SKILL.md");
        try {
            const st = await fs.stat(dir);
            if (!st.isDirectory())
                continue;
            const raw = await fs.readFile(skillFile, "utf8");
            const { meta, body } = splitFrontmatter(raw);
            skills.push({
                id,
                name: meta.name?.trim() || id,
                description: meta.description?.trim() || "",
                body: body.trim(),
                dir,
            });
        }
        catch {
            /* skip invalid skill dirs */
        }
    }
    return skills;
}
export function skillsToSystemBlock(skills) {
    if (skills.length === 0)
        return "";
    return skills
        .map((s) => `## Skill: ${s.name} (${s.id})\n${s.description}\n\n${s.body}`)
        .join("\n\n---\n\n");
}
