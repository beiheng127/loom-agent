# Loom · 能力关联：代码 × 本地自动化 × 联网

> 更新：2026-07-27（晚）· **实现与排期对照**（非空设计稿）  
> 原则：三类能力共用 **Tool + HITL + Skills + 可观测时间线**。

---

## 1. 产品里怎么摆

```text
用户目标
   │
   ├─ 改代码 / 读仓库 ─────────── FS 工具 + Diff HITL + 撤回
   ├─ 本地批量/检查 ───────────── run_safe_cmd（白名单）+ repo-hygiene
   └─ 查资料 / 打开链接 ───────── fetch_url；web_search（需 Key）
           │
           ▼
    同一条 Run / Plan Worker
    同一套 Skills（docs-then-patch 等）
    同一套审批（写盘、跑命令）
```

| 能力层 | 工具 | 危险级 | 默认策略 | 状态 |
|--------|------|--------|----------|------|
| 代码 | list_dir / read_file / grep / write_file | 写=高 | Diff 批准 + 可撤回 | ✅ |
| 本地自动化 | run_safe_cmd | 高 | 白名单 + 每次批准 | ✅ |
| 本地自动化 | batch_rename | 高 | 预览表 + 批准 | ❌ 待做 |
| 联网 | fetch_url | 中 | 禁内网/禁重定向 | ✅ |
| 联网 | web_search | 中 | 无 Key → 失败不造假 | ✅（Tavily/Serp） |

**和 Desk 的分工**  
- Loom：代码 + 本地自动化 + 为改码服务的联网  
- Desk：笔记 RAG + 轻量抓网页；不做 Shell / 批量改文件  

---

## 2. 日程对照

### 已完成

| ID | 功能 | 备注 |
|----|------|------|
| L-NET-1 | `fetch_url` | 超时/体积/禁重定向 |
| L-NET-2 | `web_search` | Tavily / SerpAPI；无 Key 诚实失败 |
| L-LOC-1 | `run_safe_cmd` | git 白名单；`LOOM_SAFE_CMDS` 可扩 |
| L-NET-3 | Skill `docs-then-patch` | search/fetch → write HITL |
| L-LOC-3 | Skill `repo-hygiene` | git → 摘要 |
| L-CODE-1 | 变更集统计 + 撤回 | 单次 + 全部 |
| L-OLLAMA | Ollama `/api/tags` 探测 | Models / meta |
| L-DESK-1 | Desktop 一键起 Studio | 默认 `LOOM_AUTO_STUDIO` |
| L-UX-1 | Home 概览 / 确认弹窗 / MD 预览 | Web |

### 待做

| ID | 功能 | 依赖你确认 |
|----|------|------------|
| L-LOC-2 | 批量重命名预览 | 是否允许删文件 |
| L-PLAN-1 | Plan Worker 失败重试 | — |

### P2 后置

- 目录监听自动跑 Agent  
- 任意 Shell / 无审批脚本  
- 完整浏览器自动化  
- MCP 任意服务器（可先做只读 MCP）  

---

## 3. Skills 如何关联三类能力

| Skill | 工具组 | 状态 |
|-------|--------|------|
| `secure-audit` | 代码 grep/read | ✅ |
| `code-tour` / `demo-readme` / `plan-split` / `changelog-writer` | 代码为主 | ✅ |
| `docs-then-patch` | 联网 fetch/search → 代码 write | ✅ |
| `repo-hygiene` | 本地 git → 可选 write | ✅ |

---

## 4. 安全与文案

- 联网：禁私网；展示来源 URL；不把 Key 写进仓库  
- 本地命令：拒绝白名单外二进制；输出进时间线  
- 文案：用「需要确认」「来源」「命令预览」；无搜索 Key 不返回假结果  

---

## 5. 已拍板 / 仍待拍板

**已拍板**

1. 搜索：Tavily / SerpAPI；无 Key 诚实失败  
2. Desktop：默认一键拉起 Studio（`LOOM_AUTO_STUDIO=0` 可关）  

**仍待拍板**

1. **批量重命名**：是否允许删除？  
2. Plan Worker 失败是否自动重试？  
