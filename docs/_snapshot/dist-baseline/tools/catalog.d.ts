import type { ToolDefinition, ToolName } from "../types/index.js";
export declare const TOOL_CATALOG: Record<ToolName, ToolDefinition>;
export declare function toolsForAgent(allowed: ToolName[]): ToolDefinition[];
/** 给模型看的精简工具说明 */
export declare function formatToolsForPrompt(tools: ToolDefinition[]): string;
