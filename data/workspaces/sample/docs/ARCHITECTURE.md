# Architecture（示例）

Loom Sample 采用「工作区沙箱 + Agent Runtime + Plan Board」三层：

1. **Tools**：list_dir / read_file / grep_files / write_file(HITL)  
2. **Agents**：reader / editor / auditor / planner  
3. **Orchestrator**：并行 Worker，各自绑定模型  

面试可讲：编排在 core，可观测在 Studio UI。
