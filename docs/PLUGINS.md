# 插件：仓库自带的四个，和怎么自己写一个

> 更新：2026-10-16
> 关联：[`README.md`](../README.md) §写一个插件 · [`HARNESS-P1.md`](./HARNESS-P1.md) 层6 · [`PROGRESS.md`](./PROGRESS.md)

插件系统本身在 P1 就搭好了（`packages/core/src/plugins/`：清单校验 + 失败隔离）。
到 P2 之前，`plugins/` 下只有一个 `hello-plugin` —— 能证明「加载器能跑」，证明不了「插件能干活」。
现在自带四个，全部在真实仓库上跑出过具体数字。本文记的是**它们能干什么、协议长什么样、写的时候哪几个坑真会踩**。

---

## 一、自带的四个

| 插件 | 工具 | 读/写 | 一句话 | 实测（工作区 = 本仓库） |
|---|---|---|---|---|
| `git-plugin` | `git_summary` | 读 | 分支、改动分桶、最近提交 | 仓库根 `C:/Users/ruia3/Desktop/test`；分支「未提交过」；改动 1290（untracked 1290）；目录分布 `cli-skill(550) agent(204) boke-master(138) …` |
| `docs-plugin` | `docs_link_check` | 读 | 全仓 Markdown 死链体检 | 32 个文档 / 校验 36 条链接 / 跳过 14 条外部或锚点 / **断链 0** |
| `docs-plugin` | `docs_link_report` | **写（走审批）** | 把体检报告塞进写审批队列 | `requiresApproval=true`，`pendingWrite.path=docs-link-report.md`，195 字符，**文件没落盘** |
| `deps-plugin` | `deps_audit` | 读 | 用了没声明 / 声明了没用 | 4 个包 / 84 个源码文件 / missing 1 / unused 3 / unusedDev 0 |
| `hello-plugin` | `hello_echo`、`repo_wordcount` | 读 | 协议回归用的最小样例 | —— |

`deps_audit` 在本仓库上真扫出来的东西（不是演示数据）：

```
.              files=  9 imports=  1 missing=[ai] unused=[] unusedDev=[]
apps/desktop   files=  2 imports=  1 missing=[] unused=[] unusedDev=[]
apps/web       files= 41 imports=  3 missing=[] unused=[react-dom, zustand] unusedDev=[]
packages/core  files= 32 imports=  5 missing=[] unused=[zod] unusedDev=[]
```

- `missing=[ai]` 是**真的**：`scripts/probes/compact.mjs:10` 里 `await import("ai/test")`，
  而根 `package.json` 没声明 `ai` —— 今天能跑只是因为 npm 把 `packages/core` 的 `ai` 提升到了根 `node_modules`。
  换 pnpm 严格模式（或 `--install-strategy=nested`）当场就炸。**要不要给根包补上这条 devDependency，等李亚恒点头。**
- `react-dom` / `zustand` / `zod` 顺手查了 `apps/web/src`、`packages/core/src`：确实没有 import。
  `unused` 一律是「疑似」，因为动态拼字符串的 import 认不出来。
- 扫完这轮 `apps/desktop` 从「0 个文件、`electron` 声明了没用」变成「2 个文件、`electron` 真在用」——
  原因是它把 `main.mjs` / `preload.mjs` 摆在**包根**而不是 `src/`，第一版只扫 `src`。
  这就是那种「工具报出来的东西，得先想想是不是工具自己瞎了」的例子，见下面第 5 个坑。

---

## 二、协议（`loom-plugin.json` + `index.mjs`）

```text
plugins/my-plugin/
├── loom-plugin.json      # { name, version, main, description?, enabled?, author? }
└── index.mjs             # export const tools = [ ... ]
```

一个工具长这样：

```js
export const tools = [
  {
    name: "my_tool",                 // 必须匹配 ^[a-z][a-z0-9_]*$
    description: "给模型看的一句话",
    requiresApproval: false,         // 建议显式写，别靠默认
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    async execute(args, ctx) {
      // ctx: { workspaceRoot, signal? }
      return { ok: true, data: { echo: args.q } };
    },
  },
];
```

几条硬规矩（`packages/core/src/plugins/registry.ts`）：

- 只认**含 `loom-plugin.json` 的一级子目录**；按目录名字典序加载，顺序可复现。
- 工具名与内置同名 → **内置优先**，插件那个被丢弃并记一条 warning（`pluginToolsToDefinitions`）；
  插件之间同名 → 先发现者优先。
- 单个插件抛错只让它自己 `error`，其余照常加载，**不拖垮 Agent 循环**。
  `packages/core/test/todo-plugin.test.mjs` 的 `plugin.8` 锁这条（好插件 + 坏 manifest 并存）。
- `requiresApproval` 原样透传给 `ToolDefinition`（`registry.ts:348`：`spec.requiresApproval ?? false`）。

### 写工具别绕过审批

插件里**不要**自己 `fs.writeFileSync`。返回 `pendingWrite`，主循环会把它变成一次 `approval_needed`：

```js
async execute(args) {
  return {
    ok: true,
    requiresApproval: true,
    pendingWrite: { path: "docs-link-report.md", content: "# …" },
    data: { bytes: 195 },
  };
}
```

这条链路（`docs_link_report` 走的就是它）与内置 `write_file`（`src/tools/fs.ts:126`）完全相同：

```
插件 execute 返回 pendingWrite
  → src/loop/run.ts:387   if (result?.requiresApproval && result.pendingWrite)
  → SSE 推 approval_needed（/api/run/stream、/api/run 都有）
  → 用户点确认 → /api/writes/approve → applyApprovedWrite(workspaceRoot, path, content)
```

`plugins-real.test.mjs` 里的 `docs_link_report：自己不落盘，把 pendingWrite 交给审批队列` 锁的就是这条：
探针跑完，`docs-link-report.md` 依然 `文件是否已存在: false`。

---

## 三、写插件真会踩的六个坑

全是这轮改出来的，每个都留了测试或探针。

1. **别用一条大正则同时匹配各种 import。** 初版用
   `(?:from|import|require)\s*\(?\s*["']([^"']+)["']`，
   在 `apps/web/src/app/api/skills/route.ts` 里被 `action?: "upsert" | "import";` 钓中：
   字符串字面量里的 `"import"` 被当成关键字，它自己的收尾引号被当成说明符的左引号，
   一路吃到下一行的 `|| body.markdown) {`，包名成了 200 多个字符的源码片段。
   现在拆成五条**行锚定**正则，说明符本身 `[^"'\n]+`，注释/字符串里的 import 一律不认。
2. **`tsconfig` 的 `paths` 不是依赖。** `apps/web` 里 `"@/*": ["./src/*"]`，
   不读别名就会把 `@/components`、`@/lib` 报成「用了没声明」。
   现在按包读 `tsconfig.json` / `jsconfig.json` 的 `compilerOptions.paths`（包自己的和仓库根的），
   并把 `@/`、`~/`、`#`、裸 `@` 这类前缀直接排掉。
3. **归档目录要跳过。** `docs/_snapshot/` 里躺着历史源码副本，扫进来就是一堆假依赖（`docs/` 反正不在扫描目录里，但 `src/_snapshot` 会）。
   规则：`node_modules`、`dist`/`build`/`out`/`coverage`、`.` 与 `_` 开头的目录都不进。
   控制实验：`src/archive/old.ts` → 报 `@ghost/archived`；同样文件放 `src/_snapshot/` → 不报。
4. **文档里教人写代码的那一行，会被自己的链接检查器钓中。** README 插件章节写下
   `` `["']([^"']+)["']` `` 之后，`docs_link_check` 报 `README.md:161 -> [^"']+` 断链——
   它把 `](` 当成了 Markdown 链接。现在围栏代码块整块不扫，行内 code span 先抠掉再扫；
   而且抠 span 要按 CommonMark 的规矩认**等长反引号串**，否则 `` `a` `` 这种双反引号包单反引号的写法
   会只被抠掉三个反引号，里头那段又漏出来报一次（PLUGINS.md 自己踩了第二次）。
5. **包根上的源码也算源码。** `apps/desktop` 的入口是 `main.mjs`（包根，不在 `src/`），
   第一版只扫 `src/`/`app/`/`lib`/… 于是报「0 个文件 + `electron` 声明了没用」——
   而 `main.mjs:1` 明明写着 `import { app, BrowserWindow, dialog, ipcMain, shell } from "electron"`。
   现在包根上所有源码后缀的文件都扫（顺带把 `next.config.ts` 这类配置也覆盖了，不用单列白名单）。
6. **别信「插件热加载」这四个字，先问 Node 的 ESM 缓存。** 加载器一直是
   `await import(pathToFileURL(entry).href)`，而 Node 的模块缓存**按 URL 存**：
   同一个入口第二次 import 直接返回旧模块。于是 Studio 里改了插件源码，工具行为一动不动，
   重启一下才生效——但文档/界面上写着「插件热加载」，这就是假的。
   这轮抓到的实锤：同一个 `deps_audit`，命令行进程报 `unused 3`，跑着的 Studio 报 `unused 4`
   （多算了已修掉的 `electron`），差别就是进程里的旧模块。
   修法是把入口的 mtime 当版本号挂进 URL：`` `${pathToFileURL(entry).href}?v=${Math.trunc(st.mtimeMs)}` ``
   ——文件没动，URL 不变，照旧命中缓存；文件动过，URL 变，拿到新模块。
   （`packages/core/src/plugins/registry.ts:255` 附近；锁它的是 `todo-plugin.test.mjs` 的
   plugin.10 和 `scripts/probes/plugin-hot.mjs`。）

这些坑的压测都在 `packages/core/test/plugins-real.test.mjs`：`deps_audit` 用例里塞了注释钓鱼、
多行导入、字符串里的假 import、`@/` 别名、`src/_snapshot`；`docs_link_check` 用例里塞了围栏块、
单反引号与双反引号 span。热加载那条在第 6 坑，压测在 `packages/core/test/todo-plugin.test.mjs`。

---

## 四、怎么自己验一遍

```bash
node scripts/probes/plugins.mjs          # 库级：四个插件在真实仓库上打印人类可读输出，不用起服务
node packages/core/test/plugins-real.test.mjs   # 或 npm test（128 条里这 11 条）
npm run studio                            # :3010
node scripts/probes/http.mjs              # HTTP 面 12 项：/api/plugins、/api/meta 真的暴露插件
node scripts/probes/plugin-hot.mjs        # 改插件源码 → 不重启 → /api/meta 立马变（验「热加载」是不是真的）
node scripts/probes/plugin-live.mjs       # 真模型端到端（需 DEEPSEEK_API_KEY，没 Key 自动跳过）
```

`plugin-live.mjs` 是这轮最有说服力的一条：它不是 mock，也不是「工具包成了 ToolDefinition」这种单元级断言，
而是让**真模型自己决定调插件**：

```
PASS  服务在 http://127.0.0.1:3010，已加载插件工具 [deps_audit, docs_link_check, docs_link_report, git_summary, hello_echo, repo_wordcount]
PASS  POST /api/run 200（2696ms）模型=deepseek-chat
PASS  事件 224 条，tool_call=1 tool_result=1
PASS  模型真的调了插件工具：deps_audit
      answer(406 字): 扫描完成，结果如下： **包（共 4 个）** 1. `loom-agent`（根目录 `.`） …
PASS  答案里带具体数字
```

模型 → `tool_call deps_audit` → 插件 execute → `tool_result` → 模型拿数字总结，这一圈通了，
才叫「插件是 harness 的一部分」，而不是「仓库里多了一个能跑的 mjs」。
