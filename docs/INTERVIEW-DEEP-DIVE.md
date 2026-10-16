# Loom Agent 面试深度解析与问答手册

> 本文档所有结论均基于仓库实际代码核实，配套简历：`docs/RESUME.md`。
> 适用方向：校招 / 实习，前端 + 偏后端全栈，个人独立项目。
> 覆盖：简历逐句优化、架构讲解、六大深度问题、高频问答、被挑战防守、演进路线、自测清单。

***

## 目录

1. [事实核查（简历数字与代码对照）](#一事实核查简历数字与代码对照)
2. [简历修改版](#二简历修改版)
3. [架构 2 分钟讲解](#三架构-2-分钟讲解)
4. [六大深度问题](#四六大深度问题)
   - 4.1 ReAct vs Plan-and-Execute
   - 4.2 是否用到 RAG
   - 4.3 多 Agent 并行控制与冲突
   - 4.4 线上多 Agent 请求如何处理
   - 4.5 unified diff、写入/撤回与快照
   - 4.6 技术栈选型与替代框架
5. [高频面试问答 23 题](#五高频面试问答23-题)
6. [被挑战时的标准防守](#六被挑战时的标准防守)
7. [演进路线](#七演进路线)
8. [30 秒电梯陈述](#八30-秒电梯陈述)
9. [自测清单](#九自测清单)

***

## 一、事实核查（简历数字与代码对照）

| 简历表述                | 代码核实结果                                                                                     | 结论                       |
| ------------------- | ------------------------------------------------------------------------------------------ | ------------------------ |
| 约 1.3 万行 TypeScript | 实际 TS/TSX/MJS 约 **1.07 万行 / 62 个文件**，其中 core 引擎约 3500 行                                    | ❌ 改为「1 万余行（核心引擎 3.5k 行）」 |
| 19 个 API 路由         | 核实：19 个 route handler                                                                      | ✅                        |
| 7 个内置 Skills        | 核实：`packages/core/skills/` 下正好 7 个 SKILL.md                                                | ✅                        |
| 自定义 SSE 协议          | 核实：9 类事件 phase/text\_delta/text/tool\_call/tool\_result/approval\_needed/done/result/error | ✅ 可写「9 类事件」更具体           |
| 白名单前缀 + 超时熔断        | 核实：前缀白名单 + 危险字符拦截 + 15s SIGTERM + 输出截断 8000 字符 + **批准前后双重校验**                              | ✅ 把双重校验写上                |
| Electron 端口未启动自动拉起  | 核实：探活 `/api/meta`(1.2s) → spawn studio → 轮询就绪 → 加载窗口                                       | ✅                        |

**现有简历的三个问题：**

1. 只写「做了什么」，没写「难在哪、怎么权衡」；
2. 两个出彩设计没写：写操作在流结束后「补算 diff 再推审批卡片」的时序设计、无 Key 也能全流程演示的确定性 mock 引擎（30+ 场景）；
3. 技术栈行没体现自己实现了什么（diff、SSRF 防护、路径沙箱均为手写）。

***

## 二、简历修改版

> **Loom · IDE 风格多模型 Coding Agent 工作台** ｜ TypeScript Monorepo · Next.js 15(App Router/SSE) · Electron · Vercel AI SDK
>
> - 独立设计并实现面向本地代码库的 Coding Agent：Agent 通过 ReAct 循环调用读文件/代码搜索/网页抓取/安全命令等工具完成任务；npm workspaces 三层架构（**core 引擎 / Web 控制台 / Electron 桌面壳**），core 零 UI 依赖可被 CLI、Web、Desktop 三端复用，1 万余行 TypeScript、19 个 API 路由。
> - **写操作 HITL（Human-in-the-loop）**：write\_file 只产生「待审批提案」不直接落盘，服务端读取磁盘原文实时计算 unified diff，前端渲染增删对比，批准后才写入并保留原文快照支持一键回滚；命令执行走「前缀白名单 + Shell 元字符拦截 + 批准前后双重校验 + 超时熔断」。
> - **Plan Board 依赖编排**：Worker 用 `dependsOn` 声明依赖，调度器按拓扑分层——同批 `Promise.all` 并行、批间串行，上游结论摘要下沉进下游目标；失败按 `maxRetries` 重试、上游没成功则下游 `skipped` 不空跑；可分别绑定不同 Agent 角色与模型，AbortSignal 级联取消，单 Worker 失败不阻塞其余线程，写提案按 stepId 归集后统一进入审批队列。
> - **流式交互**：基于 Web ReadableStream 自定义 9 类 SSE 事件（token 增量 / 工具调用状态 / 审批请求 / 结果），前端用 fetch + ReadableStream 手工解析（POST 场景 EventSource 不支持），实现 Cursor 风格的边推理边渲染。
> - **工程与安全**：文件工具统一做工作区根目录沙箱校验防路径穿越；fetch\_url 实现私有 IP/内网域名拦截的 SSRF 防护；API Key 本地环境变量注入（BYOK）不上传；会话/Plan 以 JSON 本地持久化；Electron 启动时端口探活、未运行则守护拉起 Studio 子进程并轮询就绪。
> - 设计 6 种内置 Agent 角色（只读/改码/审计/计划等，工具集按角色与 Ask/Agent 模式动态裁剪）、7 个 Markdown+Frontmatter 的 Skill 包（注入 system prompt）；构建**确定性 mock 模型与 30+ 离线脚本场景**，无 API Key 时全功能可演示、开发期可回归。

版面紧张时，第 5 条的 mock 可并入第 1 条。

***

## 三、架构 2 分钟讲解

> 项目分三层。**core 是纯 TypeScript 引擎包，零 React/Next 依赖**，里面是 Agent Loop、工具目录、模型注册、Plan 编排器、diff、持久化；**web 是 Next.js App Router 控制台**，route handler 只做参数校验和事件转发，业务逻辑全在 core；**desktop 是 Electron 壳**，本质就是一个自动拉起 web 服务的浏览器窗口，所以同一套 core 还能挂 CLI——core 里确实也留了 cli.ts。
>
> 一次请求的链路：浏览器 POST `/api/run/stream` → route 注入工作区 Rules 和 @文件上下文 → 调 core 的 `runAgentLoop`：组装 system prompt（角色提示 + 工具说明 + Skill 块），用 AI SDK 的 `streamText` 拿 token 流，模型每轮输出一个 JSON 动作，解析后执行对应工具、把结果以 user 消息回注，最多 6 步直到输出 `done`。过程中所有状态通过 onEvent 回调抛给 route，route 用 SSE 编码成事件推给前端，前端按事件类型增量渲染。写文件不立即执行，循环结束后统一读磁盘原文算 diff，再推审批卡片——避免流中间态产生重复审批 UI。

***

## 四、六大深度问题

### 4.1 ReAct vs Plan-and-Execute：核心是什么

#### 概念本质

**ReAct = Reasoning + Acting 交替进行**，「边想边做、根据观察决定下一步」的单智能体循环：

```
Thought（我现在知道什么、该干什么）
  → Action（调用一个工具）
    → Observation（工具返回了什么）
      → Thought（基于新观察，再决定下一步）
        → ……直到任务完成
```

灵魂：**「下一步」是运行时由模型看着上一步的观察临时决定的**，没有预先计划。

**Plan-and-Execute = 先规划、后执行**，两个角色时序分离：

```
Planner（一次 LLM 调用，把目标拆成步骤列表/DAG）
  → Executor（逐步骤/并行执行，每步可以是一个 Agent）
    → Replanner（某步失败或结果不够，重新规划）
```

| 维度       | ReAct          | Plan-and-Execute      |
| -------- | -------------- | --------------------- |
| 决策时机     | 每步重新决策         | 先一次性规划，执行期不再想「做什么」    |
| 并行性      | 天然串行           | 无依赖步骤可并行              |
| Token 成本 | 每轮带历史推理，步数多成本高 | 规划 1 次 + N 个执行体，推理不重复 |
| 适应性      | 强，能临场调整        | 弱，计划错了需 Replanner 兜底  |
| 适用任务     | 探索型、路径不明       | 可拆解、子目标清晰             |
| 失败面      | 细节里打转、超步数      | 规划错误被放大到执行            |

#### 本项目的真实情况（必须诚实）

- **ReAct 是真 ReAct**：`packages/core/src/loop/run.ts` 的 `runAgentLoop`——组装消息 → `streamText`（AI SDK v6，`tools` 走原生 tool calling + `stepCountIs`）→ SDK 回调里执行工具 → 工具结果按原生 tool-result 消息回注 → 带观察进入下一轮，步数上限由 `stepCountIs` 给。
  > 补记（2026-10-16）：**这里 10-15 已经改写过了**——原文写的是"解析 `{"tool","args"}` 后把结果塞进 user 消息"，那是正则刮 JSON 的假工具协议，已经整个删掉。现在还这么答就是背旧稿。
- **Plan Board 是「模型拆步 + 依赖感知调度」，但仍不是完整 Plan-and-Execute**：步骤可以来自**前端预设（homo/hetero/triple/chain）、用户手工配置，或者模型自己拆**（`planner: true`：一次 `generateText` 出带 `deps` 的清单，解析不了就回落预设）；**运行时没有 Replanner**——某步失败不会回头改计划。
  但**依赖编排是真的**（2026-10-16 补）：Worker 用 `dependsOn` 声明依赖，`runPlanScheduler` 先 `topoBatches` 分层——同批 `Promise.all` 并行、批间串行；上游 failed/skipped/cancelled → 下游 `skipped` 一次都不跑；失败按 `maxRetries` 重试并记 `attempts`；直接上游的结论摘要（单条 400 字符 / 合计 1200）拼进下游 goal；依赖成环、越界、依赖自己在**跑之前**抛 `PlanDependencyError`（HTTP 400）。调度器与执行解耦，所以拓扑/跳过/重试/取消是用**假 runner** 单测的（`packages/core/test/plan-orchestrate.test.mjs`，16 条）。
  准确说法：**「模型/预设拆步 + 依赖感知的调度」**——不是 Map 扇出（那是改动前的状态），也不是完整 Plan-and-Execute（缺 Replanner 与 best-of-N 择优）。
- ~~库里的 `planner` 没有接进 orchestrator~~ **已接**（2026-10-16）：`packages/core/src/plan/planner.ts` + `/api/plan` 的 `planner`/`plannerModelId`；`plan-split` skill 仍然只是给模型看的提示，没被塞进这次调用——要接也就一行 system 拼接，属于可做没做。

> ⚠️ 面试陷阱应答：「宏观是**预设驱动的依赖编排**（同批并行、批间串行、上游结论下沉进下游），微观每个 worker 内部是完整 ReAct 循环——两种模式的分层组合：Plan-and-Execute 形在外、ReAct 在内。**还欠的**是失败重规划（Replanner）、best-of-N 择优、以及同批的并发上限（生产要 `p-limit`）。」

这种「宏观编排 + 微观 ReAct」的套娃结构与生产级系统（CrewAI、LangGraph Supervisor）同源。

***

### 4.2 是否用到 RAG？——没有

**结论：没有 RAG。** 项目里没有 embedding 模型、没有向量库、没有离线索引。RAG 严格三步：离线切块（chunk）→ 向量化入库（index）→ 查询时语义检索 top-k 塞进 prompt（retrieve）。

项目里有三种容易被误认的「近亲」：

| 现有机制                            | 它是什么                                         | 为什么不是 RAG                              |
| ------------------------------- | -------------------------------------------- | -------------------------------------- |
| `grep_files` / `read_file` 工具   | **Agentic Retrieval（智能体自主检索）**：模型自己决定何时搜、搜什么 | 词法子串匹配（`includes`）、非语义；无索引每次现遍历；40 条上限 |
| 注入 `.loom/RULES.md`、`AGENTS.md` | **静态上下文注入**（context stuffing）                | 固定文件、无检索过程                             |
| @文件附加上下文（4 个 × 6000 字符）         | **人工指定的上下文**                                 | 检索动作由人完成                               |

**一句话：RAG 是「系统替你先建好索引、按语义找」；Agentic Retrieval 是「模型像人一样用 grep/find 现找」。** 两者可结合：RAG 粗召回，Agent 再 read 精读。

**什么情况下上 RAG、怎么加（回答要有层次）：**

1. 触发条件：仓库大到 grep 遍历不动；语义查询（「哪里处理鉴权逻辑」，代码里可能没有「鉴权」字样）；跨仓库知识；文档问答。
2. 代码感知切块：tree-sitter 按 AST（函数/类）切，保留符号名和文件路径作为元数据，不按行瞎切。
3. Embedding：本地隐私优先 Ollama 跑 bge-m3（代码/中文友好），或 OpenAI text-embedding。
4. 向量库：本地 sqlite-vec / LanceDB（零运维），服务端 pgvector。
5. 混合检索：向量召回 + BM25 关键词召回（代码符号精确匹配很重要），再 rerank。
6. 增量索引：文件 watcher / git diff 只重建变更块。
7. 检索结果包装成新工具 `semantic_search` 给 ReAct 调用——**RAG 成为 Agent 的工具之一，而不是替代 Agent**。

***

### 4.3 多 Agent 并行如何控制？冲突如何处理？

#### 五条控制机制（对照 `orchestrator.ts`）

1. **状态隔离（无共享可变状态）**：对每个 step 调独立的 `runAgentLoop`，各有自己的 messages 数组、5 步预算；worker 间无共享内存。同批并行时互相看不见对方结果；**有依赖时**上游只通过调度器给的「结论摘要」字符串单向流到下游，仍不共享可变状态。
2. **共享数据只有一个** **`pendingWrites`** **数组**：worker 通过 `onPendingWrite` 回调 push。不需要锁——**JavaScript 单线程事件循环**，回调中的同步 push 不可能在语句中间交错（与 Java/Go 多线程本质不同）。
3. **真正的共享资源「文件系统」靠 HITL 从设计上规避**：并行期间 write\_file 只产提案不落盘、run\_safe\_cmd 只提案不执行。所有 worker 面对**事实上只读**的文件系统：read-read 无冲突，write-write 不发生。**这是整个设计最漂亮的一点，主动讲。**
4. **失败隔离 + 重试**（2026-10-16 补）：单 worker 出错不再直接作废——调度器按 `maxRetries` 重试（默认 1），`attempts` 记在 step 上；重试用尽才标 `failed`，**绝不 reject**，同批其他 worker 不受影响。依赖它的下游标 `skipped`（不是 failed），**一次都不跑**。
5. **取消传播**：一个外部 AbortSignal 透传每个 worker 的 streamText 和 fetch\_url，级联取消；还没开始跑的批整批标 `cancelled`。

#### 仍存在的并行问题（被追问的诚实清单）

- **审批阶段逻辑冲突**：两个 worker 提案改同一文件，两份 diff 都基于同一份原文；串行审批时后批准覆盖先批准（last-write-wins）。当前靠人工审 diff 兜底；auto-approve 后必须按 path 加串行化队列或三路合并。
- **无并发度控制**：同一批一次性全放（`Promise.all`）；worker 多了会打爆模型厂商限流，生产要 `p-limit`/队列做 concurrency cap。**依赖分层不解决这个**——它管的是顺序，不是并发数。
- **依赖链上有数据流，同批之间没有**（2026-10-16 补）：有 `dependsOn` 的下游会拿到直接上游的结论摘要（单条 400 / 合计 1200 字符，拼进 goal），但**同批并行**的 worker 彼此看不见对方——还是各跑各的。真正的共享黑板（blackboard）或第二阶段 synthesizer agent 仍然没做。
- Plan 接口只回传 step 级状态，worker 内部 token 流未逐个透出。

***

### 4.4 线上多 Agent 请求如何处理？

现状是**本地单用户模型**：一个 Node 进程、状态活在单次请求内存、工作区是本地一个目录、SSE 占住整个运行期。上线要拆七件事：

```
                        ┌──────────┐
  用户 ── HTTP/SSE ──▶ │ API 网关  │ 鉴权/限流/预算校验
                        └────┬─────┘
                             │ 入队（job）
                        ┌────▼─────┐      ┌──────────────┐
                        │ 任务队列  │◀────│ Redis：状态/   │
                        │(BullMQ)  │      │ 事件 pub/sub │
                        └────┬─────┘      └──────────────┘
                             │ 拉取（受并发度/配额控制）
              ┌──────────────▼────────────────┐
              │  Runner 工作节点舰队            │
              │  每个 job → 一个临时沙箱：       │
              │  Docker / Firecracker 微虚拟机 │
              │  克隆仓库 → 跑 Agent → 销毁     │
              └──────┬───────────────┬────────┘
                     │               │
              模型厂商 API(限流/熔断)  事件写 Redis → 网关 fan-out 给 SSE
                        │
              Postgres：会话/审批/审计（持久）
```

1. **隔离升级**：`resolveInWorkspace` 路径前缀校验是**协作式约束，不是安全边界**（挡 bug 不挡攻击）。多租户必须**每 job 一个一次性沙箱**（容器/Firecracker/gVisor），仓库 clone 进临时卷、跑完即焚；命令白名单之外还要在网络层限制 egress。
2. **计算模型**：Agent 请求是 **I/O 密集型**（大量时间在等模型流式返回），Node 单进程能扛很多并发 SSE；但 spawn 子进程吃本机资源，必须 worker 化 + 并发上限。
3. **队列化 + 配额**：API 层无状态，请求落 job 进 Redis 队列（BullMQ/Kafka），runner 按**每用户并发数、API Key token bucket、成本预算**拉取。
4. **HITL 等待必须可持久、可恢复**——直击当前真实缺陷：`pendingWrites` 活在 SSE 那次请求的内存里，**页面一刷新待审批卡片就没了**。正确做法是 job 挂起时状态写库，审批 webhook 到达后恢复执行。现成范式：**LangGraph 的 interrupt/checkpoint，或 Temporal/Restate 的 durable execution**（工作流可挂起数天等人工，进程重启不丢）。
5. **流式扩容**：runner 事件发 Redis pub/sub，网关订阅后扇出给对应 SSE；连接与执行可落在不同机器；`Last-Event-ID` 做断线续传 + 背压。
6. **可靠性**：模型调用幂等 key 重试、provider 熔断 + 备用模型降级、每 job 硬超时与美元/token 预算封顶。
7. **可观测与审计**：每 run/step/tool call 打 trace（OpenTelemetry GenAI 语义约定），token/费用计量，写操作与审批留审计日志（Coding Agent 能动代码，审计是刚需）。

***

### 4.5 unified diff 是什么？写入/撤回/快照如何实现？

#### unified diff 格式

GNU `diff -u` / `git diff` 的标准补丁文本：

```diff
--- a/src/index.ts          # 原文件
+++ b/src/index.ts          # 新文件
@@ -1,3 +1,4 @@             # hunk 头：原文第1行起3行，新文第1行起4行
 保留的上下文行（前缀空格）
-删掉的行（前缀 -）
+新增的行（前缀 +）
 保留行
```

价值：**人能逐行审阅，机器能** **`git apply`** **回放**，所以是 Cursor/Claude Code 审批 UI 的通用语言。

#### 本项目实现：手写 Myers-lite

`packages/core/src/diff/unified.ts`：CRLF 归一化 → 按行切 → 双指针对齐，行相同保留，不同时向前后各看最多 8 行找重新对齐点，找不到先删后增。

**不是真正的 Myers/LCS，不保证最小编辑距离**，深嵌套改动会显示「整段重写」。定位是**预览级**（生产用 `diff` npm 包或 spawn `git diff --no-index`）。`summarizeDiff` 数 `+`/`-` 行（排除 `+++`/`---` 头）驱动 UI 增删统计。

#### 写入 → 审批 → 撤回的完整时序

**阶段一：提案不落盘**（`tools/fs.ts` 的 `writeFileTool`）
模型调 write\_file → 只做 `resolveInWorkspace` 路径沙箱校验 → 返回 `{requiresApproval:true, pendingWrite:{path, content}}`，**磁盘不动**。

**阶段二：流结束后补算 diff 再推审批卡**（`api/run/stream/route.ts`）
循环期间 write 提案攒进 `pendingWrites`（故意不实时推，避免无 diff 重复卡片）；循环结束后逐个**现场读磁盘原文** → `unifiedDiff(路径, 原文, 新内容)` → 连同增删统计走 SSE 推送。

**阶段三：批准才真正写，快照此时产生**（`api/writes/approve/route.ts` → `applyApprovedWrite`）

```ts
let previous = null;
try { previous = await fs.readFile(file, "utf8"); } catch { created = true; } // 快照
await fs.mkdir(path.dirname(file), { recursive: true });
await fs.writeFile(file, content, "utf8");
return { path, previous, created };
```

撤回（`api/writes/undo/route.ts` → `undoApprovedWrite`）：**新建文件 →** **`unlink`** **删除；已有文件 → 把** **`previous`** **整文写回**。

#### ⚠️ 快照机制真相与三个缺陷（面试高压点）

**真相：服务端不存快照。** `applyApprovedWrite` 把 `previous` 原文返回给浏览器，快照**暂存在前端线程消息里**，点撤回时前端再把 `previous` 回传 undo 接口；服务端全程无状态。

三个缺陷：

1. **刷新后撤回能力丢失**：会话 JSON 的消息结构没有 `previous` 字段，重载后只剩 content/diff。→ 演进：快照落服务端（SQLite 版本表），或每次批准写做一次 git commit、撤回即 `git checkout`（Claude Code 的做法）。
2. **全量快照、无版本链**：存整个文件不是 diff，只支持单卡一级撤回；对同一文件连续批准两次后乱序撤回会用旧快照盖掉新内容。
3. **TOCTOU 竞态**：批准后撤回前文件若被外部程序修改，撤回会**静默覆盖外部改动**。→ 写入记录内容 hash/mtime，撤回前校验，不一致则拒绝并提示。

***

### 4.6 技术栈选型：为什么是现在这套？再选一次选什么？

回答框架：**「当时的约束 → 候选方案 → 我的取舍 → 今天回头看的代价」**。

#### 每项选型的真实理由

| 选择                             | 核心理由（约束驱动）                                                                                        | 代价/边界                                                                   |
| ------------------------------ | ------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **TypeScript 全栈**              | LoopEvent、ToolResult、PlanStep 等类型在 core 和前端**同一份定义共享**，SSE 两端协议改动编译期可发现；AI SDK 是 TS 一等公民          | —                                                                       |
| **npm workspaces 三层 Monorepo** | core 零 UI 依赖，CLI/Web/Electron 三端复用；零额外基建，维护成本最低                                                   | 无增量构建/任务缓存，包多了上 Turborepo                                               |
| **Next.js 15 App Router**      | Route Handler 原生返回 ReadableStream，手写 SSE 几乎零成本；前端生态熟；一个端口同时出 UI 和 API                             | 长连接 SSE 与 serverless/边缘部署不兼容（函数时长限制），故定位**自托管 Node/桌面**，不部署 Vercel edge |
| **Electron**                   | 桌面分发 + 本地文件系统 + spawn 本地 Studio 进程；Node 工具链直接复用                                                   | 包体大（\~100MB）。Tauri 体积小 10 倍但后端是 Rust，管理 Node 子进程、复用 core 反而更绕           |
| **Vercel AI SDK**              | 只当**模型适配 + 流式层**：`streamText` 给 token 级 textStream，DeepSeek/Ollama 走 OpenAI 兼容 provider，换模型只改注册中心 | —                                                                       |
| **手写 ReAct 而非框架**              | 学习目的；HITL 暂停时机完全自控；mock/真实模型走同一协议路径                                                               | 正则 JSON 解析脆弱、无持久化检查点、无重放                                                |

#### 与主流框架正面比较

- **LangChain / LangGraph**：生态最全、Python 优先（JS 版也成熟）。LangGraph 核心是**图状态机 + 持久化 checkpoint +** **`interrupt()`**——审批挂起、重启恢复、time-travel 调试内建，**正好解决「刷新丢审批」缺陷**。代价：抽象层厚、概念多（node/edge/reducer/checkpointer），对吃透 Agent 循环原理反而是障碍。
- **Mastra**：**TypeScript 原生** Agent 框架，workflow 支持挂起步骤、内建 RAG/eval，是「今天用 TS 重做」最贴近的选择。
- **LlamaIndex**：以 RAG/数据索引为核心，主线是代码库语义检索时更合适；本项目主线是工具执行，不选。
- **AutoGen / CrewAI**：多角色多 Agent 协作（Python），Plan Board 的「角色分工 + 编排」与它同源。
- **Temporal / Restate**：不是 Agent 框架而是**持久化工作流基础设施**，线上 HITL 等数天人工的场景用它兜底。

#### 「重做一次」标准答案

> 「模型层仍用 Vercel AI SDK，只做适配和流式，这个边界很对。但会升级三件事：
> ① 工具协议从手搓正则 JSON 换成 **AI SDK 原生 tool calling + Zod schema**，参数错误在解析层被拒绝；
> ② 编排层引入 **LangGraph.js 或 Mastra**，用 interrupt/checkpoint 把 HITL 做成**可持久、可重放**的，而不是活在单次 SSE 请求内存里；
> ③ 持久化从 JSON 换 **SQLite（本地）/ Postgres（线上）**，审批和快照建版本表。
> 一开始手写的原因：在一个人、目标是吃透原理的阶段，手写让我真正理解了每个框架在帮我解决什么问题——**先用最小实现撞一遍墙，才知道框架的价值边界**。」

***

## 五、高频面试问答（23 题）

### A. 架构与技术选型

**Q1：为什么用 Monorepo？三层怎么划的？**
一个代码库同时交付 Web 和桌面，Agent 引擎只有一份；npm workspaces 零额外基建。划分原则：**所有与渲染无关的东西放 core**（loop/tools/diff/store），Next 侧只做 HTTP 边界和 UI；引擎可单测、可跑 CLI、Electron 升级不影响核心。core 的 package.json 里没有 react/next 依赖，只依赖 ai-sdk、yaml、nanoid 等纯逻辑库。

**Q2：Route Handler 和 core 什么关系？**
route 是「防腐层」：解析 body、校验模型可用性、拼上下文、把 core 回调事件编码成 SSE；fs 操作和业务规则都在 core。19 个路由都很薄，核心逻辑不绑死 Next API。

**Q3：为什么 SSE 不用 WebSocket？**
交互是**单方向服务端推送**（提问 → 一串事件 → 结束），SSE 天然契合、自动重连、走标准 HTTP 不用协议升级、免连接管理；WebSocket 的双向能力用不上，反而要处理心跳和连接生命周期。

**Q4：前端为什么不用 EventSource？**
EventSource **只支持 GET、不能带 body 和自定义 header**；请求要 POST goal/history/contextFiles。所以用 fetch 拿 ReadableStream，`reader.read()` 按 `\n\n` 切事件块、解析 `event:`/`data:` 行。

**Q5：为什么工具调用自己约定 JSON，不用 AI SDK 自带 tool calling？（必问）**

- AI SDK 用在模型适配和流式：`streamText` 的 textStream 给 token 级增量，provider 走 OpenAI 兼容接口接 DeepSeek/Ollama，换模型只改注册中心。
- 手工协议（prompt 约定单行 JSON → 正则提取 → JSON.parse）的当时考虑：① 完全掌控工具执行与 HITL 插入时机，SDK maxSteps 自动循环里插入「暂停等人工批准」别扭；② mock 模型复用同一协议路径，真实/离线同一套代码。
- 代价清楚：正则解析对模型不按格式输出脆弱（多 JSON、markdown 围栏），生产应用 SDK 原生 `tools` + **zod schema 校验**。这是演进第一位。

**Q6：BYOK 是什么？为什么 Key 不落服务端？**
Bring Your Own Key：Key 只存本地 `.env`，进程启动注入 `process.env`，不持久化不上传。本地应用无多租户，存服务端反而制造泄露面；模型注册中心启动时读 env 给出 `keyConfigured/ready/reason` 三态，UI 明确提示缺什么。

### B. Agent Loop

**Q7：完整讲一遍 ReAct 循环。**
system（角色 prompt + 工具清单 + Skill）→ 最近 12 轮历史 → user goal → 循环：streamText 拿全文 → 解析 JSON 动作 → 工具则执行、tool\_call/tool\_result 外抛、结果以 user 消息回注 → done 则结束；6 步上限兜底。观察回注让模型具备多步推理（先 list\_dir 再 read\_file）。

**Q8：模型不按约定输出 JSON 怎么办？**
`parseAction` 宽松正则抓第一个 `{...}` 再 parse；解析失败/无工具字段就把整段当最终答案结束——**fail-open 但不崩溃**。补强：① zod 校验参数；② 解析失败回注「格式错误请重发 JSON」让模型自我修正；③ 处理 \`\`\`json 围栏（现在靠抓花括号片段恰好兜住，是巧合不是设计）。

**Q9：怎么防死循环和成本失控？**
maxSteps=6（Plan worker 为 5）硬上限；maxRetries:1；read\_file 截断 12k、grep 40 条、fetch 4k——**所有工具有输出边界**；history 只带最近 12 轮；前端 AbortController → req.signal → 透传 streamText 和 fetch\_url 可中止。

**Q10：写操作在循环里怎么处理？模型以为写完了吗？**
write\_file 返回 `{requiresApproval, message:"需批准"}`，模型看到的观察是「已提案待批」，知道没落盘；批准是**循环外独立 HTTP 请求**（`/api/writes/approve`）。有意的人在环边界——agent 无法自我批准。

**Q11：Ask 和 Agent 双模式区别？**
Ask 只读：loop 入口 filter 掉 write\_file 和 run\_safe\_cmd，同时 prompt 追加「禁止写」——**双层约束**（能力层 + 提示层），不依赖模型自觉。

### C. 安全机制

**Q12：HITL 全链路。**
① 模型调 write\_file → 只校验路径、返回 pendingWrite、不落盘；② SSE 推 approval\_needed（**流结束后才推**：route 攒着，结束时读磁盘原文算 unified diff、统计增删，带完整 diff 推送）；③ 前端渲染 Diff + Accept/Reject；④ Accept → approve 路由 → `applyApprovedWrite` 写盘前再读一次原文留快照 → 落盘；undo 用快照恢复（新建文件则删除）。

**Q13：路径穿越怎么防？**
所有文件工具必经 `resolveInWorkspace`：`path.resolve(root, rel)` 后校验 `target === root || target.startsWith(root + sep)`。必须带分隔符——`/workspace-evil` 也 startsWith `/workspace`，是经典绕过点。

**Q14：命令执行怎么防注入？（主动自爆漏洞效果最好）**
四道：① 4 个 git 只读前缀（可环境变量追加），前缀匹配且 `git log -n` 开数字参数白名单；② 拦 `| ; & \` \$( 换行`；③ 人工批准后才 spawn；④ 15s 超时 SIGTERM、cwd 锁工作区、输出截断；批准时在 ` applyApprovedCmd`**再校验一次**，不信任前端。
真实缺口：**重定向符`>` ` < ` 没拦**，`git status > x`能过前缀检查造成任意文件写。修法：重定向加入拒绝集；更彻底是`shell:false\` + 参数数组执行，让 shell 解释器不参与。

**Q15：fetch\_url 的 SSRF 防护能被绕过吗？**
已做：协议仅 http(s)、拒 localhost/`.local`/`.internal`、拒 IPv4 私网段（10/172.16-31/192.168/127/169.254）、禁止跟随重定向（redirect:manual，3xx 拒）、8s 超时。
能绕过：**DNS rebinding**（域名公网校验通过、解析时指向内网）、十进制/IPv6 编码 IP 未全覆盖。生产要在连接层校验远端实际 IP（custom lookup / dns.resolve 后再连）。

**Q16：直接调 approve 接口不就绕过 agent 了？**
本地单用户应用，审批接口代表本机用户本人操作，浏览器 UI 和 curl 是同一信任主体；但接口内部仍做路径沙箱和命令白名单二次校验，绕过 UI 也无法越界。多用户场景要加会话鉴权——本地工具和 SaaS 的信任边界差异。

### D. Plan Board

**Q17：并行怎么实现？怎么保证线程安全？**
orchestrator 把 worker 映射成 PlanStep，按 `dependsOn` 分层调度（同批 `Promise.all` 并发、批间串行），每步跑独立 `runAgentLoop`（各自独立 messages，无共享可变状态）；上游没成功的下游直接 `skipped`，失败按 `maxRetries` 重试；写提案带 stepId push 进数组，结束后统一审批，worker 间不互踩文件；AbortSignal 级联取消。

**Q18：两个 worker 同时写同一文件怎么办？**
当前天然规避：写操作不落盘只产提案，最终人工串行审批。将来自动批准需按 path 串行化队列或 last-write 的 diff 合并（已知演进点）。

**Q19：并行的实际价值？不就是多花 token？**
异构预设是**角色分工**非重复劳动：reader 结构摸底、editor 并行起草备忘；总时延从串行相加变为取最慢者；每个 worker 可绑不同成本模型（探索用便宜模型、改码用强模型），是成本/质量编排空间。

### E. 前端与工程

**Q20：流式频繁 setState 的性能和 key 问题？**
助手消息用**固定 id 原地更新**（streamId 一次回答内不变，syncStreaming 找同 id 项替换），每 token 只是一次文本替换。
真实踩坑：phase id 原用 `Date.now()+phase名`，同名 phase（两次 thinking）同毫秒触发，React 报重复 key。改为组件级单调递增计数器生成所有线程条目 id，恢复历史会话后把计数器抬到历史最大序号之后防跨会话撞键。

**Q21：会话为什么 localStorage 和服务端 JSON 双写？**
服务端 `data/loom-store/sessions.json`（16 会话 × 80 条上限，同步全量写）是跨端/桌面事实存储；localStorage 让纯 Web 首屏不白屏、离线可用；乐观更新 + 后台 PUT 同步。短板：全量读改写、无并发写锁，多标签页会丢更新；量级到了换 SQLite。

**Q22：Electron 怎么知道 Studio 起没起？**
main 进程先 fetch `127.0.0.1:3010/api/meta` 做 1.2s 探活；通则 loadURL；ECONNREFUSED 则用 PATH 上的 node spawn studio.mjs，轮询端口直到 ready 再加载窗口；单实例锁防多开；子进程随 Electron 退出。
Windows 细节：Electron 自带二进制不能当 node 直接跑（不支持 `-p`），需 `ELECTRON_RUN_AS_NODE=1` 或显式找系统 node（原 `process.execPath.includes("Electron")` 大写判断在 Windows `electron.exe` 上失效，改为 `/electron/i`）。

**Q23：mock 模型为什么花力气做？**
① 无 Key/离线可演示；② 开发期不烧 token 即可回归 UI 全部分支（HITL、命令审批、多文件写）；③ mock 与真实模型**走完全相同的事件协议**（text\_delta 也分片模拟，24 字符/片、8ms），切真实模型零改 UI。本质是测试替身（test double）思维，30+ 场景按目标关键词自动匹配。

***

## 六、被挑战时的标准防守

| 挑战                    | 错误答法     | 应该说                                                                                         |
| --------------------- | -------- | ------------------------------------------------------------------------------------------- |
| 「diff 为什么不直接用库？」      | 「自己写更厉害」 | 「演示版写了前瞻对齐的 Myers-lite 够 HITL 预览；生产会换 `diff` 包或 spawn `git diff`，算法正确性不该自己维护」               |
| 「JSON 存全部会话，规模大了怎么办？」 | 「不会大」    | 「本地单机 16 会话量级 JSON 最简、零依赖；过了量级迁 better-sqlite3，store 接口已隔离，替换不动上层」                          |
| 「grep 为什么不用 ripgrep？」 | 「没想到」    | 「现在受控遍历 + 40 条上限够演示；大仓库 spawn ripgrep 加 ignore 规则，工具接口不变」                                   |
| 「有单元测试吗？」             | 沉默/瞎编    | 「没有，这是目前最大工程债；核心纯函数（isSafeCommand/resolveInWorkspace/unifiedDiff）无外部依赖，最适合先补 Vitest，优先安全相关」 |
| 「Agent 会不会把用户密钥读出去？」  | 「不会」     | 「read\_file 能读工作区内任何文件，.env 在工作区内就有泄露面；有审计场景专门扫 sk-，根治要做敏感文件读取脱敏或 .gitignore 联动拦截，这是已识别风险」  |
| 「1 万行一个人写多久？」         | 编造       | 如实回答，口径：「利用课余约 X 周，core 引擎先行，UI 迭代最久的是流式和 HITL 交互时序」                                        |

***

## 七、演进路线

- **短期（不改架构）**：工具协议迁 AI SDK 原生 tool calling + zod；补命令重定向拦截 / `shell:false`；安全纯函数补 Vitest；DNS rebinding 防护。
- **中期（换存储/提可靠）**：持久化换 SQLite（会话、审批队列、worker 状态可查询）；Plan 支持步骤间依赖（DAG）；审批队列跨请求持久化（修「刷新丢待审批」）；并发度/成本预算控制。
- **长期（产品化）**：工具 MCP 化；RAG 代码库索引（ripgrep + 向量库）替代全量读文件；多会话 Agent 服务化 + 鉴权审计；可观测性（每轮 token/时延埋点）。

**可直接落地的两个高价值改造：**

1. 给拆步加**失败重规划**（Replanner）：某步失败后带着已跑出的结论重拆一次，才算真·Plan-and-Execute（拆步本身已接）；
2. 用 SQLite + 版本表修掉「刷新丢审批 / 快照不持久」两个缺陷。

***

## 八、30 秒电梯陈述

> 这是我独立做的一个 IDE 风格本地 Coding Agent 工作台，TypeScript Monorepo，1 万多行代码。核心是一个 ReAct Agent 循环：模型通过约定的工具协议调用读文件、搜索、抓网页等工具，多步完成代码库任务。我重点做了两件事：一是**写操作的人在环机制**——Agent 只能生成带 unified diff 的写提案，人批准后才落盘、还能回滚，命令执行有白名单和超时熔断；二是 **Plan Board 多 Agent 并行编排**，不同角色 Worker 绑不同模型并行推进、失败隔离、统一审批。前端用 Next.js + 自定义 SSE 事件协议做 Cursor 风格流式渲染，再套 Electron 壳做桌面应用，能自动拉起本地服务。另外做了一套确定性 mock 模型，让产品没有 API Key 也能完整演示。

***

## 九、自测清单

能脱稿答出就算吃透：

1. 不看代码画出 ReAct 一轮的消息序列：system 里有什么？observation 以什么 role 回注？为什么只带最近 12 轮？
2. 为什么说 Plan Board 不是严格 Plan-and-Execute？差哪两个组件？
3. grep 工具和 RAG 的三个本质区别？给本项目加 RAG 的链路？
4. 并行 worker 为什么不需要锁？哪个共享资源仍有冲突风险、当前靠什么规避、auto-approve 后怎么办？
5. 刷新页面后待审批文件去哪了？线上怎么设计才能让审批挂起三天不丢？
6. 从模型输出 write\_file 到磁盘被修改，经过几个进程边界？快照在哪一刻产生、存在哪、撤回的两个分支是什么？
7. 为什么 Next.js + SSE 不能直接部署到边缘 serverless？
8. `git diff` 比手写 diff 强在哪？「前瞻 8 行」算法最坏情况输出什么？

***

*文档生成日期：2026-09-12 · 基于仓库代码实际核实*

---

## 补记（2026-10-16 晚 · 后台 job 通道已落地）

原文在「DSH 的后台子 agent 归父级的通用 Job 接口管理」处只记了差距（`packages/core/src/agents/subagents.ts:13` 的注释）。
现在父级有了对等的通道：`run_safe_cmd` 传 `background:true`（批准后）立刻拿 `jobId`，
`job_list` / `job_output` / `job_kill` 三个工具让模型先启动、干别的、再回来收；输出按游标只给新增，
单 job 截到 8000 字符。**句柄只在进程内存里**（重启即失效）——分工是：todo 是状态所以落盘，job 是句柄所以不落盘。

实锤：`packages/core/test/jobs.test.mjs` 14 条真起真杀、`scripts/probes/jobs.mjs` 11 条、http 探针新增 8 条。
踩到的坑值得单独背：**Next 在开发模式下给每条 route 各编译一份 server chunk**，`import "@loom/core"` 被各自内联，
模块级单例于是变成两份——症状是「批准后台命令拿到了 `jobId`，`GET /api/jobs` 却返回 `jobs=0`」。
修法是把单例挂 `globalThis`，并让单测钉住这条契约。
