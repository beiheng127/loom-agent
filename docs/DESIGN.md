# Loom Agent · 产品设计与独特卖点

## 一句话

**Loom Agent**：本地优先的「织机式」Coding Agent 控制台 —— 把任务织成计划板，用**多个智能体 × 多个模型 × 并行线程**执行，Skills 可插拔，文件工具默认安全。

名字取自 loom（织布机）：计划是经线，Worker 是纬线。

---

## 独特设计点（相对 Cline / Aider / OpenClaw 壳）

1. **Plan Board 一等公民**  
   不是聊天里藏计划，而是独立面板：节点状态（pending/running/done/failed）、绑定的 Agent、模型、耗时，可点开看线程日志。

2. **Agent Profile 工厂**  
   用户可创建智能体：`systemPrompt` + `allowedTools` + `defaultModel` + `skills[]`。例如「只读审计员」「带 HITL 的改码工」。

3. **多模型并行，不共享一个上下文糊弄**  
   Planner（可用强模型）拆任务 → Worker 线程各自带独立消息窗口与模型（可用便宜/本地模型）→ Merger 汇总。这是简历可讲的架构点。

4. **Skills = 可版本化的能力包**  
   `skills/<id>/SKILL.md`，运行时注入 system 片段 + 可选工具扩展；热加载，不重启。

5. **Deny-first 工作区沙箱**  
   所有 fs 操作限制在 `workspaceRoot` 内；写操作默认需批准（MVP 可先 mock 审批队列）。

6. **与 Aether Desk 双作品叙事**  
   Desk = 知识/HITL/RAG 工作台；Loom = 编码 Agent / 多线程计划。不重复造聊天壳。

---

## MVP 范围（现在就做）

- [x] 核心包：`@loom/core`（loop / tools / skills / models / plan）
- [x] CLI：`loom run` 单线程任务；`loom plan` 多线程演示
- [x] 示例 Skill：`demo-readme`
- [x] 文档：调研 + 设计 + 路线图 + Handoff
- [x] Web Studio（IDE 风，非 Desk 四栏）
- [x] Electron 包装（打开文件夹）
- [x] Agent 设置 + 模型就绪面板 + Mock HITL / 异构 Plan

---

## 架构图

```
┌─────────────────────────────────────────────────┐
│  UI（Web / 未来 Electron）                       │
│  Chat · Plan Board · Agents · Skills · Settings │
└─────────────────────┬───────────────────────────┘
                      │ IPC / HTTP
┌─────────────────────▼───────────────────────────┐
│  Orchestrator                                    │
│  - Planner → Plan DAG                            │
│  - Worker Pool（并行，每线程独立 model+agent）    │
│  - Merger                                        │
└───────┬─────────────────────────────┬───────────┘
        │                             │
   AgentRuntime                  SkillLoader
   (ReAct loop)                  (SKILL.md)
        │
   ToolRouter → fs / grep / fetch_url / run_safe_cmd
        │
   ModelRegistry → deepseek / openai / ollama（可探测）
```

---

## 安全原则

| 操作 | MVP |
|------|-----|
| 读文件 / 列目录 / 搜索 | 自动，路径必须在 workspace 内 |
| 写文件 | `requiresApproval: true`，进审批队列；可撤回 |
| Shell | 仅白名单 `run_safe_cmd` + HITL（非任意 Shell） |
| 网络 | `fetch_url` 只读（禁内网/禁重定向）；`web_search`（Tavily/Serp，需 Key） |

---

## 和「搞头」的关系

值得做，前提是：

1. **4 周内**能演示：读仓库 + Skill + 切换模型 + 双线程计划板（CLI 或 Web 其一）  
2. 简历写清「自研 runtime + Plan Board」，不要写「集成了 OpenClaw」  
3. Aether Desk 保持可演示状态，Loom 作为第二主作品加深 Agent 叙事  

详见 [`ROADMAP.md`](./ROADMAP.md)、[`RESEARCH.md`](./RESEARCH.md)。
