# Loom Agent · 接手必读

## 60 秒

**Loom Studio** = 本地 Coding Agent 控制台（Web / Electron）。  
打开先看 **Home · 概览**；侧栏：**任务 / Run / Plan / Agents / Skills / Models / 设置**。  
≠ Aether Desk（不是四栏 RAG）。

进度与后续任务：[`PROGRESS.md`](./PROGRESS.md)。

## 对标市面产品

见 [`COMPETITIVE.md`](./COMPETITIVE.md)：Cursor Composer、Claude Rules/HITL、Trae 模式切换、Codex 任务叙事 —— Loom 借交互，不抄壳。

## 启动

```bash
cd agent
export PATH="/opt/homebrew/opt/node@20/bin:$PATH"   # Node ≥ 20
npm install && npm run studio    # :3010（推荐）
# 或 npm run web
npm run desktop                  # 可选 Electron（需 Studio 已起）
```

## 上手

1. Home **概览** → 打开 Composer / Demo / 功能说明  
2. **上手 Demo** Step1：探索 / 审计 / Skill 导览  
3. Step2：写审批（批准 / 拒绝 / 撤回）  
4. Step3：异构或三线程 Plan  
5. **任务**：四步流水线（摸清→拟定→改码→核对）  
6. Agents：模板创建 / 克隆；Skills：预览 MD、加入本轮 Run  

## Skills（packages/core/skills）

| id | 用途 |
|----|------|
| `demo-readme` | 优先读 README |
| `secure-audit` | 密钥/TODO 审计清单 |
| `plan-split` | 拆并行子任务 |
| `changelog-writer` | 纪要/CHANGELOG 草稿（HITL） |
| `code-tour` | 5 分钟导览 |
| `docs-then-patch` | 查文档 / 读本地 → 再 write Diff |
| `repo-hygiene` | git 白名单卫生检查 |

## Agent 能力

- 内置：reader / editor / auditor / planner / guide / **hygienist**  
- 模板一键：`from_template`（含文档对照改码、提交前卫生）  
- 克隆内置 → 可编辑自定义  
- Run 级 **skillIds 开关** + Abort  
- Diff：**变更集统计** + **撤回最近批准**  

## 工具

`list_dir` · `read_file` · `grep_files` · `write_file` · `fetch_url` · `web_search` · `run_safe_cmd`  
（`web_search` 需 `TAVILY_API_KEY` / `SERPAPI_API_KEY`；无 Key 诚实失败）

## Desktop

`npm run desktop`：若 :3010 未就绪，默认自动拉起 `scripts/studio.mjs`（可用 `LOOM_AUTO_STUDIO=0` 关闭）。

## API 增量

| 路径 | 说明 |
|------|------|
| `GET /api/meta` | 含 Ollama 探测后的 models.availability |
| `GET /api/skills` | Skill 列表 + 正文预览 |
| `POST /api/agents` | upsert / from_template / clone |
| `POST /api/run` | 可传 `skillIds` 覆盖 |
| `POST /api/writes/approve` | 返回 `previous` / `created` |
| `POST /api/writes/undo` | 撤回已批准写入 |

## 规划

见 [`ROADMAP.md`](./ROADMAP.md)、[`PROGRESS.md`](./PROGRESS.md)。简历 [`RESUME.md`](./RESUME.md)。
