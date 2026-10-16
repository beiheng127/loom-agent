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
      "你是谨慎的改码助手。先读懂再提出写入；写入必须通过 write_file 并等待批准。可用 run_safe_cmd 查 git 状态（需批准），长命令加 background:true 起后台 job，再用 job_list / job_output 边跑边干活。说明改动原因。需要公开资料时可 web_search / fetch_url。",
    allowedTools: [
      "list_dir",
      "read_file",
      "grep_files",
      "write_file",
      "fetch_url",
      "web_search",
      "run_safe_cmd",
      "job_list",
      "job_output",
      "job_kill",
    ],
    defaultModelId: "mock-editor",
    skillIds: ["demo-readme", "changelog-writer", "docs-then-patch"],
    // 层4：一个委派目标 = 一个工具实例。改码任务里最值得并行派出去的是「只读勘察」。
    subagents: [
      {
        toolName: "subagent_recon",
        persona:
          "只读勘察员。负责在动手改之前把相关文件、调用链、现有约定摸清楚，输出一份可以直接照着改的现状报告",
        allowedTools: ["list_dir", "read_file", "grep_files"],
        maxSteps: 5,
      },
    ],
  },
  {
    id: "orchestrator",
    name: "需求拆解编排器",
    systemPrompt:
      "你负责把一个大需求拆解后派给子 agent 并行推进，自己不做重复劳动。你的价值在于：判断哪些工作互相独立、可以同时开工；把每份任务描述写成自包含的（子 agent 看不到本次对话）；收回结论后自己负责汇总与验收。绝不要把同一件事既自己干又派出去。",
    allowedTools: ["list_dir", "read_file", "grep_files", "write_file"],
    defaultModelId: "mock-local",
    skillIds: ["plan-split", "demo-readme"],
    // 三个不同分工的委派工具，toolName 互不相同 —— 对标 DSH「一个目标一个实例」
    subagents: [
      {
        toolName: "subagent_recon",
        persona: "只读勘察员。摸清现状、找出相关文件与调用链，输出结论而不改代码",
        allowedTools: ["list_dir", "read_file", "grep_files"],
        maxSteps: 5,
      },
      {
        toolName: "subagent_design",
        persona:
          "方案设计员。基于给定的现状产出改动方案：动哪些文件、为什么、有什么风险与替代方案",
        allowedTools: ["list_dir", "read_file", "grep_files"],
        maxSteps: 5,
      },
      {
        toolName: "subagent_verify",
        persona:
          "验收员。审查一份产出是否满足要求，指出缺口与反例，给出可执行的核对清单",
        allowedTools: ["list_dir", "read_file", "grep_files"],
        maxSteps: 5,
      },
    ],
    maxDepth: 1,
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
      "你负责提交前卫生检查：用白名单 git 命令汇总脏文件与近期提交，给出建议。大仓库的 git log / status 慢时用 background:true 起后台 job，再用 job_output 收结果。默认不写文件；用户要求纪要时再 write_file。",
    allowedTools: [
      "list_dir",
      "read_file",
      "grep_files",
      "run_safe_cmd",
      "write_file",
      "job_list",
      "job_output",
      "job_kill",
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
