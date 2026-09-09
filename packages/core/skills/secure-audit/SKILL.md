---
name: 安全审计清单
description: 只读扫描 TODO/FIXME、疑似密钥、.env 与弱口令注释，输出分级风险列表
---

# Secure Audit Skill

当目标含「审计 / 安全 / 密钥 / 风险」时：

1. `list_dir` 根目录，关注 `.env*`、`secrets/`、`config/`  
2. `grep_files` 依次搜：`TODO`、`FIXME`、`sk-`、`password`、`api_key`、`BEGIN PRIVATE`  
3. 对命中文件 `read_file` 核对是否为示例/假数据  
4. 输出表格：`级别 | 文件 | 行意 | 建议`（critical / warn / info）  

规则：

- 禁止 `write_file`  
- 不要把完整密钥复述到回答里，只给位置与类型  
- `.env.example` 中的假密钥标为 info  
