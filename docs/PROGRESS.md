# Loom Agent · 进度与任务清单

> 更新：2026-10-16
> 关联：[`HARNESS-UPGRADE.md`](./HARNESS-UPGRADE.md)（P0）· [`HARNESS-P1.md`](./HARNESS-P1.md)（P1）· [`PLUGINS.md`](./PLUGINS.md)（P2 · **本次**）· [`ROADMAP.md`](./ROADMAP.md) · [`CAPABILITY-MAP.md`](./CAPABILITY-MAP.md)

---

## 当前状态（一句话）

**有真 harness 的本地 Coding Agent Studio**：原生 tool calling + 逐步 token 计量 + 阈值上下文压缩 + 子 Agent 委派 + 插件热加载（自带 4 个能干活的插件）+ **Plan 真编排（依赖分批 / 重试 / 上游摘要下沉 / 模型动态拆步）** + **后台 job 通道（`job_list` / `job_output` / `job_kill`）**；Composer Diff HITL、并行与串行流水线、Skills/Agents 照旧；**128 条单测全绿**，无 Key 可跑离线 Demo。

---

## P1 本轮增量（2026-10-15）

引擎侧从「有个循环」补到「有 harness」。细节见 [`HARNESS-P1.md`](./HARNESS-P1.md)。

| 层 | 内容 | 文件 | 状态 |
|---|---|---|---|
| 3 | 上下文压缩（0.8 / 0.16 / 65536 阈值） | `src/loop/compact.ts` | ✅ |
| 4 | 子 Agent 委派 + 控制工具 | `src/agents/subagents.ts` | ✅ |
| 5 | `todo_write` 整表替换 + 会话投影 | `src/plan/todo.ts` | ✅ |
| 6 | 插件系统（清单 + 失败隔离） | `src/plugins/` + `plugins/` | ✅ |
| — | 白名单补 `>` `<`（越界写洞） | `src/tools/cmd.ts` | ✅ |
| — | 两个运行路由 + `meta` 接线 | `apps/web/src/app/api/` | ✅ |
| — | UI 渲染委派/压缩/token 事件 | `apps/web/src/components/LoomShell.tsx` | ✅ |
| 7 | 单测 0 → 58 | `packages/core/test/` | ✅ |

**关键修复**：`sessionId` 之前从未随请求发出，导致 todo 能力在 UI 里永远走不到；
`subagent_start` / `subagent_end` / `compacted` / `usage` 四个事件之前落进 SSE
if/else 链会被**静默丢弃**——两者都已接上。

补记（同日）：层5 此前**没有离线演示入口**——`todo_focus` 只读 TODO.md 不调 `todo_write`，
而 `resolveMockScenario` 的 `/TODO/i` 分支排在 `todo_focus` 之前，把「看看 TODO.md 里的待办清单」
也截走判成 `grep_audit`。现在 `todo_focus` 真调一次整表替换，显式待办措辞优先匹配，
单测 25/26 锁住这两条；HTTP 面实测 `tool_call todo_write` → `Updated todo list: 1 pending, 1 in progress, 1 completed.`

---

## P2 本轮增量（2026-10-16）

P1 把插件系统搭好了，但 `plugins/` 里只有一个 `hello-plugin`——能证明加载器会跑，证明不了「插件能干活」。
这轮补的是**四个真插件 + 端到端证据**，细节见 [`PLUGINS.md`](./PLUGINS.md)。

| 插件 | 工具 | 读/写 | 实测（工作区 = 本仓库） |
|---|---|---|---|
| `git-plugin` | `git_summary` | 读 | 仓库根 `C:/Users/ruia3/Desktop/test`；分支「未提交过」；改动 1291（untracked 1291） |
| `docs-plugin` | `docs_link_check` | 读 | 32 个文档 / 36 条链接 / 跳过 14 条外部或锚点 / 断链 0 |
| `docs-plugin` | `docs_link_report` | 写（走审批） | `requiresApproval=true`，`pendingWrite=docs-link-report.md`，195 字符，**未落盘** |
| `deps-plugin` | `deps_audit` | 读 | 4 个包 / 84 个源码文件 / missing 1 / unused 3 |
| `hello-plugin` | `hello_echo` / `repo_wordcount` | 读 | 协议回归的最小样例 |

**真模型端到端**（`scripts/probes/plugin-live.mjs`，`deepseek-chat`，2696ms）：模型自己选了 `deps_audit`，
`tool_call=1 / tool_result=1`，拿到结果后总结出「4 个包、missing 1、unused 3」——插件是 harness 的一部分，不是仓库里多一个能跑的 mjs。

**顺手修掉的真问题**（每个都有测试或探针锁住）：

| # | 症状 | 根因 | 修法 |
|---|---|---|---|
| 1 | 包名成了 200 多字符的源码片段 | 一条大正则 `(?:from\|import\|require)\s*\(?\s*["']([^"']+)["']` 被 `action?: "upsert" \| "import";` 钓中，字符串字面量里的 `"import"` 被当关键字、自己的收尾引号被当说明符左引号 | 拆成五条行锚定正则，说明符 `[^"'\n]+` |
| 2 | `@/components`、`@/lib` 被报「用了没声明」 | `tsconfig` 的 `paths` 是路径别名不是依赖 | 读包与仓库根的 `compilerOptions.paths` 当别名前缀；`@/`/`~/`/`#`/裸 `@` 直接排掉 |
| 3 | 归档副本被当成源码 | `docs/_snapshot/`、`src/_snapshot` 这类历史副本 | `.` 与 `_` 开头目录、`dist/build/out/coverage` 都不进 |
| 4 | 文档教人写正则的那行自报断链 | `docs_link_check` 把行内 code span 里的 `](` 当 Markdown 链接 | 围栏块整块不扫、行内 span 按 CommonMark 等长反引号串抠掉 |
| 5 | `apps/desktop` 报「0 个文件、`electron` 没用」 | 它的入口 `main.mjs` 在**包根**不在 `src/` | 包根上所有源码后缀的文件都扫 |
| 6 | 改插件源码必须重启 Studio 才生效（所谓「热加载」是假的） | Node 的 ESM 缓存按 URL 存，`import(fileURL)` 第二次直接返回旧模块 | 入口 URL 挂 `?v=<mtime>`：文件没动就命中缓存，动过就换 URL 拿新模块（`registry.ts:255` 附近；`todo-plugin.test.mjs` 的 plugin.10 + `scripts/probes/plugin-hot.mjs` 锁住） |

顺手发现但**没动**：根 `package.json` 没声明 `ai`，而 `scripts/probes/compact.mjs:10` 在 `import("ai/test")`，
现在靠 npm 提升才能跑（`deps_audit` 报的 `missing=[ai]` 就是这个）。要不要补这条 devDependency，等李亚恒点头。

---

## 本轮增量 · Plan 真编排（2026-10-16 晚）

之前的 `orchestrator.ts` 名不副实：一轮 `Promise.all` 扇出，**没有依赖、没有重试、失败就是失败**。
这轮把「编排」两个字补上，并把它和执行**解耦**——所以编排本身能用假 runner 单测。

| 能力 | 实现 | 证据 |
|---|---|---|
| 依赖分层 | `topoBatches`：同批并行、批间串行 | 单测：链式 `[[0],[1],[2]]`、钻石 `[[0],[1,2],[3]]`、全无依赖 `[[0,1,2]]` |
| 跑之前先验依赖 | 成环 / 越界 / 依赖自己 / 非整数 → `PlanDependencyError` | 单测 4 条；HTTP 上循环依赖返回 **400**（不是 500），文案点名 `W1「A」 → W2「B」` |
| 失败重试 | `maxRetries`（默认 1，路由夹到 0..5），`attempts` 记在 step 上 | 单测：`maxRetries=2` 第三次成功 → `attempts=3`、`maxRetries=0` → 一次就 `failed` |
| 上游失败不再烧 token | 直接上游 failed/skipped/cancelled → 本步 `skipped`，runner 一次都不调 | 单测：链 A→B→C 炸在 A，`ran=["A"]`，B/C 都 `skipped` |
| 上游结论下沉 | 直接上游的结论摘要拼进下游 goal，单条 400 字符、合计 1200 | 单测：600 字上游只带 400 字进下游 |
| 取消 | signal 中断 → 未跑的批 `cancelled` | 单测：发出即中断 → 两步都 `cancelled` |
| 串行流水线预设 | 新增 `chain`：C1 结构 → C2 审计 → C3 纪要（编辑器走写审批） | HTTP 实测 `batchSizes=[1,1,1]`、`merged` 里写着「批次：1 → 1 → 1」 |
| UI | 预设下拉新增 `chain` + 失败重试下拉 + 自定义 Worker 的「依赖（下标）」输入；Board 卡片显示 `第 N 批` / `重试 N 次` / `依赖 <stepId>` | `LoomShell.tsx` 的 Plan 面板与 Board；`globals.css` 新增 `.badge.skipped`（虚线灰，故意比 failed 淡——它不是错误，是省下来的 token） |

**数字**：单测 70 → **86**（新增 `packages/core/test/plan-orchestrate.test.mjs`，16 条，含 2 条真 mock 端到端）；
HTTP 探针 12 → **17** 项断言，全绿；`typecheck` / `next build`（20 路由）EXIT=0。

**边界照旧写清楚**：拆步是**一次** LLM 调用出清单，不是边跑边重规划——失败不会回头改计划（没有 Replanner）；也没有多跑几次投票择优；
同批仍是一次性全放，没有并发上限（`p-limit` 那个坑还在）。所以现在能自己长出**一条**链路，「已知的长链路」仍然是最稳的用法。

---

## 本轮增量 · todo 状态落盘（2026-10-16 晚）

上一轮把 Plan 编排补上了，但层5 还留着一条最短的短板：`todo_write` 的事件日志活在进程内存里，
**重启即丢**——而 DSH 那边「日志承载状态」的意思恰恰是「日志在文件里，重启还能回放」。
这轮把这条补上，核心就两个新文件：

| 文件 | 干什么 |
|---|---|
| `packages/core/src/plan/todo-file.ts` | `createFileTodoStore({ dir })`：接口与内存版**完全一致**（`TodoStore`），所以 `runAgentLoop` / `createTodoWriteTool` 一行没改。事件按 JSONL 追加进 `<dir>/<会话>.jsonl`，某会话第一次被碰到才读它那份文件 |
| `packages/core/src/plan/todo-dir.ts` | 路径解析与开关：`LOOM_TODO_DIR` > 从 cwd 往上找带 `workspaces` 的 package.json > cwd；`LOOM_TODO_STORE=memory` 退回纯内存（CI 里不想落文件就用它） |

四个刻意的选择，都是能被问到的：

- **只追加、永不改写**：日志语义不因为落盘而变；投影仍然只是「最新一条事件的值」。
- **懒加载**：按会话读自己的文件。启动时把整目录读进来既没必要，也模糊了「清单属于某个会话」这条承诺。
- **写盘失败不崩**：磁盘只读 / 满盘 → 降级为内存 + 记 warning（去重）。todo 是给模型看的工作记忆，不值得为它打断整轮循环。
- **`reset()` 只清内存**：测试用临时目录，不靠 reset 删文件——磁盘上的日志是持久事实。

**证据**：

| 验证 | 命令 | 结果 |
|---|---|---|
| 单测（真开临时目录真读真写） | `node --test packages/core/test/todo-persist.test.mjs` | **11 / 11 pass**（落盘内容、跨实例回放、追加不覆盖、只 `startTurn` 清投影、坏行跳过并记 warning、路径穿越被挡住、写失败降级、会话隔离、目录解析优先级、懒创建、坏行解析） |
| 跨进程回放（真重启语义） | `node scripts/probes/todo-persist.mjs write` → `replay` | 进程 A 写 2 条；**进程 B 空内存**只读文件：`回放事件数 2 / 恢复的 turn 2 / 清单 3 项全对`，再写一行 → 文件 3 行（旧行还在） |
| HTTP 端到端 | `node scripts/probes/http.mjs` | **21 / 21 pass**（新增 4 条：`/api/run` 真调 `todo_write`、JSONL 落到 `data/loom-store/todos`、最后一行是完整清单事件、新 store 实例能回放出同一份清单） |
| 全量回归 | `npm test` / `npm run typecheck` | 当时 **112 pass / 0 fail**、TC EXIT=0（本节其他数字也是当时的快照） |

**仍然没对齐 DSH 的形态差**（写进源码注释了）：DSH 的 todo 事件和会话消息在**同一条会话日志**里，
所以「第几轮」由日志本身给出；这里是独立 todo 日志 + `startTurn` 本地计数，回放靠最后一条事件恢复 `turn`。
语义等价，形态不同——被追问时直说，别含糊。

---



## 本轮增量 · 模型动态拆步（2026-10-16 晚）

到上一轮为止，Plan Board 还欠着 README 自己写下的那句「不能自己长出链路」。这轮把 `planner` 接进了自动链路：

| 文件 | 干什么 |
|---|---|
| `packages/core/src/plan/planner.ts` | `planWorkers({ goal, modelId, maxWorkers, allowedAgentIds })`：**一次** `generateText`，要求模型回 `{"workers":[{ title, goal, agentId?, dependsOn? }]}`（裸数组或代码围栏也认），`dependsOn` 是下标；越界/成环/白名单外的字段由 `normalizePlannerDrafts` 逐条挡下或回落 |
| `apps/web/src/app/api/plan/route.ts` | body 新增 `planner?: boolean` / `plannerModelId?: string`：勾了就先用模型拆步，成功用模型清单、失败回落预设，`planner` 字段把「用没用 / 为什么没用」如实回给前端 |

刻意的选择，都是能被问到的：

- **只拆一次**：不做边跑边重规划（Replanner）。一次调用的清单好审、好回放，失败了也便宜。
- **解析不了就回落，不硬撑**：模型没给可解析 JSON / 只给 1 个 Worker / 依赖成环越界 → 一律回落预设，并把原因写进 `planner.summary`，不猜。
- **Worker 的模型默认 `mock-local`**：拆步是「编排」的事，不该顺手替用户挑贵的模型；要真跑 worker 就用带真模型角色的预设。

**证据**：

| 验证 | 命令 | 结果 |
|---|---|---|
| 解析 / 校验 / 回落（假模型） | `node --test packages/core/test/plan-planner.test.mjs` | **14 / 14 pass**（JSON 与围栏解析、依赖下标映射、只给 1 个回落、成环回落、模型报错回落、无真模型回落、默认模型注入） |
| 编排接口 | `node scripts/probes/http.mjs` | **25 / 25 pass**（新增 4 条：`planner:true` 没真模型时回落且带原因；规划成功时 `workers`/`batches` 来自模型清单） |
| 真模型端到端 | `node scripts/probes/planner-live.mjs` | deepseek-chat 1605ms 拆出 3 个 Worker：`检查死链` / `核对安装步骤`（无依赖，同批并行）→ `整理待修清单`（`依赖=[0,1]`），批次 `2 → 1`，三步全 `done` |
| 全量回归 | `npm test` / `npm run typecheck` | 当时 **112 pass / 0 fail**、TC EXIT=0（现在是 128 条） |

**没做的**：失败重规划（Replanner）、best-of-N 择优（同一目标多拆几次挑最好）、拆步结果的人工编辑（现在只能在「自定义 Worker」里手填）。

---

## 本轮增量 · 后台 job 通道（2026-10-16 晚）

`run_safe_cmd` 以前只能**阻塞**跑：一条 `git log` 慢起来就占着整轮循环等超时。
这轮补上 DSH 那套 job 通道——启动、读取、杀掉拆成三种权限：

| 文件 | 干什么 |
|---|---|
| `packages/core/src/jobs/store.ts` | `createJobStore()`：spawn 立刻返回句柄，输出按游标累计（读一次推进一次），单 job 上限 8000 字符、已结束的只留 20 条，`kill` 走 `taskkill /T /F` 连孙进程一起收 |
| `packages/core/src/tools/jobs.ts` | `job_list` / `job_output` / `job_kill` 三个工具；`job_output` 不给 id 就读最近那个 |
| `packages/core/src/tools/cmd.ts` | `run_safe_cmd` 多一个 `background` 参数：批准之后不再等命令跑完，直接回 `jobId` |
| `apps/web/src/app/api/jobs/route.ts` | `GET` 列表（带 `tail` / `elapsedMs`）、`POST` 杀一个；`/api/cmds/approve` 支持 `background:true` |

两个刻意的选择：

- **启动要审批、读取不要**：起进程是写操作，跟 `write_file` 一样进 HITL；读输出是只读，模型随时可调——不然「先启动、干别的、再回来收」根本无从谈起。
- **句柄只在内存里**：job 是句柄不是状态，重启后 pid 和管道都没了，落盘只会留下一堆永远 `running` 的假象。所以它**故意**不持久化（跟 todo 落盘是相反的取舍）。
- **没配 Key 也能看这条通道**：离线剧本 `jobs_tour`（Demo 画廊的「后台 job：批准后边跑边收」）——第一遍只提一个待批准的后台命令，批准后第二遍就走 `job_list` + `job_output` 把输出读回来。

**证据**：

| 验证 | 命令 | 结果 |
|---|---|---|
| 单测（真起真杀） | `node --test packages/core/test/jobs.test.mjs` | **14 / 14 pass**（立刻返回、游标只给新增、非零退出→failed、kill 收掉整棵树、输出截断标记、保留条数、白名单不是后门、三个工具的人话、`drain` 收尾、单例必须挂 `globalThis`） |
| 离线剧本 | `node --test packages/core/test/loop.test.mjs` | **32 / 32 pass**（新增 2 条：没 job 时只提待批准的后台命令、不假装起了；批准后第二遍真的 `job_list` + `job_output` 读回来） |
| 库级探针 | `node scripts/probes/jobs.mjs` | **11 / 11 pass**：42ms 返回句柄（那条命令要跑 60s）、第二次读是空串、kill 后 `status=killed`、带 `background` 也过不了白名单 |
| HTTP 端到端 | `node scripts/probes/http.mjs` | **33 / 33 pass**（新增 8 条：批准→立刻 `jobId`、列表立刻看得到、`tail`/`elapsedMs` 在、已结束的杀它是 `killed:false`、不存在的 404、被拒命令不留 job） |
| 全量回归 | `npm test` / `npm run typecheck` | **128 pass / 0 fail**、TC EXIT=0 |

**踩到并修掉的一个真 bug**：`GET /api/jobs` 一开始永远返回 `jobs=0`——批准命令明明拿到了 `jobId=job-1`。
原因是 Next 的 App Router 在开发模式下**给每条 route 各编译一个 server chunk**，`import "@loom/core"`
被各自内联了一份，模块级单例在 `/api/cmds/approve` 和 `/api/jobs` 里是**两个** store。
修法是把单例挂到 `globalThis`（`packages/core/src/jobs/store.ts`），单测 `jobs.14` 钉住这条契约。
这个坑是先被 http 探针抓出来、再修的，不是事后补的说明。

---


## 完成度总览

| 模块 | 完成度 | 说明 |
|------|--------|------|
| Agent Harness（协议/计量/压缩/委派/插件/编排/todo 落盘/后台 job） | ✅ ~88% | 六件内脏齐了 + 4 个真插件 + todo 事件落盘（跨进程回放已验证）+ 模型动态拆步 + 后台 job 通道（批准后起 job，模型能边跑边读）；剩无 best-of-N 择优 / 无失败重规划 |
| Home / 上手 | ✅ ~95% | 概览落地页、Demo、功能说明、历史 CRUD |
| 多步任务 | ✅ ~90% | 四步流水线、回写、确认 |
| Composer Run | ✅ ~90% | Ask/Agent、Sessions、@文件、SSE、token 用量 |
| Diff / 命令 HITL | ✅ ~95% | 统计、单次/全部撤回 |
| Plan Board | ✅ ~95% | 依赖分批 + 重试 + 上游下沉 + `chain` 串行预设 + 模型动态拆步，依赖错给 400；**无 best-of-N 择优、无失败重规划** |
| Agents / Skills | ✅ ~92% | 含委派能力声明（`orchestrator`） |
| Models / 联网 | ✅ ~92% | 每个模型带 `contextWindow`；`web_search` live（需 Key） |
| Desktop | ✅ ~85% | 检测 :3010，否则自动 `studio` |
| **工程门禁** | ❌ ~10% | 有 128 条单测；**无 git / CI / lint / LICENSE** |

---

## 后续功能（按性价比排）

| # | 项 | 状态 | 备注 |
|---|----|------|------|
| 1 | `git init` + LICENSE + 推远端 | 待做 | 零代码，收益最大；远端停在 2026-09-09 |
| 2 | GitHub Actions：typecheck + test | 待做 | 约 30 行 YAML |
| 3 | todo 状态落盘 | ✅ 2026-10-16 | 事件追加 `data/loom-store/todos/*.jsonl`（懒加载/只追加/写失败降级）；11 条单测 + 两进程回放探针 |
| 4 | Plan Worker 失败重试 + 真编排 | ✅ 2026-10-16 | 依赖分层 + 重试 + 上游摘要下沉 + `chain` 预设；剩 择优 / 失败重规划 / 并发上限 |
| 5 | `zod` 用起来或删掉 | ✅ 2026-10-16 | 已删：core 里 0 处 import，删掉声明 + 重生成 lock；`ai` 的 peer 仍会把它装进 `node_modules`（那是 `ai` 的事） |
| 6 | 批量重命名预览 + 批准 | 待做 | Sprint B 剩余 |
| 7 | 根包补 `ai` 声明 | 待做 | `scripts/probes/compact.mjs:10` 在用 `ai/test`，现在靠 npm 提升；等本人点头 |
| 8 | 后台 job（`job_list` / `job_output` / `job_kill`） | ✅ 2026-10-16 | 批准后起 job 拿句柄，输出按游标只给新增；单例必须挂 `globalThis`（Next 每条 route 各编译一份模块）；14 条单测 + 库级探针 11 条 + HTTP 8 条 |

---

## 验收

```bash
cd agent
npm run typecheck     # EXIT=0（core + web）
npm test              # 128 pass / 0 fail（含 todo 落盘 11 条、模型拆步 14 条、后台 job 14 条、离线 job 剧本 2 条）
node packages/core/dist/demo.js      # 离线 Demo，无需 Key
node scripts/probes/harness.mjs           # 委派 + 计量端到端（库级）
node scripts/probes/plugins.mjs           # 4 个自带插件在真实仓库上跑出具体数字（库级，不起服务）
node scripts/probes/todo-persist.mjs write   # todo 事件落盘（进程 A）
node scripts/probes/todo-persist.mjs replay  # 换一个空内存进程只靠文件恢复（进程 B）
node scripts/probes/jobs.mjs                 # 后台 job：立刻返回 / 游标读输出 / kill 真收掉 / 白名单拦得住（库级，不用起服务）
npm run studio                       # :3010
node scripts/probes/http.mjs              # HTTP 端到端，33 项断言（含 chain 3 批、循环依赖 400、todo 落盘与回放、模型拆步与回落、后台 job 8 条，另开终端）
node scripts/probes/plugin-live.mjs       # 真模型端到端：模型自己调插件（需 DEEPSEEK_API_KEY，没 Key 自动跳过）
node scripts/probes/planner-live.mjs      # 真模型端到端：一句总目标 → 模型拆出带依赖的清单 → 分批跑完（需 Key，没 Key 自动跳过）
node scripts/probes/plugin-hot.mjs         # 热加载是真的吗：改插件源码 → 不重启 → /api/meta 立马变（需先起 :3010）
node scripts/probes/audit-mock-claims.mjs    # 假动作审计：mock 有没有「说了没做」
node scripts/probes/check-docs-encoding.mjs  # 文档编码自检（BOM / U+FFFD / mojibake）
cd apps/web && npx next build        # EXIT=0，20 条路由
```

UI 自测九点：

1. Composer 标题栏出现 `第 N 步 ↑x ↓y`。
2. 选 `orchestrator` 问「派子 agent 并行盘点」，应出现子 agent 卡片
   （事件名 `subagent_start` / `subagent_end`）。
3. 多轮堆到阈值，展开底部「Harness 事件轨迹」应看到压缩一行。
   **注意两个名字**：事件名是 `compacted`，UI 卡片名叫 `context_compact`
   （`LoomShell.tsx:1035` 收事件，`:1042` 建卡片）。
4. 选 `guide` 问「帮我列一下待办清单」，应出现 `todo_write` 的 call/ok 卡片，
   结果文案 `Updated todo list: 1 pending, 1 in progress, 1 completed.`
   ——这是层5 唯一的离线可见入口。
5. 用真模型问「用 deps_audit 扫一下这个仓库」，应看到 `deps_audit` 的 call/ok 卡片
   （P2：插件工具和内置工具在同一个工具表里，模型没法区分谁是插件）。
6. 改 `plugins/deps-plugin/index.mjs` 里 `deps_audit` 的 description 一个字，**不重启**
   刷新 GUI 再问一次，新描述就该生效（改完没反应 = 热加载是假的，只能重启）。
   不想开 GUI 就直接 `node scripts/probes/plugin-hot.mjs`，它会自己改回来。
7. Plan 面板把预设切到「串行流水线 · 结构 → 审计 → 纪要（有依赖）」，点启动：
   Board 上应看到三张卡分别标着 `第 1 批` / `第 2 批` / `第 3 批`，第 2、3 张卡片的
   小字里带 `依赖 <stepId>`；`merged` 输出顶部写着「批次：1 → 1 → 1」。
   再把预设切到「自定义 Worker」、给 Worker B 的依赖填 `0`、把其中一个 Worker 的模型
   换成不可用的，点启动 → 失败的 Worker 会按「失败重试」下拉重试，成功后 `重试 N 次` 徽标出现；
   若上游一直失败，下游卡片是**虚线灰的 `skipped`**（不是红 `failed`）——那是省下来的 token。

8. 在 Composer 里让模型用 `run_safe_cmd`（带 `background`）跑一条长命令 → 批准后
   **不用在终端等**：右侧 Jobs 面板会出现这个 job（`在跑` / `done`、`tail` 会刷新、有「停」按钮）；
   也可以直接在对话框追问「后台那个 job 现在到哪了」，模型会调 `job_output` 读。

9. **没配 Key 也能演这条通道**：Demo 画廊点「后台 job：批准后边跑边收」（剧本 `jobs_tour`）→
   第一遍只出一张待批准的 cmd 卡片，右侧 Jobs 是空的（提案不等于执行）；批准后 job 才出现，
   再点一次同一张卡片问同一句话，第二遍就走 `job_list` + `job_output` 把输出读回来。


