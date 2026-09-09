# Agent 项目 · 下一步优化（Desk + Loom）

> 更新：2026-07-27（晚）。目标：面试能讲清「做了什么 / 刻意不做 / 下一步为何」。

---

## 0. 一句话定位

| 项目 | 定位 | 继续做 | 明确少做 |
|------|------|--------|----------|
| **Aether Desk** | 本地知识工作台：笔记 RAG + HITL 写库 | 轻量部署故事 | Shell、批量改文件、编码 Diff |
| **Loom Agent** | 编码 Agent：FS + Diff HITL + Plan/Skills | 批量重命名、Plan 重试 | 强行合并 Desk UI、无沙箱任意 Shell |

共用叙事：**Tool Calling + HITL + 可观测时间线**。

---

## 1. Desk（摘要）

已落地：真 HITL（待办+存笔记）、Abort、导入导出、引用校验、`/eval`、health、**Fixture**、主页产品介绍 / 设置偏好、工具耗时瀑布、Hybrid env、`npm test`、`MIGRATE.md`。

下一刀：**轻量部署故事**（P2）。详见 `../aether-desk/docs/PROGRESS.md`。

---

## 2. Loom：已接通

| 工具 / 能力 | 状态 |
|-------------|------|
| FS + write HITL | ✅ |
| `fetch_url` / `web_search` / `run_safe_cmd` | ✅（搜索需 Key） |
| Desktop 一键 Studio | ✅ |
| Changeset 统计 + 全部撤回 | ✅ |
| Skills docs-then-patch / repo-hygiene | ✅ |
| Home 概览 / 确认弹窗 / MD 预览 | ✅ |

剩余主线：**批量重命名预览**；次要：Plan Worker 重试。

---

## 3. 跨项目原则

1. 写操作必 HITL  
2. 外发只读默认；无 Key 不造假  
3. 文档与代码同步（PROGRESS / ROADMAP / CAPABILITY-MAP / HANDOFF）  

---

## 4. 落地顺序（进度）

```text
Week 1–3  fetch_url / run_safe_cmd / Skills / HITL     ✅
Week 4    web_search + Desktop 一键 + Desk 主页/Fixture ✅
Done      Desk 单测 + migrate + Hybrid 可调 + 耗时瀑布  ✅
Next      Loom batch_rename；Desk 部署故事（P2）
```
