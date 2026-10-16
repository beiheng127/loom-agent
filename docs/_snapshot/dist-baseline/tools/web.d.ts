import type { ToolContext, ToolResult } from "../types/index.js";
/** 禁止内网 / 非 http(s)，与 Aether Desk 对齐的演示级 SSRF 防护 */
export declare function assertPublicHttpUrl(raw: string): URL;
export declare function fetchUrlTool(args: Record<string, unknown>, _ctx: ToolContext): Promise<ToolResult>;
export type WebSearchHit = {
    title: string;
    url: string;
    snippet: string;
};
/** 公开网页搜索：优先 Tavily，其次 SerpAPI；无 Key 时诚实失败 */
export declare function webSearchTool(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
