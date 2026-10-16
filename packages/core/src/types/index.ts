import type { JSONSchema7, LanguageModel } from "ai";

/** 内置工具：编译期封闭联合，用于目录、白名单与路由 */
export type BuiltinToolName =
  | "list_dir"
  | "read_file"
  | "grep_files"
  | "write_file"
  | "fetch_url"
  | "web_search"
  | "run_safe_cmd"
  | "todo_write"
  | "job_list"
  | "job_output"
  | "job_kill";

/**
 * 工具名的类型。放宽为字符串，是为了让插件与子 agent 委派工具也能进入同一条
 * 工具流水线；内置工具仍用 BuiltinToolName 做穷尽检查。
 */
export type ToolName = BuiltinToolName | (string & {});

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
    /** 后台执行：批准后立刻返回 jobId，不阻塞循环 */
    background?: boolean;
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
  /** 层1：真工具协议。模型的参数校验靠它，不再靠 system prompt 里的文字约定 */
  inputSchema: JSONSchema7;
  execute: (
    args: Record<string, unknown>,
    ctx: ToolContext,
  ) => Promise<ToolResult>;
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
  /**
   * 上下文窗口（token）。层3 的压缩阈值按它算；不传则该模型不自动压缩。
   *
   * 对标 DSH 的 `ctx.llm.resolveModelInfo().context`：容量属于「路由」，不属于压缩器
   * —— compaction 只读这个值，不自己猜。
   */
  contextWindow?: number;
};

/** Mock 脚本场景：无 Key 也能演示探索 / 审计 / 写审批 / 命令 HITL / 工单阶段等 */
export type MockScenario =
  | "explore"
  | "readme_focus"
  | "structure_focus"
  | "docs_focus"
  | "grep_audit"
  | "write_hitl"
  | "multi_write"
  | "cmd_hitl"
  | "fetch_url_stub"
  | "ask_readonly"
  | "rules_focus"
  | "todo_focus"
  | "package_focus"
  | "utils_focus"
  | "api_docs"
  | "env_audit"
  | "changelog_write"
  | "workflow_requirements"
  | "workflow_design"
  | "workflow_code"
  | "workflow_verify"
  | "skill_tour"
  | "list_only"
  | "multi_grep"
  | "jobs_tour"
  | "delegate_fanout";

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
  /**
   * 层4：这个 Agent 能派出去的委派工具。一个目标一个实例，toolName 必须互不相同。
   * 不传 = 这个 Agent 没有委派能力（工具列表里不会出现任何委派工具）。
   */
  subagents?: SubagentSpec[];
  /** 委派深度上限，默认 1（0 表示禁止再往下派） */
  maxDepth?: number;
};

export type PlanStepStatus =
  | "pending"
  | "running"
  | "done"
  | "failed"
  /** 上游挂了，这一步没跑（编排里的「不再浪费 token」） */
  | "skipped"
  | "cancelled";

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
  /** 依赖的步骤 id（按 Worker 下标解析出来的，给人看的） */
  dependsOnIds?: string[];
  /** 第几批执行（0 基）：同批并行，批间串行 */
  batch?: number;
  /** 实际跑了几次（含重试）；1 表示一次过 */
  attempts?: number;
};

export type Plan = {
  id: string;
  goal: string;
  steps: PlanStep[];
  createdAt: number;
};

/** 层2：单步计量（真值取自 SDK 的 usage；估算兜底用 CHARS_PER_TOKEN） */
export type StepUsage = {
  step: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 本步上下文压力（输入 token 估算值），用于判断是否该压缩 */
  pressureTokens: number;
  /** 估算还是真值：true 表示来自模型 usage，false 表示按字符估的 */
  measured: boolean;
};

export type TokenBudget = {
  maxSteps?: number;
  maxTokens?: number;
  /** 上下文窗口（token）。压缩阈值按它算；不传则不做自动压缩 */
  contextWindow?: number;
  /** 压缩触发比例，默认 0.8 */
  compactThresholdRatio?: number;
  /** 压缩后逐字保留的尾部比例，默认 0.16 */
  compactRetainRatio?: number;
  /** 硬余量 token，默认 65536 */
  headroomTokens?: number;
};

/**
 * 委派工具规格：一个委派目标对应一个工具实例，toolName 必须互不相同。
 * 对标 DSH 的 dsh-tool-subagent「一个目标一个实例」。
 */
export type SubagentSpec = {
  /** 暴露给模型的工具名，需匹配 ^[a-z][a-z0-9_]*$ 且不得与其它工具重名 */
  toolName: string;
  /** 覆盖工具描述；不传则按 persona 生成 */
  description?: string;
  /** 子 agent 的人格/职责，会追加到 systemPrompt */
  persona: string;
  /** 子 agent 可用工具白名单；不传则继承父级 */
  allowedTools?: ToolName[];
  /** 子 agent 用的模型 id；不传继承父级 */
  modelId?: string;
  /** 子 agent 的步数上限，默认 5 */
  maxSteps?: number;
  /** 是否允许后台运行（调用时用 run_in_background 触发） */
  allowBackground?: boolean;
};

/** 子 agent 的对外状态。注意：inactive 只表示当前没有轮次在执行，不代表完成 */
export type SubagentStatus = "running" | "inactive" | "failed";

export type SubagentRecord = {
  id: string;
  /** 产出它的委派工具名，用于区分多个委派目标 */
  toolName: string;
  label: string;
  status: SubagentStatus;
  depth: number;
  startedAt: number;
  endedAt?: number;
  /** 累积的步数 */
  steps: number;
  /** 最近一次产出（前台返回的最终文本） */
  lastText?: string;
  error?: string;
};

export type LoopEvent =
  | { type: "phase"; phase: "thinking" | "tooling" | "writing" | "done" }
  | { type: "text_delta"; delta: string }
  | { type: "text"; text: string }
  | { type: "tool_call"; name: string; args: Record<string, unknown> }
  | { type: "tool_result"; name: string; result: ToolResult }
  | { type: "tool_input_delta"; name: string; delta: string }
  | { type: "usage"; usage: StepUsage; budget?: TokenBudget }
  | {
      type: "approval_needed";
      kind?: "write" | "cmd";
      path: string;
      content: string;
      command?: string;
      /** 后台命令：UI 批准时要把它带回去，approve 路由才知道起 job */
      background?: boolean;
    }
  | { type: "done"; text: string; usage?: StepUsage[] }
  | { type: "subagent_start"; id: string; toolName: string; label: string; depth: number }
  | {
      type: "subagent_end";
      id: string;
      toolName: string;
      status: SubagentStatus;
      text?: string;
      error?: string;
      steps: number;
    }
  | {
      type: "compacted";
      compactedCount: number;
      releasedTokens: number;
      pressureTokens: number;
      thresholdTokens: number;
      retainedCount: number;
      reason?: string;
    }
  | { type: "error"; message: string };

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
  history?: Array<{ role: "user" | "assistant"; content: string }>;
  /** Ask 模式：即使 Agent 有 write_file 也不注入该工具 */
  readOnly?: boolean;
  /** 层2：预算。maxSteps 覆盖 maxSteps；maxTokens 超了就停 */
  budget?: TokenBudget;
  /**
   * 测试缝：直接注入 LanguageModel，跳过 resolveLanguageModel。
   * 生产路径不要传，让 registry 按 model config 解析。
   */
  languageModel?: LanguageModel;
  /** 层4：对本轮可见的委派工具。一个目标一个实例，toolName 互不相同 */
  subagents?: SubagentSpec[];
  /** 委派深度。0 表示禁止再往下委派，默认 1 */
  maxDepth?: number;
  /** 层5：todo 工具的会话归属与状态 */
  todo?: {
    sessionId: string;
    allowParallelInProgress: boolean;
  };
  /** 层6：额外的工具（插件注册的），会与内置工具按名合并 */
  extraTools?: ToolDefinition[];
  /** 层5：本轮开始前是否清空 todo 投影（默认 true，对标 DSH 的「下一轮次开始清空」） */
  resetTodosAtTurnStart?: boolean;
};
