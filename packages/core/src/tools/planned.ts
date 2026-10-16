/**
 * 能力清单：已上线工具 vs 未配置/计划中。
 * 正式执行只走 TOOL_CATALOG；本文件供 meta / Models UI 展示。
 */

import { listSafeCmdPrefixes } from "./cmd.js";

export const PLANNED_TOOL_NAMES = [
  "web_search",
  "fetch_url",
  "run_safe_cmd",
] as const;

export type PlannedToolName = (typeof PLANNED_TOOL_NAMES)[number];

export type ToolCapabilityStatus = "live" | "not_configured" | "planned";

export const PLANNED_TOOL_BLURBS: Record<
  PlannedToolName,
  { description: string; requiresApproval: boolean; group: "web" | "local" }
> = {
  web_search: {
    group: "web",
    requiresApproval: false,
    description:
      "按关键词检索公开网页，返回标题、链接与摘要（需配置搜索服务）",
  },
  fetch_url: {
    group: "web",
    requiresApproval: false,
    description: "抓取指定 URL 的文本内容（禁内网；有超时与体积上限）",
  },
  run_safe_cmd: {
    group: "local",
    requiresApproval: true,
    description: "在工作区执行白名单内的本地命令（如 git status），需确认后执行",
  },
};

/** 已实现并注册进 catalog 的工具 */
export const LIVE_EXTENDED_TOOLS: PlannedToolName[] = [
  "fetch_url",
  "run_safe_cmd",
  "web_search",
];

export function isSearchConfigured(): boolean {
  return Boolean(
    process.env.TAVILY_API_KEY?.trim() ||
      process.env.LOOM_SEARCH_API_KEY?.trim() ||
      process.env.SERPAPI_API_KEY?.trim(),
  );
}

export function describeCapabilityStatus(
  name: PlannedToolName,
): ToolCapabilityStatus {
  if (name === "fetch_url" || name === "run_safe_cmd") return "live";
  if (name === "web_search") {
    return isSearchConfigured() ? "live" : "not_configured";
  }
  return "planned";
}

export function listPlannedTools() {
  return PLANNED_TOOL_NAMES.map((name) => ({
    name,
    ...PLANNED_TOOL_BLURBS[name],
    status: describeCapabilityStatus(name),
  }));
}

export function capabilitySettingsSnapshot() {
  return {
    search: {
      configured: isSearchConfigured(),
      envHints: ["TAVILY_API_KEY", "LOOM_SEARCH_API_KEY", "SERPAPI_API_KEY"],
      note: "未配置时 web_search 不可用，不会返回假结果",
    },
    fetch: {
      live: true,
      timeoutMs: Number(process.env.LOOM_FETCH_TIMEOUT_MS ?? 8000),
      maxChars: Number(process.env.LOOM_FETCH_MAX_CHARS ?? 4000),
      redirect: "manual（禁止跟随）",
    },
    safeCmd: {
      live: true,
      prefixes: listSafeCmdPrefixes(),
      envExtra: "LOOM_SAFE_CMDS（逗号分隔前缀）",
      timeoutMs: Number(process.env.LOOM_CMD_TIMEOUT_MS ?? 15000),
    },
    jobs: {
      live: true,
      tools: ["job_list", "job_output", "job_kill"],
      // 与 todo 相反：job 是「句柄」不是「状态」，重启后句柄就没了，
      // 落盘只会留下一堆永远 running 的假象，所以刻意只在进程内存里。
      persistent: false,
      maxOutputChars: 8000,
      keepFinished: 20,
      note: "后台跑：run_safe_cmd 传 background:true，批准后拿 jobId，再用 job_output 收输出",
    },
  };
}
