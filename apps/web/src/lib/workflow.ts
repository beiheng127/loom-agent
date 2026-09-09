/** 多步任务：把改码拆成可确认的四步（Loom 自有编排，非外部产品复制） */

export type StageId =
  | "requirements"
  | "design"
  | "code"
  | "verify";

export type StageStatus =
  | "pending"
  | "running"
  | "awaiting_confirm"
  | "done"
  | "failed";

export type WorkflowStage = {
  id: StageId;
  title: string;
  status: StageStatus;
  summary?: string;
  updatedAt?: number;
};

export type WorkflowTicket = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  currentStage: StageId;
  stages: WorkflowStage[];
};

export const STAGE_DEFS: Array<{
  id: StageId;
  title: string;
  hint: string;
  defaultGoal: (ticketTitle: string) => string;
}> = [
  {
    id: "requirements",
    title: "摸清现状",
    hint: "读代码，列出改动点与验收标准",
    defaultGoal: (t) =>
      `【多步任务 · 摸清现状】目标「${t}」：浏览工作区相关文件，用条目列出：1) 现状理解 2) 涉及文件 3) 验收标准 4) 风险。不要写文件。`,
  },
  {
    id: "design",
    title: "拟定改法",
    hint: "步骤、风险、拟改文件",
    defaultGoal: (t) =>
      `【多步任务 · 拟定改法】目标「${t}」：给出实施方案（步骤、拟改文件、风险、回滚注意）。不要写文件。`,
  },
  {
    id: "code",
    title: "动手改码",
    hint: "提议写入，等待 Diff 批准",
    defaultGoal: (t) =>
      `【多步任务 · 动手改码】目标「${t}」：按方案谨慎改代码。需要落盘用 write_file 并等待批准；可先 run_safe_cmd 看 git status。改完说明改了什么。`,
  },
  {
    id: "verify",
    title: "核对结果",
    hint: "对照验收，汇总剩余风险",
    defaultGoal: (t) =>
      `【多步任务 · 核对结果】目标「${t}」：对照验收标准做验证说明；可用 run_safe_cmd 跑 git status / git diff。输出：已完成、未完成、剩余风险。不要继续大范围改码。`,
  },
];

export const TICKETS_KEY = "loom.workflow.tickets.v1";
export const WORKFLOW_EVENT = "loom-workflow-updated";

function blankStages(): WorkflowStage[] {
  return STAGE_DEFS.map((s) => ({
    id: s.id,
    title: s.title,
    status: "pending" as const,
  }));
}

export function createTicket(title: string): WorkflowTicket {
  const now = Date.now();
  return {
    id: `tk-${now.toString(36)}`,
    title: title.trim() || "未命名任务",
    createdAt: now,
    updatedAt: now,
    currentStage: "requirements",
    stages: blankStages(),
  };
}

export function createSampleTicket(): WorkflowTicket {
  const t = createTicket("示例：补充 README 入口说明");
  return markStage(t, "requirements", {
    status: "pending",
    summary: "示例多步任务：走完四步即可体验「跑一步 → 确认 → 再下一步」。",
  });
}

export function loadTickets(): WorkflowTicket[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(TICKETS_KEY);
    if (!raw) return [];
    return JSON.parse(raw) as WorkflowTicket[];
  } catch {
    return [];
  }
}

export function saveTickets(tickets: WorkflowTicket[]) {
  if (typeof window === "undefined") return;
  localStorage.setItem(TICKETS_KEY, JSON.stringify(tickets));
  window.dispatchEvent(new CustomEvent(WORKFLOW_EVENT));
}

export function stageIndex(id: StageId): number {
  return STAGE_DEFS.findIndex((s) => s.id === id);
}

export function nextStageId(id: StageId): StageId | null {
  const i = stageIndex(id);
  if (i < 0 || i >= STAGE_DEFS.length - 1) return null;
  return STAGE_DEFS[i + 1]!.id;
}

export function markStage(
  ticket: WorkflowTicket,
  stageId: StageId,
  patch: Partial<WorkflowStage>,
): WorkflowTicket {
  return {
    ...ticket,
    updatedAt: Date.now(),
    stages: ticket.stages.map((s) =>
      s.id === stageId ? { ...s, ...patch, updatedAt: Date.now() } : s,
    ),
  };
}

export function applyTicketStageResult(
  ticketId: string,
  stageId: StageId,
  result: { summary: string; status: StageStatus },
): WorkflowTicket | null {
  const tickets = loadTickets();
  const idx = tickets.findIndex((t) => t.id === ticketId);
  if (idx < 0) return null;
  const summary = result.summary.trim().slice(0, 4000);
  const next = markStage(tickets[idx]!, stageId, {
    status: result.status,
    summary: summary || tickets[idx]!.stages.find((s) => s.id === stageId)?.summary,
  });
  const list = tickets.slice();
  list[idx] = next;
  saveTickets(list);
  return next;
}

export function recoverStaleRunningStages(): boolean {
  if (typeof window === "undefined") return false;
  const tickets = loadTickets();
  let changed = false;
  const next = tickets.map((t) => {
    let ticket = t;
    for (const s of t.stages) {
      if (s.status !== "running") continue;
      changed = true;
      ticket = markStage(ticket, s.id, {
        status: "failed",
        summary:
          s.summary?.trim() ||
          "（中断：页面刷新或会话结束，本步未回写完整结果）",
      });
    }
    return ticket;
  });
  if (changed) saveTickets(next);
  return changed;
}

export function stageStatusLabel(status: StageStatus, isCurrent: boolean): string {
  switch (status) {
    case "done":
      return "已完成";
    case "running":
      return "运行中";
    case "awaiting_confirm":
      return "待确认";
    case "failed":
      return "失败";
    case "pending":
      return isCurrent ? "当前" : "待开始";
    default: {
      const _exhaustive: never = status;
      return _exhaustive;
    }
  }
}
