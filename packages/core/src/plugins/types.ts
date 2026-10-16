/**
 * loom-agent 简易插件系统 —— 类型契约（对标 VS Code 扩展 / Rollup 插件的使用直觉）
 *
 * ## 插件目录结构
 * ```
 * <repoRoot>/
 *   plugins/                       <- 插件根目录（DEFAULT_PLUGINS_DIRNAME = "plugins"）
 *     hello-plugin/                <- 一个插件一个一级子目录，目录名是插件名的兜底来源
 *       loom-plugin.json           <- 插件清单（manifest），必须有，否则该目录被忽略
 *       index.mjs                  <- ESM 入口，默认 index.mjs
 * ```
 * 用 `defaultPluginsDir(repoRoot)` 得到插件根目录，再交给 `loadLoomPlugins({ root })`。
 *
 * ## manifest 字段
 * - `name`（必填）：插件唯一 id，同时是插件名。工具重名时按「先发现者优先」处理。
 * - `version`（必填）：版本号字符串，仅用于展示与排查。
 * - `description`（可选）：一句话说明。
 * - `main`（可选）：相对插件目录的 ESM 入口，默认 `"index.mjs"`。
 * - `enabled`（可选，默认 true）：显式 `false` 表示跳过加载入口。
 * - `author`（可选）：作者。
 *
 * 入口模块形状：`export const tools = [...]` 或 `export default { tools: [...] }`，两种都支持。
 *
 * ## 加载顺序
 * 1. `discoverPluginDirs(root)`：读 root 下的一级子目录，只保留含 `loom-plugin.json` 的，
 *    按目录名字典序排序；root 不存在返回 `[]`。
 * 2. `loadLoomPlugins({ root, log })`：按上面的顺序**顺序**逐个加载（顺序加载才能保证
 *    「先发现者优先」可预测）：读 manifest -> 校验 -> 动态 import 入口 -> 校验工具 -> 调一次 setup。
 *    任何一步失败都只在该条记录上写 `error`，不抛给调用方、也不中断其它插件。
 * 3. `pluginToolsToDefinitions(plugins)`：把插件工具包成 `ToolDefinition`。
 * 4. `mergePluginTools(builtinNames, plugins, log)`：与内置工具、其它插件工具去重。
 *
 * ## 插件工具与内置工具同名时的优先级
 * **内置优先**。同名插件工具被丢弃，理由是 `与内置工具同名`；插件之间重名时保留先发现的那个，
 * 后者理由是 `与插件 X 的工具同名`。所以插件作者应当自带命名空间前缀（如 `hello_echo`）。
 */

import type { JSONSchema7 } from "ai";

/** 插件清单 `loom-plugin.json` 的形状 */
export type LoomPluginManifest = {
  /** 插件唯一 id，同时是插件名 */
  name: string;
  version: string;
  description?: string;
  /** 相对插件目录的 ESM 入口，默认 "index.mjs" */
  main?: string;
  /** 默认 true；false 则跳过加载 */
  enabled?: boolean;
  author?: string;
};

/**
 * 插件声明的一个工具。
 * 注意 `execute` 可以返回任意值：返回 `{ ok: boolean, ... }` 会被当作 `ToolResult` 原样透传，
 * 其它返回值会被包成 `{ ok: true, data: <返回值> }`（见 `pluginToolsToDefinitions`）。
 */
export type LoomPluginToolSpec = {
  name: string;
  description: string;
  requiresApproval?: boolean;
  inputSchema: JSONSchema7;
  execute: (
    args: Record<string, unknown>,
    ctx: { workspaceRoot: string; signal?: AbortSignal },
  ) => Promise<unknown>;
};

/** 插件入口模块导出的形状（命名导出 `{ tools }` 与 `default: { tools }` 都归一到这里） */
export type LoomPluginModule = {
  tools?: LoomPluginToolSpec[];
  /** 插件可以注册新的 agent 档案 */
  agents?: unknown[];
  /** 插件可以自带 skill 正文 */
  skills?: Array<{ id: string; name: string; description: string; body: string }>;
  /** 可选初始化钩子，加载后调用一次 */
  setup?: (ctx: {
    pluginDir: string;
    pluginName: string;
    log: (msg: string) => void;
  }) => void | Promise<void>;
};

/** 一条插件加载结果。`error` 只表示"这个插件没加载全"，不表示整个加载过程失败 */
export type LoadedLoomPlugin = {
  manifest: LoomPluginManifest;
  dir: string;
  tools: LoomPluginToolSpec[];
  module: LoomPluginModule | null;
  /** 加载失败时为具体错误文本；失败不静默，也不抛给调用方 */
  error?: string;
};
