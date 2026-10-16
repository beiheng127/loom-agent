import type { SkillMeta } from "../types/index.js";
export type StoredSkill = SkillMeta & {
    builtin: boolean;
};
export declare function defaultCustomSkillsRoot(repoRoot: string): string;
export declare function parseSkillMarkdown(raw: string): {
    name: string;
    description: string;
    body: string;
};
export declare function formatSkillMarkdown(input: {
    name: string;
    description: string;
    body: string;
}): string;
export declare function listAllSkills(builtinRoot: string, customRoot: string): Promise<StoredSkill[]>;
export declare function upsertCustomSkill(customRoot: string, input: {
    id?: string;
    name: string;
    description?: string;
    body: string;
}, opts?: {
    builtinIds?: Set<string>;
}): Promise<StoredSkill>;
export declare function deleteCustomSkill(customRoot: string, id: string): boolean;
/** 从粘贴的 SKILL.md 全文导入；可指定 id */
export declare function importSkillMarkdown(customRoot: string, markdown: string, preferredId?: string, opts?: {
    builtinIds?: Set<string>;
}): Promise<StoredSkill>;
