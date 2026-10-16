import {
  loadLoomPlugins,
  pluginToolsToDefinitions,
  type LoadedLoomPlugin,
  type ToolDefinition,
} from "@loom/core";
import { defaultPluginsRoot } from "./paths";

/**
 * 层6：把 `plugins/` 下的插件加载成工具。
 *
 * 每次请求都重新加载 —— 因为插件是用户随时能改的本地文件，缓存会让
 * 「改完插件刷新页面没生效」变成一个说不清的问题。加载失败只记一行日志，
 * 不让插件拖垮整个 Agent 循环（对标 DSH：单插件失败隔离成 error 字段）。
 */
export async function loadPluginTools(log?: (m: string) => void): Promise<{
  plugins: LoadedLoomPlugin[];
  tools: ToolDefinition[];
  warnings: string[];
}> {
  const warnings: string[] = [];
  const emit = (m: string) => {
    // core 的 log 通道成功/失败共用一条回调（`已加载 X@Y：N 个工具` 与
    // `X 加载失败：...` 走同一个入参）。成功那条直接丢弃：它既不该当 warning
    // 推给 UI（否则插件装得好好的，自测时却满屏 plugin_warning），也不该走
    // log 回调 —— 那个回调被 SSE 路由接成 `plugin_warning` 事件。
    // 「装了什么」由 `plugins` 事件本身表达，不需要文本。
    if (m.startsWith("[plugins] 已加载 ") && !m.includes("有错误")) return;
    warnings.push(m);
    log?.(m);
  };

  let plugins: LoadedLoomPlugin[] = [];
  try {
    plugins = await loadLoomPlugins({ root: defaultPluginsRoot(), log: emit });
  } catch (err) {
    // 目录不存在 / 无权限：插件是可选能力，不能因此让 Agent 起不来
    emit(
      `[plugins] 插件目录加载失败，按「无插件」继续：${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return { plugins: [], tools: [], warnings };
  }

  // 不再按 p.error 二次上报：loadLoomPlugins 的每条失败路径都已经走过 log 回调，
  // 这里再 emit 一次会在 UI 上出现同一个错误的两行（实测过）。

  return { plugins, tools: pluginToolsToDefinitions(plugins), warnings };
}
