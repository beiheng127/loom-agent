/** Home「功能说明」：按 Loom 实际能力编写（Composer / Diff / Plan），不照搬第三方产品文案 */

export type FeatureGuideItem = {
  id: string;
  nav: string;
  title: string;
  summary: string;
  what: string[];
  how: string[];
  tips?: string[];
};

export const FEATURE_GUIDE: FeatureGuideItem[] = [
  {
    id: "home",
    nav: "Home",
    title: "主页",
    summary: "产品概览、Demo 上手、功能说明、会话与 Plan 历史。",
    what: [
      "概览：高端主题主页，统计与快捷入口（默认打开）。",
      "上手 Demo：按步骤跑探索、Diff 审批、Plan、自定义 Agent。",
      "功能说明：每个页面做什么、怎么点。",
      "历史：打开/新建/重命名/删除 Run 会话；载入/删除 Plan 目标。",
    ],
    how: [
      "顶部 Home → 切换「概览 / Demo / 功能说明 / 历史」。",
      "无 API Key 时 Demo 用本地脚本；配置 Key 后同一 Demo 走真模型。",
      "⌘K 可搜「功能说明」「历史」「新建会话」。",
    ],
  },
  {
    id: "workflow",
    nav: "任务",
    title: "多步任务",
    summary: "把一次改码拆成可确认的四步：摸清 → 拟定 → 改码 → 核对（类似 Cursor 里分阶段推进，但步骤显式可见）。",
    what: [
      "任务列表可新建、示例、重命名、删除（本地持久化）。",
      "每步启动 Composer，结束后摘要回写，你确认再进下一步。",
      "改码步默认用可写 Agent；落盘仍要 Diff 批准。",
    ],
    how: [
      "任务 →「示例」或输入标题新建。",
      "「启动本步」→ 进入 Run；跑完可「返回任务」审阅摘要。",
      "点「确认完成本步」进入下一步。",
    ],
    tips: ["这是 Loom 自有的多步编排，不是外部产品的工单中心复制。"],
  },
  {
    id: "run",
    nav: "Run",
    title: "Composer（Ask / Agent）",
    summary: "主对话区：只读问答或提议改码，对齐 Cursor Composer 的使用直觉。",
    what: [
      "Ask：只读探索，不会提写文件/命令。",
      "Agent：可提议 write_file / run_safe_cmd，需你 Accept。",
      "左侧 Sessions + Explorer @文件上下文。",
    ],
    how: [
      "输入目标发送；或 /ask /agent /explore /audit。",
      "出现 Diff / 命令卡片 → Accept 或 Reject。",
      "「新建」开空白会话；历史里可回放。",
    ],
  },
  {
    id: "plan",
    nav: "Plan",
    title: "Plan Board",
    summary: "多 Worker 并行（不同 Agent × 模型），合并结果；写入仍回流审批。",
    what: [
      "预设：双读、读写异构、三线程、自定义。",
      "Board 上看每个 Worker 状态与预览。",
      "历史可载入目标再跑。",
    ],
    how: [
      "Plan → 填目标 → 选预设 → 启动。",
      "有待审批写入时回 Run Accept。",
      "Home「历史」或本页「载入目标」。",
    ],
  },
  {
    id: "agents",
    nav: "Agents",
    title: "Agents",
    summary: "内置与自定义 Agent：工具白名单、Skills、默认模型（类似 Cursor 里选 Agent 模式/规则组合）。",
    what: [
      "内置 reader / editor / auditor / planner / guide / hygienist。",
      "模板创建（含文档对照改码、提交前卫生）或表单精细配置。",
      "可克隆内置再改。",
    ],
    how: [
      "Agents → 模板创建，或打开表单保存。",
      "Run 页 Agent 下拉选用。",
    ],
  },
  {
    id: "skills",
    nav: "Skills",
    title: "Skills",
    summary: "把约定写成 Skill，注入 system 提示（类似项目规则 / 可复用提示块）。",
    what: [
      "内置只读；自定义可新建、编辑、导入 Markdown（卡片渲染预览）。",
      "含 docs-then-patch、repo-hygiene 等流程 Skill。",
      "Run 里勾选后对本轮生效。",
    ],
    how: [
      "Skills → 新建或导入 SKILL.md → 保存。",
      "Run → Skills 多选勾上。",
    ],
  },
  {
    id: "models",
    nav: "Models",
    title: "Models",
    summary: "本地 mock + 云端 / Ollama；只展示已接通能力。",
    what: [
      "mock：无 Key 可演示全流程。",
      "DeepSeek / OpenAI：配 Key 后 ready。",
      "Ollama：实时探测本机服务是否可达。",
      "已接通工具：fetch_url、web_search（需搜索 Key）、run_safe_cmd（白名单 + 审批）。",
    ],
    how: [
      "agent/.env 填 DEEPSEEK_API_KEY（复制 .env.example）→ 重启 studio。",
      "搜索：填 TAVILY_API_KEY 或 SERPAPI_API_KEY。",
      "Models 页确认 ready，Run 下拉切换。",
    ],
    tips: ["无搜索 Key 时 web_search 诚实失败，不会返回假结果。"],
  },
  {
    id: "settings",
    nav: "设置",
    title: "外观",
    summary: "主题、密度、强调色、状态条——只影响界面，不影响 Agent 逻辑。",
    what: ["Studio 浅色 / 深色 / 紧凑。", "侧栏文字与顶栏状态条开关。"],
    how: ["设置里改选项，立即生效并记住。"],
  },
  {
    id: "hitl",
    nav: "Diff",
    title: "Diff / 命令审批",
    summary: "写文件与安全命令先提案再执行——对应 Cursor 的 diff review 习惯。",
    what: [
      "write_file → Diff 卡片；顶部显示文件数与 +/- 行。",
      "run_safe_cmd → 白名单命令待批准。",
      "支持 Accept All / Reject All；批准后可单次或全部撤回。",
    ],
    how: [
      "跑「提议写入」Demo，或 Agent 模式让模型改文件。",
      "卡片上 Accept / Reject；需要时点撤回。",
    ],
  },
  {
    id: "sessions",
    nav: "Sessions",
    title: "会话",
    summary: "线程自动保存，可回放与清理。",
    what: ["发送后写入本地（及可选服务端）。", "新建 / 打开 / 重命名 / 删除。"],
    how: [
      "Home「历史」或 Run 左侧 Sessions。",
      "「新建会话」清空当前线程。",
    ],
  },
];
