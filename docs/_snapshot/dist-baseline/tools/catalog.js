import { runSafeCmdTool } from "./cmd.js";
import { grepFiles, listDir, readFileTool, writeFileTool, } from "./fs.js";
import { fetchUrlTool, webSearchTool } from "./web.js";
export const TOOL_CATALOG = {
    list_dir: {
        name: "list_dir",
        description: "列出工作区内某目录的文件与子目录",
        requiresApproval: false,
        execute: listDir,
    },
    read_file: {
        name: "read_file",
        description: "读取工作区内文本文件内容（过大自动截断）",
        requiresApproval: false,
        execute: readFileTool,
    },
    grep_files: {
        name: "grep_files",
        description: "在工作区内按关键字搜索源码/文档",
        requiresApproval: false,
        execute: grepFiles,
    },
    write_file: {
        name: "write_file",
        description: "请求写入文件（需人工批准后才真正落盘）",
        requiresApproval: true,
        execute: writeFileTool,
    },
    fetch_url: {
        name: "fetch_url",
        description: "抓取公开 http(s) 页面文本摘要（禁内网、禁重定向、有超时）；用于查文档/报错页",
        requiresApproval: false,
        execute: fetchUrlTool,
    },
    web_search: {
        name: "web_search",
        description: "按关键词检索公开网页（需 Tavily / SerpAPI Key）；返回标题、链接与摘要，无 Key 时失败且不造假",
        requiresApproval: false,
        execute: webSearchTool,
    },
    run_safe_cmd: {
        name: "run_safe_cmd",
        description: "提议在工作区执行白名单命令（默认 git status/diff/log）；需人工确认后执行",
        requiresApproval: true,
        execute: runSafeCmdTool,
    },
};
export function toolsForAgent(allowed) {
    return allowed.map((name) => TOOL_CATALOG[name]);
}
/** 给模型看的精简工具说明 */
export function formatToolsForPrompt(tools) {
    return tools
        .map((t) => `- ${t.name}: ${t.description}${t.requiresApproval ? " [需批准]" : ""}`)
        .join("\n");
}
