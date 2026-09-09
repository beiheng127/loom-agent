# Loom Agent · 进度与任务清单

> 更新：2026-07-27（下午）  
> 关联：[`ROADMAP.md`](./ROADMAP.md) · [`CAPABILITY-MAP.md`](./CAPABILITY-MAP.md) · [`HANDOFF.md`](./HANDOFF.md)

---

## 当前状态（一句话）

**可演示的本地 Coding Agent Studio**：Home 概览 + 四步任务 + Composer Diff HITL（单次/全部撤回）+ Plan 并行 + Skills/Agents；`web_search` 已接通（需 Key）；Desktop 可一键拉起 Studio。

---

## 完成度总览

| 模块 | 完成度 | 说明 |
|------|--------|------|
| Home / 上手 | ✅ ~95% | 概览落地页、Demo、功能说明、历史 CRUD |
| 多步任务 | ✅ ~90% | 四步流水线、回写、确认 |
| Composer Run | ✅ ~90% | Ask/Agent、Sessions、@文件、SSE |
| Diff / 命令 HITL | ✅ ~95% | 统计、单次/全部撤回 |
| Plan Board | ✅ ~85% | 多预设、历史 |
| Agents / Skills | ✅ ~90% | 含 docs-then-patch / repo-hygiene |
| Models / 联网 | ✅ ~92% | Ollama 探测；`web_search` live（需 Key） |
| Desktop | ✅ ~85% | 检测 :3010，否则自动 `studio` |
| 批量重命名 | ❌ 0% | Sprint B 剩余 |
| Plan Worker 重试 | ❌ 0% | 待做 |

---

## 本轮增量（已合入文档）

- [x] `web_search`（Tavily / SerpAPI；无 Key 诚实失败）  
- [x] Desktop 一键拉起 Studio（`LOOM_AUTO_STUDIO`）  
- [x] Changeset **全部撤回**  
- [x] Home 概览 / 确认弹窗 / Markdown 预览  
- [x] CAPABILITY-MAP / OPTIMIZATION-NEXT / RESUME 与代码对齐  

并行：Aether Desk 主页 / Fixture / 单测 / Hybrid 可调（见 `../aether-desk/docs/`）。

---

## 后续功能

| # | 项 | 状态 |
|---|----|------|
| 1 | 批量重命名预览 + 批准 | 待做 |
| 2 | Plan Worker 失败重试 | 待做 |
| 3 | Skill 标签筛选商店式目录 | 待做 |
| 4 | 演示录像 / 一键剧本 | 待做 |

---

## 验收

```bash
cd agent && npm run studio          # :3010
# 或 npm run desktop                # 自动起 Studio
# Models：web_search 有 Key 显示 live
# Accept 多个文件后点「全部撤回」
```
