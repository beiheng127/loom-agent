export type ToolName = "list_dir" | "read_file" | "grep_files" | "write_file" | "fetch_url" | "web_search" | "run_safe_cmd";
export type ToolResult = {
    ok: boolean;
    data?: unknown;
    error?: string;
    requiresApproval?: boolean;
    pendingWrite?: {
        path: string;
        content: string;
    };
    pendingCmd?: {
        command: string;
    };
};
export type ToolContext = {
    workspaceRoot: string;
    signal?: AbortSignal;
};
export type ToolDefinition = {
    name: ToolName;
    description: string;
    requiresApproval: boolean;
    execute: (args: Record<string, unknown>, ctx: ToolContext) => Promise<ToolResult>;
};
export type ModelProviderId = "mock" | "deepseek" | "openai" | "ollama";
export type ModelConfig = {
    id: string;
    provider: ModelProviderId;
    model: string;
    baseURL?: string;
    apiKeyEnv?: string;
    /** UI 展示用短说明 */
    blurb?: string;
    /** 建议温度（UI / 后续传给 generateText） */
    temperature?: number;
};
/** Mock 脚本场景：无 Key 也能演示探索 / 审计 / 写审批 / 命令 HITL / 工单阶段等 */
export type MockScenario = "explore" | "readme_focus" | "structure_focus" | "docs_focus" | "grep_audit" | "write_hitl" | "multi_write" | "cmd_hitl" | "fetch_url_stub" | "ask_readonly" | "rules_focus" | "todo_focus" | "package_focus" | "utils_focus" | "api_docs" | "env_audit" | "changelog_write" | "workflow_requirements" | "workflow_design" | "workflow_code" | "workflow_verify" | "skill_tour" | "list_only" | "multi_grep";
export type ModelAvailability = {
    id: string;
    ready: boolean;
    reason: string;
    keyEnv?: string;
    keyConfigured: boolean;
};
export type SkillMeta = {
    id: string;
    name: string;
    description: string;
    body: string;
    dir: string;
};
export type AgentProfile = {
    id: string;
    name: string;
    systemPrompt: string;
    allowedTools: ToolName[];
    defaultModelId: string;
    skillIds: string[];
};
export type PlanStepStatus = "pending" | "running" | "done" | "failed" | "cancelled";
export type PlanStep = {
    id: string;
    title: string;
    goal: string;
    agentId: string;
    modelId: string;
    status: PlanStepStatus;
    resultPreview?: string;
    error?: string;
    startedAt?: number;
    endedAt?: number;
};
export type Plan = {
    id: string;
    goal: string;
    steps: PlanStep[];
    createdAt: number;
};
export type LoopEvent = {
    type: "phase";
    phase: "thinking" | "tooling" | "writing" | "done";
} | {
    type: "text_delta";
    delta: string;
} | {
    type: "text";
    text: string;
} | {
    type: "tool_call";
    name: string;
    args: Record<string, unknown>;
} | {
    type: "tool_result";
    name: string;
    result: ToolResult;
} | {
    type: "approval_needed";
    kind?: "write" | "cmd";
    path: string;
    content: string;
    command?: string;
} | {
    type: "done";
    text: string;
} | {
    type: "error";
    message: string;
};
export type RunLoopInput = {
    workspaceRoot: string;
    agent: AgentProfile;
    model: ModelConfig;
    skills: SkillMeta[];
    goal: string;
    maxSteps?: number;
    signal?: AbortSignal;
    onEvent?: (event: LoopEvent) => void;
    /** 覆盖 mock 脚本；不传则按 agent/goal 推断 */
    mockScenario?: MockScenario;
    temperature?: number;
    /** 多轮：此前的 user/assistant 文本（不含 system） */
    history?: Array<{
        role: "user" | "assistant";
        content: string;
    }>;
    /** Ask 模式：即使 Agent 有 write_file 也不注入该工具 */
    readOnly?: boolean;
};
