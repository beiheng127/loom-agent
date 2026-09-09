# Web 控制台 · Loom Studio

Next.js App Router 控制台，默认端口 **3010**。

## 启动

在仓库 `agent/` 根目录（需 Node ≥ 20）：

```bash
npm run studio
# 浏览器 http://localhost:3010
```

开发也可：

```bash
npm run build:core && npm run dev:web
```

## 界面结构

| 导航 | 内容 |
|------|------|
| Home | 概览主题页 / Demo / 功能说明 / 历史 |
| 任务 | 四步多步任务流水线 |
| Run | Composer（Ask/Agent）、Sessions、Explorer、Changeset |
| Plan | Plan Board 多 Worker |
| Agents / Skills / Models | 配置与选用 |
| 设置 | 外观主题 |

## 主要能力

- 无 API Key：离线 mock Demo 全流程  
- 有 Key / Ollama：真模型；Ollama 经 `/api/tags` 探测  
- 写文件与白名单命令均需 HITL；批准后可撤回  
- Skills 卡片 Markdown 渲染；删除类操作用自定义确认框  

## 相关文档

- 上手：[`../../docs/HANDOFF.md`](../../docs/HANDOFF.md)  
- 进度：[`../../docs/PROGRESS.md`](../../docs/PROGRESS.md)  
- 路线图：[`../../docs/ROADMAP.md`](../../docs/ROADMAP.md)  
