# Loom Agent · 路线图

> 更新：2026-07-27  
> 能力关联详见 [`CAPABILITY-MAP.md`](./CAPABILITY-MAP.md)  
> **进度快照**：[`PROGRESS.md`](./PROGRESS.md)  
> **下一步优化总览**（Desk+Loom）：[`OPTIMIZATION-NEXT.md`](./OPTIMIZATION-NEXT.md)

---

## 已具备

| 能力 | 状态 |
|------|------|
| Composer Ask / Agent / Plan | ✅ |
| Explorer、@ 文件、Diff 确认写文件 | ✅ |
| Changeset 统计（文件数 / +/-）+ 已批撤回 | ✅ 2026-07-27 |
| SSE（含 token 增量） | ✅ |
| Sessions / Plans 本地保存（含删除） | ✅ |
| Skills 新建 / 编辑 / 导入 / 删除自定义 | ✅ |
| Skills：`docs-then-patch` / `repo-hygiene` | ✅ 2026-07-27 |
| Plan 多 Worker；可配云端模型 | ✅ |
| Electron 打开文件夹 | ✅ |
| `fetch_url`（禁内网/禁重定向） | ✅ |
| `web_search`（Tavily / SerpAPI） | ✅ 2026-07-27 · 无 Key 不可用 |
| `run_safe_cmd`（git 白名单 + HITL） | ✅ |
| Ollama 就绪探测 | ✅ |
| Desktop 一键拉起 Studio | ✅ 2026-07-27 |
| Changeset 统计 + 单次/全部撤回 | ✅ |
| Models：联网/命令配置位 | ✅ |
| 外观设置（主题 / 密度 / 强调色） | ✅ |
| 多步任务（摸清→拟定→改码→核对） | ✅ |
| Home 概览主题页 + 自定义确认弹窗 + MD 预览 | ✅ |

---

## 近期排期

### Sprint A · 联网只读

- [x] `fetch_url`：超时、体积上限、禁重定向  
- [x] Skill：查文档 → 再改代码（`docs-then-patch`）  
- [x] `web_search`：Tavily / SerpAPI；无 Key 诚实失败  

### Sprint B · 本地自动化（白名单）

- [x] `run_safe_cmd` + 命令预览批准  
- [x] 首批白名单：`git status` / `git diff` / `git log -n`  
- [x] Skill：`repo-hygiene`  
- [ ] 批量重命名预览  

### Sprint C · 体验

- [x] Desktop 一键拉起 Next / `studio`  
- [x] 多文件变更集统计与撤回（单次 + 全部）  
- [x] Ollama 就绪探测  

---

## 明确后置

- 无沙箱任意 Shell  
- 云端自动开 PR  
- 完整浏览器自动化  
- 与 Aether Desk UI 强行合并  

---

## 本周准备

1. [x] `fetch_url` / `run_safe_cmd` / `web_search` 进正式工具目录  
2. [x] 设置页能力说明  
3. [x] 样式、确认弹窗、概览页  
4. [x] Desktop 自动拉起 Studio  
