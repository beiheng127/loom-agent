import { defaultDemoWorkers, heteroDemoWorkers, } from "../plan/orchestrator.js";
import { listAutoSelectableRealModels, preferredComposerModelId, preferredRealModelRoles, } from "../models/registry.js";
/** 上手路径：按 step 顺序点即可理解系统 */
export const DEMO_RECIPES = [
    {
        id: "explore-readme",
        step: 1,
        title: "探索示例项目",
        subtitle: "只读探索 · 列目录与读文件",
        proves: "浏览工作区并总结项目结构",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "总结 sample 工作区定位、入口文件与技术栈",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "readme_focus",
        },
    },
    {
        id: "audit-grep",
        step: 1,
        title: "安全审计（grep）",
        subtitle: "审计 Agent · 搜索 TODO 与可疑痕迹",
        proves: "用 grep 扫描工作区风险点",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "审计工作区：查找 TODO、FIXME 与疑似密钥痕迹",
            agentId: "auditor",
            modelId: "mock-local",
            mockScenario: "grep_audit",
        },
    },
    {
        id: "docs-tour",
        step: 1,
        title: "阅读 docs/",
        subtitle: "只读探索 · 浏览文档目录",
        proves: "多文件阅读并概括架构说明",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "浏览 docs 目录并概括 ARCHITECTURE",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "docs_focus",
        },
    },
    {
        id: "write-hitl",
        step: 2,
        title: "提议写入并人工批准",
        subtitle: "改码助手 · 写文件需审批",
        proves: "写操作先出 Diff，再由你批准或拒绝",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "起草 notes/session-brief.md 工作纪要（需审批）",
            agentId: "editor",
            modelId: "mock-editor",
            mockScenario: "write_hitl",
        },
    },
    {
        id: "multi-write",
        step: 2,
        title: "一次提议两个文件",
        subtitle: "改码助手 · 批量写入提议",
        proves: "审批队列可同时处理多条写入",
        kind: "run",
        etaSec: 3,
        run: {
            goal: "同时提议 changelog 与 notes 两份草稿",
            agentId: "editor",
            modelId: "mock-editor",
            mockScenario: "multi_write",
        },
    },
    {
        id: "plan-homo",
        step: 3,
        title: "同质双线程 Plan",
        subtitle: "结构探索 ∥ README 精读",
        proves: "两个只读线程并行推进同一目标",
        kind: "plan",
        etaSec: 3,
        plan: {
            goal: "快速了解示例项目能做什么",
            preset: "homo",
        },
    },
    {
        id: "plan-hetero",
        step: 3,
        title: "异构并行（推荐）",
        subtitle: "探索 ∥ 改码 · 不同角色协作",
        proves: "多 Agent 并行，写操作回流审批",
        kind: "plan",
        etaSec: 3,
        plan: {
            goal: "了解项目并起草备忘",
            preset: "hetero",
        },
    },
    {
        id: "plan-triple",
        step: 3,
        title: "三线程织机",
        subtitle: "结构 + 审计 + 写入",
        proves: "Plan Board 可同时跑三个 Worker",
        kind: "plan",
        etaSec: 4,
        plan: {
            goal: "全面摸底 sample 并留下纪要草案",
            preset: "triple",
        },
    },
    {
        id: "custom-agent-hint",
        step: 4,
        title: "创建自己的 Agent",
        subtitle: "到 Agents 页用模板或表单保存",
        proves: "自定义工具、Skills 与系统提示",
        kind: "run",
        etaSec: 0,
    },
    {
        id: "skill-audit",
        step: 1,
        title: "带 Skill 的审计",
        subtitle: "审计 Agent + 安全审计 Skill",
        proves: "Skill 写入 system 提示并驱动扫描",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "按安全审计 Skill 扫描工作区风险",
            agentId: "auditor",
            modelId: "mock-local",
            mockScenario: "grep_audit",
        },
    },
    {
        id: "skill-tour",
        step: 1,
        title: "新人导览",
        subtitle: "导览 Agent + 代码导览 Skill",
        proves: "按 Skill 做入口与目录地图导览",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "做 5 分钟代码导览：入口与目录地图",
            agentId: "guide",
            modelId: "mock-local",
            mockScenario: "skill_tour",
        },
    },
    {
        id: "skill-docs-patch",
        step: 2,
        title: "查文档再改码",
        subtitle: "docs-then-patch · Diff HITL",
        proves: "先读本地说明再提议写入",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "按 docs-then-patch：读 README 后提议一处纪要草稿",
            agentId: "editor",
            modelId: "mock-editor",
            mockScenario: "changelog_write",
        },
    },
    {
        id: "skill-repo-hygiene",
        step: 2,
        title: "仓库卫生检查",
        subtitle: "repo-hygiene · git 白名单",
        proves: "run_safe_cmd 需批准后汇总卫生建议",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "提交前仓库卫生检查：git status 与建议",
            agentId: "hygienist",
            modelId: "mock-local",
            mockScenario: "cmd_hitl",
        },
    },
    // —— 扩充离线全流程 fixture（仅无云端 Key / 选用 mock 模型时走脚本）——
    {
        id: "list-only",
        step: 1,
        title: "只列目录",
        subtitle: "最小只读",
        proves: "list_dir 单工具路径",
        kind: "run",
        etaSec: 1,
        run: {
            goal: "只列出工作区根目录",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "list_only",
        },
    },
    {
        id: "structure-focus",
        step: 1,
        title: "结构探索",
        subtitle: "目录 + 入口文件",
        proves: "structure_focus 脚本",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "探索目录结构与入口",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "structure_focus",
        },
    },
    {
        id: "rules-focus",
        step: 1,
        title: "阅读 RULES",
        subtitle: ".loom/RULES.md",
        proves: "规则注入可被脚本覆盖",
        kind: "run",
        etaSec: 1,
        run: {
            goal: "阅读 .loom/RULES.md 并总结约束",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "rules_focus",
        },
    },
    {
        id: "todo-focus",
        step: 1,
        title: "TODO 清单",
        subtitle: "TODO.md + grep",
        proves: "读文件与 grep 组合",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "汇总 TODO.md 与代码 TODO",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "todo_focus",
        },
    },
    {
        id: "package-focus",
        step: 1,
        title: "读 package.json",
        subtitle: "依赖与脚本",
        proves: "配置文件精读",
        kind: "run",
        etaSec: 1,
        run: {
            goal: "阅读 package.json 依赖",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "package_focus",
        },
    },
    {
        id: "utils-focus",
        step: 1,
        title: "读 src 工具",
        subtitle: "index + utils",
        proves: "多文件精读",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "阅读 src 入口与工具函数",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "utils_focus",
        },
    },
    {
        id: "api-docs",
        step: 1,
        title: "读 API 文档",
        subtitle: "docs/API.md",
        proves: "接口文档精读",
        kind: "run",
        etaSec: 1,
        run: {
            goal: "阅读 docs/API.md 接口文档",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "api_docs",
        },
    },
    {
        id: "env-audit",
        step: 1,
        title: "环境变量审计",
        subtitle: "sk- / password / .env.example",
        proves: "敏感痕迹扫描",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "审计 .env 与疑似密钥痕迹",
            agentId: "auditor",
            modelId: "mock-local",
            mockScenario: "env_audit",
        },
    },
    {
        id: "multi-grep",
        step: 1,
        title: "多关键词 grep",
        subtitle: "export / function / TODO",
        proves: "连续 grep 路径",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "多关键词扫描 export function TODO",
            agentId: "auditor",
            modelId: "mock-local",
            mockScenario: "multi_grep",
        },
    },
    {
        id: "ask-readonly",
        step: 1,
        title: "Ask 只读",
        subtitle: "禁止写与命令",
        proves: "Ask 模式脚本",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "Ask 模式只读总结项目，不要写文件",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "ask_readonly",
        },
    },
    {
        id: "fetch-url-stub",
        step: 1,
        title: "fetch_url 离线 stub",
        subtitle: "无外网模拟抓取",
        proves: "fetch 路径可演示",
        kind: "run",
        etaSec: 1,
        run: {
            goal: "演示 fetch_url 抓取公开页（离线 stub）",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "fetch_url_stub",
        },
    },
    {
        id: "cmd-hitl",
        step: 2,
        title: "命令 HITL",
        subtitle: "git status 待批准",
        proves: "run_safe_cmd 审批",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "执行 git status（需审批）",
            agentId: "editor",
            modelId: "mock-editor",
            mockScenario: "cmd_hitl",
        },
    },
    {
        id: "changelog-write",
        step: 2,
        title: "CHANGELOG 草稿",
        subtitle: "单文件写审批",
        proves: "changelog_write 脚本",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "起草 changelog 草稿并走审批",
            agentId: "editor",
            modelId: "mock-editor",
            mockScenario: "changelog_write",
        },
    },
    {
        id: "wf-requirements",
        step: 2,
        title: "任务·摸清现状",
        subtitle: "多步①",
        proves: "任务步脚本可回写摘要",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "【多步任务 · 摸清现状】补充 README 入口说明",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "workflow_requirements",
        },
    },
    {
        id: "wf-design",
        step: 2,
        title: "任务·拟定改法",
        subtitle: "多步②",
        proves: "方案步产出",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "【多步任务 · 拟定改法】补充 README 入口说明",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "workflow_design",
        },
    },
    {
        id: "wf-code",
        step: 2,
        title: "任务·动手改码",
        subtitle: "多步③ + Diff",
        proves: "改码步可提写入",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "【多步任务 · 动手改码】补充 README 入口说明",
            agentId: "editor",
            modelId: "mock-editor",
            mockScenario: "workflow_code",
        },
    },
    {
        id: "wf-verify",
        step: 2,
        title: "任务·核对结果",
        subtitle: "多步④ + 命令",
        proves: "核对步可提 git status",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "【多步任务 · 核对结果】补充 README 入口说明",
            agentId: "editor",
            modelId: "mock-editor",
            mockScenario: "workflow_verify",
        },
    },
    {
        id: "explore-generic",
        step: 1,
        title: "综合探索",
        subtitle: "默认 explore",
        proves: "默认脚本回落",
        kind: "run",
        etaSec: 2,
        run: {
            goal: "综合探索 sample 工作区",
            agentId: "reader",
            modelId: "mock-local",
            mockScenario: "explore",
        },
    },
    {
        id: "plan-homo-offline",
        step: 3,
        title: "Plan 同质（强调离线）",
        subtitle: "强制 mock workers",
        proves: "preferReal=false 路径",
        kind: "plan",
        etaSec: 3,
        plan: {
            goal: "离线同质双线程摸底",
            preset: "homo",
        },
    },
];
/** 有云端 Key 时 Demo 应改走真模型，剥离 mockScenario */
export function resolveDemoRunForEnvironment(run) {
    const realId = preferredComposerModelId();
    if (!realId || !hasReadyRealModel()) {
        return { ...run };
    }
    // 接入 AI 后：不调用 mock 测试数据
    return {
        goal: run.goal,
        agentId: run.agentId,
        modelId: realId,
        mockScenario: undefined,
    };
}
export function getDemoRecipe(id) {
    return DEMO_RECIPES.find((d) => d.id === id);
}
/** 离线 mock Worker 预设（preferReal:false 强制） */
export function workersForPlanPresetMock(preset, goal) {
    switch (preset) {
        case "hetero":
            return heteroDemoWorkers(goal);
        case "triple":
            return tripleDemoWorkers(goal);
        case "homo":
        default:
            return defaultDemoWorkers(goal);
    }
}
/**
 * Plan Worker 工厂。
 * - 默认 preferReal=true：有 Key 用真模型，否则 mock
 * - preferReal=false：强制离线 demo 脚本
 */
export function workersForPlanPreset(preset, goal, options) {
    if (options?.preferReal === false) {
        return workersForPlanPresetMock(preset, goal);
    }
    return workersForPlanPresetAuto(preset, goal);
}
/**
 * Key 就绪时用真实模型跑 Plan；否则回落 mock workers。
 * 角色偏好：reader→ollama/deepseek，auditor/editor→deepseek（再回落 openai/ollama）。
 * 不带 mockScenario，走真实 generate/stream 路径。
 */
export function workersForPlanPresetAuto(preset, goal) {
    const roles = preferredRealModelRoles();
    if (!roles) {
        return workersForPlanPresetMock(preset, goal);
    }
    switch (preset) {
        case "hetero":
            return [
                {
                    agentId: "reader",
                    modelId: roles.reader,
                    title: "Reader · 结构",
                    goal: `列出目录与入口，服务：${goal}`,
                },
                {
                    agentId: "editor",
                    modelId: roles.editor,
                    title: "Editor · 提议写入",
                    goal: `为「${goal}」起草一份 notes 备忘并走 write_file 审批`,
                },
            ];
        case "triple":
            return [
                {
                    agentId: "reader",
                    modelId: roles.reader,
                    title: "W1 · 结构",
                    goal: `列目录找入口，服务：${goal}`,
                },
                {
                    agentId: "auditor",
                    modelId: roles.auditor,
                    title: "W2 · 审计",
                    goal: `grep 风险痕迹，服务：${goal}`,
                },
                {
                    agentId: "editor",
                    modelId: roles.editor,
                    title: "W3 · 纪要草案",
                    goal: `为「${goal}」起草 notes 并走审批`,
                },
            ];
        case "homo":
        default:
            return [
                {
                    agentId: "reader",
                    modelId: roles.reader,
                    title: "线程 A · 结构探索",
                    goal: `探索工作区目录结构，服务总目标：${goal}`,
                },
                {
                    agentId: "reader",
                    modelId: roles.reader,
                    title: "线程 B · README 精读",
                    goal: `阅读 README.md 并提炼要点，服务总目标：${goal}`,
                },
            ];
    }
}
/** 是否有任一非 mock 模型就绪（供 UI / meta） */
export function hasReadyRealModel() {
    return listAutoSelectableRealModels().length > 0;
}
export function tripleDemoWorkers(goal) {
    return [
        {
            agentId: "reader",
            modelId: "mock-local",
            title: "W1 · 结构",
            goal: `列目录找入口，服务：${goal}`,
            mockScenario: "structure_focus",
        },
        {
            agentId: "auditor",
            modelId: "mock-local",
            title: "W2 · 审计",
            goal: `grep 风险痕迹，服务：${goal}`,
            mockScenario: "grep_audit",
        },
        {
            agentId: "editor",
            modelId: "mock-editor",
            title: "W3 · 纪要草案",
            goal: `为「${goal}」起草 notes 并走审批`,
            mockScenario: "write_hitl",
        },
    ];
}
