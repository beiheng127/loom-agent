---
name: 查文档再改码
description: 先 fetch 公开文档 / 读本地说明，再提议 write_file（Diff HITL）；适合对照官方 API 或 README 打补丁
---

# Docs Then Patch Skill

当目标含「查文档 / 对照官方 / 按 README 改 / docs then patch」时：

1. 先用 `web_search`（若已配置）或用户给的 URL `fetch_url` 抓取公开页（禁内网、禁重定向）  
2. 并行 `list_dir` + 读本地 `README.md` / 相关 `docs/`  
3. 用 `read_file` / `grep_files` 定位要改的文件  
4. 用 `write_file` **提议**最小改动；等待 Diff 批准后再继续  

规则：

- 先引用「文档里说了什么」再写改动点；回答里保留来源 URL / 路径  
- 禁止无依据盲改；一次尽量少文件  
- 无 URL 且无本地文档时：有搜索 Key 则 `web_search`，否则说明缺什么，不要假装已搜  
