# Loom Agent · 开源对标调研

> 目标：做**自己的**本地桌面/控制台 Coding Agent，而不是再包一层 OpenClaw。  
> 调研日期：2026-07

---

## 对标项目一览

| 项目 | 形态 | 核心能力 | 可借鉴 | 我们不照搬 |
|------|------|----------|--------|------------|
| **Claude Code** | CLI/多端 | Agent loop、deny-first 权限、Skills/Hooks/MCP、子代理 | 权限分层、Skill 机制、上下文压缩思路 | 闭源、单厂商 |
| **Cline** | VS Code 扩展 | 模型无关、HITL、MCP、checkpoint | BYOK 多模型、审批 UX | 绑死 IDE |
| **Aider** | CLI | Git 优先、architect 模式 | 先计划后改码、repo map | 无桌面 UI、弱多 Agent |
| **OpenHands / SWE-Agent** | 容器沙箱 | 隔离执行 | 安全沙箱叙事 | 过重，校招难演示 |
| **OpenClaw 系桌面**（HermesClaw / KeAgent 等） | Electron 壳 | Gateway、Skills 市场、多频道 | 「控制台而非聊天框」产品感 | 依赖庞大 runtime，难讲清自研 |
| **Cursor** | IDE | 多 Agent / 规则 / Skills | 工作流体验 | 闭源商业 |

共性架构（几乎所有成熟 Agent）：

```
用户目标 → 组装上下文 → 模型调用 → 工具执行 → 观察 → 循环直到完成
扩展：Skills / MCP / Hooks
安全：deny-first 或 Git 回滚或容器隔离
```

---

## 功能点拆解（对标 → Loom 取舍）

| 能力 | 业界 | Loom MVP | Loom 下一阶段 |
|------|------|----------|----------------|
| 读项目文件 | ✅ 标配 | ✅ `list_dir` / `read_file` / `grep` | 语义索引 |
| 写文件 / 改码 | ✅ | ⚠️ 需 HITL | diff 预览 + 批准 |
| Shell | ✅ | ⚠️ 白名单命令 | 沙箱 |
| Skills | Claude/OpenClaw | ✅ `SKILL.md` 热加载 | 市场/导入 |
| 切换模型 | Cline/Aider | ✅ Provider Registry | 按任务路由 |
| 创建智能体 | OpenClaw/多 Agent | ✅ Agent Profile | 模板库 |
| 多模型多线程计划 | Claude subagent / ACP | ✅ **Plan Board（特异点）** | DAG 依赖、冲突合并 |
| MCP | 主流 | 延后 | P1 |
| 桌面壳 | Electron/Tauri | Web 控制台先跑通 | Electron 包装 |

---

## 技术选型建议

| 层 | 选择 | 理由 |
|----|------|------|
| 语言 | TypeScript | 与秋招前端叙事一致，和 Aether Desk 技能复用 |
| 运行时 | Node ≥ 20 | 本地工具 / fs |
| Agent 编排 | 自研 loop +（可选）Vercel AI SDK | 可控、可讲解；不绑死 LangGraph |
| 模型 | OpenAI 兼容（DeepSeek / OpenAI / Ollama） | BYOK，切换成本低 |
| Skills | 目录 + YAML frontmatter `SKILL.md` | 对齐业界，面试好讲 |
| UI 第一阶段 | Next.js 本地控制台 | 快；后续套 Electron |
| 持久化 | SQLite（计划/会话/Agent 配置） | 本地优先 |
| 打包第二阶段 | Electron 或 Tauri | 真「桌面项目」叙事 |

**不选**：一上来 fork OpenClaw —— 作品会变成「壳」，面试难讲你做了什么。

---

## 搞头评估（对你是否值得做）

| 维度 | 结论 |
|------|------|
| 秋招区分度 | **高**：Aether Desk=知识工作台 Agent；Loom=编码/文件 Agent + 多模型计划板，形成「双作品」 |
| 工作量风险 | 中高；必须砍范围，先 MVP |
| 与现有技能 | 高复用（SSE、工具可观测、HITL、Zustand） |
| 差异化空间 | **Plan Board 可视化多线程 + 自研 Skill 运行时**，不做 IM 频道大杂烩 |

**建议**：Loom 作为 **P0 主力新项目**；Aether Desk 做 P0 打磨（Abort/HITL）并行，不必再堆功能。
