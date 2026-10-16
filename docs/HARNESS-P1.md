# Loom Agent · P1:从「有个循环」到「有 harness」

> 2026-10-15。P0 把假的工具协议换成了真的（见 [`HARNESS-UPGRADE.md`](./HARNESS-UPGRADE.md)）。
> 这份文档记录 P1：**把 harness 的其余内脏补齐并接进产品**。
> 状态：**设计完成度 60%**，交你自测。没做完的部分在 §6 明写，不藏。

---

## 0. 先说难听的

「agent = 模型 + harness」。P0 之前这个项目的模型是个**文本生成器**，
它和代码之间靠正则抠 JSON 沟通。现在模型是真会发 tool call 了。

但翻完 P1 之前的代码，还有几句实话：

1. **能力造出来了，但产品够不着。** todo 投影、子 agent 委派、插件、预算
   全都写在 `packages/core` 里，而 `apps/web` 里 grep 这些词——**零命中**。
   造了没人能用，等于没造。这是 P1 最该修的一件事。
2. **`Plan Board 编排器` 这个名字撑不住。** `orchestrator.ts` 里没有 Planner
   LLM、没有 DAG、没有 retry、没有投票择优，就是 `Promise.all` 扇出 + 字符串拼接。
   准确的说法是 **Parallel Fan-out**。简历上写「编排器」会被问塌。
   > 补记（2026-10-16 晚，第二次补）：依赖分层、失败重试、上游结论下沉、上游挂了下游 `skipped`
   > 都补上了（`runPlanScheduler` + `topoBatches`，依赖错在跑之前就报），`chain` 预设是真正的串行流水线；
   > 再往后 `planner.ts` 把**模型拆步**也接进了自动链路（`POST /api/plan { planner: true }` → 一次
   > `generateText` 出带 `deps` 的 Worker 清单，解析不了就回落预设；真模型实测拆出「2 批 → 1」的链）。
   > **仍然没有** best-of-N 择优与失败重规划（Replanner）——所以「自己长链路」补上了，「长歪了能改」还没补。
3. **上下文永远不会压缩。** `run.ts` 原来写死 `history.slice(-12)`，
   既不计量也不压缩——多轮长任务必然爆上下文，而代码里连「爆了」这件事都看不见。
4. **安全洞是真的。** `cmd.ts` 的白名单拦截字符表漏了 `>` 和 `<`，
   而 `spawn` 用的是 `shell:true`。实测 `git status > ../../evil.txt` 能过白名单，
   **写到工作区外面去**。这不是理论风险，是复现过的。
5. **没有 git、没有 CI、没有 LICENSE。** 远端 `pushed_at` 停在 2026-09-09，
   10 月的所有改造一个字节都没推上去。

这五条是 P1 的施工清单。

---

## 1. P1 做了什么

对照 DSH（DeepSeek Harness）的插件实体逐条移植。设计原则只有一条：
**能抄 DSH 的默认值和公式就抄，抄不了的写清楚差异，不假装一样。**

### 层 3 · 上下文压缩（对标 `dsh-compaction-basic`）

新建 `packages/core/src/loop/compact.ts`。

| 项 | DSH 默认值 | Loom 实现 |
|---|---|---|
| `thresholdRatio` | 0.8 | 0.8 |
| `headroomTokens` | 65536 | 65536 |
| `retainRatio` | 0.16 | 0.16 |
| `maxOutputTokens` | — | 8192 |
| 触发阈值 | `floor(min(W×0.8, W−O−B))` | 同式 |
| 保留预算 | `(W−O)×0.16` | 同式 |

- 压缩时把最旧的一段换成**一条摘要消息** `<context_summary>…</context_summary>`，
  近期尾部**逐字保留**。
- **边界安全**：保留起点只允许落在 `role === "user"` 上，绝不切开
  tool-call / tool-result 配对。切不动就不压。
- **失败不静默**：摘要模型抛错 → `摘要生成失败：<msg>`；没内容可压 →
  `没有可安全压缩的旧内容`；每种都给得出 `reason`，并通过 `compacted` 事件上报。
- 容量**不自己猜**：`contextWindow` 放在 `ModelConfig` 上（对标 DSH
  `ctx.llm.resolveModelInfo().context`——容量属于路由，不属于压缩器）。
  mock 故意只给 32000，为的是让离线演示能低成本触发压缩。

### 层 4 · 子 Agent 委派（对标 `dsh-tool-subagent` + `dsh-tool-subagent-control`）

新建 `packages/core/src/agents/subagents.ts`。

- **一个委派目标 = 一个工具实例，`toolName` 必须互不相同。**
  内置 `orchestrator` 挂了三个：`subagent_recon` / `subagent_design` / `subagent_verify`。
- 委派能力**由 Agent 档案自己声明**（`AgentProfile.subagents`），
  加一个「能派 3 个子 agent」的 Agent，只改 `profiles.ts` 一处，UI 不用硬编码。
- `maxDepth` 默认 1；超限时工具**仍然可见**，调用才返回错误——对标 DSH。
- **永不放权**：子 agent 工具白名单 = 父级 `allowedTools` ∩ spec 白名单。
- 子 agent 默认**继承父级 modelId**。理由照抄 DSH：fork 型子 agent 覆盖路由
  会让 KV Cache 前缀失效。
- 控制工具三个：`list_agents` / `send_message` / `interrupt_agent`。
  `send_message` **只回 messageId、绝不回内容**——这是 steering 不是问答。
- 前台调用与 `send_message` 唤醒**走同一个 `runSubagentTurn`**。
  两条路各写一份是这类系统最常见的坑。
- 子 agent 中间步骤**不回流**父级事件流，父级只拿到最终文本。

**如实标注的差异**（写在源码注释里）：DSH 的 steering 在**步骤边界**投递，
loom 一个子 agent 一轮就是一个 `streamText` 请求，中途没法注入，
所以投递点是**轮次边界**。不吹成同款。

### 层 5 · TODO（对标 `dsh-tool-todo`）

新建 `packages/core/src/plan/todo.ts`。

- **整表替换**，无部分更新、无回读工具。
- 成功文案逐字：`Updated todo list: <p> pending, <i> in progress, <c> completed.`
- 四条失败文案逐字对齐，含
  ``Error: invalid todo: `content` must be a non-empty string``
  与 `Error: invalid todos: at most one task may be in progress (got <n>)`。
- **单一所有者**：列表属于创建它的 agent 会话；非 agent 调用方被拒。
- 投影：首次写入前为 null，**下一轮次开始时清空**，`turn/end` 保留刚完成的清单。

**当时的差距 → 2026-10-16 已补**：原文写的是「事件日志在进程内存里，重启即丢」。
现在事件追加进 `<仓库根>/data/loom-store/todos/<会话>.jsonl`（JSONL，只追加，懒加载，
`LOOM_TODO_DIR` 可覆盖、`LOOM_TODO_STORE=memory` 退回内存），重启后第一次碰到该会话就回放：
投影、`turn`、历史事件全在。验收见 `node scripts/probes/todo-persist.mjs write` 与 `replay`
（两个进程，第二个是全新进程空内存）。
**仍未对齐 DSH 的地方**：DSH 把 todo 事件和会话消息写在同一条会话日志里，所以「第几轮」由日志本身给出；
这里是独立的 todo 日志文件 + `startTurn` 本地计数，回放靠最后一条事件恢复 turn —— 语义等价但形态不同。

### 层 6 · 插件系统（对标 DSH 的 cordis 插件形态）

新建 `packages/core/src/plugins/`。

- 磁盘契约：`plugins/<name>/loom-plugin.json` + `index.mjs`，零新依赖。
- 清单字段 `name` / `version` 必填，`main` / `enabled` 可选。
- 动态 `import(pathToFileURL(...))`，支持 `{tools}` 与 `{default:{tools}}` 两种导出。
- **失败隔离**：单个插件炸了记成 `error` 字段继续跑，不拖垮 Agent 循环。
- 工具名必须匹配 `/^[a-z][a-z0-9_]*$/`，与内置同名则丢弃并记 warning。
- 示例插件 `plugins/hello-plugin/`：`hello_echo` + `repo_wordcount`。

### 顺手补的安全洞

`packages/core/src/tools/cmd.ts` 抽出 `DANGEROUS_CHARS`：

```ts
const DANGEROUS_CHARS = ["|", ";", "&", "`", "$(", ">", "<", "\n", "\r"] as const;
```

`>` 和 `<` 是这次补上的。`spawn(..., {shell:true})` 的安全性 100% 依赖这张表，
所以表旁边留了注释：**改这张表 = 改攻击面**。

### 接进产品（这才是 P1 的重点）

造出来够不着，等于没造。所以：

- **两个运行路由**（`/api/run`、`/api/run/stream`）接受 `sessionId` / `plugins` / `budget`，
  加载插件工具当 `extraTools` 注入循环。
- **`/api/meta`** 新增 `harness` 段：插件清单 + 每个 Agent 的委派工具与 `maxDepth`。
- **`LoomShell.tsx`** 补了 UI 真正缺的东西：
  - `sessionId` 在首次 run 时生成并随 body 发出——**在此之前 todo 这条能力在 UI 里永远走不到**。
  - SSE 事件链新增 `subagent_start` / `subagent_end` / `compacted` / `usage` 四个分支。
    之前这些事件**落进 if/else 链会被静默丢弃**。
  - Composer 标题栏显示每一步的 `↑input ↓output` token 数。
- **mock 也要看得见完整工具集**：`resolveMockScenario` 的入参从「内置工具」
  改成「合并后的全部工具」，并新增 `delegate_fanout` 场景。
  否则「派子 agent」这条路径只在真模型下存在，离线演示永远演不出来。

### 一个只有起产品才会暴露的 bug（记一笔）

插件在**纯 Node 下加载正常**（单测、CLI、探针全过），但一起 Studio 就报：

```
Cannot find module 'file:///C:/Users/ruia3/Desktop/test/agent/plugins/hello-plugin/index.mjs'
```

根因是 `apps/web/next.config.ts` 里的 `transpilePackages: ["@loom/core"]` —— webpack 会把
`registry.ts` 里那行动态 `import(pathToFileURL(entryPath).href)` 编译成一个 context module，
运行时按「相对 bundle」去解析，而插件入口是磁盘上的绝对 `file://` URL，必然找不到。

修法是给它加 webpack 的魔法注释，让 bundler 原样放行、交给 Node 的 ESM loader：

```ts
await import(/* webpackIgnore: true */ pathToFileURL(entryPath).href);
```

**教训**：这次是 `next build` 早就报过 `Critical dependency: the request of a dependency is
an expression` 这条 warning，当时当成「Next 常见告警」略过了 —— 它就是同一个 bug 的预告。
**库级测试全绿不等于产品能跑**：能力必须从 HTTP 面再验一遍，所以这轮补了
`scripts/probes/http.mjs`（12 项断言，见 §2）。

---

## 2. 实测数字（不是形容词）

全部在 `C:\Users\ruia3\Desktop\test\agent\` 下跑出来的。

| 检查项 | 命令 | 结果 |
|---|---|---|
| core 类型检查 | `tsc -p packages/core/tsconfig.json --noEmit` | **EXIT=0** |
| web 类型检查 | `cd apps/web; tsc --noEmit` | **EXIT=0** |
| core 编译 | `npm run build:core` | **EXIT=0** |
| 单测 | `node --test "packages/core/test/*.test.mjs"` | **58 / 58 pass, 0 fail**（P1 当时的数字；现在 128 条，见 [`PROGRESS.md`](./PROGRESS.md)） |
| 离线 Demo | `node packages/core/dist/demo.js` | **EXIT=0**，同质双线程 228ms/230ms；异构 Reader 191ms + Editor 127ms，pendingWrites=1 |
| web 构建 | `cd apps/web; npx next build` | **EXIT=0**，20 条路由（含新增 `/api/plugins`） |
| **HTTP 端到端** | `node scripts/probes/http.mjs`（需先 `npm run studio`） | **12 / 12 pass** |
| 白名单安全 | `isSafeCommand('git status > ../../evil.txt')` | 改动前 `true`（可越界写）→ 现在 **`false`** |

**规模**：`packages/core/src` 27 个 `.ts`、**5793 行**；单测 4 个文件
（`loop.test.mjs` 319 / `compact.test.mjs` 331 / `todo-plugin.test.mjs` 329 / `helpers.mjs` 71）。

**端到端探针**（`scripts/probes/harness.mjs`，真实跑一遍不是纸上推演）：

```
plugins: [ { name: 'hello-plugin', tools: [ 'hello_echo', 'repo_wordcount' ] } ]
plugin tool defs: [ 'hello_echo', 'repo_wordcount' ]
orchestrator subagents: [ 'subagent_recon', 'subagent_design', 'subagent_verify' ]

event types: phase, compacted, text_delta, text, tool_input_delta,
             subagent_start, tool_call, subagent_end, tool_result, usage, done
counts: {"phase":4,"compacted":1,"text_delta":11,"text":2,"tool_input_delta":12,
         "subagent_start":2,"tool_call":2,"subagent_end":2,"tool_result":2,"usage":3,"done":1}
subagent_start: [ 'subagent_recon', 'subagent_recon' ]
subagent_end statuses: [ 'inactive', 'inactive' ]
```

即：**插件加载 → 委派工具可见 → 子 agent 真被派出 → 结果回流 → 计量逐步上报**，
整条链路在离线 mock 下跑通。

### 前后对比

| 维度 | P0 之前 | 现在 |
|---|---|---|
| 工具协议 | 正则从自由文本抠 JSON | AI SDK v6 原生 tool call |
| 多步 | 手写 `while` + `parseAction` | `stopWhen: stepCountIs(n)` |
| 计量 | 无 | 每步 usage 事件 + 预算熔断 |
| 上下文 | `history.slice(-12)` 死截断 | 0.8/0.16 阈值压缩 + 摘要 |
| 委派 | 无 | 每 Agent 可挂多个子 agent 工具 |
| 插件 | 无 | 目录 + 清单 + 失败隔离 |
| 安全 | `>` `<` 未拦（可越界写） | 已拦 |
| 单测 | **0** | **58** |
| UI 可见性 | — | 委派/压缩/token 三类事件已渲染 |

---

## 3. 怎么自测

```bash
cd C:\Users\ruia3\Desktop\test\agent

# 1) 门禁三连
npm run typecheck
npm run build:core
npm test                       # P1 时期是 58 pass；现在 128 pass，0 fail

# 2) 离线 Demo（不需要任何 Key）
node packages/core/dist/demo.js

# 3) 端到端探针：插件 + 委派 + 计量（库级）
node scripts/probes/harness.mjs

# 4) 起 Studio 看 UI
npm run studio                 # → http://localhost:3010

# 5) HTTP 端到端探针（另一个终端，Studio 起着时跑）
#    验的是「能力真的从 API 路由暴露出来」——库级探针查不出 webpack 那类问题
node scripts/probes/http.mjs

# 6) 假动作审计：mock 剧本里有没有「说了却没做」的分支
node scripts/probes/audit-mock-claims.mjs

# 7) 文档编码自检（防 PowerShell 把中文文档写坏）
node scripts/probes/check-docs-encoding.mjs
```

UI 里重点看三处（这是 P1 新增的可视证据）：

1. **Composer 标题栏**：跑起来后应该出现 `第 N 步 ↑x ↓y`。
2. **选 `orchestrator` Agent 问「派子 agent 并行盘点」**：
   线程里应出现子 agent 的 call/ok 卡片，且**子 agent 的中间步骤不会铺满线程**。
3. **多轮对话把上下文堆过 0.8 阈值**：应出现 `context_compact` 卡片，
   带「压缩了 N 条历史，估算释放 X tokens」。
   注意两个名字不是一回事：**事件名是 `compacted`**，卡片名叫 `context_compact`
   （`LoomShell.tsx:1035` 收事件，`:1042` 建卡片）。按事件名 grep 不到卡片是正常的。

4. **`guide` Agent 问「帮我列一下待办清单」**：应看到 `todo_write` 的 call/ok 卡片，
   结果文案是 `Updated todo list: 1 pending, 1 in progress, 1 completed.`
   ——这是层5 唯一的离线可见入口（见下方补记）。

---

## 4. 验收标准（对照 m01213 的要求）

| 要求 | 达成 | 证据 |
|---|---|---|
| 不留情面的评价 | ✅ | §0 五条 |
| 按 agent=model+harness 改进 | ✅ | §1 四层 |
| **不只是页面**，功能工程化 | ✅ | 层 3/4/5/6 都进了循环与路由，不是摆设 |
| **能自行调用子 agent 开发** | ✅ | `orchestrator` + 3 个委派工具，探针实测派出 2 个 |
| 按 DSH 基础逻辑设计 | ✅ | 默认值/公式/文案逐条对标，差异明写 |
| 可自行添加插件 | ✅ | `plugins/` 目录 + 清单 + 示例 |
| 难度与设计简易 | ✅ | 插件零新依赖；委派能力改 `profiles.ts` 一处 |
| 完成度 60% 交付自测 | ✅ | 本文件 |
| 跟进开发/设计文档 | ✅ | 本文件 + `PROGRESS.md` |
| 同步更新 README | ✅ | `README.md` harness 段 |

---

## 5. 已知缺口（这就是那 40%）

按「被面试官问到会不会塌」排序：

| # | 缺口 | 现状 | 塌法 |
|---|---|---|---|
| 1 | **没有 git 仓库** | 根目录无 `.git` | 「你怎么管理版本？」答不上来 |
| 2 | **没有 CI / lint / 格式化** | 无 `.github`、无 eslint/prettier | 「工程化体现在哪？」只有单测 |
| 3 | **没有 LICENSE** | 远端 `license: null`，仓库 public | 直接是硬伤 |
| 4 | ~~todo 状态不持久化~~ **已修**（2026-10-16） | 事件追加 `data/loom-store/todos/*.jsonl`，跨进程回放已验证 | 独立 todo 日志文件 ≠ DSH 的单一日志，形态差异已在层5 记 |
| 5 | **远端停在 9-09** | 10 月改造零推送 | 「代码呢？」 |
| 6 | ~~Plan 无 retry~~ 已补（依赖分批 + 重试 + 上游下沉 + 模型拆步）；**仍无择优 / 无失败重规划** | `runPlanScheduler` + `topoBatches`；`planner.ts` 一次 `generateText` 出清单，模型不给就回落预设 | 「编排器」这个词现在只欠「长歪了能改」（Replanner）与「多拆几次挑好的」 |
| 7 | ~~`zod` 列了依赖但零 import~~ **已删**（2026-10-16） | `packages/core/package.json` 不再声明；`ai` 的 peer 仍会把它装进 `node_modules` | 追问「参数校验呢」时直说：工具 schema 是 JSON Schema 字面量，没有二次校验 |
| 8 | `toolNameOf` 已修但同类回查仍脆 | 靠 `tool-input-start` 建 id→name 表 | 边界场景可能拿到空名 |
| 9 | `CHARS_PER_TOKEN = 4` 对 CJK 严重低估 | 沿用 DSH 启发式 | DSH 自己都在 README 里承认这点 |
| 10 | mock 摘要走 `doGenerate` | 已给 mock 补上非流式路径 | 换模型时注意实现对称 |
| 11 | 层5 曾无离线演示入口 | 已补 `todo_focus` 真调 + 分派优先级（见上） | 已修，单测 25/26 锁住 |
| 12 | mock 曾「说了但没做」 | 已补 `has()` 守卫 + 审计脚本（见下） | 已修，单测 27/28/29 + 审计锁住 |
| 13 | ~~没有后台 job~~ **已补**（2026-10-16） | `run_safe_cmd` 传 `background:true`（批准后）立刻拿 `jobId`，`job_list` / `job_output` / `job_kill` 三个工具；单例挂 `globalThis`，否则 Next 各 route 各编译一份模块、列表永远是空的 | 追问「长命令怎么办」时直说：句柄只在进程内存里，重启即失效，故意不假装持久 |

### 补记（同日二次收口）：层5 此前没有离线演示入口

自测时发现一个自己造的坑：`todo_write` 在 `run.ts` 里按 `input.todo`
条件注入，而 `todo_focus` 剧本**只读 TODO.md、从不调 `todo_write`**，
于是「离线能不能看见 todo 投影」这条根本验不了 —— 能力存在，但演示路径不通。

另一处更隐蔽：`resolveMockScenario` 里 `auditor` 的 `/TODO/i` 分支
排在 `todo_focus` 分支**之前**，goal 写「看看 TODO.md 里的待办清单」会被
先截走判成 `grep_audit`。两个 bug 叠在一起，症状就是「待办功能好像没做」。

修法与证据：

- `mock.ts` 的 `todo_focus` 现在真调一次整表替换（1 完成 / 1 进行中 / 1 待办）。
- `run.ts` 把显式待办措辞（`TODO.md` / `待办清单`）提到 auditor 分支之前；
  「审计一下 TODO」仍走 `grep_audit`，不抢口径。
- 单测 25 锁分派优先级，单测 26 锁「离线 mock 真调 todo_write」。
- HTTP 面实测：`POST /api/run` → `tool_call todo_write` →
  `Updated todo list: 1 pending, 1 in progress, 1 completed.`，4 步 usage。

**教训**：一个能力「写完了」和「能被演示出来」是两件事。
单测只证明前者；离线场景覆盖不到的能力，用户第一次点开就会以为没做。

### 补记（同日三次收口）：mock 会「说了但没做」——假动作是一类 bug，不是一个 bug

拿真实 HTTP 面复核自测步骤时抓到的：`guide` 问「帮我列一下待办清单」，
**回答声称「并写入 todo 列表」，可 `tool_call` 序列里根本没有 `todo_write`**。

根因是两层叠加：

1. `todo_write` 比别的工具多一道门槛 —— 它按 `RunLoopInput.todo.sessionId`
   条件注入。请求没带 `sessionId` 时它压根不在工具集里。
2. mock 的 `call()` 在工具没注入时**静默返回 null** 被丢掉，而 `final` 结论文案
   却写死了「已写入 todo 列表」。

于是剧本演了一出「嘴上说了、手上没做」。这和当初把 `list_agents` 当成委派工具
（事件流里出现 2 次 `tool_call list_agents` 而 `subagent_start: 0`）是**同一类问题**：
工具没真调，但叙事把它当成做过了。

同一轮审计还扫出第二处：`workflow_code` 分支声称「已提出 notes/... 待批准」，
但它排上的 `write_file` 同样没有 `has()` 守卫。而路由事实是：带 `write_file`
的 Agent 说「动手改码」会先进 `write_hitl`（那一支**有**守卫），能落到
`workflow_code` 的恰好都是不带 `write_file` 的 Agent —— 所以那句声称**永远**是假的。

修法与证据：

- `mock.ts` 的 `todo_focus`：按 `has("todo_write")` 分叉，没注入时如实说
  「本次没有会话归属（未传 sessionId），todo_write 未注入，因此没有写入待办列表」。
- `mock.ts` 的 `workflow_code`：`proposedWrite = scenario === "workflow_code" && has("write_file")`，
  写提案没排上就不说「已提出待批准」。
- 单测 27/28/29 锁住三条：没 sessionId 不许声称写 todo、`workflow_code` 不许声称写入、
  readOnly 摘掉 `write_file` 后 `write_hitl` 也不许声称。
- HTTP 面复测（`/api/run`，同一条 goal）：传 `sessionId` → `["read_file","grep_files","todo_write"]`
  且声称与实际一致 ✅；**不传** → `["read_file","grep_files"]`，回答不再声称 ✅。

**教训（比上一条更硬）**：mock 是给人看的**证据**，不是给人看的**表演**。
剧本里的每一句「我做了 X」，都必须由一次真实的工具调用背书 ——
`call()` 会静默丢弃，所以每一处「说了」旁边都得有 `has()` 在把关。

这条已经变成审计脚本 [`scripts/probes/audit-mock-claims.mjs`](../scripts/probes/audit-mock-claims.mjs)：
扫所有 case，挑出「有 `call()`、有动作声称、却没有任何缺失工具分支」的那些。
当前的 6 个守卫星覆盖了 20 个 case，输出 `✅ 未发现`。

脚本本身也做了非空壳证明：对一份故意去掉守卫的 fixture 跑，必须 exit 1；对真文件 exit 0。
（不做这步的话，一个永远返回 0 的空壳也会显得「全绿」。）

### 关于「按需加载 Skills 省 token」

**不做，且有实测依据**：7 个内置 skill 正文合计 3193 字符，
全量注入 vs 按需加载的差值约等于一个来回的误差。省不出东西，
反而凭空多一套检索失败路径。这条老老实实写进文档，比假装做了强。

---

## 6. 下一步（P2，待你点头）

按性价比排：

1. **`git init` + 首次提交 + 建 LICENSE + 推远端**（0 代码，收益最大）
2. **加 GitHub Actions：`typecheck` + `test` 两条**（30 行 YAML）
3. ~~**todo 状态落盘**~~ **已做**（2026-10-16）：`packages/core/src/plan/todo-file.ts` 把事件追加进
   `data/loom-store/todos/<会话>.jsonl`（懒加载、只追加、写失败降级内存），`todo-dir.ts` 负责路径解析
   （`LOOM_TODO_DIR` > 仓库根 > cwd）；11 条单测 + `scripts/probes/todo-persist.mjs write|replay` 两进程实测
4. ~~**Plan Worker retry**~~ **已做**（依赖分批 + 重试 + 上游摘要下沉 + `chain` 预设，128 条单测锁住）；
   ~~**Planner LLM 动态拆步**~~ **也做了**（`planner.ts` 一次调用出带依赖的清单，解析不了回落预设，
   `scripts/probes/planner-live.mjs` 用真模型端到端验过）；剩下的是 **best-of-N 择优 + 失败重规划 + 同批并发上限**
5. ~~**`zod` 用起来或删掉**~~ **已删**（core 零 import，`ai` 的 peer 仍会装上它）
6. ~~**后台 job 通道**~~ **已做**（2026-10-16）：`run_safe_cmd` 传 `background:true`（批准后）立刻拿 `jobId`，
   `job_list` / `job_output` / `job_kill` 让模型边跑边读（输出按游标只给新增）；单例必须挂 `globalThis`——
   Next 每条 route 各编译一份模块，不挂就会出现「批准拿到了 jobId、列表却是空的」（http 探针先报的）；
   14 条单测真起真杀 + `scripts/probes/jobs.mjs` 11 条 + http 探针 8 条
---

## 7. 备份与回滚

改动前的原始文件在 `docs/_snapshot/` 下（按时间戳分目录），
`packages/core/dist` 的基线也留了一份用于逐场景比对事件流。
**没有 git 兜底**，所以这些快照就是唯一的后悔药——P2 第一件事应该就是把它变成 git。
