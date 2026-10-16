import type { AgentProfile, ToolName } from "../types/index.js";

export const BUILTIN_AGENTS: AgentProfile[] = [
  {
    id: "reader",
    name: "只读探索者",
    systemPrompt:
      "你是代码库只读助手。先列目录再读关键文件，用简洁中文总结结构与入口。不要尝试写文件。需要公开文档时可 fetch_url。优先遵循已加载 Skills。",
    allowedTools: ["list_dir", "read_file", "grep_files", "fetch_url", "web_search"],
    defaultModelId: "mock-local",
    skillIds: ["demo-readme", "code-tour"],
  },
  {
    id: "editor",
    name: "改码助手",
    systemPrompt:
      "你是谨慎的改码助手。先读懂再提出写入；写入必须通过 write_file 并等待批准。可用 run_safe_cmd 查 git 状态（需批准）。说明改动原因。需要公开资料时可 web_search / fetch_url。",
    allowedTools: [
      "list_dir",
      "read_file",
      "grep_files",
      "write_file",
      "fetch_url",
      "web_search",
      "run_safe_cmd",
    ],
    defaultModelId: "mock-editor",
    skillIds: ["demo-readme", "changelog-writer", "docs-then-patch"],
  },
  {
    id: "auditor",
    name: "安全审计员",
    systemPrompt:
      "你只做只读审计：找可疑路径、密钥痕迹、过大文件引用。输出风险列表，禁止写文件。严格遵循 secure-audit Skill。",
    allowedTools: ["list_dir", "read_file", "grep_files", "fetch_url"],
    defaultModelId: "mock-local",
    skillIds: ["secure-audit"],
  },
  {
    id: "planner",
    name: "计划拆解员",
    systemPrompt:
      "你负责把用户目标拆成 2～4 个可并行的子任务标题与目标，不要直接改代码。遵循 plan-split Skill。",
    allowedTools: ["list_dir", "read_file", "fetch_url"],
    defaultModelId: "mock-local",
    skillIds: ["plan-split", "demo-readme"],
  },
  {
    id: "guide",
    name: "新人导游",
    systemPrompt:
      "你是耐心的仓库导游。输出 5 分钟上手路径与目录地图，禁止写文件。",
    allowedTools: ["list_dir", "read_file", "grep_files", "fetch_url"],
    defaultModelId: "mock-local",
    skillIds: ["code-tour", "demo-readme"],
  },
  {
    id: "hygienist",
    name: "仓库卫生员",
    systemPrompt:
      "你负责提交前卫生检查：用白名单 git 命令汇总脏文件与近期提交，给出建议。默认不写文件；用户要求纪要时再 write_file。",
    allowedTools: [
      "list_dir",
      "read_file",
      "grep_files",
      "run_safe_cmd",
      "write_file",
    ],
    defaultModelId: "mock-local",
    skillIds: ["repo-hygiene", "secure-audit"],
  },
];

/** @deprecated 请用 resolveAgent(storePath) 以包含自定义 Agent */
export function getAgent(id: string): AgentProfile {
  const a = BUILTIN_AGENTS.find((x) => x.id === id);
  if (!a) throw new Error(`未知 Agent: ${id}`);
  return a;
}

export function createAgentProfile(input: {
  id: string;
  name: string;
  systemPrompt: string;
  allowedTools?: ToolName[];
  defaultModelId?: string;
  skillIds?: string[];
}): AgentProfile {
  return {
    id: input.id,
    name: input.name,
    systemPrompt: input.systemPrompt,
    allowedTools: input.allowedTools ?? ["list_dir", "read_file", "grep_files"],
    defaultModelId: input.defaultModelId ?? "mock-local",
    skillIds: input.skillIds ?? [],
  };
}

/** 从内置 Agent 克隆为可编辑草稿（仍需 upsert 才持久化） */
export function cloneAgentAsCustom(
  source: AgentProfile,
  nameSuffix = "（副本）",
): AgentProfile {
  return createAgentProfile({
    id: `custom-${source.id}-${Date.now().toString(36).slice(-4)}`,
    name: `${source.name}${nameSuffix}`,
    systemPrompt: source.systemPrompt,
    allowedTools: [...source.allowedTools],
    defaultModelId: source.defaultModelId,
    skillIds: [...source.skillIds],
  });
}
