import type { ToolDefinition, ToolName } from "../types/index.js";
import { runSafeCmdTool } from "./cmd.js";
import {
  grepFiles,
  listDir,
  readFileTool,
  writeFileTool,
} from "./fs.js";
import { fetchUrlTool, webSearchTool } from "./web.js";

export const TOOL_CATALOG: Record<ToolName, ToolDefinition> = {
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
      "提议在工作区执行白名单命令（默认 git status/diff/log）；需人工确认后执行",
    requiresApproval: true,
    inputSchema: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description:
            "白名单命令，仅允许 git status / git diff / git log 前缀；禁止管道、重定向与命令拼接",
        },
      },
      required: ["command"],
      additionalProperties: false,
    },
    execute: runSafeCmdTool,
  },
};

export function toolsForAgent(allowed: ToolName[]): ToolDefinition[] {
  return allowed.map((name) => TOOL_CATALOG[name]);
}
