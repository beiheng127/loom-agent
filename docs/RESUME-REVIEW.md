# 简历项目简介：逐句审计 + 改写

审计对象是这段（你发我的那版）：

> 技术栈：TypeScript Monorepo · Next.js 15 (App Router/SSE) · Electron · Vercel AI SDK
> 项目简介：实现 IDE 风格的多模型 Coding Agent 工作台，Agent 可对指定工作区执行读文件 / 搜索 / 安全命令等操作；采用"先 Diff 预览、确认后落盘"的写操作 HITL 机制；设计 Plan Board 编排器，支持多 Worker 并行推进同一任务，Ask / Agent 双模式切换。
> • 架构设计：npm workspaces 三层 Monorepo（core 引擎 / Web 控制台 / Electron 壳），core 与 UI 完全解耦，约 1.3 万行 TypeScript、19 个 API 路由、多个内置 Skills；自定义 SSE 协议传输文本增量与工具调用状态
> • 安全机制：写文件统一进入待审批状态，基于 unified diff 生成可视化对比；命令执行走白名单前缀校验 + 超时熔断；API Key 仅存本地（BYOK）
> • 工程化：会话 / Plan 本地 JSON 持久化；Electron 检测 Studio 端口未启动时自动拉起

审计日期 2026-10-12，全部数字来自实测（命令与结果附在文末）。

---

## 一、先说结论

这份简介的问题不是写得不漂亮，是**重心站错了**。

它整个在讲"我做了个 IDE 工作台"——这是 2024 年的叙事。2026 年筛 Agent 岗的人看的是 harness 里那几件事：**工具协议走没走原生、token 有没有计量和预算、上下文怎么管、有没有测试和评测、HITL 的边界在哪**。你这份里：

- 工具协议写了「自定义 SSE 协议传输……工具调用状态」——**这是自曝**。而真实情况是：改造前工具调用是正则解析模型输出的 JSON，是假的原生调用；你 10 月刚把它换成 Vercel AI SDK v6 原生 tool calling + `stepCountIs` 多步。**这是整份简历里最值钱的一段，一个字没提。**
- 4 条最容易被问塌的说法：`1.3 万行`（实测 1.15 万）、`API Key 仅存本地（BYOK）`（实际是服务端 `process.env`，不是浏览器本地）、`Plan Board 编排器`（10-16 前确实是 `Promise.all` 扇出、无依赖无重试；现在补上了依赖分层 / 重试 / 上游下沉 / 模型动态拆步，**仍无失败重规划与 best-of-N 择优**——改口径别改事实）、`自定义 SSE 协议`（见上）。
- 3 个真正扛揍的硬货写得不够重：`19 个 API 路由`（真的）、白名单+超时熔断（真的有 15000ms / 8000 字符常量）、core 与 UI 解耦（真的有：13 处 import 全走包入口，core 零 react/next 依赖）。
- **被完全漏掉的两个亮点**：token 计量与预算熔断（`usage` 事件 + `maxTokens` 超限中止）、24 条单元测试全绿。后者是"工程化"那段唯一的硬证据，你没写。

还有一件事比文案重要得多，见第四节。

---

## 二、逐句审计

| 原话 | 判定 | 实测 |
|---|---|---|
| 约 1.3 万行 TypeScript | **虚报 13%** | 11494 行 TS/TSX（63 文件）。改说 `1.1 万行`；想显专业就拆成 `core 引擎 4.3K + Web 7.2K` |
| 19 个 API 路由 | **真** | `route.ts` 实测 19 个，一字不差 |
| 多个内置 Skills | **真但含糊** | 就写 `7 个`。数字比形容词值钱 |
| core 与 UI 完全解耦 | **真有硬证据** | Web 侧 13 处 import 全走包入口，无一处深路径；core 的 .ts 零 react/next 依赖 |
| 自定义 SSE 协议传输文本增量与工具调用状态 | **说法过时且有坑** | SSE 是标准，自定义的是 10 类 `LoopEvent` schema + 手写编码。但 2026 见"自定义协议"第一反应是"没用原生 tool calling"——而你**现在已经用了** |
| 命令执行走白名单前缀校验 + 超时熔断 | **真，能扛** | 前缀 `git status / git diff / git log -n / git log --oneline -n`，超时 15000ms、输出截 8000 字符，`LOOM_SAFE_CMDS` 可扩展 |
| API Key 仅存本地（BYOK） | **会被问塌** | 真身是 `process.env[apiKeyEnv]`，服务端 Node 进程读。浏览器 localStorage 里存的是外观偏好和 tickets，**不是 Key** |
| 写文件统一待审批 + unified diff 可视化 | **真，但别提算法名** | `diff/unified.ts` 自己的注释写着"简单 LCS 太重，MVP 用启发式"：8 行前瞻窗口近似对齐，>40 行截断。**追问算法时别答 Myers** |
| Plan Board 编排器 | **补了一半，词还偏大** | 现在：`dependsOn` 按依赖分层（同批并行 / 批间串行）、`maxRetries` 重试、上游失败下游 `skipped`、上游结论摘要下沉、依赖成环在跑之前报 400。**还是**没有 best-of-N 择优、没有失败重规划（Replanner）、没有并发上限 |
| 支持多 Worker 并行推进同一任务 | **真** | 确实是并发跑不同 Agent+模型；单 Worker 失败被 try/catch 隔离，不拖垮整体 |
| Ask / Agent 双模式 | **真且比写的更好** | 不只是 prompt 约束：`readOnly` 时直接把 `write_file`/`run_safe_cmd` 从工具集里摘掉，挡在模型之前 |
| 会话 / Plan 本地 JSON 持久化 | **真** | `data/loom-store/` 下 3 个文件：agents / plans / sessions |
| Electron 检测端口自动拉起 | **真，且能报数字** | 1200ms 超时探活，未起就 spawn studio，轮询 60×1s |
| 工程化（整段） | **最弱的一段** | **没有 .git、没有 .github、没有 CI、没有 eslint/prettier**。而且远端仓库 `pushed_at` 停在 2026-09-09 |

---

## 三、面试官会怎么下刀（附你的答法）

**1. "你的工具调用是怎么实现的？"**
这是必问题，也是最容易翻车的一问。诚实版答法：
> "一开始我是让模型输出 JSON 动作、用正则解析——现在回看这是假的 tool calling，模型不遵守格式就崩。10 月我重写成了 Vercel AI SDK v6 的原生 tool calling：每个工具带 `inputSchema`（JSON Schema），SDK 负责校验和回传，多步用 `stepCountIs` 驱动，`fullStream` 里 `tool-input-start/delta/call/result` 全都能拿到。我把 `tool-input-delta` 直接透传到前端，所以调用参数是边生成边显示的。"

这一答把"我用过 SDK" "我知道 fake 和真的区别" "我能改架构"全说了。**比原稿的"自定义 SSE 协议"强一个量级。**

**2. "API Key 怎么存的？"**
> "服务端环境变量注入，`.env` 在 `.gitignore` 里，不入库不上传不写日志。模型层只认 `apiKeyEnv` 这个名字，真值不进任何配置文件。"

别说"存在浏览器本地"。

**3. "Plan Board 的编排逻辑是什么？有 DAG 吗？"**
现在**有依赖图了，可以正面答**（10-16 之前不行，别用旧口径）：
> "有。Worker 用 `dependsOn`（下标）声明依赖，调度器 `runPlanScheduler` 先 `topoBatches` 按依赖分层：同批 `Promise.all` 并行、批间串行。上游 failed/skipped/cancelled 时下游直接标 `skipped`、**一次都不跑**——省 token；失败按 `maxRetries` 重试、`attempts` 记在 step 上；直接上游的结论摘要（单条 400 字符、合计 1200）会拼进下游 goal，所以是数据流而不是各跑各的。依赖成环 / 越界 / 依赖自己在**跑之前**就抛 `PlanDependencyError`，HTTP 面是 400 不是 500。调度器和执行解耦，所以我用假 runner 单测了拓扑、跳过、重试、取消——16 条。另外 `planner: true` 时先让**真模型**拆一次步（产 JSON 清单 + `deps` 下标，模型没给出可解析清单就回落预设），拆出来的清单也走同一个调度器；真模型实测拆出「2 批 → 1」。
> **还欠的是**：拆步是一次 LLM 调用出清单，没有失败重规划（某步挂了不会重拆），也没有 best-of-N 择优，同批没有并发上限（生产要上 `p-limit`）。"

主动交出边界，比被逼出来强十倍。

**4. "命令白名单怎么防重定向？"** ← **这题你现在答不了，见下**

**5. "有测试吗？"**
> "有，128 条 `node:test`，覆盖工具 schema、原生协议事件成对、usage 计量真实性、token 预算熔断、readOnly 摘工具、mock 走真路径、插件加载与真插件行为、上下文压缩、**Plan 编排（依赖分层 / 重试 / 跳过 / 取消，用假 runner 直接测调度器）**。`tsc --noEmit` 干净，`next build` 20 条路由 EXIT=0。"

**6. "上下文超了怎么办？"**
没做。老实说"没做，下一步就是用 token 计量做阈值触发的压缩"——但**前提是你真的去做**，别只写在简历上。

---

## 四、比文案更急的一件事：代码没推上去

```
远端 pushed_at  2026-09-09T13:05:39Z
本地最新文件    2026-10-12 18:38
```

**10 月的全部改造（原生 tool calling、usage 计量、24 条单测）都还躺在本地。** 而且本地**连 `.git` 都没有**（`Test-Path .git` = False），意味着你现在没法 `git push`，得先重新 init 或 clone 回来。

面试官会 clone。clone 下来看到的是 9 月的旧版：工具调用还是正则、没有单测、`package.json` 里 `zod` 列了依赖却零引用。那时候简历上写"原生 tool calling"就是自曝其短。

**动作顺序：先 push，再改文案。**

顺带，仓库有这几个门面问题：
- `license: null` —— 没有 LICENSE 文件
- 没有 CI。加一个 GitHub Actions 跑 `tsc --noEmit` + `node --test`，成本 20 行 YAML，简历上就能写"CI 卡门禁"
- `zod ^4.4.3` 在 dependencies 里但全仓零 import —— 要么删，要么真用起来

---

## 五、还挖出一个洞：白名单能绕过

`packages/core/src/tools/cmd.ts:23` 的拦截字符集是 `|` `;` `&` 反引号 `$(` 和换行，**没有 `>` 和 `<`**；而 `applyApprovedCmd` 在 `:106` 用了 `shell: true`。

实测（`packages/core/dist/tools/cmd.js` 的 `isSafeCommand`）：

```
true   git status
true   git status > evil.txt          ← 能过
true   git status > ../../evil.txt    ← 能过，能跳出工作区
true   git diff < x
false  git status; rm -rf
false  git status | cat
true   git log -n 20
```

`git status > ../../evil.txt` 通过白名单 → `spawn(..., {shell:true})` → **任意路径任意文件写**。等你写"白名单前缀校验"的时候，面试官顺手就问这个。

两种处理方式，选一个：
- **A（推荐，20 分钟）**：拦截集加上 `>` `<`，再补一条**路径边界**检查（重定向目标必须在 workspaceRoot 内）。改完简历可以写"白名单前缀 + Shell 元字符拦截 + 工作区路径边界"。
- **B**：不修，简历也别写"安全"。写了就是给自己挖坑。

（`docs/INTERVIEW-DEEP-DIVE.md:340` 里你自己已经承认过这个缺口——既然知道，就顺手补了。）

---

## 六、改写版

### 稿 A：稳守版（只写已经过实测的，一句都不虚）

> **Loom Agent｜本地优先的 Coding Agent 工作台｜独立开发**
> TypeScript Monorepo · Next.js 15 · Electron · Vercel AI SDK v6
>
> - **架构**：npm workspaces 三层（core 引擎 4.3K 行 / Web 控制台 7.2K 行 / Electron 壳），core 与 UI 完全解耦——Web 侧 13 处引用全部走包入口，引擎零前端依赖；对外 19 个 API 路由 + 手写 SSE 事件流。
> - **Agent 循环**：基于 AI SDK v6 原生 tool calling（7 个工具各带 JSON Schema）实现多步 ReAct，`stepCountIs` 驱动步数上限；`fullStream` 的 `tool-input-delta` 直接透传，调用参数边生成边显示。**这一步是把原先正则解析 JSON 动作的假调用整个换掉**，换来的是模型不会再因为格式不合规而崩。
> - **成本与可观测**：每步从 SDK 拿真实 usage（输入/输出/缓存命中），估算用 4 字符≈1 token；累计超预算即中止。单条会话可以按步看到 token 花在哪。
> - **安全与 HITL**：写文件一律进待审批，服务端算 unified diff（增删行数可视化）后交人确认，支持单次/全部撤回；命令走白名单前缀 + Shell 元字符拦截 + 工作区路径边界，超时 15000ms、输出截 8000 字符；外链工具禁内网 IP、禁重定向（SSRF）。密钥只从服务端环境变量注入，不入库不上传。
> - **编排与测试**：Plan Board 支持 Worker 声明 `dependsOn`，调度器按依赖分层——同批并行、批间串行，上游失败下游直接 `skipped` 不再烧 token，失败按 `maxRetries` 重试并记录 `attempts`，上游结论摘要下沉进下游目标；依赖成环/越界在跑之前报错。**调度与执行解耦**，因此编排本身（拓扑/跳过/重试/取消）用假 runner 单测；全仓 128 条 `node:test`，`tsc --noEmit` 零错误。

变化：`1.3 万`→拆成真实数字；`多个 Skills`→删（Skills 不是卖点）；`自定义 SSE`→换成原生协议叙事；`BYOK`→改成服务端注入；`编排器`→先说边界（有依赖分层、重试与模型拆步，无失败重规划与择优）；补上 usage 计量、SSRF、128 条测试。**每一条都能在代码里指出行号。**

### 稿 B：进取版（做完下文"动手清单"后可用）

在稿 A 基础上再加：

> - **上下文工程**：按 token 计量做阈值触发的历史压缩（到 80% 上下文时摘要旧轮次，保留最近 16%），压缩失败降级并记事件，不静默丢历史。
> - **工程门禁**：GitHub Actions 跑 `tsc --noEmit` + 128 条单测，PR 不绿不合。

这两条今天还不成立——等真做完再写。**简历上不写没做过的东西，这一条你已经在"自定义 SSE 协议"上吃过一次了。**

---

## 七、动手清单（按性价比排序）

| 优先级 | 事项 | 成本 | 收益 |
|---|---|---|---|
| **P0** | 重新 init git，把 10 月改造推上去 | 30 分钟 | 不推，简历上的技术描述全是空中楼阁 |
| **P0** | `isSafeCommand` 补 `>` `<` + 路径边界 | 20 分钟 | 堵住一个能当场复现的洞 |
| P1 | 加 GitHub Actions（typecheck + test） | 20 分钟 | "工程化"段落从零证据变成有两道门禁 |
| P1 | 删掉零引用的 `zod` 依赖 | 5 分钟 | 少一个被问"你 zod 用在哪"的坑 |
| P1 | 加 LICENSE | 2 分钟 | 仓库门面 |
| P2 | 层3 上下文压缩（token 阈值触发） | 半天 | 补上 2026 最热的"上下文工程"叙事 |
| P2 | 更新 `docs/INTERVIEW-DEEP-DIVE.md`（大量结论已被 P0 推翻） | 1 小时 | 自测时不会被自己的旧文档带偏 |

---

## 附：实测命令与结果

```
# 规模（排除 node_modules/dist/.next/_snapshot）
TS/TSX files = 63   total lines = 11494
  packages\core  4266   （loop 1028 / tools 792 / demos 663 / agents 333 / …）
  apps\web       7210   （components 5371 / lib 580 / api 路由约 1259）

# 门禁
npx tsc --noEmit -p packages/core/tsconfig.json   → exit 0
node --test "packages/core/test/*.test.mjs"       → # tests 24 / # pass 24 / # fail 0

# 计数
route.ts = 19    tools = 7    builtin agents = 6    skills = 7    models = 5

# 仓库门面
.git False   .github False   LICENSE False   eslint/prettier/vitest 配置 均 False

# 远端（api.github.com/repos/beiheng127/loom-agent）
pushed_at 2026-09-09T13:05:39Z   license null   stars 0   topics []

# 白名单绕过（packages/core/dist/tools/cmd.js）
isSafeCommand("git status > ../../evil.txt") === true
```

---

## 补记（2026-10-16 晚 · 本文档的哪些结论已过期）

上面第一~七节是 **10-12 当天**的审计快照，别拿它当现在的状态用。已经变了的事实：

| 当时 | 现在 |
|---|---|
| 单测 24 条 | **128 条**（`npm test`：128 pass / 0 fail） |
| 工具 7 个 | 11 个（多了 `todo_write` 与后台 job 三件套 `job_list` / `job_output` / `job_kill`），外加插件提供的 4 个 |
| API 路由 19 条 | **20 条**（多了 `/api/plugins`、`/api/plans` 等，`next build` 也报 20） |
| Plan 是纯扇出、无 retry | 有依赖分层 + 重试 + 上游摘要下沉 + `chain` 串行预设 + 模型动态拆步；仍无失败重规划与 best-of-N 择优 |
| `cmd.ts` 白名单能绕过 | 已堵（`| ; & \` $( > <` 与换行全进 `DANGEROUS_CHARS`） |
| 没有 `.git` | 仍然没有 —— 这条还是 P0，别拖 |

