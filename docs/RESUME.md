# Loom Agent · 简历条目（克制版）

**Loom Agent｜本地代码 Agent 工作区｜独立开发**  
TypeScript · Next.js · Electron · Vercel AI SDK

- 在指定目录跑 Agent：读文件、搜索、抓公开页、联网搜索（需 Key）、安全命令、提议写文件；写文件先 Diff，确认后落盘，支持变更集统计与单次/全部撤回。
- Ask / Agent / Plan；Plan 可并行多个 Worker；多步任务四阶段推进；可配置云端或本地模型（含 Ollama 探测），未配置时用离线脚本。
- Skills 支持新建、编辑、导入、删除；内置「查文档再改码」「仓库卫生」等；自定义 Agent 可绑工具与 Skill；会话与 Plan 本地保存。
- Desktop 可检测 Studio，未启动则自动拉起（可关）。

本地：`npm run studio` → :3010
