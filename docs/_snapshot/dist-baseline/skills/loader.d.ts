import type { SkillMeta } from "../types/index.js";
export declare function loadSkillsFromDir(skillsRoot: string): Promise<SkillMeta[]>;
export declare function skillsToSystemBlock(skills: SkillMeta[]): string;
