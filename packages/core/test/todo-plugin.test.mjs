/**
 * 层5（todo）与层6（插件）的单测。
 *
 * 两条原则：
 * 1. 断言的是**语义**（整表替换、单一所有者、内置优先），不是实现细节；
 * 2. 反例必须一起测 —— 「拒绝的路径」和「成功的路径」同样是契约。
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import fs from "node:fs/promises";
import { fileURLToPath } from "node:url";

import {
  createTodoStore,
  createTodoWriteTool,
  summarizeTodoList,
  validateTodos,
  TODO_WRITE_SCHEMA,
  discoverPluginDirs,
  loadLoomPlugins,
  pluginToolsToDefinitions,
  mergePluginTools,
  defaultPluginsDir,
  PLUGIN_MANIFEST_FILENAME,
} from "../dist/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/* ================= 层5：todo ================= */

test("todo.1 schema 是整表替换：只有 todos 一个必填字段", () => {
  assert.equal(TODO_WRITE_SCHEMA.type, "object");
  assert.deepEqual(TODO_WRITE_SCHEMA.required, ["todos"]);
  assert.equal(TODO_WRITE_SCHEMA.additionalProperties, false);
  assert.equal(TODO_WRITE_SCHEMA.properties.todos.type, "array");
});

test("todo.2 校验通过：合法清单原样返回并 trim", () => {
  const r = validateTodos(
    { todos: [{ content: "  读代码  ", status: "pending" }] },
    { allowParallelInProgress: false },
  );
  assert.equal(r.ok, true);
  assert.deepEqual(r.todos, [{ content: "读代码", status: "pending" }]);
});

test("todo.3 content 为空 -> 报 DSH 同款错误文本", () => {
  const r = validateTodos({ todos: [{ content: "   ", status: "pending" }] }, {
    allowParallelInProgress: false,
  });
  assert.equal(r.ok, false);
  assert.equal(r.error, "Error: invalid todo: `content` must be a non-empty string");
});

test("todo.4 重复 content 被拒", () => {
  const r = validateTodos(
    {
      todos: [
        { content: "a", status: "pending" },
        { content: "a", status: "completed" },
      ],
    },
    { allowParallelInProgress: true },
  );
  assert.equal(r.ok, false);
  assert.match(r.error, /duplicate content "a"/);
});

test("todo.5 非并发部署：两个 in_progress 被拒（默认关闭并发）", () => {
  const r = validateTodos(
    {
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    },
    { allowParallelInProgress: false },
  );
  assert.equal(r.ok, false);
  assert.equal(
    r.error,
    "Error: invalid todos: at most one task may be in_progress (got 2)",
  );
});

test("todo.6 allowParallelInProgress=true 时多个 in_progress 合法", () => {
  const r = validateTodos(
    {
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    },
    { allowParallelInProgress: true },
  );
  assert.equal(r.ok, true);
  assert.equal(r.todos.length, 2);
});

test("todo.7 状态非法被拒（枚举外的值）", () => {
  const r = validateTodos({ todos: [{ content: "a", status: "doing" }] }, {
    allowParallelInProgress: true,
  });
  assert.equal(r.ok, false);
  assert.match(r.error, /`status` must be one of/);
});

test("todo.8 summarizeTodoList 输出 DSH 同款文案", () => {
  const s = summarizeTodoList([
    { content: "a", status: "pending" },
    { content: "b", status: "in_progress" },
    { content: "c", status: "completed" },
    { content: "d", status: "completed" },
  ]);
  assert.equal(s, "Updated todo list: 1 pending, 1 in progress, 2 completed.");
});

test("todo.9 整表替换：第二次写入覆盖第一次，不是追加", async () => {
  const store = createTodoStore();
  const tool = createTodoWriteTool({
    store,
    allowParallelInProgress: true,
    sessionId: "s1",
  });
  const store2 = createTodoStore();
  const tool2 = createTodoWriteTool({
    store: store2,
    allowParallelInProgress: true,
    sessionId: "s1",
  });
  await tool2.execute({ todos: [{ content: "a", status: "pending" }] }, {});
  // 同一个 store 上写两次
  const t = createTodoWriteTool({ store: store2, allowParallelInProgress: true, sessionId: "s1" });
  await t.execute(
    {
      todos: [
        { content: "a", status: "completed" },
        { content: "b", status: "pending" },
      ],
    },
    {},
  );
  const proj = store2.projection("s1");
  assert.equal(proj.todos.length, 2);
  assert.equal(proj.todos[0].status, "completed");
  // 事件日志保留两次写入（日志承载状态）
  assert.equal(store2.events("s1").length, 2);
  assert.equal(tool.name, "todo_write");
});

test("todo.10 单一所有者：不同会话互相看不见", async () => {
  const store = createTodoStore();
  const a = createTodoWriteTool({ store, allowParallelInProgress: true, sessionId: "sa" });
  await a.execute({ todos: [{ content: "仅 a 可见", status: "pending" }] }, {});
  assert.equal(store.projection("sa").todos.length, 1);
  assert.equal(store.projection("sb"), null);
});

test("todo.11 没有会话归属 -> 拒绝，且不写日志", async () => {
  const store = createTodoStore();
  const tool = createTodoWriteTool({
    store,
    allowParallelInProgress: true,
    sessionId: "",
  });
  const res = await tool.execute({ todos: [{ content: "a", status: "pending" }] }, {});
  assert.equal(res.ok, false);
  assert.equal(res.error, "Error: todo_write requires an owning agent session");
  assert.equal(store.events().length, 0);
});

test("todo.12 轮次语义：startTurn 清空投影，endTurn 保留清单", async () => {
  const store = createTodoStore();
  const tool = createTodoWriteTool({ store, allowParallelInProgress: true, sessionId: "s" });
  store.startTurn("s");
  await tool.execute({ todos: [{ content: "a", status: "completed" }] }, {});
  assert.equal(store.projection("s").todos.length, 1);
  store.endTurn("s");
  // turn/end 保留刚完成的清单
  assert.equal(store.projection("s").todos.length, 1);
  // 下一轮次开始清空
  store.startTurn("s");
  assert.equal(store.projection("s").todos, null);
  // 但事件日志还在
  assert.equal(store.events("s").length, 1);
});

test("todo.13 校验失败时不落事件（日志快照如实反映输入）", async () => {
  const store = createTodoStore();
  const tool = createTodoWriteTool({ store, allowParallelInProgress: false, sessionId: "s" });
  const res = await tool.execute(
    {
      todos: [
        { content: "a", status: "in_progress" },
        { content: "b", status: "in_progress" },
      ],
    },
    {},
  );
  assert.equal(res.ok, false);
  assert.equal(store.events("s").length, 0);
});

/* ================= 层6：插件 ================= */

test("plugin.1 发现：无插件目录时返回 []，不抛错", async () => {
  const dirs = await discoverPluginDirs(path.join(ROOT, "这个目录不存在"));
  assert.deepEqual(dirs, []);
});

test("plugin.2 发现：只认含 loom-plugin.json 的一级子目录", async () => {
  const dirs = await discoverPluginDirs(defaultPluginsDir(ROOT));
  // 仓库自带插件会越来越多，这里只锁「发现有清单的目录」，不锁数量
  assert.ok(dirs.length >= 1);
  assert.ok(dirs.some((d) => /hello-plugin$/.test(d)), "没发现 hello-plugin");
  for (const d of dirs) {
    const st = await fs.stat(path.join(d, PLUGIN_MANIFEST_FILENAME));
    assert.ok(st.isFile(), `${d} 里没有清单文件`);
  }
});

test("plugin.3 加载示例插件：manifest 校验通过，拿到两个工具", async () => {
  const plugins = await loadLoomPlugins({ root: defaultPluginsDir(ROOT) });
  // 自带插件全部必须加载成功——插件的失败隔离是隔离用户插件，不是给我们自己的糊弄用
  assert.deepEqual(
    plugins.filter((p) => p.error).map((p) => `${p.manifest?.name}: ${p.error}`),
    [],
  );
  const p = plugins.find((x) => x.manifest?.name === "hello-plugin");
  assert.ok(p, "没加载到 hello-plugin");
  assert.equal(p.tools.length, 2);
  assert.deepEqual(
    p.tools.map((t) => t.name).sort(),
    ["hello_echo", "repo_wordcount"],
  );
});

test("plugin.4 插件工具包成 ToolDefinition：返回值透传 / 包装正确", async () => {
  const plugins = await loadLoomPlugins({ root: defaultPluginsDir(ROOT) });
  const defs = pluginToolsToDefinitions(plugins);
  const echo = defs.find((d) => d.name === "hello_echo");
  assert.ok(echo);
  const res = await echo.execute({ text: "hi" }, { workspaceRoot: ROOT });
  assert.equal(res.ok, true);
  assert.equal(res.data.echo, "hi");
  assert.equal(res.data.plugin, "hello-plugin");
});

test("plugin.5 插件 execute 抛错被边界兜住，不逃出工具", async () => {
  const fake = [
    {
      manifest: { name: "boom", version: "0.0.0" },
      dir: "/x",
      module: null,
      tools: [
        {
          name: "boom_tool",
          description: "总是抛",
          inputSchema: { type: "object", properties: {}, required: [] },
          execute: async () => {
            throw new Error("炸了");
          },
        },
      ],
    },
  ];
  const defs = pluginToolsToDefinitions(fake);
  const res = await defs[0].execute({}, { workspaceRoot: ROOT });
  assert.equal(res.ok, false);
  assert.equal(res.error, "炸了");
});

test("plugin.6 去重：与内置同名 -> 内置优先，插件被丢弃并记理由", async () => {
  const fake = [
    {
      manifest: { name: "clash", version: "0.0.0" },
      dir: "/x",
      module: null,
      tools: [
        {
          name: "read_file",
          description: "和内置撞名",
          inputSchema: { type: "object", properties: {}, required: [] },
          execute: async () => ({}),
        },
      ],
    },
  ];
  const { added, skipped } = mergePluginTools(["read_file", "list_dir"], fake);
  assert.equal(added.length, 0);
  assert.equal(skipped.length, 1);
  assert.equal(skipped[0].reason, "与内置工具同名");
});

test("plugin.7 去重：插件之间同名 -> 先发现者优先", async () => {
  const mk = (pluginName, toolName) => ({
    manifest: { name: pluginName, version: "0.0.0" },
    dir: "/x",
    module: null,
    tools: [
      {
        name: toolName,
        description: "x",
        inputSchema: { type: "object", properties: {}, required: [] },
        execute: async () => ({}),
      },
    ],
  });
  const { added, skipped } = mergePluginTools([], [mk("p1", "dup_tool"), mk("p2", "dup_tool")]);
  assert.equal(added.length, 1);
  assert.equal(skipped.length, 1);
  assert.match(skipped[0].reason, /与插件 p1 的工具同名/);
});

test("plugin.8 坏 manifest 不中断其它插件：失败只写 error", async () => {
  const tmp = await fs.mkdtemp(path.join(ROOT, "tmp-plugins-"));
  try {
    // 一个好插件 + 一个坏 manifest
    const good = path.join(tmp, "good");
    await fs.mkdir(good, { recursive: true });
    await fs.writeFile(
      path.join(good, PLUGIN_MANIFEST_FILENAME),
      JSON.stringify({ name: "good", version: "1.0.0" }),
    );
    await fs.writeFile(
      path.join(good, "index.mjs"),
      `export const tools = [{ name: "good_tool", description: "x", inputSchema: { type: "object", properties: {}, required: [] }, execute: async () => ({ ok: true }) }];\n`,
    );

    const bad = path.join(tmp, "bad");
    await fs.mkdir(bad, { recursive: true });
    await fs.writeFile(path.join(bad, PLUGIN_MANIFEST_FILENAME), "{ 这不是 JSON");

    const plugins = await loadLoomPlugins({ root: tmp });
    assert.equal(plugins.length, 2);
    const okOne = plugins.find((p) => p.manifest.name === "good");
    const badOne = plugins.find((p) => p.dir.endsWith("bad"));
    assert.equal(okOne.error, undefined);
    assert.equal(okOne.tools.length, 1);
    assert.ok(badOne.error, "坏 manifest 必须有 error");
    assert.match(badOne.error, /manifest 读取\/解析失败/);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("plugin.9 插件目录名字典序：加载顺序可复现", async () => {
  const tmp = await fs.mkdtemp(path.join(ROOT, "tmp-plugins-"));
  try {
    for (const n of ["zebra", "alpha", "middle"]) {
      const d = path.join(tmp, n);
      await fs.mkdir(d, { recursive: true });
      await fs.writeFile(
        path.join(d, PLUGIN_MANIFEST_FILENAME),
        JSON.stringify({ name: n, version: "1.0.0" }),
      );
      await fs.writeFile(path.join(d, "index.mjs"), "export const tools = [];\n");
    }
    const plugins = await loadLoomPlugins({ root: tmp });
    assert.deepEqual(
      plugins.map((p) => p.manifest.name),
      ["alpha", "middle", "zebra"],
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("plugin.10 改了插件代码，下一次 load 就拿到新工具（别等重启）", async () => {
  const tmp = await fs.mkdtemp(path.join(ROOT, "tmp-plugins-"));
  const dir = path.join(tmp, "hot");
  const entry = path.join(dir, "index.mjs");
  const tool = (name) =>
    `export const tools = [{ name: "${name}", description: "x", inputSchema: { type: "object", properties: {}, required: [] }, execute: async () => ({ ok: true }) }];\n`;
  try {
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, PLUGIN_MANIFEST_FILENAME),
      JSON.stringify({ name: "hot", version: "1.0.0" }),
    );
    await fs.writeFile(entry, tool("first_tool"));

    const before = await loadLoomPlugins({ root: tmp });
    assert.deepEqual(before[0].tools.map((t) => t.name), ["first_tool"]);

    // 改内容 + 往前推 mtime（Node 的 ESM 缓存按 URL 存，靠 mtime 当版本号破缓存）
    await fs.writeFile(entry, tool("second_tool"));
    const future = new Date(Date.now() + 2000);
    await fs.utimes(entry, future, future);

    const after = await loadLoomPlugins({ root: tmp });
    assert.deepEqual(
      after[0].tools.map((t) => t.name),
      ["second_tool"],
      "改完插件代码还是旧工具——说明模块缓存没打破，所谓热加载只是「重启才生效」",
    );
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
