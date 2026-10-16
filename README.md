# Loom Agent

[![Node](https://img.shields.io/badge/Node-%E2%89%A520.18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white)](https://www.electronjs.org)
[![License](https://img.shields.io/badge/License-MIT-blue)]()

本地优先的 **Coding Agent Studio** —— 织机式 Plan Board：多智能体 × 多模型 × 并行线程。

一句话介绍：在一个 IDE 风格的工作台里，给任务派多个 AI Worker 并行读改你的代码库；所有写文件操作先出 Diff、你确认后才落盘，随时可撤回。**没有 API Key 也能完整跑通离线 Demo**，配置 Key 后无缝切换真模型（DeepSeek / OpenAI / 本地 Ollama）。

引擎侧是一套**真正的 harness**：AI SDK 原生 tool calling、逐步骤 token 计量、按阈值自动压缩上下文、子 Agent 委派、插件热加载（改插件源码下一次请求就生效，不用重启 Studio）。

> 设计 [`docs/DESIGN.md`](./docs/DESIGN.md) · 上手 [`docs/HANDOFF.md`](./docs/HANDOFF.md) · 进度 [`docs/PROGRESS.md`](./docs/PROGRESS.md) · 路线图 [`docs/ROADMAP.md`](./docs/ROADMAP.md) · **Harness 改造 [`docs/HARNESS-UPGRADE.md`](./docs/HARNESS-UPGRADE.md) · [`docs/HARNESS-P1.md`](./docs/HARNESS-P1.md)** · 简历条目 [`docs/RESUME.md`](./docs/RESUME.md)

## 核心特性

### ⚙️ Agent Harness：模型真正会「用工具」
- **原生 tool calling**：工具以 JSON Schema 声明，走 AI SDK v6 的 `streamText` + `stepCountIs`，多步 ReAct 由 SDK 驱动（不再靠正则从自由文本里抠 JSON）
- **逐步骤计量**：每一步上报 `input/output/cacheRead` token，超预算自动熔断
- **上下文压缩**：压力超过 `min(W×0.8, W−O−65536)` 时把最旧历史换成一条摘要，近期尾部逐字保留，**绝不切开 tool-call/tool-result 配对**
- **子 Agent 委派**：一个委派目标 = 一个工具实例。内置 `orchestrator` 挂了 `subagent_recon` / `subagent_design` / `subagent_verify` 三个；子 agent 看不到父级对话，中间步骤不回流父级
- **插件系统**：`plugins/<name>/loom-plugin.json` + `index.mjs`，零新依赖，单插件失败隔离不拖垮主循环。仓库自带四个能用的：`git_summary`（分支/改动分桶/最近提交）、`docs_link_check`（全仓 Markdown 死链）、`docs_link_report`（把报告塞进写审批队列，不自己落盘）、`deps_audit`（用了没声明 / 声明了没用）
- **todo 状态落盘**：`todo_write` 的事件按 JSONL 追加进 `data/loom-store/todos/<会话>.jsonl`，**重启后回放**（投影 + 轮次 + 历史事件都在）；写盘失败降级为内存，不打断循环
- **后台 job**：`run_safe_cmd` 传 `background`（仍需人工批准）后**立刻**拿到 `jobId`，模型用 `job_list` / `job_output` / `job_kill` 边跑边收——启动是写操作要审批，读取是只读随时可调。输出按游标只给新增，单 job 截到 8000 字符；句柄只在进程内存里，**重启即失效**（句柄不是状态，不假装持久，与 todo 相反）。无 Key 也能看这条通道：Demo 画廊的「后台 job：批准后边跑边收」（`jobs_tour` 剧本）

### 🧵 Plan Board：并行 Worker 织任务
- 同质 Plan、异构 Plan（不同角色分工协作）、三线程并行、**串行流水线（有依赖）**、自定义 Worker 均支持
- **真编排**：Worker 可以声明 `dependsOn`（下标），调度器按依赖分层——同批并行、批间串行；上游失败/跳过/取消 → 下游直接 `skipped`，不浪费 token
- **失败重试**：每个 Worker 失败后按 `maxRetries` 重试（默认 1），`attempts` 记在 step 上给 UI 看
- **上游结论下沉**：直接上游的结论摘要（单条 400 字符、合计 1200）拼进下游 goal——是数据流，不是各跑各的
- 依赖写歪（成环 / 越界 / 依赖自己）在**跑之前**就报 400，不跑到一半才发现编排是错的
- **模型动态拆步**：Plan 面板勾「让模型拆步」并选真模型后，`/api/plan` 先让模型把总目标拆成带依赖的 Worker 清单（一次调用、JSON 输出、`deps` 是下标），再交给同一个调度器跑；模型没给出可解析清单就回落预设，历史里写明「规划：未用（原因）」
- 拆步的 API 是 `POST /api/plan { preset, planner: true, plannerModelId, maxRetries }`；模型只给 1 个 Worker、给错依赖、给了不存在的序号，都在**跑之前**被挡下
- 多步任务四阶段推进：**摸清 → 拟定 → 改码 → 核对**，结果回写、逐步确认
- Plan 与会话全部本地持久化（JSON 存储），历史可查可删

- **best-of-N 择优**：Worker 设「候选数 > 1」就并行跑 N 份，再让裁判模型挑一份定稿（`judgeModelId`）；没接裁判时不假装择优，step 上写明「未接裁判」
- **失败重规划（Replanner）**：重试也失败的步，可以让规划模型重排**剩下没跑的步**（`replan: true`），新步不会沿用失败那一步的模型——那一步刚证明自己跑不通
- **同批并发上限**：`maxConcurrency`（默认 2，`<=0` 为不限）限制同一批同时跑几个，避免一批 20 个 Worker 或 N 个候选把 API 打爆

> 边界也说清楚：重规划**只重排还没跑的步**，已经 done / failed 的原样保留；它有全局预算（`maxReplans`，默认 1 = 整个 plan 最多重排一次），不是边跑边改计划的常驻 planner。择优同样要一次额外的裁判调用——N 份候选 + 1 次裁判，token 是实打实多花的。

### ✍️ Composer：Ask / Agent 双模式
- Ask 模式问代码，Agent 模式改代码；`@` 引用工作区文件
- SSE 流式输出；**写文件先 Diff 预览，命令执行走白名单审批（HITL）**
- 委派、压缩、token 用量在时间线里都有卡片；变更集统计、单次撤回 / 全部撤回

### 🤖 Agent 工厂 + Skills
- 内置 Agent 模板 + 自定义 Agent（可绑定工具集与 Skill）；委派能力**由 Agent 档案自己声明**
- 内置 Skills：`docs-then-patch`（查文档再改码）、`repo-hygiene`（仓库卫生）、`plan-split`、`secure-audit` 等，支持新建 / 编辑 / 导入

### 🔧 工具与模型
- 工具：内置 `list_dir` / `read_file` / `grep_files` / `write_file` / `fetch_url` / `web_search` / `run_safe_cmd`（白名单 + 超时熔断，可 `background`）/ `todo_write` / `job_list` / `job_output` / `job_kill`，外加插件提供的 `git_summary` / `docs_link_check` / `docs_link_report` / `deps_audit`
- 模型注册表：mock（离线）· DeepSeek · OpenAI · Ollama（实时探测本地模型），每个模型带 `contextWindow` 供压缩器读数
- BYOK（Bring Your Own Key）：Key 从环境变量注入（`.env`），不入库、不上传

### 🖥️ 三种打开方式
- `npm run demo`：纯 CLI，最快感受 Plan 编排
- `npm run studio`：Web 控制台（Home 概览 / Demo 画廊 / 功能说明 / 历史）
- `npm run desktop`：Electron 桌面壳，检测到 Studio 未启动会自动拉起

## 和 Aether Desk 的区别

同作者的另一个 Agent 项目，定位刻意错开：

| | Aether Desk | Loom Agent |
|--|-------------|------------|
| 场景 | 知识工作台 / RAG / 会话制品 | 读改代码库 / Skills / Plan Board |
| UI | 四栏工作台 | **IDE 风 Studio**（概览 + 任务 / Run / Plan / Agents…） |
| 壳 | 浏览器 | Web + **Electron** |
| 特异点 | Hybrid RAG + 引用 | **并行 Worker × 模型** + Agent 工厂 + Diff HITL |

## 架构

Monorepo（npm workspaces），三层结构：

```
agent/
├── packages/core/        # @loom/core：Agent 引擎（纯 TS，无 UI 依赖）
│   ├── src/loop/         #   Agent 执行循环 + 上下文压缩（compact.ts）
│   ├── src/agents/       #   Agent 工厂：profiles / templates / store / **subagents（委派）**
│   ├── src/plan/         #   真编排：依赖分批 + 重试 + 上游摘要下沉
│   ├── src/jobs/         #   后台 job：进程内句柄 + 输出游标（挂 globalThis，跨 route 共享）
│   ├── src/plugins/      #   **插件加载器（清单 + 失败隔离）**
│   ├── src/tools/        #   工具集：fs / cmd / web / planned（写审批）
│   ├── src/diff/         #   unified diff 生成
│   ├── src/skills/       #   Skill 加载与存储
│   ├── src/models/       #   模型注册表：mock / deepseek / openai / ollama
│   ├── test/             #   node:test 单测（128 条）
│   └── skills/           #   内置 SKILL.md 定义
├── apps/web/             # Next.js 15：Studio Web 界面（SSE + API routes）
├── apps/desktop/         # Electron 桌面壳
└── plugins/              # **用户插件目录**（自带：hello-plugin / git-plugin / docs-plugin / deps-plugin）
```

**安全设计**：写文件永远先产出 Diff 进入待审批状态，用户确认才落盘；命令执行走白名单前缀校验 + 超时熔断（危险字符表含 `| ; & \` $( > <` 与换行）；API Key 从环境变量注入。

## 快速开始

```bash
git clone https://github.com/beiheng127/loom-agent.git
cd loom-agent
npm install            # 需要 Node ≥ 20.18
npm run studio         # 编译 core + 启动 Web → http://localhost:3010
```

打开后默认进入 **Home · 概览**，可切「上手 Demo / 功能说明 / 历史」。**无 API Key 即可跑离线 Demo**（内置 mock 场景，全流程可跑通）。

配置真模型（可选）：复制 `.env.example` 为 `.env`，填入 `DEEPSEEK_API_KEY` 或 `OPENAI_API_KEY`；本机装了 Ollama 的话 Models 面板会实时探测到。

桌面壳（另开终端，需 Studio 已监听 3010）：

```bash
npm run desktop
```

## 门禁

```bash
npm run typecheck   # core + web 类型检查
npm test            # node:test，128 条用例
node packages/core/dist/demo.js   # 离线端到端 Demo（无需任何 Key）
cd apps/web && npx next build     # Web 构建，20 条路由
npm run studio                    # 起 :3010 后，另开终端跑 HTTP 端到端探针：
node scripts/probes/http.mjs           # 33 项断言：插件 / 委派 / 计量 / todo 落盘 / 依赖编排 / 模型拆步 / 后台 job 真的从 API 暴露
node scripts/probes/plugins.mjs        # 四个自带插件的真实能力 + 误报形态压测（无需起服务）
node scripts/probes/plugin-hot.mjs     # 热加载真不真：改插件源码 → 不重启 → /api/meta 立马变
node scripts/probes/planner-live.mjs   # 真模型拆步端到端：一句目标 → 模型出清单 → 分批跑完（需 Key，没 Key 自动跳过）
node scripts/probes/jobs.mjs               # 后台 job 通道：立刻返回 / 游标读输出 / kill 真收掉 / 白名单拦得住（库级，不用起服务）
node scripts/probes/audit-mock-claims.mjs    # 假动作审计：mock 剧本有没有「说了却没做」
node scripts/probes/check-docs-encoding.mjs  # 文档编码自检：BOM / U+FFFD / 常见 mojibake
```

> **Windows 上改中文文档别用 PowerShell。** `Get-Content` 默认按 ANSI(GBK) 读、`Set-Content -Encoding UTF8` 会写 BOM，
> 两者一凑就把 UTF 8 中文文档变成乱码（本项目真发生过，三个文档全毁）。
> 用编辑器的读写、或 Node 的 `fs.readFileSync(p, "utf8")`。`check-docs-encoding.mjs` 就是为此留的哨兵。

> **Studio 跑着的时候别执行 `npx next build`。** dev server 和 build 抢同一个 `apps/web/.next`，
> 构建会覆盖 dev 的 chunk，页面上立刻 500 报 `Cannot find module './79.js'`。
> 顺序要么「先 build 再起 studio」，要么先停 studio；真撞上了就删掉 `apps/web/.next` 重启（本项目撞过一次）。

## 写一个插件

零新依赖：建目录、写清单、导出一个 `tools` 数组。

```text
plugins/my-plugin/
├── loom-plugin.json
└── index.mjs
```

```json
{ "name": "my-plugin", "version": "0.1.0", "main": "index.mjs" }
```

```js
export const tools = [
  {
    name: "my_tool",
    description: "做一件小事",
    inputSchema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
    async execute(args, ctx) {
      return { ok: true, data: { echo: args.q, root: ctx.workspaceRoot } };
    },
  },
];
```

工具名须匹配 `^[a-z][a-z0-9_]*$`，与内置同名会被丢弃并记一条 warning；
插件抛错只会让它自己标成 `error`，**不会拖垮 Agent 循环**。

想让写文件走审批，别在插件里 `fs.writeFileSync`——返回 `pendingWrite`，主循环会把它变成一次 `approval_needed`：

```js
async execute(args) {
  return { ok: true, pendingWrite: { path: "report.md", content: "# ..." }, data: { chars: 195 } };
}
```

三个坑（前两个 `deps_audit` 真踩过）：一是**别用一条大正则**同时匹配 `import x from` / `from "x"` / `require("x")`，
宽松的 `["']([^"']+)["']` 会跨行吃到 `action?: "upsert" | "import"` 这种字符串字面量里的 `"import"`，
把后头 200 多个字符当成包名；二是 `tsconfig.json` 里的 `paths`（如 `@/*`）是**路径别名不是依赖**，
不读别名就会把 `@/lib/x` 报成「用了没声明的包」。仓库自带的 `scripts/probes/plugins.mjs` 就是压这两类误报的。
三是**别信「热加载」四个字**：Node 的 ESM 缓存按 URL 存，`import(fileURL)` 第二次直接返回旧模块，
于是「改了没反应、重启才生效」很常见；入口 URL 挂上 `?v=<mtime>` 才真的改完即生效
（`scripts/probes/plugin-hot.mjs` 专测这个，它会改一行插件源码再改回来）。
六个坑的全文、自带插件的真实输出、审批链路，都在 [`docs/PLUGINS.md`](./docs/PLUGINS.md)。

## 技术栈

TypeScript · Node.js ≥ 20 · Next.js 15 (App Router, SSE) · React · Electron · npm workspaces · Vercel AI SDK v6 · node:test

## 下一步

见 [`docs/HARNESS-P1.md`](./docs/HARNESS-P1.md) §6 与 [`docs/PROGRESS.md`](./docs/PROGRESS.md)：择优的**裁判缓存**（同一批候选只判一次）、重规划的**成本预算**（限制重排次数与 token）、批量重命名预览 + 批准、CI 里跑 lint。
