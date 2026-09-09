# Loom Agent

[![Node](https://img.shields.io/badge/Node-%E2%89%A520.18-339933?logo=nodedotjs&logoColor=white)](https://nodejs.org)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.x-3178C6?logo=typescript&logoColor=white)](https://www.typescriptlang.org)
[![Next.js](https://img.shields.io/badge/Next.js-15-black?logo=nextdotjs&logoColor=white)](https://nextjs.org)
[![Electron](https://img.shields.io/badge/Electron-Desktop-47848F?logo=electron&logoColor=white)](https://www.electronjs.org)
[![License](https://img.shields.io/badge/License-MIT-blue)]()

本地优先的 **Coding Agent Studio** —— 织机式 Plan Board：多智能体 × 多模型 × 并行线程。

一句话介绍：在一个 IDE 风格的工作台里，给任务派多个 AI Worker 并行读改你的代码库；所有写文件操作先出 Diff、你确认后才落盘，随时可撤回。**没有 API Key 也能完整跑通离线 Demo**，配置 Key 后无缝切换真模型（DeepSeek / OpenAI / 本地 Ollama）。

> 设计 [`docs/DESIGN.md`](./docs/DESIGN.md) · 上手 [`docs/HANDOFF.md`](./docs/HANDOFF.md) · 进度 [`docs/PROGRESS.md`](./docs/PROGRESS.md) · 路线图 [`docs/ROADMAP.md`](./docs/ROADMAP.md) · 简历条目 [`docs/RESUME.md`](./docs/RESUME.md)

## 核心特性

### 🧵 Plan Board：并行 Worker 织任务
- 同质 Plan（多个 Worker 干同一类活取最优）、异构 Plan（不同角色分工协作）、三线程并行、自定义 Worker 均支持
- 多步任务四阶段推进：**摸清 → 拟定 → 改码 → 核对**，结果回写、逐步确认
- Plan 与会话全部本地持久化（JSON 存储），历史可查可删

### ✍️ Composer：Ask / Agent 双模式
- Ask 模式问代码，Agent 模式改代码；`@` 引用工作区文件
- SSE 流式输出；**写文件先 Diff 预览，命令执行走白名单审批（HITL）**
- 变更集统计、单次撤回 / 全部撤回，误操作有后悔药

### 🤖 Agent 工厂 + Skills
- 内置 Agent 模板 + 自定义 Agent（可绑定工具集与 Skill）
- 内置 Skills：`docs-then-patch`（查文档再改码）、`repo-hygiene`（仓库卫生）、`plan-split`、`secure-audit` 等，支持新建 / 编辑 / 导入

### 🔧 工具与模型
- 工具：`list_dir` / `read_file` / `grep_files` / `write_file` / `fetch_url` / `web_search` / `run_safe_cmd`（白名单 + 超时控制）
- 模型注册表：mock（离线）· DeepSeek · OpenAI · Ollama（实时探测本地模型）
- BYOK（Bring Your Own Key）：Key 只存本地 `.env`，不上传任何服务

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
│   ├── src/loop/         #   Agent 执行循环
│   ├── src/plan/         #   Plan 编排器（并行 Worker 调度）
│   ├── src/tools/        #   工具集：fs / cmd / web / planned（写审批）
│   ├── src/diff/         #   unified diff 生成
│   ├── src/agents/       #   Agent 工厂：profiles / templates / store
│   ├── src/skills/       #   Skill 加载与存储
│   ├── src/models/       #   模型注册表：mock / deepseek / openai / ollama
│   └── skills/           #   内置 SKILL.md 定义
├── apps/web/             # Next.js 15：Studio Web 界面（SSE + API routes）
└── apps/desktop/         # Electron 桌面壳
```

**安全设计**：写文件永远先产出 Diff 进入待审批状态，用户确认才落盘；命令执行走白名单前缀校验 + 超时熔断；API Key 仅存本地环境变量。

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

## 技术栈

TypeScript · Node.js ≥ 20 · Next.js 15 (App Router, SSE) · React · Electron · npm workspaces · Vercel AI SDK · JSON 本地持久化

## 下一步

见 [`docs/ROADMAP.md`](./docs/ROADMAP.md) 与 [`docs/PROGRESS.md`](./docs/PROGRESS.md)：批量重命名、更多 Skill 模板等。
