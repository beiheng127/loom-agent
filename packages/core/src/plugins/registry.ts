/**
 * loom-agent 简易插件系统 —— 发现 / 加载 / 转 ToolDefinition / 去重
 *
 * 顶层设计说明（目录结构、manifest 字段、加载顺序、与内置工具同名时的优先级）见 `./types.ts`
 * 的文件头注释；这里只补充实现层面的取舍：
 *
 * - **顺序加载**：`loadLoomPlugins` 按目录名字典序逐个 `await`，不并发。因为「插件之间重名保留
 *   先发现的那个」这条优先级只有在顺序确定时才有意义。
 * - **失败隔离**：任何单插件失败（manifest 坏 / 缺必填 / 入口不存在 / import 抛错 / 工具不合法）
 *   都收敛成该条记录上的 `error` 文本，绝不抛给调用方，也不影响后续插件。
 * - **`enabled: false` 的语义**：该插件**仍然出现在结果数组里**（保留目录、manifest、`tools: []`），
 *   但带一条 `error` 说明它被禁用。理由是让调用方能解释"我配置了但它没生效"，而不是静默消失。
 *   未通过校验的记录同理出现且 `module: null`。
 */

import fs from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import type { ToolDefinition } from "../types/index.js";
import type {
  LoadedLoomPlugin,
  LoomPluginManifest,
  LoomPluginModule,
  LoomPluginToolSpec,
} from "./types.js";

/** 插件根目录的一级目录名，默认在仓库根下 */
export const DEFAULT_PLUGINS_DIRNAME = "plugins";

/** 插件清单文件名 */
export const PLUGIN_MANIFEST_FILENAME = "loom-plugin.json";

/** 插件入口默认文件名 */
export const DEFAULT_PLUGIN_MAIN = "index.mjs";

/** 插件工具名只允许小写字母开头 + 小写字母/数字/下划线 */
export const PLUGIN_TOOL_NAME_PATTERN = /^[a-z][a-z0-9_]*$/;

/** 仓库根 -> 插件根目录 */
export function defaultPluginsDir(repoRoot: string): string {
  return path.join(path.resolve(repoRoot), DEFAULT_PLUGINS_DIRNAME);
}

function toErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
}

function baseName(dir: string): string {
  return path.basename(dir);
}

/**
 * 1) 发现：读 root 下的一级子目录，保留含 `loom-plugin.json` 的，按目录名字典序排序。
 * root 不存在 / 不可读 / 不是目录 -> `[]`，不抛错。
 */
export async function discoverPluginDirs(root: string): Promise<string[]> {
  const base = path.resolve(root);
  let entries: Dirent[];
  try {
    entries = await fs.readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }

  const dirs: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(base, entry.name);
    try {
      const st = await fs.stat(path.join(dir, PLUGIN_MANIFEST_FILENAME));
      if (!st.isFile()) continue;
    } catch {
      continue; // 没有 manifest 的目录不是插件
    }
    dirs.push(dir);
  }

  // 字典序（按目录名码点，不依赖 locale，保证跨机器可复现）
  dirs.sort((a, b) => {
    const an = baseName(a);
    const bn = baseName(b);
    if (an === bn) return 0;
    return an < bn ? -1 : 1;
  });
  return dirs;
}

/** 校验 manifest 形状；返回 error 时调用方构造"带 error 的记录" */
function parseManifest(
  raw: unknown,
): { manifest: LoomPluginManifest } | { error: string } {
  if (!isPlainObject(raw)) {
    return { error: `manifest 不是 JSON 对象（实际是 ${Array.isArray(raw) ? "array" : typeof raw}）` };
  }

  const name = nonEmptyString(raw.name);
  if (name === null) return { error: "manifest 缺少必填字段 name（非空字符串）" };

  const version = nonEmptyString(raw.version);
  if (version === null) return { error: "manifest 缺少必填字段 version（非空字符串）" };

  let main: string | undefined;
  if (raw.main !== undefined) {
    const m = nonEmptyString(raw.main);
    if (m === null) return { error: "manifest 的 main 必须是非空字符串" };
    main = m;
  }

  let enabled: boolean | undefined;
  if (raw.enabled !== undefined) {
    if (typeof raw.enabled !== "boolean") {
      return { error: "manifest 的 enabled 必须是布尔值" };
    }
    enabled = raw.enabled;
  }

  const manifest: LoomPluginManifest = { name, version };
  if (nonEmptyString(raw.description) !== null) {
    manifest.description = nonEmptyString(raw.description) as string;
  }
  if (main !== undefined) manifest.main = main;
  if (enabled !== undefined) manifest.enabled = enabled;
  if (nonEmptyString(raw.author) !== null) {
    manifest.author = nonEmptyString(raw.author) as string;
  }
  return { manifest };
}

/** 校验一个工具声明；不合法时返回原因文本 */
function validateToolSpec(raw: unknown): { tool: LoomPluginToolSpec } | { error: string } {
  if (!isPlainObject(raw)) {
    return { error: `工具项不是对象（实际是 ${Array.isArray(raw) ? "array" : typeof raw}）` };
  }

  const name = nonEmptyString(raw.name);
  if (name === null) return { error: "工具缺少合法的 name（非空字符串）" };
  if (!PLUGIN_TOOL_NAME_PATTERN.test(name)) {
    return {
      error: `工具名 "${name}" 不合法，必须匹配 ${PLUGIN_TOOL_NAME_PATTERN.source}`,
    };
  }

  const description = nonEmptyString(raw.description);
  if (description === null) {
    return { error: `工具 "${name}" 缺少合法的 description（非空字符串）` };
  }

  if (!isPlainObject(raw.inputSchema)) {
    return { error: `工具 "${name}" 的 inputSchema 必须是对象` };
  }

  if (typeof raw.execute !== "function") {
    return { error: `工具 "${name}" 的 execute 必须是函数` };
  }

  return {
    tool: {
      name,
      description,
      ...(typeof raw.requiresApproval === "boolean"
        ? { requiresApproval: raw.requiresApproval }
        : {}),
      inputSchema: raw.inputSchema as LoomPluginToolSpec["inputSchema"],
      execute: raw.execute as LoomPluginToolSpec["execute"],
    },
  };
}

/**
 * 2) + 3) + 4) 加载：读 manifest -> 校验 -> 动态 import 入口 -> 校验工具 -> 调一次 setup。
 * 单插件失败只写 `error`，不抛、不中断其它插件。
 */
export async function loadLoomPlugins(input: {
  root: string;
  log?: (m: string) => void;
}): Promise<LoadedLoomPlugin[]> {
  const log = input.log ?? (() => {});
  const dirs = await discoverPluginDirs(input.root);
  const results: LoadedLoomPlugin[] = [];

  for (const dir of dirs) {
    const fallbackName = baseName(dir);
    const manifestPath = path.join(dir, PLUGIN_MANIFEST_FILENAME);

    // --- manifest ---
    let rawManifest: unknown;
    try {
      rawManifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
    } catch (err) {
      const error = `manifest 读取/解析失败: ${toErrorMessage(err)}`;
      log(`[plugins] ${fallbackName} 加载失败：${error}`);
      results.push({
        manifest: { name: fallbackName, version: "0.0.0" },
        dir,
        tools: [],
        module: null,
        error,
      });
      continue;
    }

    const parsed = parseManifest(rawManifest);
    if ("error" in parsed) {
      log(`[plugins] ${fallbackName} 加载失败：${parsed.error}`);
      results.push({
        manifest: { name: fallbackName, version: "0.0.0" },
        dir,
        tools: [],
        module: null,
        error: parsed.error,
      });
      continue;
    }

    const manifest = parsed.manifest;

    // --- enabled: false 语义：保留记录但带 error，tools 为空（见文件头注释） ---
    if (manifest.enabled === false) {
      const error = "插件在 manifest 中 enabled: false，已跳过入口加载";
      log(`[plugins] ${manifest.name} 已禁用：${error}`);
      results.push({ manifest, dir, tools: [], module: null, error });
      continue;
    }

    // --- 动态 import 入口 ---
    const main = manifest.main ?? DEFAULT_PLUGIN_MAIN;
    const entryPath = path.join(dir, main);
    let entryMtimeMs = 0;
    try {
      const st = await fs.stat(entryPath);
      if (!st.isFile()) throw new Error(`入口不是文件: ${entryPath}`);
      entryMtimeMs = st.mtimeMs;
    } catch (err) {
      const error = `入口文件不存在或不可读 (${main}): ${toErrorMessage(err)}`;
      log(`[plugins] ${manifest.name} 加载失败：${error}`);
      results.push({ manifest, dir, tools: [], module: null, error });
      continue;
    }

    let moduleOrNull: LoomPluginModule | null = null;
    try {
      // `webpackIgnore` 是必需的，不是装饰：apps/web 的 next.config.ts 里
      // `transpilePackages: ["@loom/core"]` 会让 webpack 把这行动态 import 编译成
      // 一个 context module，运行时按「相对 bundle」解析；而插件入口是磁盘上的
      // 绝对 file:// URL，于是 Next 里必然报 `Cannot find module 'file:///...'`——
      // 纯 Node 下（单测、CLI）反而正常，所以库级探针查不出来，只有起 Studio 才暴露。
      // 加了这个注释 webpack 就原样保留 import()，交给 Node 的 ESM loader 处理。
      //
      // `?v=<mtime>` 也不是装饰：Node 的 ESM 缓存按 URL 存，同一个入口第二次 import
      // 直接返回旧模块——于是「改了插件代码要重启 Studio 才生效」会被错当成热加载。
      // 把文件 mtime 当版本号挂进 URL：文件没动 → URL 不变 → 命中缓存（不重复解析）；
      // 文件动过 → 新 URL → 拿到新模块。相对 import 的解析不受 query 影响。
      const version = Math.trunc(entryMtimeMs);
      const entryUrl = `${pathToFileURL(entryPath).href}?v=${version}`;
      const imported: unknown = await import(/* webpackIgnore: true */ entryUrl);
      const candidate = isPlainObject(imported) && imported.default !== undefined
        ? imported.default
        : imported;
      if (!isPlainObject(candidate)) {
        const error = "入口模块的导出不是对象（期望 `{ tools }` 或 `export default { tools }`）";
        log(`[plugins] ${manifest.name} 加载失败：${error}`);
        results.push({ manifest, dir, tools: [], module: null, error });
        continue;
      }
      moduleOrNull = candidate as LoomPluginModule;
    } catch (err) {
      const error = `入口 import 失败: ${toErrorMessage(err)}`;
      log(`[plugins] ${manifest.name} 加载失败：${error}`);
      results.push({ manifest, dir, tools: [], module: null, error });
      continue;
    }

    // --- 校验工具 ---
    const toolErrors: string[] = [];
    const tools: LoomPluginToolSpec[] = [];
    const declared = moduleOrNull.tools;
    if (declared === undefined) {
      // 没有 tools 的插件合法（可以只提供 agents / skills / setup）
    } else if (!Array.isArray(declared)) {
      toolErrors.push(`导出的 tools 不是数组（实际是 ${typeof declared}）`);
    } else {
      declared.forEach((item, i) => {
        const checked = validateToolSpec(item);
        if ("error" in checked) {
          const reason = `tools[${i}] ${checked.error}`;
          toolErrors.push(reason);
          log(`[plugins] ${manifest.name} 跳过非法工具：${reason}`);
        } else {
          tools.push(checked.tool);
        }
      });
    }

    // --- setup 钩子：加载后调用一次；抛错同样收敛成 error，已通过校验的工具仍然保留 ---
    if (typeof moduleOrNull.setup === "function") {
      try {
        await moduleOrNull.setup({
          pluginDir: dir,
          pluginName: manifest.name,
          log: (msg: string) => log(`[plugins:${manifest.name}] ${msg}`),
        });
      } catch (err) {
        const reason = `setup 钩子抛错: ${toErrorMessage(err)}`;
        toolErrors.push(reason);
        log(`[plugins] ${manifest.name} ${reason}`);
      }
    }

    const record: LoadedLoomPlugin = {
      manifest,
      dir,
      tools,
      module: moduleOrNull,
    };
    if (toolErrors.length > 0) record.error = toolErrors.join("; ");
    log(
      `[plugins] 已加载 ${manifest.name}@${manifest.version}：${tools.length} 个工具` +
        (record.error ? `（有错误：${record.error}）` : ""),
    );
    results.push(record);
  }

  return results;
}

/** 判断插件 `execute` 的返回值是不是已经是个 ToolResult 形状 */
function isToolResultShape(value: unknown): value is import("../types/index.js").ToolResult {
  if (!isPlainObject(value)) return false;
  return typeof (value as { ok?: unknown }).ok === "boolean";
}

/**
 * 5) 把插件工具转成 `ToolDefinition`。
 * `execute` 里包一层边界：
 * - 插件返回 `{ ok: boolean, ... }` -> 原样透传；
 * - 插件返回其它值 -> `{ ok: true, data: <返回值> }`；
 * - 插件抛错 -> `{ ok: false, error: <err.message> }`，异常绝不逃出工具边界。
 */
export function pluginToolsToDefinitions(
  plugins: LoadedLoomPlugin[],
): ToolDefinition[] {
  const defs: ToolDefinition[] = [];
  for (const plugin of plugins) {
    for (const spec of plugin.tools) {
      defs.push({
        name: spec.name as ToolDefinition["name"],
        description: spec.description,
        requiresApproval: spec.requiresApproval ?? false,
        inputSchema: spec.inputSchema,
        execute: async (args, ctx) => {
          try {
            const raw = await spec.execute(args, {
              workspaceRoot: ctx.workspaceRoot,
              ...(ctx.signal ? { signal: ctx.signal } : {}),
            });
            return isToolResultShape(raw) ? raw : { ok: true, data: raw };
          } catch (err) {
            return { ok: false, error: toErrorMessage(err) };
          }
        },
      });
    }
  }
  return defs;
}

/**
 * 6) 按 name 去重：**内置优先**。同名内置工具胜出，插件工具被丢弃（理由 `与内置工具同名`）；
 * 插件之间重名时保留先发现的那个（理由 `与插件 X 的工具同名`）。每次丢弃都记一条 log。
 */
export function mergePluginTools(
  builtin: string[],
  plugins: LoadedLoomPlugin[],
  log?: (m: string) => void,
): {
  added: LoomPluginToolSpec[];
  skipped: Array<{ name: string; reason: string }>;
} {
  const emit = log ?? (() => {});
  const builtinNames = new Set(builtin);
  const ownerByToolName = new Map<string, string>();
  const added: LoomPluginToolSpec[] = [];
  const skipped: Array<{ name: string; reason: string }> = [];

  for (const plugin of plugins) {
    for (const spec of plugin.tools) {
      if (builtinNames.has(spec.name)) {
        skipped.push({ name: spec.name, reason: "与内置工具同名" });
        emit(`[plugins] 跳过 ${spec.name}（来自 ${plugin.manifest.name}）：与内置工具同名`);
        continue;
      }
      const owner = ownerByToolName.get(spec.name);
      if (owner !== undefined) {
        const reason = `与插件 ${owner} 的工具同名`;
        skipped.push({ name: spec.name, reason });
        emit(`[plugins] 跳过 ${spec.name}（来自 ${plugin.manifest.name}）：${reason}`);
        continue;
      }
      ownerByToolName.set(spec.name, plugin.manifest.name);
      added.push(spec);
    }
  }

  return { added, skipped };
}
