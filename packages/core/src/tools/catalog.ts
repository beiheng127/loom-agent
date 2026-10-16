import type {
  BuiltinToolName,
  ToolDefinition,
  ToolName,
} from "../types/index.js";
import { runSafeCmdTool } from "./cmd.js";
import {
  grepFiles,
  listDir,
  readFileTool,
  writeFileTool,
} from "./fs.js";
import { jobKillTool, jobListTool, jobOutputTool } from "./jobs.js";
import { fetchUrlTool, webSearchTool } from "./web.js";

export const TOOL_CATALOG: Record<
  Exclude<BuiltinToolName, "todo_write">,
  ToolDefinition
> = {
  // 内置 10 个工具从这里开始：需要会话状态的 todo_write / 委派工具不在目录里
  list_dir: {
    name: "list_dir",
    description: "列出工作区内某目录的文件与子目录",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description: "相对工作区根目录的目录路径，默认 .",
        },
      },
      required: [],
      additionalProperties: false,
    },
    execute: listDir,
  },
  read_file: {
    name: "read_file",
    description: "读取工作区内文本文件内容（过大自动截断）",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作区根目录的文件路径" },
        maxChars: {
          type: "number",
          description: "最多返回字符数，默认 12000",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    execute: readFileTool,
  },
  grep_files: {
    name: "grep_files",
    description: "在工作区内按关键字搜索源码/文档",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "要检索的关键字（大小写不敏感）" },
        path: {
          type: "string",
          description: "检索起点目录，相对工作区根目录，默认 .",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: grepFiles,
  },
  write_file: {
    name: "write_file",
    description: "请求写入文件（需人工批准后才真正落盘）",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        path: { type: "string", description: "相对工作区根目录的文件路径" },
        content: { type: "string", description: "要写入的完整文件内容" },
      },
      required: ["path", "content"],
      additionalProperties: false,
    },
    execute: writeFileTool,
  },
  fetch_url: {
    name: "fetch_url",
    description:
      "抓取公开 http(s) 页面文本摘要（禁内网、禁重定向、有超时）；用于查文档/报错页",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "要抓取的公开 http(s) URL" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    execute: fetchUrlTool,
  },
  web_search: {
    name: "web_search",
    description:
      "按关键词检索公开网页（需 Tavily / SerpAPI Key）；返回标题、链接与摘要，无 Key 时失败且不造假",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "检索关键词" },
        maxResults: {
          type: "number",
          description: "返回条数，默认 5，上限 8",
          minimum: 1,
          maximum: 8,
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    execute: webSearchTool,
  },
  run_safe_cmd: {
    name: "run_safe_cmd",
    description:
      "提议在工作区执行白名单命令（默认 git status/diff/log）；需人工确认后执行。传 background:true 则批准后立刻拿到 jobId，用 job_output 取输出，不阻塞循环",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "白名单命令，仅允许 git status / git diff / git log 前缀；禁止管道、重定向与命令拼接",
        },
        background: {
          type: "boolean",
          description: "true = 后台跑（长命令、要边跑边干别的）；默认 false 阻塞等结果",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: runSafeCmdTool,
  },
  job_list: {
    name: "job_list",
    description: "列出后台 job（在跑/已结束、命令、耗时、最近输出尾巴）",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: jobListTool,
  },
  job_output: {
    name: "job_output",
    description:
      "读后台 job 自上次读取以来的新增输出；传 wait:true 等它结束（最多 timeoutMs）",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "job id；省略则读最近一个" },
        wait: { type: "boolean", description: "true = 阻塞等它结束或超时" },
        timeoutMs: {
          type: "number",
          description: "wait 的等待上限，默认 1000，最大 30000",
          minimum: 1,
          maximum: 30000,
        },
      },
      required: [],
      additionalProperties: false,
    },
    execute: jobOutputTool,
  },
  job_kill: {
    name: "job_kill",
    description: "杀掉还在跑的后台 job（SIGTERM）",
    requiresApproval: false,
    inputSchema: {
      type: "object",
      properties: {
        jobId: { type: "string", description: "job id；job_list 里能看到" },
      },
      required: ["jobId"],
      additionalProperties: false,
    },
    execute: jobKillTool,
  },
};

/**
 * 按名字取工具定义。
 * 注意：`todo_write` 与委派工具（subagent / send_message / …）不在这个目录里 ——
 * 它们需要运行时状态（会话归属、子 agent 注册表），由 run.ts 在循环装配时注入。
 * 这里对未知名字**跳过而不是抛错**，好让 Agent 档案能声明这类工具名。
 */
export function toolsForAgent(allowed: ToolName[]): ToolDefinition[] {
  const out: ToolDefinition[] = [];
  for (const name of allowed) {
    if (name === "todo_write") continue;
    const tool = TOOL_CATALOG[name as Exclude<BuiltinToolName, "todo_write">];
    if (tool) out.push(tool);
  }
  return out;
}
