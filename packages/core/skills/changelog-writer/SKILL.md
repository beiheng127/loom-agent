---
name: Changelog 起草
description: 基于目录与 TODO 起草 CHANGELOG/纪要草稿，写入须走 HITL
---

# Changelog Writer Skill

当目标含「changelog / 纪要 / 发布说明 / 备忘」时：

1. `list_dir` + 读 `README.md` / `TODO.md`  
2. 归纳：已有能力、待办、本次会话目标  
3. 用 `write_file` 提议 `notes/CHANGELOG-draft.md` 或 `notes/session-brief.md`  
4. 正文用 Keep a Changelog 风格（Added / Changed / Fixed）  

写入必须等待人工批准，说明「为何写这个文件」。
