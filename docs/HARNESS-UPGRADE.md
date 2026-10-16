# Loom Agent:从"插件壳"到"模型 + Harness"

> 2026-10-12。这份文档回答一个问题:**这个项目为什么不像 agent,以及怎么改才像。**
> 结论先行:框架是对的,地基是假的——工具调用是拿正则从自由文本里抠 JSON 抠出来的。

---

## 0. 一句话诊断

`loom-agent` 现在的形态是「**一个把大模型当文本生成器用的工作流工具**」。
它有 agent 需要的**外壳**(plan board、agent profile、skills、HITL diff、多模型),
但缺的是 harness 的**内脏**:

**模型发不出真正的工具调用,工具结果也回不到模型的原生协议里。**

这不是能力问题,是代码问题。

---

## 1. 体检:先看数字,别看形容词

### 1.1 工具调用是"伪"的

`packages/core/src/loop/run.ts` 里,模型和代码之间的约定是**自然语言**:

```ts
// run.ts:44-58
"当你需要调用工具时,只输出一行 JSON(不要 markdown):",
`{"tool":"<name>","args":{...}}`,
```

然后从**自由文本**里把 JSON 抠出来:

```ts
// run.ts:236-245
function parseAction(text: string): Action | null {
  const match = text.match(/\{[\s\S]*\}/);   // ← 从自由文本里正则抠
  if (!match) return null;
  try {
    return JSON.parse(match[0]) as Action;
  } catch {
    return null;
  }
}
```

工具结果是这样塞回去的:

```ts
// run.ts:174-177
messages.push({
  role: "user",
  content: `工具 ${toolName} 结果:\n${JSON.stringify(result, null, 2)}`,
});
```

这里缺的东西,数一遍:

| 真 harness 该有的 | 现在有吗 |
|---|---|
| 工具参数 JSON Schema | ❌ `ToolDefinition` 只有 `{name, description, requiresApproval, execute}` |
| 原生 `tool_calls` 协议 | ❌ 一行自然语言约定 |
| `tool_call_id` 对应关系 | ❌ 字符串散文拼回去 |
| `tool` 角色的消息 | ❌ 伪装成 `role:"user"` 的中文 |
| 多工具并行调用 | ❌ 一次只能出一个 JSON |
| 工具调用失败可修复 | ❌ 解析不出来就当最终答案 |

给模型看的工具清单(`tools/catalog.ts:64-71`)全文就这个:

```
- list_dir: 列出工作区某目录的文件与子目录
- read_file: 读取工作区文本文件内容(过大自动截断)
```

**没有参数说明。** 模型不靠猜还能怎么办。

### 1.2 真模型循环只占六分之一

`run.ts` 616 行。按顶层声明切块实测:

| 段落 | 行范围 | 行数 | 占比 |
|---|---|---|---|
| `runMockLoop` 硬编码剧本 | 246–601 | 356 | 57.8% |
| `resolveMockScenario` 正则猜意图 | 189–231 | 43 | 7.0% |
| `runAgentLoop` 内 mock 派发段 | 63–80 | 18 | 2.9% |
| `runAgentLoop` 真模型分支 | 82–187 | 106 | 17.2% |
| `parseAction` | 236–245 | 10 | 1.6% |
| `emitTextDeltas` 假打字机 | 602–617 | 16 | 2.6% |

**mock 相关合计 417 行,占 67.7%;真模型分支 106 行,占 17.2%。**

mock 还带点表演性质:

- `resolveMockScenario` 用 18 条中文正则猜你想干嘛(`/审计|TODO|密钥|grep/i → grep_audit`),对应 `MockScenario` 类型里的 24 个场景值;
- `fetch_url_stub` 直接返回**假数据**,不联网(`run.ts:337-365`:注释写着"离线不发起外网",返回 `example.com` 的 fixture 摘录);
- `emitTextDeltas` 把整段文本切 24 字一块、`sleep(8)` 假装打字机。

演示能跑,面试官一追问"你怎么保证模型真的调了工具"就露。

### 1.3 没有 harness 的任何一件内脏

全项目(排除 `node_modules`)grep `harness`: **0 命中**。

`types/index.ts` 的 `LoopEvent` 一共 8 个分支:
`phase / text_delta / text / tool_call / tool_result / approval_needed / done / error`。

缺:token 用量、成本、步数、压缩、TODO、子 agent、检查点、超时预算、重试。

`AgentProfile` 就 6 个字段:`{id, name, systemPrompt, allowedTools, defaultModelId, skillIds}`。
没有预算、没有步数上限、没有权限策略、没有沙箱级别。

历史管理是这一行:

```ts
// run.ts:83
for (const h of history.slice(-12)) { ... }
```

超出就砍头,不摘要、不记账。

### 1.4 没有一条测试

- 项目里 `*.test.ts` / `*.spec.ts`:**0 个**。
- `vitest` / `jest`:**未安装**。
- 但 `ai` 自带 `ai/test` 子导出(`MockLanguageModelV3`、`MockProviderV3`、`simulateReadableStream`、`mockValues`),**可以在零网络下把整个 loop 测穿**。

地基是假的、还没有测试——这两件事叠在一起,意味着现在的"agent"行为**不可回归**。

### 1.5 项目不在 git 里

`C:\Users\ruia3\Desktop\test` 这个仓库是坏的(`fatal: your current branch appears to be broken`),`agent/` 是未跟踪目录。

**改坏了没有 `git checkout` 兜底。** 改造期间必须自己留快照。

### 1.6 老实说:Skills 常驻不是问题

实测 7 个内置 Skill 正文合计 **2218 字符**(去掉 frontmatter),逐个体节:
`changelog-writer 284 / code-tour 275 / demo-readme 184 / docs-then-patch 396 / plan-split 304 / repo-hygiene 424 / secure-audit 351`。

6 个 agent 首轮 system prompt:

| agent | 自身提示 | 工具数 | 工具文本 | skill 正文 | 合计字符 | ≈tokens |
|---|---|---|---|---|---|---|
| editor | 112 | 7 | 322 | 864 | 1598 | 400 |
| hygienist | 65 | 5 | 191 | 775 | 1331 | 333 |
| reader | 76 | 5 | 225 | 459 | 1060 | 265 |
| planner | 57 | 3 | 120 | 488 | 965 | 241 |
| guide | 33 | 4 | 151 | 459 | 943 | 236 |
| auditor | 63 | 4 | 151 | 351 | 865 | 216 |

平均 1127 字符 ≈ 282 tokens(按 4 字符/token)。

**所以"改成按需加载能省 token"是站不住的**——2218 字符只是 555 tokens 的量级,省不出东西。Skills 目录化真正的收益是**能力可被发现**:模型知道自己还有哪些 skill 没加载,而不是只能干瞪眼。

这一点必须写进文档,不然就是拿假理由骗自己。

---

## 2. Harness 到底是什么(从 DSH 拆出来的)

我把本机 DeepSeek Harness 的 `app.asar` 解包,翻了里面约 250 个 `@deepseek-ai/dsh-*` 包。关于 agent 运行的关键结论只有一条:

**`dsh-agent-loop` 本体不写死工具协议、不写死压缩、不写死计量。这些全是外挂插件。**

| 部件 | 包 | 机制 |
|---|---|---|
| 工具协议 | `dsh-tools` | 每个工具带 `inputSchema`,派发走 `tools/execute` 钩子 |
| 上下文压缩 | `dsh-compaction-basic` | `THRESHOLD_RATIO=0.8`、`RETAIN_RATIO=0.16`,`thresholdTokens=min(contextWindow*0.8, budget)`,保留尾部 `retainTokens`,约束 `retainTokens < thresholdTokens` |
| token 计量 | `dsh-token-meter` | `CHARS_PER_TOKEN=4`、`BLOCK_OVERHEAD=4`;用量按 `sessionSeq` 走 `addReplacing`(同 seq 替换不累加) |
| 持久化检查点 | `dsh-session-checkpoint-policy` | 钩 `llm/stream`、`tools/execute`、`agent/pre-step` 三个边界,**先 `sessions.flush()` 再放行**;flush 失败 fail-closed,工具不执行 |
| TODO | `dsh-tool-todo` | zod4 schema,三态 `pending/in_progress/completed`,`additionalProperties:false`,重复 content 直接抛错;每次调用 append 一条快照,replay 用 last-write-wins |
| Skills | `dsh-skill` + `dsh-tool-skill` | 只注入**目录**(name + 上限 500 字的描述),模型按精确名 load 正文;目录靠条目 digest 做差 |
| 子 agent | `dsh-subagent`、`dsh-tool-subagent` | 独立上下文跑子 loop,只把摘要回主线程 |

翻译成一句话:**harness 是一圈围着模型转的插件,每件负责一件事,互相通过事件总线协作。**

Loom 现在把这一圈全塞进了 `run.ts` 一个文件,还塞歪了。

---

## 3. 差距表

| harness 部件 | Loom 现状 | 差在哪 |
|---|---|---|
| 原生工具协议 | 自然语言约定 + 正则抠 JSON | **根本性缺失,P0** |
| 工具参数 schema | 无 | 模型看不到参数结构 |
| token 计量 | 无 | 不知道花了多少、还剩多少 |
| 上下文压缩 | `slice(-12)` 砍头 | 无摘要、无比例触发 |
| Skills 目录/按需 | 全量常驻 system | 能力不可发现 |
| TODO 面板 | 无 | 多步任务无可视进度 |
| 会话持久化 | 整文件覆盖 JSON | 无 append 日志、无断点恢复、无检查点 |
| 子 agent | 无 | 上下文无法隔离 |
| Plan | `Promise.all` 扇出 | 无 DAG、无重试、失败信息被吞 |
| 测试 | 0 | 不可回归 |
| Agent profile | 6 字段 | 无预算/步数/权限 |

关键补充:`ai` 包实际版本 **6.0.230**,`dist/index.d.ts` 里这些都导出了:

`tool` / `jsonSchema` / `dynamicTool` / `zodSchema` / `asSchema` / `stepCountIs(n)` / `hasToolCall(name)` / `stopWhen` / `prepareStep` / `fullStream` / `totalUsage` / `onStepFinish` / `needsApproval` / `experimental_toolApprovalSecret`,
`TextStreamPart` 里 `tool-input-start`/`tool-input-delta`/`tool-call`/`tool-result` 齐活。

**所以根因不是"SDK 不支持",是"代码没用"。** 这句话是整份方案的支点。

---

## 4. 七层改造

原则:**层与层可独立验收,每层都能单独跑 demo。**

### 层 1 · 真工具协议(地基,P0)

改三个文件:

**`types/index.ts`**
```ts
export type ToolDefinition = {
  name: ToolName;
  description: string;
  requiresApproval: boolean;
  inputSchema: JSONSchema7;      // 新增
  execute(args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult>;
};
```

**`tools/catalog.ts`** — 给 7 个工具补参数 schema。举例:

| 工具 | 参数 |
|---|---|
| `list_dir` | `{ path?: string }` |
| `read_file` | `{ path: string, maxChars?: number }` |
| `grep_files` | `{ pattern: string, glob?: string }` |
| `write_file` | `{ path: string, content: string }` |
| `fetch_url` | `{ url: string }` |
| `web_search` | `{ query: string }` |
| `run_safe_cmd` | `{ command: string }` |

`formatToolsForPrompt` **删掉**——有了原生协议就不需要把工具塞进 system prompt 文本了。

**`loop/run.ts`** — 核心置换:

```ts
const stream = streamText({
  model: languageModel,
  tools: toAISDKTools(tools),           // 原生工具集
  stopWhen: stepCountIs(maxSteps),      // 循环交给 SDK
  system,
  messages,
  abortSignal: signal,
  onStepFinish: ({ usage, stepType }) => emitUsage(usage),
});
```

`parseAction` **删除**。`fullStream` 映射到现有 `LoopEvent`:

| fullStream part | → LoopEvent |
|---|---|
| `text-delta` | `text_delta` |
| `tool-call` | `tool_call` |
| `tool-result` | `tool_result` |
| `tool-input-delta` | (新)`tool_input_delta` |
| `finish` | `done` |

**UI 不用改**:`LoomShell.tsx` 消费的事件名一个不动。

### 层 2 · 计量与预算(dsh-token-meter)

`LoopEvent` 加一支:

```ts
| { type: "usage"; step: number; inputTokens: number; outputTokens: number;
    cacheReadTokens: number; pressureTokens: number; contextWindow?: number }
```

估算用 `CHARS_PER_TOKEN = 4`(和 DSH 同源),真值优先取 `onStepFinish` 的 `usage`。
`RunLoopInput` 加 `budget?: { maxSteps?: number; maxTokens?: number }`。

### 层 3 · 上下文压缩(dsh-compaction-basic)

常量照抄,别自己发明:

```ts
const THRESHOLD_RATIO = 0.8;
const RETAIN_RATIO = 0.16;
```

超阈值时把头部消息摘要成一条,保留尾部。替换掉 `history.slice(-12)`。
摘要失败时**降级为砍头并记事件**,不能静默。

### 层 4 · Skills 目录化(dsh-skill / dsh-tool-skill)

- `loader.ts` 加 `toSkillCatalog(skills, maxDescLen = 500)`,产出只含 name + 截断描述的目录;
- 新增第 8 个工具 `skill`,模型按精确名加载正文,返回固定的 `<skill_content>` 结构;
- 保持兼容:`agent.skillIds` 里显式勾选的仍然全量注入,其余进目录等按需加载。

如上所述,**这一层的理由是"可发现",不是"省 token"。**

### 层 5 · TODO + 会话检查点(dsh-tool-todo / dsh-session-checkpoint-policy)

- 新增第 9 个工具 `todo`,zod4 定义,三态,`additionalProperties:false`,content 去空格 + 去重(重复直接抛 `invalid todos: duplicate content`),非并行时最多一个 `in_progress`;
- `sessions/store.ts` 从"整文件覆盖 UI 消息"升级为 **append-only JSONL 事件日志**(`sessions/<id>.jsonl`);
- 检查点:每次发 LLM 请求前、每次顶层工具派发前 `flush`,**失败 fail-closed**(宁可不执行,不产生"模型以为写了、日志里没有"的状态)。

### 层 6 · 子 agent + Plan 升级

- 新增第 10 个工具 `subagent`:进程内起一个隔离上下文子 loop,只回摘要;
- `plan/orchestrator.ts`:`PlanWorkerDef` 加 `blockedBy?: string[]` 做 DAG,加 `retries?: number`,失败不再被 `失败：${error}` 一句话吞掉——保留 `error`、`attempts`、`lastError`。

### 层 7 · 测试(node:test + ai/test)

不引新依赖:`node:test` 是内置的,`ai/test` 已经在包里。

用 `MockLanguageModelV3` 造"模型先调工具、再给答案"的流,把整条 loop 测穿:

1. 工具协议走通(收到 `tool_call`、发回 `tool-result`、`role:"tool"` 正确)
2. 工具参数非法时被 schema 挡住
3. 压缩在阈值触发、保留尾部
4. `todo` 重复 content 抛错、非并行多 `in_progress` 抛错
5. 检查点 flush 失败 → 工具不执行(fail-closed)
6. 写入类工具仍走审批队列,不落盘

目标:**0 → ≥12 个 case 全绿。**

---

## 5. 不做什么(说清楚,免得被问)

| 不做 | 为什么 |
|---|---|
| 引入 Anthropic SDK / 新 provider 抽象 | DeepSeek / OpenAI / Ollama 都走 OpenAI 兼容协议,够用;加抽象是空转 |
| 删掉 mock 路径 | 面试 demo 必须离线能跑。但 mock 要从"417 行正则剧本"降级为"MockLanguageModel 驱动同一套真 loop" |
| 改成真沙箱 / 容器隔离 | 现有 `resolveInWorkspace` 路径越界防护够用,重做是另一个项目 |
| 全量重写 UI | `LoomShell.tsx` 3309 行,事件名保持兼容就不用动 |
| 押注"按需加载省 token" | 实测 skill 正文 2218 字符,省不出东西(见 1.6) |

---

## 6. 分期与验收

| 期 | 内容 | 可测验收 |
|---|---|---|
| **P0** | 层 1 + 层 2 + 层 7 | `grep -c "inputSchema\|tool_call_id"` 从 0 → >0;`parseAction` 删除;`run.ts` mock 占比 67.7% → <20%;单测 0 → ≥12 全绿 |
| **P1** | 层 3 + 层 4 + 层 5 的 todo | 长会话触发压缩(断言保留尾部 token 数);模型可 load 未预选 skill;todo 面板出状态 |
| **P2** | 层 5 的 JSONL 检查点 + 层 6 | 杀进程后可从 JSONL 恢复;Plan 带 DAG 与重试;子 agent 上下文隔离(断言主线程消息数不增长) |

每期结束都要满足:**`node packages/core/dist/demo.js` 仍然离线跑通。**

---

## 7. 两个必须先解决的事

1. **写权限。** 本项目在 `C:\Users\ruia3\Desktop\test\agent`,当前会话沙箱是 workspace-write,只允许写 `C:\Users\ruia3\Documents\deepseek-harness\default-workspace`。实测往项目里写探针文件被拒(`访问被拒绝`)。**落地代码前需要把该项目路径加入可写范围,或把项目移进工作区。**
2. **没有 git 兜底。** 改之前先在项目内留一份快照(哪怕只是 `docs/_snapshot/` 里存关键文件副本),别指望 `git checkout`。

---

## 8. 一句话收束

Loom 的外壳(Plan Board / Agent Profile / HITL Diff / Skills)其实是有想法的,
**问题是底下那台"模型 ↔ 工具"的发动机是纸做的**。

把层 1 做完,这个项目就从"插件壳"变成"能用原生工具协议的 agent";
层 2–7 是让它长成 harness。

---

## 9. P0 收尾:实测前后对比

> 2026-10-12。层 1 + 层 2 + 层 7 已落地。以下每个数字都是跑出来的,不是估的。

### 9.1 验收表

| 指标 | 改前 | 改后 | 命令 |
|---|---|---|---|
| `inputSchema` 命中数 | **0** | **11** | `grep -rn "inputSchema\|tool_call_id" packages/core/src` |
| 伪协议残留(`parseAction` 等) | **10 处** | **0 处**(仅剩 mock.ts:19 一句注释) | `grep -rn "parseAction\|formatToolsForPrompt\|runMockLoop\|emitTextDeltas"` |
| `parseAction` 函数 | 存在(:236) | **已删** | — |
| `formatToolsForPrompt` | 存在(catalog.ts:64) | **已删** | — |
| `run.ts` 总行数 | 616 | **403** | — |
| `run.ts` 里 mock-only 代码占比 | **69.5%**(189–616 行) | **11.2%**(359–403 行,只剩 scenario 正则分派表) | — |
| mock 循环 | 自建 `runMockLoop` 368 行 | **`mock.ts` 625 行,但是个 `LanguageModelV3`** | — |
| 单测 | **0** | **24 条全绿** | `npm test` |
| typecheck | — | **0 错** | `tsc --noEmit` |
| 离线 demo | 通 | **通**(`DEMO=0`) | `node packages/core/dist/demo.js` |
| Web 端 typecheck | — | **0 错** | `tsc -p apps/web/tsconfig.json --noEmit` |
| lockfile 与 package.json 同步 | — | **同步**(`npm ci` 通过) | `npm ci` |

### 9.2 关键结构变化

**改前**:模型吐自由文本 → `parseAction` 正则抠 JSON → 手工 `execute` → 手工拼字符串塞回 messages → 再问一次。
**改后**:`streamText({ model, tools, stopWhen: stepCountIs(n) })` → SDK 自己跑 ReAct 循环 → 工具结果按 `role:"tool"` 原生协议回灌。**循环控制权交还给 SDK,这是"从插件壳到 harness"的分界线。**

mock 不再是第二套循环,而是**换一个照剧本演的 `LanguageModelV3`**(provider `loom-mock`),由同一条真路径驱动。
→ 副产品:**"mock 能跑通"现在等价于"工具协议本身没问题"**,这个测试价值比原来 368 行 mock 循环高得多。

### 9.3 事件协议增量(UI 零改动)

`LoopEvent` 新增 2 支,原有 8 支**事件名一字未动**,`LoomShell.tsx` 不需要改:

| 新事件 | 载荷 | 用途 |
|---|---|---|
| `tool_input_delta` | `{ name, delta }` | 工具参数流式打字机效果 |
| `usage` | `{ usage: StepUsage, budget? }` | 每步 token 计量 |

`done` 从 `{ text }` 扩展为 `{ text, usage? }`(向后兼容)。`StepUsage` = `{ step, inputTokens, outputTokens, totalTokens, cacheReadTokens, cacheWriteTokens, pressureTokens, measured }`。
`RunLoopInput` 新增 `budget?: { maxSteps?, maxTokens? }`,**超预算会 abort 并发 error**。

### 9.4 两处必须记下的坑

**坑一:方案文档写错了工具字段名。**
方案文档 §4 层 1 写的 `grep_files` 参数是 `{ pattern, glob }`——**错的**。实现里读的是 `args.query`(fs.ts:62),照文档抄会把现有 mock 路径全部弄坏。**已按真字段名 `{ query, path? }` 落 schema。**
教训:补 schema 时以实现为准,不以设计文档为准。

**坑二:`@ai-sdk/provider` 需要直接声明,且 lockfile 没自动跟上。**
`LanguageModelV3` / `LanguageModelV3StreamPart` / `LanguageModelV3Usage` 这些 V3 原生类型**不在 `ai` 的 export 里**(`ai` 只 re-export 了 `LanguageModel` 这类联合类型),必须从 `@ai-sdk/provider` 取。
它在 node_modules 里本来就存在(是 `ai` 的传递依赖),所以"能跑"——但**不能靠传递依赖**,已在 `packages/core/package.json` 显式声明 `"@ai-sdk/provider": "^3.0.14"`。
显式声明之后 `package-lock.json` **没有自动更新**(`npm ci` 会报 lock 不同步),已跑 `npm install --package-lock-only` 补齐并复验 `npm ci` 通过。改前的 lock 备份在 `docs/_snapshot/p0-20261012-175657/package-lock.json.before`。

### 9.5 单测 24 条覆盖

| # | 覆盖点 |
|---|---|
| 1–4 | schema 合法性、`grep_files` 字段名、`formatToolsForPrompt` 已删、工具白名单 |
| 5–7 | `tool_call`/`tool_result` 成对、args 是对象、`tool_input_delta` 有分片 |
| 8–11 | usage 字段完整、`measured=true`、done 带 usage 数组、注入模型的 usage 被采纳 |
| 12–14 | 超 `maxTokens` 报"超预算"、`maxSteps` 兜底恰好 3 步、不传 `stopWhen` 时 SDK 默认单步(对照组) |
| 15–18 | mock 产 tool_call/usage、write→审批、cmd→审批、multi_write 两条审批 |
| 19–21 | readOnly 摘掉写工具且文件未被写、9 个关键 scenario 分派、fetch_url 走离线桩 |
| 22–24 | 未知工具不崩、execute 抛错转 `tool_result(ok:false)` 不中断、`estimateTokens` 4 字符≈1 token |

### 9.6 备份

改前 8 个文件的原件在 `docs/_snapshot/p0-20261012-175657/`(文件名把 `\` 换成 `__`),
改前编译产物在 `docs/_snapshot/dist-baseline/`。**没有 git,这是唯一的兜底。**

---

## 10. 下一步(P1,待批准)

层 3(上下文压缩:`THRESHOLD_RATIO=0.8` / `RETAIN_RATIO=0.16` 替换 `history.slice(-12)`)、
层 4(Skills 目录化 + 第 8 个工具 `skill`)、层 5 的 todo 工具。

**P1 不动手,等你说开始。**
