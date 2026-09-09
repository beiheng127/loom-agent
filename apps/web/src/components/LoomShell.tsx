"use client";

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
} from "react";
import { FileTree } from "@/components/FileTree";
import { DiffBlock } from "@/components/DiffBlock";
import {
  ComposerThread,
  type ThreadItem,
} from "@/components/ComposerThread";
import {
  CommandPalette,
  type PaletteAction,
} from "@/components/CommandPalette";
import { WorkflowView } from "@/components/WorkflowView";
import { SettingsView } from "@/components/SettingsView";
import { HomeView, type HomeTab } from "@/components/HomeView";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { useConfirm } from "@/lib/confirm";
import {
  applySettingsToDocument,
  loadSettings,
  saveSettings,
  DEFAULT_SETTINGS,
  type LoomSettings,
} from "@/lib/settings";
import {
  STAGE_DEFS,
  applyTicketStageResult,
  type StageId,
} from "@/lib/workflow";

/** SSR-safe 初始值；客户端 mount 后再 hydrate */
const DEFAULT_SETTINGS_CLIENT = DEFAULT_SETTINGS;

type ViewId =
  | "home"
  | "run"
  | "workflow"
  | "plan"
  | "agents"
  | "skills"
  | "models"
  | "settings";
type StudioMode = "ask" | "agent" | "plan";

type Agent = {
  id: string;
  name: string;
  systemPrompt: string;
  allowedTools: string[];
  defaultModelId: string;
  skillIds: string[];
  builtin?: boolean;
};

type ModelRow = {
  id: string;
  label: string;
  blurb?: string;
  temperature?: number;
  availability: { ready: boolean; reason: string; keyConfigured: boolean };
  baseURL?: string;
  apiKeyEnv?: string;
  model: string;
};

type SkillBrief = { id: string; name: string; description: string };

type Template = {
  id: string;
  name: string;
  blurb: string;
  defaultModelId: string;
  skillIds: string[];
  allowedTools: string[];
};

type DemoRecipe = {
  id: string;
  step: 1 | 2 | 3 | 4;
  title: string;
  subtitle: string;
  proves: string;
  kind: "run" | "plan";
  etaSec: number;
  run?: {
    goal: string;
    agentId: string;
    modelId: string;
    mockScenario?: string;
  };
  plan?: { goal: string; preset: "homo" | "hetero" | "triple" | "custom" };
};

type Meta = {
  workspaceDefault: string;
  agents: Agent[];
  models: ModelRow[];
  preferredModelId?: string | null;
  skills: SkillBrief[];
  planPresets: Array<{ id: string; label: string }>;
  demos: DemoRecipe[];
  templates: Template[];
  plannedTools?: Array<{
    name: string;
    description: string;
    requiresApproval: boolean;
    group: "web" | "local";
    status: "live" | "not_configured" | "planned";
  }>;
  capabilitySettings?: {
    search: {
      configured: boolean;
      envHints: string[];
      note: string;
    };
    fetch: {
      live: boolean;
      timeoutMs: number;
      maxChars: number;
      redirect: string;
    };
    safeCmd: {
      live: boolean;
      prefixes: string[];
      envExtra: string;
      timeoutMs: number;
    };
  };
};

type PlanStep = {
  id: string;
  title: string;
  status: string;
  agentId: string;
  modelId: string;
  resultPreview?: string;
  error?: string;
};

type LogLine = { t: number; text: string };
type WorkerDraft = {
  title: string;
  agentId: string;
  modelId: string;
  goal: string;
};
type Progress = Record<string, boolean>;
type SkillDetail = SkillBrief & {
  body: string;
  bodyPreview: string;
  chars: number;
  builtin?: boolean;
};

declare global {
  interface Window {
    loomDesktop?: {
      isDesktop: boolean;
      openDirectory: () => Promise<string | null>;
    };
  }
}

const TOOL_OPTIONS = [
  "list_dir",
  "read_file",
  "grep_files",
  "write_file",
  "fetch_url",
  "web_search",
  "run_safe_cmd",
];
const PROGRESS_KEY = "loom.demo.progress.v1";

function loadProgress(): Progress {
  try {
    return JSON.parse(localStorage.getItem(PROGRESS_KEY) || "{}") as Progress;
  } catch {
    return {};
  }
}

export function LoomShell() {
  const confirm = useConfirm();
  const [view, setView] = useState<ViewId>("home");
  const [homeTab, setHomeTab] = useState<HomeTab>("landing");
  const [settings, setSettings] = useState<LoomSettings>(DEFAULT_SETTINGS_CLIENT);
  const [meta, setMeta] = useState<Meta | null>(null);
  const [skillDetails, setSkillDetails] = useState<SkillDetail[]>([]);
  const [draftSkill, setDraftSkill] = useState({
    id: "",
    name: "",
    description: "",
    body: "",
  });
  const [skillFormOpen, setSkillFormOpen] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [importMarkdown, setImportMarkdown] = useState("");
  const [skillBusy, setSkillBusy] = useState(false);
  const [skillError, setSkillError] = useState<string | null>(null);
  const [workspace, setWorkspace] = useState("");
  const [goal, setGoal] = useState("总结这个示例项目的定位与入口");
  const [agentId, setAgentId] = useState("reader");
  const [modelId, setModelId] = useState("mock-local");
  const [skillIds, setSkillIds] = useState<string[]>(["demo-readme", "code-tour"]);
  const [temperature, setTemperature] = useState(0.3);
  const [busy, setBusy] = useState(false);
  const [abortCtrl, setAbortCtrl] = useState<AbortController | null>(null);
  const [answer, setAnswer] = useState("");
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [steps, setSteps] = useState<PlanStep[]>([]);
  const [merged, setMerged] = useState("");
  const [pendingWrites, setPendingWrites] = useState<
    Array<{
      path: string;
      content: string;
      diff?: string;
      additions?: number;
      deletions?: number;
    }>
  >([]);
  const [writeUndoStack, setWriteUndoStack] = useState<
    Array<{
      path: string;
      previous: string | null;
      created: boolean;
      content: string;
    }>
  >([]);
  const [pendingCmds, setPendingCmds] = useState<Array<{ command: string }>>(
    [],
  );
  const runTokenRef = useRef(0);
  const workflowRunRef = useRef<{
    ticketId: string;
    stageId: StageId;
  } | null>(null);
  /** 本轮已拒绝的命令，防止 result 事件把 HITL 又塞回来 */
  const rejectedCmdsRef = useRef<Set<string>>(new Set());
  /** Run 页顶栏：当前/刚结束的工单阶段，便于回跳 */
  const [workflowBanner, setWorkflowBanner] = useState<{
    ticketId: string;
    stageId: StageId;
  } | null>(null);
  const [studioMode, setStudioMode] = useState<StudioMode>("agent");
  const [thread, setThread] = useState<ThreadItem[]>([]);
  const [contextFiles, setContextFiles] = useState<
    Array<{ path: string; content: string }>
  >([]);
  const [selectedFile, setSelectedFile] = useState<string | undefined>();
  const [phaseLabel, setPhaseLabel] = useState<string>("idle");
  const [error, setError] = useState<string | null>(null);
  const [planPreset, setPlanPreset] = useState<
    "homo" | "hetero" | "triple" | "custom"
  >("hetero");
  const [workers, setWorkers] = useState<WorkerDraft[]>([
    {
      title: "Worker A",
      agentId: "reader",
      modelId: "mock-local",
      goal: "探索目录结构",
    },
    {
      title: "Worker B",
      agentId: "editor",
      modelId: "mock-editor",
      goal: "起草 notes 并请求写入批准",
    },
  ]);
  const [draftAgent, setDraftAgent] = useState({
    id: "" as string,
    name: "我的审计员",
    systemPrompt: "你只读审计仓库，列出风险点，禁止写文件。",
    defaultModelId: "mock-local",
    allowedTools: ["list_dir", "read_file", "grep_files"] as string[],
    skillIds: ["secure-audit"] as string[],
  });
  const [isDesktop, setIsDesktop] = useState(false);
  const [progress, setProgress] = useState<Progress>({});
  const [lastDemo, setLastDemo] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [planHistory, setPlanHistory] = useState<
    Array<{ id: string; goal: string; preset: string; at: number; threads: number }>
  >([]);
  const [sessions, setSessions] = useState<
    Array<{
      id: string;
      title: string;
      mode: StudioMode;
      thread: ThreadItem[];
      updatedAt: number;
    }>
  >([]);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [preview, setPreview] = useState<{ path: string; content: string } | null>(
    null,
  );
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionQ, setMentionQ] = useState("");
  const [treeFiles, setTreeFiles] = useState<string[]>([]);
  const [gitInfo, setGitInfo] = useState<{
    branch: string | null;
    dirty: number;
  } | null>(null);
  const [rulesPath, setRulesPath] = useState<string | null>(null);

  const metaRef = useRef(meta);
  metaRef.current = meta;

  const selectedModel = useMemo(
    () => meta?.models.find((m) => m.id === modelId),
    [meta, modelId],
  );
  const readyModels = useMemo(
    () => (meta?.models ?? []).filter((m) => m.availability.ready).length,
    [meta],
  );

  const markDone = useCallback((demoId: string, step: number) => {
    setProgress((prev) => {
      const next = { ...prev, [demoId]: true, [`step-${step}`]: true };
      localStorage.setItem(PROGRESS_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  const refreshMeta = async () => {
    const res = await fetch("/api/meta");
    const d = (await res.json()) as Meta;
    setMeta(d);
    setWorkspace((w) => w || d.workspaceDefault);
    // BYOK：有就绪真模型时默认切到它（仍保留 mock 列表）
    const preferred = d.models.find(
      (m) =>
        m.availability.ready &&
        !m.id.startsWith("mock-") &&
        (m.id === "ollama-local"
          ? false // Ollama 需 LOOM_USE_OLLAMA；Composer 仍可手动选
          : m.availability.keyConfigured),
    );
    if (preferred) {
      setModelId((cur) => (cur === "mock-local" ? preferred.id : cur));
    }
  };

  const refreshSessions = async () => {
    try {
      const res = await fetch("/api/sessions");
      const d = (await res.json()) as {
        sessions?: Array<{
          id: string;
          title: string;
          mode: StudioMode;
          thread: ThreadItem[];
          updatedAt: number;
        }>;
      };
      if (Array.isArray(d.sessions) && d.sessions.length) {
        setSessions(d.sessions);
        try {
          localStorage.setItem("loom.sessions.v1", JSON.stringify(d.sessions));
        } catch {
          /* cache optional */
        }
        return;
      }
    } catch {
      /* fall through to localStorage */
    }
    try {
      const raw = localStorage.getItem("loom.sessions.v1");
      if (raw) {
        setSessions(
          JSON.parse(raw) as Array<{
            id: string;
            title: string;
            mode: StudioMode;
            thread: ThreadItem[];
            updatedAt: number;
          }>,
        );
      }
    } catch {
      /* ignore */
    }
  };

  const refreshPlanHistory = async () => {
    try {
      const res = await fetch("/api/plans");
      const d = (await res.json()) as {
        plans?: Array<{
          id: string;
          goal: string;
          preset: string;
          createdAt: number;
          threads: number;
        }>;
      };
      if (Array.isArray(d.plans)) {
        const mapped = d.plans.map((p) => ({
          id: p.id,
          goal: p.goal,
          preset: p.preset,
          at: p.createdAt,
          threads: p.threads,
        }));
        setPlanHistory(mapped);
        try {
          localStorage.setItem("loom.plan.history.v1", JSON.stringify(mapped));
        } catch {
          /* cache optional */
        }
        return;
      }
    } catch {
      /* fall through */
    }
    try {
      const raw = localStorage.getItem("loom.plan.history.v1");
      if (raw) {
        setPlanHistory(
          JSON.parse(raw) as Array<{
            id: string;
            goal: string;
            preset: string;
            at: number;
            threads: number;
          }>,
        );
      }
    } catch {
      /* ignore */
    }
  };

  const refreshSkills = async () => {
    const res = await fetch("/api/skills");
    const d = (await res.json()) as { skills: SkillDetail[] };
    setSkillDetails(d.skills ?? []);
  };

  useEffect(() => {
    setIsDesktop(Boolean(window.loomDesktop?.isDesktop));
    setProgress(loadProgress());
    const s = loadSettings();
    setSettings(s);
    applySettingsToDocument(s);
    void Promise.all([
      refreshMeta(),
      refreshSkills(),
      refreshSessions(),
      refreshPlanHistory(),
    ]).catch((e) => setError(String(e)));
  }, []);

  const updateSettings = (next: LoomSettings) => {
    setSettings(next);
    saveSettings(next);
    applySettingsToDocument(next);
  };

  useEffect(() => {
    if (!workspace) return;
    void fetch(
      `/api/workspace/git?workspace=${encodeURIComponent(workspace)}`,
    )
      .then((r) => r.json())
      .then((d) =>
        setGitInfo({ branch: d.branch ?? null, dirty: d.dirty ?? 0 }),
      )
      .catch(() => setGitInfo(null));
    void fetch(
      `/api/workspace/rules?workspace=${encodeURIComponent(workspace)}`,
    )
      .then((r) => r.json())
      .then((d) => setRulesPath(d.found ? d.path : null))
      .catch(() => setRulesPath(null));
    void fetch(
      `/api/workspace/tree?workspace=${encodeURIComponent(workspace)}&depth=4`,
    )
      .then((r) => r.json())
      .then((d) => {
        const files: string[] = [];
        const walk = (nodes: Array<{ path: string; type: string; children?: unknown[] }>) => {
          for (const n of nodes ?? []) {
            if (n.type === "file") files.push(n.path);
            if (n.children) walk(n.children as typeof nodes);
          }
        };
        walk(d.nodes ?? []);
        setTreeFiles(files.slice(0, 200));
      })
      .catch(() => setTreeFiles([]));
  }, [workspace]);

  useEffect(() => {
    const a = metaRef.current?.agents.find((x) => x.id === agentId);
    if (a) {
      setSkillIds(a.skillIds);
      setModelId(a.defaultModelId);
    }
  }, [agentId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      }
      if (e.key === "Escape") setPaletteOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pushLog = (text: string) =>
    setLogs((prev) => [...prev, { t: Date.now(), text }].slice(-140));

  const openFolder = async () => {
    if (window.loomDesktop?.openDirectory) {
      const dir = await window.loomDesktop.openDirectory();
      if (dir) setWorkspace(dir);
      return;
    }
    setError("在浏览器中请粘贴工作区绝对路径；桌面端可使用打开文件夹。");
  };

  const ingestEvents = (events: Array<Record<string, unknown>>) => {
    for (const e of events) {
      if (e.type === "tool_call") {
        pushLog(`→ ${String(e.name)} ${JSON.stringify(e.args)}`);
      } else if (e.type === "tool_result") {
        const r = e.result as { ok?: boolean } | undefined;
        pushLog(`← ${String(e.name)} ok=${r?.ok}`);
      } else if (e.type === "approval_needed") {
        pushLog(`! 待批准 ${String(e.path)}`);
      } else if (e.type === "text") {
        pushLog(String(e.text).slice(0, 160));
      }
    }
  };

  const stop = () => {
    runTokenRef.current = Date.now();
    abortCtrl?.abort();
    setBusy(false);
    setAbortCtrl(null);
    setPhaseLabel("idle");
    pushLog("已请求中止");
  };

  const attachFile = async (rel: string) => {
    setSelectedFile(rel);
    try {
      const res = await fetch(
        `/api/workspace/file?workspace=${encodeURIComponent(workspace)}&path=${encodeURIComponent(rel)}`,
      );
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "读文件失败");
      setPreview({ path: rel, content: String(data.content ?? "") });
      setContextFiles((prev) => {
        const next = prev.filter((p) => p.path !== rel);
        next.push({ path: rel, content: data.content });
        return next.slice(-4);
      });
      pushLog(`@${rel} 已附加到上下文`);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const persistSession = (title: string, items: ThreadItem[], mode: StudioMode) => {
    const id = sessionId ?? `s-${Date.now()}`;
    setSessionId(id);
    const row = {
      id,
      title: title.slice(0, 48) || "Untitled",
      mode,
      thread: items.slice(-80),
      updatedAt: Date.now(),
    };
    setSessions((prev) => {
      const next = [row, ...prev.filter((s) => s.id !== id)].slice(0, 40);
      try {
        localStorage.setItem("loom.sessions.v1", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    void fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(row),
    }).catch(() => {
      /* server optional on first paint */
    });
  };

  const loadSession = (id: string) => {
    const s = sessions.find((x) => x.id === id);
    if (!s) return;
    abortCtrl?.abort();
    setSessionId(s.id);
    setThread(s.thread);
    setStudioMode(s.mode);
    const writes = s.thread
      .filter(
        (t): t is Extract<ThreadItem, { kind: "hitl" }> =>
          t.kind === "hitl" && t.hitlKind !== "cmd",
      )
      .map((t) => ({
        path: t.path,
        content: t.content,
        diff: t.diff,
        additions: t.additions,
        deletions: t.deletions,
      }));
    const cmds = s.thread
      .filter(
        (t): t is Extract<ThreadItem, { kind: "hitl" }> =>
          t.kind === "hitl" &&
          (t.hitlKind === "cmd" || Boolean(t.command)),
      )
      .map((t) => ({ command: t.command ?? t.path }));
    setPendingWrites(writes);
    setPendingCmds(cmds);
    setView("run");
  };

  const newSession = () => {
    abortCtrl?.abort();
    setSessionId(null);
    setThread([]);
    setAnswer("");
    setPendingWrites([]);
    setPendingCmds([]);
    setWorkflowBanner(null);
    setGoal("");
    setView("run");
    setError(null);
  };

  const renameSession = (id: string, title: string) => {
    const nextTitle = title.trim() || "Untitled";
    setSessions((prev) => {
      const next = prev.map((s) =>
        s.id === id ? { ...s, title: nextTitle, updatedAt: Date.now() } : s,
      );
      try {
        localStorage.setItem("loom.sessions.v1", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      const row = next.find((s) => s.id === id);
      if (row) {
        void fetch(`/api/sessions/${encodeURIComponent(id)}`, {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(row),
        }).catch(() => undefined);
      }
      return next;
    });
  };

  const deleteSessionById = (id: string) => {
    setSessions((prev) => {
      const next = prev.filter((s) => s.id !== id);
      try {
        localStorage.setItem("loom.sessions.v1", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
    void fetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "DELETE",
    }).catch(() => undefined);
    if (sessionId === id) {
      setSessionId(null);
      setThread([]);
      setAnswer("");
      setPendingWrites([]);
      setPendingCmds([]);
    }
  };

  const pushThread = (item: ThreadItem) =>
    setThread((prev) => [...prev, item].slice(-80));

  const hitlKey = (t: Extract<ThreadItem, { kind: "hitl" }>) =>
    t.hitlKind === "cmd" ? `cmd:${t.command ?? t.path}` : `write:${t.path}`;

  const upsertHitl = (item: Extract<ThreadItem, { kind: "hitl" }>) => {
    setThread((prev) => {
      const key = hitlKey(item);
      const idx = prev.findIndex(
        (t) => t.kind === "hitl" && hitlKey(t) === key,
      );
      if (idx === -1) return [...prev, item].slice(-80);
      const next = prev.slice();
      const old = next[idx] as Extract<ThreadItem, { kind: "hitl" }>;
      next[idx] = { ...old, ...item, id: old.id };
      return next;
    });
  };

  const removeHitl = (matcher: {
    hitlKind?: "write" | "cmd";
    path?: string;
    command?: string;
  }) => {
    setThread((prev) =>
      prev.filter((t) => {
        if (t.kind !== "hitl") return true;
        if (matcher.hitlKind === "cmd" || matcher.command) {
          return (t.command ?? t.path) !== (matcher.command ?? matcher.path);
        }
        return t.path !== matcher.path;
      }),
    );
  };

  const runSingle = async (opts?: {
    goal?: string;
    agentId?: string;
    modelId?: string;
    mockScenario?: string;
    skillIds?: string[];
    demoId?: string;
    step?: number;
    /** 工单阶段回写上下文 */
    workflow?: { ticketId: string; stageId: StageId };
  }) => {
    // 等通过校验再挂上 workflowRunRef，避免早退导致工单卡在 running
    const pendingWorkflow = opts?.workflow ?? null;

    const g0 = (opts?.goal ?? goal).trim();
    let g = g0;
    // slash 命令：先算出有效 mode，再 setState（避免读到旧 studioMode）
    let effectiveMode: StudioMode = studioMode;
    if (g.startsWith("/ask ")) {
      effectiveMode = "ask";
      g = g.slice(5).trim();
    } else if (g.startsWith("/agent ")) {
      effectiveMode = "agent";
      g = g.slice(7).trim();
    } else if (g.startsWith("/plan ")) {
      effectiveMode = "plan";
      g = g.slice(6).trim();
    } else if (g === "/explore") {
      g = "总结 sample 工作区定位与入口";
      effectiveMode = "ask";
    } else if (g === "/audit") {
      g = "按安全审计 Skill 扫描工作区风险";
      setAgentId("auditor");
      effectiveMode = "ask";
    }
    if (effectiveMode !== studioMode) setStudioMode(effectiveMode);

    let a = opts?.agentId ?? agentId;
    const m = opts?.modelId ?? modelId;
    const skills = opts?.skillIds ?? skillIds;
    if (!g) {
      if (pendingWorkflow) {
        applyTicketStageResult(pendingWorkflow.ticketId, pendingWorkflow.stageId, {
          summary: "（目标为空，未启动运行）",
          status: "failed",
        });
      }
      return;
    }

    if (effectiveMode === "plan") {
      if (pendingWorkflow) {
        applyTicketStageResult(pendingWorkflow.ticketId, pendingWorkflow.stageId, {
          summary: "（多步任务不支持 /plan，请用 Ask/Agent）",
          status: "failed",
        });
      }
      await runPlan({ goal: g, demoId: opts?.demoId, step: opts?.step });
      return;
    }

    const readOnly = effectiveMode === "ask";
    if (readOnly && a === "editor") a = "reader";

    workflowRunRef.current = pendingWorkflow;
    setWorkflowBanner(pendingWorkflow);

    const ctrl = new AbortController();
    const runToken = Date.now();
    runTokenRef.current = runToken;
    setAbortCtrl(ctrl);
    setView("run");
    setBusy(true);
    setError(null);
    setAnswer("");
    setPendingWrites([]);
    setPendingCmds([]);
    rejectedCmdsRef.current = new Set();
    setPhaseLabel("thinking");
    if (opts?.goal) setGoal(opts.goal);
    if (opts?.agentId) setAgentId(a);
    if (opts?.modelId) setModelId(opts.modelId);
    if (opts?.skillIds) setSkillIds(opts.skillIds);

    const history = thread
      .filter((t) => t.kind === "user" || t.kind === "assistant")
      .slice(-8)
      .map((t) => ({
        role: t.kind as "user" | "assistant",
        content: (t as { text: string }).text,
      }));

    pushThread({
      kind: "user",
      id: `u-${Date.now()}`,
      text:
        g +
        (contextFiles.length
          ? `\n\n@files: ${contextFiles.map((f) => f.path).join(", ")}`
          : ""),
      at: Date.now(),
    });
    pushLog(`stream · mode=${effectiveMode} · ${a} @ ${m}`);

    let finalAnswerForTicket = "";
    let runFailed = false;
    let runAborted = false;
    let failMessage = "";

    try {
      const res = await fetch("/api/run/stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          goal: g,
          workspace,
          agentId: a,
          modelId: m,
          temperature,
          mockScenario: opts?.mockScenario,
          skillIds: skills,
          readOnly,
          history,
          contextFiles,
        }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(
          [err.error, err.hint].filter(Boolean).join(" · ") ||
            `HTTP ${res.status}`,
        );
      }

      const reader = res.body?.getReader();
      if (!reader) throw new Error("无流式响应");
      const decoder = new TextDecoder();
      let buffer = "";
      let assistantBuf = "";
      let turnBuf = "";
      let streamId = `a-${Date.now()}`;

      const syncStreaming = (text: string, streaming: boolean) => {
        if (runTokenRef.current !== runToken) return;
        const id = streamId;
        setThread((prev) => {
          const idx = prev.findIndex(
            (t) => t.kind === "assistant" && t.id === id,
          );
          const item: ThreadItem = {
            kind: "assistant",
            id,
            text,
            at: Date.now(),
            streaming,
          };
          if (idx === -1) return [...prev, item].slice(-80);
          const next = prev.slice();
          next[idx] = item;
          return next;
        });
      };

      while (true) {
        if (runTokenRef.current !== runToken || ctrl.signal.aborted) break;
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split("\n\n");
        buffer = chunks.pop() ?? "";
        for (const chunk of chunks) {
          if (runTokenRef.current !== runToken) break;
          const lines = chunk.split("\n");
          let event = "message";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event:")) event = line.slice(6).trim();
            if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue;
          const payload = JSON.parse(data) as Record<string, unknown>;

          if (event === "phase") {
            const phase = String(payload.phase);
            setPhaseLabel(phase);
            pushThread({
              kind: "phase",
              id: `ph-${Date.now()}-${phase}`,
              phase,
              at: Date.now(),
            });
          } else if (event === "text_delta") {
            const delta = String(payload.delta ?? "");
            turnBuf += delta;
            assistantBuf = turnBuf;
            syncStreaming(turnBuf, true);
          } else if (event === "text") {
            const text = String(payload.text ?? "");
            turnBuf = text;
            assistantBuf = text;
            syncStreaming(text, true);
            pushLog(text.slice(0, 120));
          } else if (event === "tool_call") {
            if (turnBuf) {
              syncStreaming(turnBuf, false);
              turnBuf = "";
              streamId = `a-${Date.now()}`;
            }
            pushThread({
              kind: "tool",
              id: `tc-${Date.now()}-${String(payload.name)}`,
              name: String(payload.name),
              args: payload.args as Record<string, unknown>,
              at: Date.now(),
            });
            pushLog(`→ ${String(payload.name)}`);
          } else if (event === "tool_result") {
            const result = payload.result as {
              ok?: boolean;
              data?: unknown;
              error?: string;
            };
            const name = String(payload.name);
            const notConfigured =
              /not.?configured|未配置|不可用/i.test(String(result?.error ?? "")) ||
              name === "web_search";
            pushThread({
              kind: "tool",
              id: `tr-${Date.now()}-${name}`,
              name,
              ok: result?.ok,
              statusHint: notConfigured
                ? "not_configured"
                : result?.ok === false
                  ? "error"
                  : result?.ok
                    ? "ok"
                    : undefined,
              preview: JSON.stringify(
                result?.data ?? result?.error ?? result,
              ).slice(0, 280),
              at: Date.now(),
            });
          } else if (event === "approval_needed") {
            const kind =
              (payload.kind as "write" | "cmd" | undefined) ??
              (payload.command ? "cmd" : "write");
            if (kind === "cmd") {
              const command = String(payload.command ?? payload.path ?? "");
              pushLog(`! 待批准命令 ${command}`);
              setPendingCmds((prev) =>
                prev.some((x) => x.command === command)
                  ? prev
                  : [...prev, { command }],
              );
              upsertHitl({
                kind: "hitl",
                id: `h-cmd-${Date.now()}-${command}`,
                hitlKind: "cmd",
                path: command,
                content: "",
                command,
                at: Date.now(),
              });
            } else {
              pushLog(`! 待批准 ${String(payload.path)}`);
              upsertHitl({
                kind: "hitl",
                id: `h-${Date.now()}-${String(payload.path)}`,
                hitlKind: "write",
                path: String(payload.path),
                content: String(payload.content ?? ""),
                diff: payload.diff as string | undefined,
                additions: payload.additions as number | undefined,
                deletions: payload.deletions as number | undefined,
                at: Date.now(),
              });
            }
          } else if (event === "done") {
            assistantBuf = String(payload.text ?? assistantBuf);
            turnBuf = assistantBuf;
            syncStreaming(assistantBuf, false);
          } else if (event === "result") {
            const finalText = String(payload.answer ?? assistantBuf);
            finalAnswerForTicket = finalText;
            setAnswer(finalText);
            const writes = (payload.pendingWrites ?? []) as Array<{
              path: string;
              content: string;
              diff?: string;
              additions?: number;
              deletions?: number;
            }>;
            setPendingWrites(writes);
            // 仅 upsert 带 diff 的卡片，避免 result 再插一份重复 HITL
            for (const w of writes) {
              upsertHitl({
                kind: "hitl",
                id: `hr-${Date.now()}-${w.path}`,
                hitlKind: "write",
                path: w.path,
                content: w.content,
                diff: w.diff,
                additions: w.additions,
                deletions: w.deletions,
                at: Date.now(),
              });
            }
            const cmds = (payload.pendingCmds ?? []) as Array<{
              command: string;
            }>;
            if (cmds.length) {
              setPendingCmds(
                cmds.filter((c) => !rejectedCmdsRef.current.has(c.command)),
              );
            }
            if (finalText) {
              syncStreaming(finalText, false);
            }
          } else if (event === "error") {
            throw new Error(String(payload.message ?? "stream error"));
          }
        }
      }

      if (opts?.demoId && opts.step) {
        markDone(opts.demoId, opts.step);
        setLastDemo(opts.demoId);
      }
      if (!finalAnswerForTicket && assistantBuf) {
        finalAnswerForTicket = assistantBuf;
      }
      // 保存 Session（Agents Window）—— 等 setState 刷完
      setTimeout(() => {
        setThread((current) => {
          persistSession(g, current, effectiveMode === "ask" ? "ask" : "agent");
          return current;
        });
      }, 0);
    } catch (e) {
      if (e instanceof Error && e.name === "AbortError") {
        runAborted = true;
        pushLog("已中止");
      } else {
        runFailed = true;
        failMessage = e instanceof Error ? e.message : String(e);
        setError(failMessage);
      }
    } finally {
      const wf = workflowRunRef.current;
      if (wf) {
        const status = runAborted || runFailed ? "failed" : "awaiting_confirm";
        const summary =
          finalAnswerForTicket.trim() ||
          (runAborted
            ? "（运行已中止，无完整产出）"
            : runFailed
              ? `（运行失败）${failMessage}`.trim()
              : "（无文本产出）");
        applyTicketStageResult(wf.ticketId, wf.stageId, { summary, status });
        pushLog(
          status === "failed"
            ? `任务步失败回写 · ${wf.stageId}`
            : `任务步待确认 · ${wf.stageId}`,
        );
        workflowRunRef.current = null;
      }
      if (runTokenRef.current === runToken) {
        setBusy(false);
        setAbortCtrl(null);
        setPhaseLabel("idle");
      }
    }
  };

  const runPlan = async (opts?: {
    goal?: string;
    preset?: typeof planPreset;
    demoId?: string;
    step?: number;
    /** 上手 Demo 强制 mock；默认 undefined = 服务端 auto */
    preferReal?: boolean;
  }) => {
    const g = (opts?.goal ?? goal).trim() || "探索工作区并总结";
    const preset = opts?.preset ?? planPreset;
    const ctrl = new AbortController();
    setAbortCtrl(ctrl);
    setView("plan");
    setBusy(true);
    setError(null);
    setSteps([]);
    setMerged("");
    setPendingWrites([]);
    if (opts?.goal) setGoal(opts.goal);
    if (opts?.preset) setPlanPreset(opts.preset);
    pushLog(`plan · ${preset}`);

    try {
      const res = await fetch("/api/plan", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          goal: g,
          workspace,
          preset,
          preferReal: opts?.preferReal,
          workers:
            preset === "custom"
              ? workers.map((w) => ({
                  title: w.title,
                  agentId: w.agentId,
                  modelId: w.modelId,
                  goal: w.goal || g,
                }))
              : undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
      setSteps(data.steps ?? []);
      setMerged(data.merged ?? "");
      const writes = (data.pendingWrites ?? []) as Array<{
        path: string;
        content: string;
      }>;
      setPendingWrites(writes);
      pushLog(
        `plan done · ${(data.steps ?? []).length} threads · models=${(
          data.workers as Array<{ modelId: string }> | undefined
        )
          ?.map((w) => w.modelId)
          .join(",") || "—"}`,
      );
      if (writes.length) pushLog(`pending writes · ${writes.length}`);
      const entry = {
        id: String(data.plan?.id ?? Date.now()),
        goal: g,
        preset,
        at: Date.now(),
        threads: (data.steps ?? []).length,
      };
      setPlanHistory((prev) => {
        const next = [entry, ...prev.filter((h) => h.id !== entry.id)].slice(
          0,
          12,
        );
        try {
          localStorage.setItem("loom.plan.history.v1", JSON.stringify(next));
        } catch {
          /* ignore */
        }
        return next;
      });
      void refreshPlanHistory();
      if (opts?.demoId && opts.step) {
        markDone(opts.demoId, opts.step);
        setLastDemo(opts.demoId);
      }
    } catch (e) {
      if (!(e instanceof Error && e.name === "AbortError")) {
        setError(e instanceof Error ? e.message : String(e));
      }
    } finally {
      setBusy(false);
      setAbortCtrl(null);
    }
  };

  const launchDemo = async (demo: DemoRecipe) => {
    if (demo.id === "custom-agent-hint") {
      setView("agents");
      markDone(demo.id, demo.step);
      return;
    }
    if (demo.kind === "plan" && demo.plan) {
      // 有真模型：preferReal 默认 true；无 Key：自动回落 mock
      // plan-homo-offline 强制离线脚本（仅该卡片）
      const forceMock = demo.id === "plan-homo-offline";
      await runPlan({
        goal: demo.plan.goal,
        preset: demo.plan.preset,
        demoId: demo.id,
        step: demo.step,
        preferReal: forceMock ? false : true,
      });
      return;
    }
    if (demo.run) {
      // 有可用真模型（meta.preferredModelId）时 Demo 不走 mock 测试数据
      const realId = meta?.preferredModelId ?? null;
      const useReal = Boolean(realId);
      const agentId = demo.run.agentId;
      const agent = meta?.agents.find((a) => a.id === agentId);
      await runSingle({
        goal: demo.run.goal,
        agentId,
        modelId: useReal ? realId! : demo.run.modelId,
        mockScenario: useReal ? undefined : demo.run.mockScenario,
        skillIds: agent?.skillIds,
        demoId: demo.id,
        step: demo.step,
      });
    }
  };

  const approveWrite = async (w: { path: string; content: string }) => {
    const res = await fetch("/api/writes/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, ...w }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      error?: string;
      previous?: string | null;
      created?: boolean;
      path?: string;
    };
    if (!res.ok) {
      setError(data.error || "批准失败");
      return;
    }
    pushLog(`approved · ${w.path}`);
    setWriteUndoStack((prev) =>
      [
        {
          path: w.path,
          previous: data.previous ?? null,
          created: Boolean(data.created),
          content: w.content,
        },
        ...prev.filter((x) => x.path !== w.path),
      ].slice(0, 20),
    );
    setPendingWrites((prev) => prev.filter((x) => x.path !== w.path));
    removeHitl({ hitlKind: "write", path: w.path });
  };

  const undoWrite = async (entry: {
    path: string;
    previous: string | null;
    created: boolean;
  }) => {
    const res = await fetch("/api/writes/undo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, ...entry }),
    });
    const data = (await res.json()) as { ok?: boolean; error?: string };
    if (!res.ok) {
      setError(data.error || "撤回失败");
      return;
    }
    pushLog(`undone · ${entry.path}`);
    setWriteUndoStack((prev) => prev.filter((x) => x.path !== entry.path));
  };

  const undoLastWrite = async () => {
    const last = writeUndoStack[0];
    if (!last) return;
    await undoWrite(last);
  };

  const undoAllWrites = async () => {
    const list = [...writeUndoStack];
    for (const entry of list) {
      await undoWrite(entry);
    }
  };

  const rejectWrite = async (w: { path: string; content: string }) => {
    await fetch("/api/writes/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ path: w.path }),
    });
    pushLog(`rejected · ${w.path}`);
    setPendingWrites((prev) => prev.filter((x) => x.path !== w.path));
    removeHitl({ hitlKind: "write", path: w.path });
  };

  const approveCmd = async (c: { command: string }) => {
    const res = await fetch("/api/cmds/approve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workspace, command: c.command }),
    });
    const data = (await res.json()) as {
      ok?: boolean;
      stdout?: string;
      stderr?: string;
      error?: string;
      exitCode?: number | null;
    };
    if (!res.ok) {
      setError(data.error || "命令执行失败");
      pushThread({
        kind: "tool",
        id: `cmd-err-${Date.now()}`,
        name: "run_safe_cmd",
        ok: false,
        statusHint: "error",
        preview: data.error || "失败",
        at: Date.now(),
      });
      return;
    }
    removeHitl({ hitlKind: "cmd", command: c.command });
    setPendingCmds((prev) => prev.filter((x) => x.command !== c.command));
    pushLog(`cmd ok · ${c.command}`);
    pushThread({
      kind: "tool",
      id: `cmd-ok-${Date.now()}`,
      name: "run_safe_cmd",
      ok: data.ok !== false,
      statusHint: data.ok === false ? "error" : "ok",
      preview: JSON.stringify({
        exitCode: data.exitCode,
        stdout: (data.stdout ?? "").slice(0, 400),
        stderr: (data.stderr ?? "").slice(0, 200),
      }),
      at: Date.now(),
    });
  };

  const rejectCmd = async (c: { command: string }) => {
    await fetch("/api/cmds/reject", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ command: c.command }),
    });
    rejectedCmdsRef.current.add(c.command);
    pushLog(`cmd rejected · ${c.command}`);
    setPendingCmds((prev) => prev.filter((x) => x.command !== c.command));
    removeHitl({ hitlKind: "cmd", command: c.command });
  };

  const acceptAllWrites = async () => {
    const list = [...pendingWrites];
    for (const w of list) {
      await approveWrite(w);
    }
  };

  const rejectAllWrites = async () => {
    const list = [...pendingWrites];
    for (const w of list) {
      await rejectWrite(w);
    }
  };

  const saveAgent = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        action: "upsert",
        id: draftAgent.id || undefined,
        name: draftAgent.name,
        systemPrompt: draftAgent.systemPrompt,
        defaultModelId: draftAgent.defaultModelId,
        allowedTools: draftAgent.allowedTools,
        skillIds: draftAgent.skillIds,
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "保存失败");
      return;
    }
    await refreshMeta();
    if (data.agent?.id) {
      setAgentId(data.agent.id);
      setDraftAgent((d) => ({ ...d, id: data.agent.id }));
    }
    markDone("custom-agent-hint", 4);
    pushLog(`agent saved · ${data.agent?.id}`);
  };

  const createFromTemplate = async (templateId: string) => {
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "from_template", templateId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "模板创建失败");
      return;
    }
    await refreshMeta();
    const a = data.agent as Agent;
    setDraftAgent({
      id: a.id,
      name: a.name,
      systemPrompt: a.systemPrompt,
      defaultModelId: a.defaultModelId,
      allowedTools: a.allowedTools,
      skillIds: a.skillIds,
    });
    setAgentId(a.id);
    markDone("custom-agent-hint", 4);
    pushLog(`template · ${templateId} → ${a.id}`);
  };

  const openNewSkillForm = () => {
    setDraftSkill({ id: "", name: "", description: "", body: "" });
    setSkillError(null);
    setSkillFormOpen(true);
    setImportOpen(false);
  };

  const openEditSkill = (s: SkillDetail) => {
    setDraftSkill({
      id: s.id,
      name: s.name,
      description: s.description,
      body: s.body || s.bodyPreview || "",
    });
    setSkillError(null);
    setSkillFormOpen(true);
    setImportOpen(false);
  };

  const openCopySkill = (s: SkillDetail) => {
    setDraftSkill({
      id: `${s.id}-custom`,
      name: `${s.name}（自定义）`,
      description: s.description,
      body: s.body || s.bodyPreview || "",
    });
    setSkillError(null);
    setSkillFormOpen(true);
    setImportOpen(false);
  };

  const saveSkill = async (e: FormEvent) => {
    e.preventDefault();
    setSkillBusy(true);
    setSkillError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draftSkill.name,
          description: draftSkill.description,
          body: draftSkill.body,
          ...(draftSkill.id.trim() ? { id: draftSkill.id.trim() } : {}),
        }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSkillError(data.error || "保存失败");
        return;
      }
      await Promise.all([refreshSkills(), refreshMeta()]);
      setSkillFormOpen(false);
      if (data.skill?.id) {
        setDraftSkill((d) => ({ ...d, id: data.skill.id }));
      }
      pushLog(`skill saved · ${data.skill?.id ?? draftSkill.name}`);
    } catch (err) {
      setSkillError(String(err));
    } finally {
      setSkillBusy(false);
    }
  };

  const importSkill = async () => {
    setSkillBusy(true);
    setSkillError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "import", markdown: importMarkdown }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSkillError(data.error || "导入失败");
        return;
      }
      await Promise.all([refreshSkills(), refreshMeta()]);
      setImportOpen(false);
      setImportMarkdown("");
      pushLog(`skill imported · ${data.skill?.id ?? ""}`);
    } catch (err) {
      setSkillError(String(err));
    } finally {
      setSkillBusy(false);
    }
  };

  const removeSkill = async (id: string) => {
    const ok = await confirm({
      title: "删除 Skill",
      message: `确定删除自定义 Skill「${id}」？`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    setSkillBusy(true);
    setSkillError(null);
    try {
      const res = await fetch("/api/skills", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id }),
      });
      const data = await res.json();
      if (!res.ok) {
        setSkillError(data.error || "删除失败");
        return;
      }
      await Promise.all([refreshSkills(), refreshMeta()]);
      setSkillIds((prev) => prev.filter((x) => x !== id));
      pushLog(`skill deleted · ${id}`);
    } catch (err) {
      setSkillError(String(err));
    } finally {
      setSkillBusy(false);
    }
  };

  const cloneAgent = async (sourceId: string) => {
    const res = await fetch("/api/agents", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "clone", sourceId }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "克隆失败");
      return;
    }
    await refreshMeta();
    const a = data.agent as Agent;
    setDraftAgent({
      id: a.id,
      name: a.name,
      systemPrompt: a.systemPrompt,
      defaultModelId: a.defaultModelId,
      allowedTools: a.allowedTools,
      skillIds: a.skillIds,
    });
    setAgentId(a.id);
    pushLog(`cloned · ${sourceId} → ${a.id}`);
  };

  const editAgent = (a: Agent) => {
    if (a.builtin) {
      void cloneAgent(a.id);
      return;
    }
    setDraftAgent({
      id: a.id,
      name: a.name,
      systemPrompt: a.systemPrompt,
      defaultModelId: a.defaultModelId,
      allowedTools: a.allowedTools,
      skillIds: a.skillIds,
    });
  };

  const removeAgent = async (id: string) => {
    const ok = await confirm({
      title: "删除 Agent",
      message: `确定删除自定义 Agent「${id}」？`,
      confirmLabel: "删除",
      tone: "danger",
    });
    if (!ok) return;
    const res = await fetch("/api/agents", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id }),
    });
    const data = await res.json();
    if (!res.ok) {
      setError(data.error || "删除失败");
      return;
    }
    await refreshMeta();
    setDraftAgent((d) => (d.id === id ? { ...d, id: "" } : d));
  };

  const deletePlanHistory = (row: {
    id: string;
    at: number;
  }) => {
    setPlanHistory((prev) => {
      const next = prev.filter(
        (h) => !(h.id === row.id && h.at === row.at),
      );
      try {
        localStorage.setItem("loom.plan.history.v1", JSON.stringify(next));
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  const demos = meta?.demos ?? [];
  const paletteActions: PaletteAction[] = useMemo(
    () => [
      {
        id: "mode-ask",
        label: "切换 Ask 模式",
        hint: "只读问答",
        group: "Mode",
        run: () => {
          setStudioMode("ask");
          setView("run");
        },
      },
      {
        id: "mode-agent",
        label: "切换 Agent 模式",
        hint: "可写 + Diff HITL",
        group: "Mode",
        run: () => {
          setStudioMode("agent");
          setView("run");
        },
      },
      {
        id: "mode-plan",
        label: "切换 Plan 模式",
        hint: "并行 Plan Board",
        group: "Mode",
        run: () => {
          setStudioMode("plan");
          setView("run");
        },
      },
      {
        id: "demo-explore",
        label: "运行 · 探索示例",
        group: "Demo",
        run: () => {
          const d = demos.find((x) => x.id === "explore-readme");
          if (d) void launchDemo(d);
        },
      },
      {
        id: "demo-write",
        label: "运行 · 写审批 HITL",
        group: "Demo",
        run: () => {
          const d = demos.find((x) => x.id === "write-hitl");
          if (d) void launchDemo(d);
        },
      },
      {
        id: "demo-hetero",
        label: "运行 · 异构 Plan",
        group: "Demo",
        run: () => {
          const d = demos.find((x) => x.id === "plan-hetero");
          if (d) void launchDemo(d);
        },
      },
      {
        id: "nav-home",
        label: "打开 Home",
        group: "Nav",
        run: () => {
          setHomeTab("landing");
          setView("home");
        },
      },
      {
        id: "nav-guide",
        label: "功能说明",
        group: "Nav",
        run: () => {
          setHomeTab("guide");
          setView("home");
        },
      },
      {
        id: "nav-history",
        label: "历史（会话 / Plan）",
        group: "Nav",
        run: () => {
          setHomeTab("history");
          setView("home");
        },
      },
      {
        id: "nav-new-session",
        label: "新建 Run 会话",
        group: "Nav",
        run: () => newSession(),
      },
      {
        id: "nav-skills",
        label: "打开 Skills",
        group: "Nav",
        run: () => setView("skills"),
      },
      {
        id: "nav-agents",
        label: "打开 Agents",
        group: "Nav",
        run: () => setView("agents"),
      },
      {
        id: "nav-models",
        label: "打开 Models",
        group: "Nav",
        run: () => setView("models"),
      },
      {
        id: "nav-workflow",
        label: "打开多步任务",
        group: "Nav",
        run: () => setView("workflow"),
      },
      {
        id: "nav-settings",
        label: "打开外观设置",
        group: "Nav",
        run: () => setView("settings"),
      },
      {
        id: "clear-thread",
        label: "清空 Composer 线程",
        group: "Composer",
        run: () => setThread([]),
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [demos],
  );

  const nav: Array<{ id: ViewId; label: string }> = [
    { id: "home", label: "Home" },
    { id: "workflow", label: "任务" },
    { id: "run", label: "Run" },
    { id: "plan", label: "Plan" },
    { id: "agents", label: "Agents" },
    { id: "skills", label: "Skills" },
    { id: "models", label: "Models" },
    { id: "settings", label: "设置" },
  ];

  const launchWorkflowStage = (input: {
    ticketId: string;
    stageId: StageId;
    goal: string;
    preferAgent?: boolean;
  }) => {
    const mode: StudioMode = input.preferAgent ? "agent" : "ask";
    const aid = input.preferAgent ? "editor" : "reader";
    setStudioMode(mode);
    setAgentId(aid);
    setGoal(input.goal);
    setView("run");
    void runSingle({
      goal: input.goal,
      agentId: aid,
      workflow: { ticketId: input.ticketId, stageId: input.stageId },
    });
  };

  return (
    <div className="app">
      <header className="titlebar">
        <div className="traffic" aria-hidden>
          <i className="r" />
          <i className="y" />
          <i className="g" />
        </div>
        <div className="brand">
          LOOM
          <em>{isDesktop ? "Desktop" : "Studio"} · Coding Agent</em>
        </div>
        <div className="no-drag row-actions" style={{ marginLeft: "auto" }}>
          {busy ? (
            <button type="button" className="btn sm danger" onClick={stop}>
              停止
            </button>
          ) : null}
          <button
            type="button"
            className="btn sm primary"
            disabled={busy}
            onClick={() => {
              const d = demos.find((x) => x.id === "plan-hetero");
              if (d) void launchDemo(d);
            }}
          >
            异构 Plan
          </button>
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => {
              const d = demos.find((x) => x.id === "write-hitl");
              if (d) void launchDemo(d);
            }}
          >
            写审批
          </button>
        </div>
      </header>

      <div className="body">
        <nav className="rail" aria-label="主导航">
          {nav.map((n) => (
            <button
              key={n.id}
              type="button"
              data-id={n.id}
              className={view === n.id ? "active" : ""}
              onClick={() => setView(n.id)}
              title={n.label}
            >
              <span className="ico" />
              {n.label}
            </button>
          ))}
        </nav>

        <div className="main">
          <div className="workspace-bar">
            <span className="path-label">Workspace</span>
            <input
              value={workspace}
              onChange={(e) => setWorkspace(e.target.value)}
              placeholder="/path/to/project"
            />
            <button type="button" className="btn" onClick={() => void openFolder()}>
              打开文件夹
            </button>
          </div>

          <div className="status-strip" hidden={!settings.showStatusStrip}>
            <span className="chip">
              Agent <strong>{agentId}</strong>
            </span>
            <span className="chip">
              Model <strong>{modelId}</strong>
            </span>
            <span className="chip">
              Skills <strong>{skillIds.length}</strong>
            </span>
            <span className="chip">
              Ready <strong>
                {readyModels}/{meta?.models.length ?? "—"}
              </strong>
            </span>
            <span className="chip">
              HITL <strong>{pendingWrites.length + pendingCmds.length}</strong>
            </span>
            {lastDemo ? (
              <span className="chip">
                Demo <strong>{lastDemo}</strong>
              </span>
            ) : null}
            {busy ? (
              <span className="chip">
                <strong>running</strong>
              </span>
            ) : null}
          </div>

          {error ? <div className="err">{error}</div> : null}

          {view === "home" ? (
            <HomeView
              tab={homeTab}
              onTabChange={setHomeTab}
              demos={demos}
              progress={progress}
              busy={busy}
              sessions={sessions.map((s) => ({
                id: s.id,
                title: s.title,
                mode: s.mode,
                updatedAt: s.updatedAt,
              }))}
              planHistory={planHistory}
              readyModels={readyModels}
              modelTotal={meta?.models.length ?? 0}
              onLaunchDemo={(d) => {
                const full = demos.find((x) => x.id === d.id);
                if (full) void launchDemo(full);
              }}
              onOpenNav={(id) => {
                if (id === "home") {
                  setHomeTab("guide");
                  setView("home");
                  return;
                }
                const map: Record<string, ViewId> = {
                  workflow: "workflow",
                  run: "run",
                  plan: "plan",
                  agents: "agents",
                  skills: "skills",
                  models: "models",
                  settings: "settings",
                  hitl: "run",
                  sessions: "run",
                };
                setView(map[id] ?? "home");
              }}
              onNewSession={newSession}
              onOpenSession={loadSession}
              onRenameSession={renameSession}
              onDeleteSession={deleteSessionById}
              onLoadPlan={(row) => {
                setGoal(row.goal);
                if (
                  row.preset === "homo" ||
                  row.preset === "hetero" ||
                  row.preset === "triple" ||
                  row.preset === "custom"
                ) {
                  setPlanPreset(row.preset);
                }
                setView("plan");
              }}
              onDeletePlan={deletePlanHistory}
              onClearProgress={() => {
                setProgress({});
                localStorage.removeItem(PROGRESS_KEY);
              }}
            />
          ) : null}

          {view === "workflow" ? (
            <WorkflowView busy={busy} onRunStage={launchWorkflowStage} />
          ) : null}

          {view === "run" ? (
            <div className="view run composer">
              <aside className="col explorer">
                <div className="col-hd">
                  <span>Explorer</span>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        setHomeTab("history");
                        setView("home");
                      }}
                    >
                      历史
                    </button>
                    <button
                      type="button"
                      className="btn sm ghost"
                      onClick={newSession}
                    >
                      新建
                    </button>
                  </div>
                </div>
                <div className="col-bd">
                  <div className="session-rail">
                    <div className="hint" style={{ margin: "0 0 4px" }}>
                      Sessions（{sessions.length}）
                    </div>
                    {sessions.length === 0 ? (
                      <div className="empty" style={{ padding: "4px 0" }}>
                        尚无会话 · 点「新建」开始
                      </div>
                    ) : (
                      sessions.map((s) => (
                        <div key={s.id} className="session-row">
                          <button
                            type="button"
                            className={`session-item ${sessionId === s.id ? "active" : ""}`}
                            onClick={() => loadSession(s.id)}
                          >
                            <div className="t">{s.title}</div>
                            <div className="m">
                              {s.mode} ·{" "}
                              {new Date(s.updatedAt).toLocaleString()}
                            </div>
                          </button>
                          <button
                            type="button"
                            className="btn sm ghost session-del"
                            title="删除会话"
                            onClick={() => {
                              void (async () => {
                                const ok = await confirm({
                                  title: "删除会话",
                                  message: `确定删除「${s.title}」？`,
                                  confirmLabel: "删除",
                                  tone: "danger",
                                });
                                if (ok) deleteSessionById(s.id);
                              })();
                            }}
                          >
                            ×
                          </button>
                        </div>
                      ))
                    )}
                  </div>
                  {gitInfo ? (
                    <div className="git-pill">
                      git {gitInfo.branch ?? "—"}
                      {gitInfo.dirty ? ` · ${gitInfo.dirty} dirty` : " · clean"}
                      {rulesPath ? ` · rules:${rulesPath}` : ""}
                    </div>
                  ) : null}
                  <p className="hint">点击文件 = 预览 + @context（最多 4）</p>
                  <FileTree
                    workspace={workspace}
                    selected={selectedFile}
                    onPickFile={(p) => void attachFile(p)}
                  />
                  {preview ? (
                    <div className="preview-pane">
                      <div className="hint mono">{preview.path}</div>
                      <pre>{preview.content.slice(0, 1200)}</pre>
                    </div>
                  ) : null}
                  {contextFiles.length > 0 ? (
                    <div className="ctx-chips">
                      {contextFiles.map((f) => (
                        <button
                          key={f.path}
                          type="button"
                          className="ctx-chip"
                          onClick={() =>
                            setContextFiles((prev) =>
                              prev.filter((x) => x.path !== f.path),
                            )
                          }
                          title="点击移除"
                        >
                          @{f.path.split("/").pop()}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              </aside>

              <section className="col composer-main">
                <div className="col-hd">
                  <span>Composer</span>
                  <span className="hint">{phaseLabel || "idle"}</span>
                </div>
                {workflowBanner ? (
                  <div className="callout workflow-run-banner">
                    多步任务进行中：
                    {STAGE_DEFS.find((s) => s.id === workflowBanner.stageId)
                      ?.title ?? workflowBanner.stageId}
                    {busy
                      ? " · 结束后摘要会回写任务"
                      : " · 已回写，可返回确认下一步"}
                    <button
                      type="button"
                      className="btn sm primary"
                      style={{ marginLeft: 8 }}
                      onClick={() => {
                        setView("workflow");
                        setWorkflowBanner(null);
                      }}
                    >
                      返回任务
                    </button>
                  </div>
                ) : null}
                <div className="mode-tabs">
                  {(
                    [
                      ["ask", "Ask · 只读"],
                      ["agent", "Agent · 可写"],
                      ["plan", "Plan · 并行"],
                    ] as const
                  ).map(([id, label]) => (
                    <button
                      key={id}
                      type="button"
                      className={studioMode === id ? "active" : ""}
                      onClick={() => {
                        setStudioMode(id);
                        if (id === "ask" && agentId === "editor") {
                          setAgentId("reader");
                        }
                        if (id === "agent" && agentId === "reader") {
                          /* keep */
                        }
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>
                <div className="col-bd composer-body">
                  <ComposerThread
                    items={thread}
                    onApprove={(w) => void approveWrite(w)}
                    onReject={(w) => void rejectWrite(w)}
                    onApproveCmd={(c) => void approveCmd(c)}
                    onRejectCmd={(c) => void rejectCmd(c)}
                  />
                </div>
                <div className="composer-input">
                  {mentionOpen ? (
                    <div className="mention-menu">
                      {treeFiles
                        .filter((p) =>
                          mentionQ
                            ? p.toLowerCase().includes(mentionQ.toLowerCase())
                            : true,
                        )
                        .slice(0, 12)
                        .map((p) => (
                          <button
                            key={p}
                            type="button"
                            className="mention-item"
                            onClick={() => {
                              void attachFile(p);
                              setGoal((g) => g.replace(/@[\w./-]*$/, `@${p} `));
                              setMentionOpen(false);
                            }}
                          >
                            @{p}
                          </button>
                        ))}
                    </div>
                  ) : null}
                  <textarea
                    value={goal}
                    onChange={(e) => {
                      const v = e.target.value;
                      setGoal(v);
                      const m = v.match(/@([\w./-]*)$/);
                      if (m) {
                        setMentionOpen(true);
                        setMentionQ(m[1] ?? "");
                      } else {
                        setMentionOpen(false);
                      }
                    }}
                    placeholder={
                      studioMode === "ask"
                        ? "Ask：只读提问…  输入 @ 引用文件  /explore"
                        : studioMode === "plan"
                          ? "Plan：总目标… 然后启动并行 Board"
                          : "Agent：任务… @文件 · ⌘K · ⌘↵ 发送"
                    }
                    onKeyDown={(e) => {
                      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                        e.preventDefault();
                        void runSingle();
                      }
                      if (e.key === "Escape") setMentionOpen(false);
                    }}
                  />
                  <div className="composer-bar">
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => setPaletteOpen(true)}
                      >
                        ⌘K
                      </button>
                      <button
                        type="button"
                        className="btn sm ghost"
                        onClick={() => {
                          setThread([]);
                          newSession();
                        }}
                      >
                        清空线程
                      </button>
                    </div>
                    <div className="row-actions">
                      {busy ? (
                        <button
                          type="button"
                          className="btn sm danger"
                          onClick={stop}
                        >
                          停止
                        </button>
                      ) : null}
                      <button
                        type="button"
                        className="btn sm primary"
                        disabled={busy || !goal.trim()}
                        onClick={() => void runSingle()}
                      >
                        {busy
                          ? "运行中…"
                          : studioMode === "plan"
                            ? "启动 Plan"
                            : "发送 ⌘↵"}
                      </button>
                    </div>
                  </div>
                </div>
              </section>

              <aside className="col">
                <div className="col-hd">配置 / Diff HITL</div>
                <div className="col-bd">
                  <div className="field">
                    <label>Agent</label>
                    <select
                      value={agentId}
                      onChange={(e) => setAgentId(e.target.value)}
                      disabled={studioMode === "ask"}
                    >
                      {(meta?.agents ?? []).map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Model</label>
                    <select
                      value={modelId}
                      onChange={(e) => setModelId(e.target.value)}
                    >
                      {(meta?.models ?? []).map((m) => (
                        <option
                          key={m.id}
                          value={m.id}
                          disabled={!m.availability.ready}
                        >
                          {m.id}
                          {!m.availability.ready ? "（未就绪）" : ""}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Skills</label>
                    <div className="skill-toggles">
                      {(meta?.skills ?? []).map((s) => {
                        const on = skillIds.includes(s.id);
                        return (
                          <button
                            key={s.id}
                            type="button"
                            className={on ? "on" : ""}
                            onClick={() =>
                              setSkillIds((prev) =>
                                on
                                  ? prev.filter((x) => x !== s.id)
                                  : [...prev, s.id],
                              )
                            }
                          >
                            {s.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="section-title">Changeset</div>
                  {pendingWrites.length === 0 ? (
                    <div className="empty">
                      无线程待批。Agent 写文件后出现 Diff。
                      {writeUndoStack.length > 0 ? (
                        <div className="changeset-undo-hint">
                          最近已批 {writeUndoStack.length} 个文件，可撤回。
                          <button
                            type="button"
                            className="btn sm"
                            style={{ marginLeft: 8 }}
                            onClick={() => void undoLastWrite()}
                          >
                            撤回最近一次
                          </button>
                          {writeUndoStack.length > 1 ? (
                            <button
                              type="button"
                              className="btn sm danger"
                              style={{ marginLeft: 6 }}
                              onClick={() => void undoAllWrites()}
                            >
                              全部撤回
                            </button>
                          ) : null}
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <>
                      <div className="changeset-bar">
                        <div className="changeset-stats">
                          <span>
                            {pendingWrites.length} 文件
                          </span>
                          <span className="ok">
                            +
                            {pendingWrites.reduce(
                              (n, w) => n + (w.additions ?? 0),
                              0,
                            )}
                          </span>
                          <span className="danger">
                            −
                            {pendingWrites.reduce(
                              (n, w) => n + (w.deletions ?? 0),
                              0,
                            )}
                          </span>
                        </div>
                        <button
                          type="button"
                          className="btn ok sm"
                          onClick={() => void acceptAllWrites()}
                        >
                          Accept all
                        </button>
                        <button
                          type="button"
                          className="btn danger sm"
                          onClick={() => void rejectAllWrites()}
                        >
                          Reject all
                        </button>
                        {writeUndoStack.length > 0 ? (
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => void undoLastWrite()}
                            title="撤回最近一次已批准写入"
                          >
                            撤回已批
                          </button>
                        ) : null}
                        {writeUndoStack.length > 1 ? (
                          <button
                            type="button"
                            className="btn sm danger"
                            onClick={() => void undoAllWrites()}
                            title="撤回本会话全部已批准写入"
                          >
                            全部撤回
                          </button>
                        ) : null}
                      </div>
                      {pendingWrites.map((w) => (
                      <div key={w.path} className="hitl">
                        <DiffBlock
                          path={w.path}
                          diff={w.diff}
                          additions={w.additions}
                          deletions={w.deletions}
                        />
                        {!w.diff ? (
                          <pre>{w.content.slice(0, 400)}</pre>
                        ) : null}
                        <div className="row-actions">
                          <button
                            type="button"
                            className="btn ok sm"
                            onClick={() => void approveWrite(w)}
                          >
                            Accept
                          </button>
                          <button
                            type="button"
                            className="btn danger sm"
                            onClick={() => void rejectWrite(w)}
                          >
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                    </>
                  )}
                  {answer ? (
                    <>
                      <div className="section-title">Latest answer</div>
                      <div className="answer">{answer}</div>
                    </>
                  ) : null}
                </div>
              </aside>
            </div>
          ) : null}

          {view === "plan" ? (
            <div className="view plan">
              <section className="col">
                <div className="col-hd">Plan 编排</div>
                <div className="col-bd">
                  <div className="callout">
                    <strong>Plan Board：</strong>
                    Worker 各自绑定 Agent × 模型，并行后合并。
                  </div>
                  <div className="field">
                    <label>总目标</label>
                    <textarea
                      value={goal}
                      onChange={(e) => setGoal(e.target.value)}
                    />
                  </div>
                  <div className="field">
                    <label>预设</label>
                    <select
                      value={planPreset}
                      onChange={(e) =>
                        setPlanPreset(e.target.value as typeof planPreset)
                      }
                    >
                      {(meta?.planPresets ?? []).map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  {planPreset === "custom" ? (
                    <div className="board">
                      {workers.map((w, i) => (
                        <div key={i} className="step">
                          <div className="field">
                            <label>标题</label>
                            <input
                              value={w.title}
                              onChange={(e) => {
                                const next = [...workers];
                                next[i] = { ...w, title: e.target.value };
                                setWorkers(next);
                              }}
                            />
                          </div>
                          <div className="field">
                            <label>Agent / Model</label>
                            <select
                              value={w.agentId}
                              onChange={(e) => {
                                const next = [...workers];
                                next[i] = { ...w, agentId: e.target.value };
                                setWorkers(next);
                              }}
                            >
                              {(meta?.agents ?? []).map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name}
                                </option>
                              ))}
                            </select>
                            <select
                              value={w.modelId}
                              onChange={(e) => {
                                const next = [...workers];
                                next[i] = { ...w, modelId: e.target.value };
                                setWorkers(next);
                              }}
                            >
                              {(meta?.models ?? []).map((m) => (
                                <option
                                  key={m.id}
                                  value={m.id}
                                  disabled={!m.availability.ready}
                                >
                                  {m.id}
                                </option>
                              ))}
                            </select>
                          </div>
                        </div>
                      ))}
                    </div>
                  ) : null}
                  <div className="row-actions" style={{ marginTop: 12 }}>
                    <button
                      type="button"
                      className="btn primary"
                      disabled={busy}
                      onClick={() => void runPlan()}
                    >
                      {busy ? "并行中…" : "启动 Plan Board"}
                    </button>
                    {pendingWrites.length > 0 ? (
                      <button
                        type="button"
                        className="btn"
                        onClick={() => setView("run")}
                      >
                        去审批（{pendingWrites.length}）
                      </button>
                    ) : null}
                  </div>
                </div>
              </section>
              <section className="col">
                <div className="col-hd">Board</div>
                <div className="col-bd">
                  <div className="board">
                    {steps.length === 0 ? (
                      <div className="empty">尚未运行。</div>
                    ) : (
                      steps.map((s) => (
                        <div key={s.id} className="step">
                          <div className="meta">
                            <strong>{s.title}</strong>
                            <span className={`badge ${s.status}`}>{s.status}</span>
                          </div>
                          <div className="hint">
                            {s.agentId} · {s.modelId}
                          </div>
                          <pre className="log" style={{ marginTop: 8 }}>
                            {s.error || s.resultPreview || "…"}
                          </pre>
                        </div>
                      ))
                    )}
                  </div>
                  {merged ? (
                    <div className="answer" style={{ marginTop: 12 }}>
                      {merged}
                    </div>
                  ) : null}
                  {planHistory.length > 0 ? (
                    <>
                      <div className="section-title">最近 Plan</div>
                      <div className="board">
                        {planHistory.slice(0, 12).map((h) => (
                          <div key={h.id + h.at} className="step">
                            <div className="meta">
                              <strong className="mono">{h.id.slice(0, 10)}</strong>
                              <span className="badge pending">{h.preset}</span>
                            </div>
                            <div className="hint">
                              {new Date(h.at).toLocaleString()} · {h.threads}{" "}
                              threads
                            </div>
                            <div className="hint">{h.goal}</div>
                            <button
                              type="button"
                              className="btn sm"
                              style={{ marginTop: 6 }}
                              onClick={() => {
                                setGoal(h.goal);
                                if (
                                  h.preset === "homo" ||
                                  h.preset === "hetero" ||
                                  h.preset === "triple" ||
                                  h.preset === "custom"
                                ) {
                                  setPlanPreset(h.preset);
                                }
                              }}
                            >
                              载入目标
                            </button>
                            <button
                              type="button"
                              className="btn sm danger"
                              style={{ marginTop: 6, marginLeft: 6 }}
                              onClick={() => {
                                void (async () => {
                                  const label = h.goal.slice(0, 48) || h.id;
                                  const ok = await confirm({
                                    title: "删除 Plan 记录",
                                    message: `确定删除「${label}」？`,
                                    confirmLabel: "删除",
                                    tone: "danger",
                                  });
                                  if (ok) deletePlanHistory(h);
                                })();
                              }}
                            >
                              删除
                            </button>
                          </div>
                        ))}
                      </div>
                    </>
                  ) : null}
                </div>
              </section>
            </div>
          ) : null}

          {view === "agents" ? (
            <div className="view agents">
              <div className="callout">
                克隆内置 Agent，或用模板 / 表单创建自定义配置（工具、Skills、默认模型）。
                「动手改码」任务步默认倾向可写 Agent。
              </div>
              <div className="section-title">模板</div>
              <div className="cards">
                {(meta?.templates ?? []).map((t) => (
                  <div key={t.id} className="card">
                    <h3>{t.name}</h3>
                    <p>{t.blurb}</p>
                    <div className="kv">
                      <span>skills</span>
                      <span>{t.skillIds.join(", ") || "—"}</span>
                      <span>model</span>
                      <span>{t.defaultModelId}</span>
                    </div>
                    <button
                      type="button"
                      className="btn sm primary"
                      onClick={() => void createFromTemplate(t.id)}
                    >
                      用模板创建
                    </button>
                  </div>
                ))}
              </div>
              <div className="section-title">已有 Agent</div>
              <div className="cards">
                {(meta?.agents ?? []).map((a) => (
                  <div key={a.id} className="card">
                    <h3>
                      {a.name}{" "}
                      <span className="badge">
                        {a.builtin ? "builtin" : "custom"}
                      </span>
                    </h3>
                    <p>{a.systemPrompt.slice(0, 120)}…</p>
                    <div className="kv">
                      <span>id</span>
                      <span>{a.id}</span>
                      <span>skills</span>
                      <span>{a.skillIds.join(", ") || "—"}</span>
                      <span>tools</span>
                      <span>{a.allowedTools.join(", ")}</span>
                    </div>
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          setAgentId(a.id);
                          setModelId(a.defaultModelId);
                          setSkillIds(a.skillIds);
                          setView("run");
                        }}
                      >
                        用于 Run
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => editAgent(a)}
                      >
                        {a.builtin ? "克隆编辑" : "编辑"}
                      </button>
                      {!a.builtin ? (
                        <button
                          type="button"
                          className="btn sm danger"
                          onClick={() => void removeAgent(a.id)}
                        >
                          删除
                        </button>
                      ) : null}
                    </div>
                  </div>
                ))}
                <form className="card" onSubmit={(e) => void saveAgent(e)}>
                  <h3>{draftAgent.id ? `编辑 ${draftAgent.id}` : "新建 Agent"}</h3>
                  <div className="field">
                    <label>名称</label>
                    <input
                      value={draftAgent.name}
                      onChange={(e) =>
                        setDraftAgent({ ...draftAgent, name: e.target.value })
                      }
                      required
                    />
                  </div>
                  <div className="field">
                    <label>System Prompt</label>
                    <textarea
                      value={draftAgent.systemPrompt}
                      onChange={(e) =>
                        setDraftAgent({
                          ...draftAgent,
                          systemPrompt: e.target.value,
                        })
                      }
                      required
                    />
                  </div>
                  <div className="field">
                    <label>默认模型</label>
                    <select
                      value={draftAgent.defaultModelId}
                      onChange={(e) =>
                        setDraftAgent({
                          ...draftAgent,
                          defaultModelId: e.target.value,
                        })
                      }
                    >
                      {(meta?.models ?? []).map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.id}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div className="field">
                    <label>Tools</label>
                    <div className="skill-toggles">
                      {TOOL_OPTIONS.map((t) => {
                        const on = draftAgent.allowedTools.includes(t);
                        return (
                          <button
                            key={t}
                            type="button"
                            className={on ? "on" : ""}
                            onClick={() =>
                              setDraftAgent({
                                ...draftAgent,
                                allowedTools: on
                                  ? draftAgent.allowedTools.filter((x) => x !== t)
                                  : [...draftAgent.allowedTools, t],
                              })
                            }
                          >
                            {t}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="field">
                    <label>Skills</label>
                    <div className="skill-toggles">
                      {(meta?.skills ?? []).map((s) => {
                        const on = draftAgent.skillIds.includes(s.id);
                        return (
                          <button
                            key={s.id}
                            type="button"
                            className={on ? "on" : ""}
                            onClick={() =>
                              setDraftAgent({
                                ...draftAgent,
                                skillIds: on
                                  ? draftAgent.skillIds.filter((x) => x !== s.id)
                                  : [...draftAgent.skillIds, s.id],
                              })
                            }
                          >
                            {s.name}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                  <div className="row-actions">
                    <button type="submit" className="btn primary">
                      保存
                    </button>
                    {draftAgent.id ? (
                      <button
                        type="button"
                        className="btn ghost"
                        onClick={() =>
                          setDraftAgent((d) => ({
                            ...d,
                            id: "",
                            name: "新 Agent",
                          }))
                        }
                      >
                        清空为新建
                      </button>
                    ) : null}
                  </div>
                </form>
              </div>
            </div>
          ) : null}

          {view === "skills" ? (
            <div className="view skills">
              <div className="callout">
                Skills 是可复用的能力说明，会写入 Agent 的 system 提示。内置 Skills
                只读；可新建、编辑、导入自定义 Skill。
              </div>
              {skillError ? <div className="err">{skillError}</div> : null}
              <div className="toolbar">
                <button
                  type="button"
                  className="btn sm primary"
                  disabled={skillBusy}
                  onClick={openNewSkillForm}
                >
                  新建
                </button>
                <button
                  type="button"
                  className="btn sm"
                  disabled={skillBusy}
                  onClick={() => {
                    setImportOpen(true);
                    setSkillFormOpen(false);
                    setSkillError(null);
                  }}
                >
                  导入
                </button>
              </div>
              {skillFormOpen ? (
                <form className="form-panel" onSubmit={(e) => void saveSkill(e)}>
                  <h3>{draftSkill.id ? `编辑 ${draftSkill.id}` : "新建 Skill"}</h3>
                  <div className="field">
                    <label>名称</label>
                    <input
                      value={draftSkill.name}
                      onChange={(e) =>
                        setDraftSkill({ ...draftSkill, name: e.target.value })
                      }
                      required
                    />
                  </div>
                  <div className="field">
                    <label>ID（可选，创建时留空则自动生成）</label>
                    <input
                      value={draftSkill.id}
                      onChange={(e) =>
                        setDraftSkill({ ...draftSkill, id: e.target.value })
                      }
                      placeholder="my-skill"
                    />
                  </div>
                  <div className="field">
                    <label>描述</label>
                    <input
                      value={draftSkill.description}
                      onChange={(e) =>
                        setDraftSkill({
                          ...draftSkill,
                          description: e.target.value,
                        })
                      }
                    />
                  </div>
                  <div className="field">
                    <label>正文</label>
                    <textarea
                      value={draftSkill.body}
                      onChange={(e) =>
                        setDraftSkill({ ...draftSkill, body: e.target.value })
                      }
                      rows={12}
                      required
                    />
                  </div>
                  <div className="row-actions">
                    <button
                      type="submit"
                      className="btn primary"
                      disabled={skillBusy}
                    >
                      保存
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={skillBusy}
                      onClick={() => setSkillFormOpen(false)}
                    >
                      取消
                    </button>
                  </div>
                </form>
              ) : null}
              {importOpen ? (
                <div className="form-panel">
                  <h3>导入 SKILL.md</h3>
                  <div className="field">
                    <label>粘贴完整 Markdown</label>
                    <textarea
                      value={importMarkdown}
                      onChange={(e) => setImportMarkdown(e.target.value)}
                      rows={14}
                      placeholder={"---\nname: ...\ndescription: ...\n---\n\n正文"}
                    />
                  </div>
                  <div className="row-actions">
                    <button
                      type="button"
                      className="btn primary"
                      disabled={skillBusy || !importMarkdown.trim()}
                      onClick={() => void importSkill()}
                    >
                      导入
                    </button>
                    <button
                      type="button"
                      className="btn ghost"
                      disabled={skillBusy}
                      onClick={() => {
                        setImportOpen(false);
                        setImportMarkdown("");
                      }}
                    >
                      取消
                    </button>
                  </div>
                </div>
              ) : null}
              <div className="cards">
                {(skillDetails.length > 0
                  ? skillDetails
                  : (meta?.skills ?? []).map((s) => ({
                      ...s,
                      body: "",
                      bodyPreview: "",
                      chars: 0,
                      builtin: true,
                    }))
                ).map((s) => (
                  <div key={s.id} className="card">
                    <h3>
                      {s.name}{" "}
                      <span className="badge">
                        {s.builtin ? "builtin" : "custom"}
                      </span>
                    </h3>
                    <p>{s.description}</p>
                    {s.bodyPreview ? (
                      <MarkdownPreview
                        source={s.bodyPreview}
                        compact
                        truncated={s.chars > 480}
                        className="skill-md-preview"
                      />
                    ) : null}
                    <div className="row-actions">
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => {
                          setSkillIds((prev) =>
                            prev.includes(s.id) ? prev : [...prev, s.id],
                          );
                          setView("run");
                        }}
                      >
                        用于当前对话
                      </button>
                      {s.builtin ? (
                        <button
                          type="button"
                          className="btn sm"
                          disabled={skillBusy}
                          onClick={() => openCopySkill(s)}
                        >
                          复制为自定义
                        </button>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="btn sm"
                            disabled={skillBusy}
                            onClick={() => openEditSkill(s)}
                          >
                            编辑
                          </button>
                          <button
                            type="button"
                            className="btn sm danger"
                            disabled={skillBusy}
                            onClick={() => void removeSkill(s.id)}
                          >
                            删除
                          </button>
                        </>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ) : null}

          {view === "models" ? (
            <div className="view models">
              <div className="callout">
                配置 API Key 后可使用云端或本地模型；未配置时可使用内置离线模型。
              </div>
              <div className="cards">
                {(meta?.models ?? []).map((m) => (
                  <div key={m.id} className="card">
                    <h3>
                      <span
                        className={`ready-dot ${m.availability.ready ? "on" : "off"}`}
                      />
                      {m.id}
                    </h3>
                    <p>{m.blurb}</p>
                    <div className="kv">
                      <span>provider</span>
                      <span>{m.label}</span>
                      <span>model</span>
                      <span>{m.model}</span>
                      <span>key</span>
                      <span>
                        {m.apiKeyEnv || "—"} ·{" "}
                        {m.availability.keyConfigured ? "OK" : "缺"}
                      </span>
                      <span>状态</span>
                      <span>{m.availability.reason}</span>
                    </div>
                    <button
                      type="button"
                      className="btn sm"
                      disabled={!m.availability.ready}
                      onClick={() => {
                        setModelId(m.id);
                        setView("run");
                      }}
                    >
                      用于 Run
                    </button>
                  </div>
                ))}
              </div>
              {meta?.capabilitySettings ? (
                <>
                  <div className="section-title" style={{ marginTop: 22 }}>
                    已接通工具
                  </div>
                  <p className="hint" style={{ margin: "0 0 12px", maxWidth: 640 }}>
                    当前可用：公开页抓取（fetch_url）、网页搜索（web_search，需
                    Tavily/Serp Key）、白名单命令（run_safe_cmd，需审批）。无 Key
                    时搜索诚实失败，不造假。
                  </p>
                  <div className="cards" style={{ marginBottom: 16 }}>
                    <div className="card">
                      <h3>
                        fetch_url <span className="badge done">live</span>
                      </h3>
                      <p>禁内网 · 禁重定向 · 超时截断</p>
                      <div className="kv">
                        <span>timeout</span>
                        <span>{meta.capabilitySettings.fetch.timeoutMs} ms</span>
                        <span>maxChars</span>
                        <span>{meta.capabilitySettings.fetch.maxChars}</span>
                      </div>
                    </div>
                    <div className="card">
                      <h3>
                        web_search{" "}
                        <span
                          className={`badge ${
                            meta.capabilitySettings.search.configured
                              ? "done"
                              : "pending"
                          }`}
                        >
                          {meta.capabilitySettings.search.configured
                            ? "live"
                            : "需 Key"}
                        </span>
                      </h3>
                      <p>Tavily / SerpAPI；无 Key 不造假</p>
                      <div className="kv">
                        <span>env</span>
                        <span>
                          {meta.capabilitySettings.search.envHints.join(" / ")}
                        </span>
                      </div>
                    </div>
                    <div className="card">
                      <h3>
                        run_safe_cmd <span className="badge done">live</span>
                      </h3>
                      <p>白名单命令，Accept 后在工作区执行</p>
                      <div className="kv">
                        <span>白名单</span>
                        <span>
                          {meta.capabilitySettings.safeCmd.prefixes.join(" · ")}
                        </span>
                        <span>timeout</span>
                        <span>
                          {meta.capabilitySettings.safeCmd.timeoutMs} ms
                        </span>
                      </div>
                    </div>
                  </div>
                </>
              ) : null}
            </div>
          ) : null}

          {view === "settings" ? (
            <SettingsView
              settings={settings}
              onChange={updateSettings}
              capability={meta?.capabilitySettings ?? null}
            />
          ) : null}
        </div>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        actions={paletteActions}
      />
    </div>
  );
}
