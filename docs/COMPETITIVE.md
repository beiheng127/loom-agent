# Loom vs 市面 Agent 产品 · 定位与借鉴

> 目标：学习 Cursor / Claude Code / Codex / Trae 的**交互范式**，不抄壳、不假装成完整 IDE。

---

## 产品形态对照

| 产品 | 形态 | Loom 借鉴点 | Loom 不追的 |
|------|------|-------------|-------------|
| **Cursor** | AI-native IDE | Composer 线程、Ask/Agent、@文件、Diff Accept、⌘K、Explorer | 完整编辑器/Tab 补全/云 Agent |
| **Trae** | AI IDE | 模式切换清晰、多模型面板 | 闭源全家桶 |
| **Claude Code** | Terminal agent | slash 命令、Rules/约定、权限（HITL）、Plan | 任意 Shell、全仓自动改 |
| **Codex** | Cloud sandbox | 「任务→结果」异步叙事 | 云 VM / 自动 PR |

---

## Loom 独特叙事（秋招口径）

1. **Plan Board 一等公民**：多 Agent × 多模型并行（市面多为单线程 Composer）  
2. **自研 Runtime + Skills**：可讲 loop / tool protocol / SKILL.md，不是包一层 Chat  
3. **本地优先 + Electron**：无 Key 也能 Mock 演示 HITL / 并行  
4. **与 Aether Desk 双作品**：知识 RAG vs 编码 Agent，避免两个聊天壳  

---

## 已对齐的交互

- Explorer 文件树 + @context  
- Composer 流式 SSE（phase / tool / text）  
- Ask · Agent · Plan 三模式  
- Unified Diff HITL（Accept / Reject）  
- ⌘K 命令面板 + `/ask` `/agent` `/plan` slash  
- `.loom/RULES.md` 项目约定  

---

## 下一程（继续像 IDE，但不做成 VS Code 叉）

| 优先级 | 能力 | 参考 |
|--------|------|------|
| P0 | 多 Session 侧栏（Agents Window） | Cursor |
| P0 | 变更集 Accept All | Cursor Composer |
| P1 | 流式 token 更细（字级） | Cursor |
| P1 | Plan DAG / 依赖 | Claude Agent Teams |
| P2 | MCP 只读工具 | Claude Code |
| P2 | Desktop 一键起服务 | Trae/Cursor 安装体验 |

---

## 明确边界

- 不做多租户云 IDE  
- 不开放无沙箱 Shell  
- 不复制 Desk 四栏知识库 UI  
