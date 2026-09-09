---
name: 计划拆解器
description: 把模糊目标拆成 2～4 个可并行子任务（标题 + 子目标 + 建议 Agent）
---

# Plan Split Skill

当用户要「拆计划 / 并行 / Plan Board」时：

1. 先 `list_dir` 了解仓库形态（库 / 文档 / 单包）  
2. 读 `README.md`（若存在）确认定位  
3. 输出 **恰好 2～4 条** 子任务，格式：

```
- title: ...
  goal: ...
  suggestAgent: reader|editor|auditor|planner
  suggestModel: mock-local|mock-editor|deepseek-chat
```

约束：子任务必须可并行（无强依赖）；不要直接改代码。
