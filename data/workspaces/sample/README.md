# Sample Workspace · Loom 演示沙箱

无风险示例项目，给 Loom Agent 练手：读文件、grep、Plan Board、写审批。

## 入口

- 应用入口：`src/index.ts`
- 工具函数：`src/utils.ts`
- 文档：`docs/ARCHITECTURE.md`、`docs/API.md`

## 怎么用 Loom 玩转本目录

1. **探索**：Reader + mock-local → 总结定位  
2. **审计**：Auditor → 搜 TODO / 假密钥  
3. **写入**：Editor + mock-editor → 批准 `notes/*.md`  
4. **并行**：Plan「异构 / 三线程」  

## 技术栈（虚构）

TypeScript · 本地 Agent Runtime · Plan Board

## 注意事项

- `.env.example` 里是**假**密钥字符串，仅供审计 Mock 命中  
- 真正写入只会在你点「批准」后发生  
