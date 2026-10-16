import { createAgentProfile } from "./profiles.js";
/** 一键生成自定义 Agent 的模板（写入 loom-store，不覆盖内置） */
export const AGENT_TEMPLATES = [
    {
        id: "tpl-docs-writer",
        name: "文档纪要员",
        blurb: "读 README/TODO，起草 changelog（HITL）",
        profile: {
            systemPrompt: "你是文档纪要助手。先读再写；写文件必须 write_file 并等待批准。使用 Changelog 风格。",
            allowedTools: ["list_dir", "read_file", "grep_files", "write_file", "fetch_url", "run_safe_cmd"],
            defaultModelId: "mock-editor",
            skillIds: ["demo-readme", "changelog-writer"],
        },
    },
    {
        id: "tpl-strict-auditor",
        name: "严格审计官",
        blurb: "只读 + secure-audit skill，输出分级风险",
        profile: {
            systemPrompt: "你是严格安全审计官。只使用只读工具，按 Skill 清单扫描并分级，禁止写入。",
            allowedTools: ["list_dir", "read_file", "grep_files", "fetch_url"],
            defaultModelId: "mock-local",
            skillIds: ["secure-audit"],
        },
    },
    {
        id: "tpl-onboarder",
        name: "新人导游",
        blurb: "code-tour skill，输出 5 分钟上手路径",
        profile: {
            systemPrompt: "你是仓库导游。用短句带新人认识入口与目录，不要改代码。",
            allowedTools: ["list_dir", "read_file", "grep_files", "fetch_url"],
            defaultModelId: "mock-local",
            skillIds: ["code-tour", "demo-readme"],
        },
    },
    {
        id: "tpl-plan-coach",
        name: "并行教练",
        blurb: "plan-split skill，产出可并行 Worker 草案",
        profile: {
            systemPrompt: "你把目标拆成可并行子任务，标注建议 Agent/Model，不要执行写入。",
            allowedTools: ["list_dir", "read_file"],
            defaultModelId: "mock-local",
            skillIds: ["plan-split"],
        },
    },
    {
        id: "tpl-docs-patcher",
        name: "文档对照改码",
        blurb: "fetch 文档 → 读本地 → write Diff（docs-then-patch）",
        profile: {
            systemPrompt: "你先查公开文档与本地 README，再提出最小补丁。写入必须 write_file 并等待批准。",
            allowedTools: [
                "list_dir",
                "read_file",
                "grep_files",
                "fetch_url",
                "web_search",
                "write_file",
            ],
            defaultModelId: "mock-editor",
            skillIds: ["docs-then-patch", "demo-readme"],
        },
    },
    {
        id: "tpl-repo-hygiene",
        name: "提交前卫生",
        blurb: "git status/diff/log 白名单检查（repo-hygiene）",
        profile: {
            systemPrompt: "你做仓库卫生检查：批准后跑 git 只读命令，汇总脏文件与风险，默认不写盘。",
            allowedTools: [
                "list_dir",
                "read_file",
                "grep_files",
                "run_safe_cmd",
                "write_file",
            ],
            defaultModelId: "mock-local",
            skillIds: ["repo-hygiene"],
        },
    },
];
export function templateToProfile(templateId, nameOverride) {
    const t = AGENT_TEMPLATES.find((x) => x.id === templateId);
    if (!t)
        throw new Error(`未知模板: ${templateId}`);
    return createAgentProfile({
        id: `custom-${templateId.replace(/^tpl-/, "")}-${Date.now().toString(36).slice(-4)}`,
        name: nameOverride?.trim() || t.name,
        systemPrompt: t.profile.systemPrompt,
        allowedTools: t.profile.allowedTools,
        defaultModelId: t.profile.defaultModelId,
        skillIds: t.profile.skillIds,
    });
}
