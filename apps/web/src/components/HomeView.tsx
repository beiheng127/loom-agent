"use client";

import { useMemo, useState } from "react";
import { HomeLanding } from "@/components/HomeLanding";
import type { GuideModelRow } from "@/components/ModelKeyGuide";
import { FEATURE_GUIDE } from "@/lib/feature-guide";
import { useConfirm } from "@/lib/confirm";

export type HomeTab = "landing" | "demos" | "guide" | "history";

type DemoCard = {
  id: string;
  step: 1 | 2 | 3 | 4;
  title: string;
  subtitle: string;
  proves: string;
  kind: "run" | "plan";
  etaSec: number;
};

type SessionRow = {
  id: string;
  title: string;
  mode: string;
  updatedAt: number;
};

type PlanRow = {
  id: string;
  goal: string;
  preset: string;
  at: number;
  threads: number;
};

const GUIDE_STEPS = [
  { step: 1, title: "读懂工作区", tip: "探索 / 审计 / Skill 导览" },
  { step: 2, title: "写操作审批", tip: "提议写入 → 批准或拒绝" },
  { step: 3, title: "Plan Board", tip: "多线程并行织计划" },
  { step: 4, title: "定制 Agent", tip: "模板 / Skills / 克隆" },
] as const;

export function HomeView({
  tab,
  onTabChange,
  demos,
  progress,
  busy,
  sessions,
  planHistory,
  onLaunchDemo,
  onOpenNav,
  onNewSession,
  onOpenSession,
  onRenameSession,
  onDeleteSession,
  onLoadPlan,
  onDeletePlan,
  onClearProgress,
  readyModels,
  modelTotal,
  models,
}: {
  tab: HomeTab;
  onTabChange: (t: HomeTab) => void;
  demos: DemoCard[];
  progress: Record<string, boolean>;
  busy: boolean;
  sessions: SessionRow[];
  planHistory: PlanRow[];
  readyModels: number;
  modelTotal: number;
  models: GuideModelRow[];
  onLaunchDemo: (d: DemoCard) => void;
  onOpenNav: (id: string) => void;
  onNewSession: () => void;
  onOpenSession: (id: string) => void;
  onRenameSession: (id: string, title: string) => void;
  onDeleteSession: (id: string) => void;
  onLoadPlan: (row: PlanRow) => void;
  onDeletePlan: (row: PlanRow) => void;
  onClearProgress: () => void;
}) {
  const confirm = useConfirm();
  const [guideId, setGuideId] = useState(FEATURE_GUIDE[0]?.id ?? "home");
  const [renameId, setRenameId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const [sessionQ, setSessionQ] = useState("");

  const activeGuide = useMemo(
    () => FEATURE_GUIDE.find((g) => g.id === guideId) ?? FEATURE_GUIDE[0]!,
    [guideId],
  );

  const demoDone = useMemo(
    () => demos.filter((d) => progress[d.id]).length,
    [demos, progress],
  );

  const filteredSessions = useMemo(() => {
    const q = sessionQ.trim().toLowerCase();
    if (!q) return sessions;
    return sessions.filter(
      (s) =>
        s.title.toLowerCase().includes(q) ||
        s.mode.toLowerCase().includes(q) ||
        s.id.toLowerCase().includes(q),
    );
  }, [sessions, sessionQ]);

  return (
    <div className="view home">
      {tab !== "landing" ? (
        <div className="hero">
          <h1>Loom · Coding Agent Studio</h1>
          <p className="lead">
            本地优先的改码助手：Composer（Ask / Agent）、Diff 审批、Plan
            并行、可配置 Agents / Skills。用法接近 Cursor / Qoder，能力按本仓库真实实现裁剪。
          </p>
        </div>
      ) : null}

      <div className="home-tabs" role="tablist" aria-label="主页分区">
          {(
            [
              ["landing", "概览"],
              ["demos", "上手 Demo"],
              ["guide", "功能说明"],
              ["history", "历史"],
            ] as const
          ).map(([id, label]) => (
            <button
              key={id}
              type="button"
              role="tab"
              aria-selected={tab === id}
              className={`home-tab ${tab === id ? "active" : ""}`}
              onClick={() => onTabChange(id)}
            >
              {label}
            </button>
          ))}
      </div>

        {tab === "landing" ? (
          <HomeLanding
            sessionCount={sessions.length}
            planCount={planHistory.length}
            demoDone={demoDone}
            demoTotal={demos.length}
            readyModels={readyModels}
            modelTotal={modelTotal}
            models={models}
            onOpenNav={onOpenNav}
            onTabChange={onTabChange}
          />
        ) : null}

        {tab === "demos" ? (
          <>
            <div className="market-banner">
              <button
                type="button"
                className="chip-link"
                onClick={() => onOpenNav("workflow")}
              >
                多步任务
              </button>
              <button
                type="button"
                className="chip-link"
                onClick={() => onOpenNav("run")}
              >
                Composer
              </button>
              <button
                type="button"
                className="chip-link"
                onClick={() => onOpenNav("plan")}
              >
                Plan Board
              </button>
              <button
                type="button"
                className="chip-link"
                onClick={() => onOpenNav("agents")}
              >
                Agents
              </button>
              <button
                type="button"
                className="chip-link"
                onClick={() => onOpenNav("skills")}
              >
                Skills
              </button>
              <button
                type="button"
                className="chip-link"
                onClick={() => onTabChange("guide")}
              >
                功能说明 →
              </button>
            </div>
            <div className="callout">
              Ask 只读 · Agent 可写（Diff HITL）· Plan 多线程 · Explorer
              @文件。未实现的能力不会出现在界面上。
            </div>
            <div className="steps">
              {GUIDE_STEPS.map((g) => (
                <div
                  key={g.step}
                  className={`step-pill ${progress[`step-${g.step}`] ? "done" : ""}`}
                >
                  <div className="n">
                    STEP {g.step}
                    {progress[`step-${g.step}`] ? " · DONE" : ""}
                  </div>
                  <div className="t">{g.title}</div>
                  <div className="d">{g.tip}</div>
                </div>
              ))}
            </div>
            <div className="row-actions" style={{ marginBottom: 8 }}>
              <button
                type="button"
                className="btn sm"
                onClick={() => {
                  void (async () => {
                    const ok = await confirm({
                      title: "清空 Demo 进度",
                      message: "将清除所有 Demo 完成标记，此操作不可撤销。",
                      confirmLabel: "清空",
                      tone: "danger",
                    });
                    if (ok) onClearProgress();
                  })();
                }}
              >
                清空 Demo 进度
              </button>
            </div>
            {([1, 2, 3, 4] as const).map((step) => (
              <div key={step}>
                <div className="section-title">
                  Step {step} · {GUIDE_STEPS[step - 1]?.title}
                </div>
                <div className="scenario-grid">
                  {demos
                    .filter((d) => d.step === step)
                    .filter((d) => d.id !== "fetch-url-stub")
                    .map((d) => (
                      <button
                        key={d.id}
                        type="button"
                        className="scenario"
                        disabled={busy}
                        onClick={() => onLaunchDemo(d)}
                      >
                        <span className="tag">
                          {d.kind.toUpperCase()}
                          {progress[d.id] ? " · DONE" : ""}
                          {d.etaSec ? ` · ~${d.etaSec}s` : ""}
                        </span>
                        <h3>{d.title}</h3>
                        <p>{d.subtitle}</p>
                        <p>{d.proves}</p>
                        <div className="foot">
                          <span className="hint">点击运行</span>
                          <span className="badge pending">离线示例</span>
                        </div>
                      </button>
                    ))}
                </div>
              </div>
            ))}
          </>
        ) : null}

        {tab === "guide" ? (
          <div className="guide-layout">
            <aside className="guide-nav">
              <div className="section-title">功能列表</div>
              <ul className="guide-list">
                {FEATURE_GUIDE.map((g) => (
                  <li key={g.id}>
                    <button
                      type="button"
                      className={guideId === g.id ? "active" : ""}
                      onClick={() => setGuideId(g.id)}
                    >
                      <span className="nav-tag">{g.nav}</span>
                      <span>{g.title}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </aside>
            <article className="guide-detail card-panel">
              <div className="guide-hd">
                <h2>{activeGuide.title}</h2>
                <button
                  type="button"
                  className="btn sm primary"
                  onClick={() => onOpenNav(activeGuide.id === "hitl" || activeGuide.id === "sessions" ? "run" : activeGuide.id)}
                >
                  打开相关页
                </button>
              </div>
              <p className="lead-sm">{activeGuide.summary}</p>
              <div className="section-title">能做什么</div>
              <ul className="guide-bullets">
                {activeGuide.what.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
              <div className="section-title">怎么操作</div>
              <ol className="guide-steps">
                {activeGuide.how.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ol>
              {activeGuide.tips?.length ? (
                <>
                  <div className="section-title">注意</div>
                  <ul className="guide-bullets tip">
                    {activeGuide.tips.map((line) => (
                      <li key={line}>{line}</li>
                    ))}
                  </ul>
                </>
              ) : null}
            </article>
          </div>
        ) : null}

        {tab === "history" ? (
          <div className="history-home">
            <div className="history-toolbar">
              <button type="button" className="btn primary" onClick={onNewSession}>
                新建 Run 会话
              </button>
              <button type="button" className="btn" onClick={() => onOpenNav("workflow")}>
                去多步任务
              </button>
              <button type="button" className="btn" onClick={() => onOpenNav("plan")}>
                去 Plan
              </button>
            </div>

            <section className="card-panel history-block">
              <div className="history-block-hd">
                <h3>Run 会话历史</h3>
                <input
                  value={sessionQ}
                  onChange={(e) => setSessionQ(e.target.value)}
                  placeholder="搜索标题 / 模式…"
                  aria-label="搜索会话"
                />
              </div>
              {filteredSessions.length === 0 ? (
                <p className="hint">还没有会话。去 Run 发一条，或点「新建 Run 会话」。</p>
              ) : (
                <ul className="history-session-list">
                  {filteredSessions.map((s) => (
                    <li key={s.id}>
                      {renameId === s.id ? (
                        <form
                          className="row-actions"
                          onSubmit={(e) => {
                            e.preventDefault();
                            onRenameSession(s.id, renameDraft);
                            setRenameId(null);
                          }}
                        >
                          <input
                            autoFocus
                            value={renameDraft}
                            onChange={(e) => setRenameDraft(e.target.value)}
                            style={{ flex: 1 }}
                          />
                          <button type="submit" className="btn sm primary">
                            保存
                          </button>
                          <button
                            type="button"
                            className="btn sm"
                            onClick={() => setRenameId(null)}
                          >
                            取消
                          </button>
                        </form>
                      ) : (
                        <>
                          <button
                            type="button"
                            className="history-session-main"
                            onClick={() => onOpenSession(s.id)}
                          >
                            <strong>{s.title}</strong>
                            <span className="hint">
                              {s.mode} · {new Date(s.updatedAt).toLocaleString()}
                            </span>
                          </button>
                          <div className="row-actions">
                            <button
                              type="button"
                              className="btn sm"
                              onClick={() => {
                                setRenameId(s.id);
                                setRenameDraft(s.title);
                              }}
                            >
                              重命名
                            </button>
                            <button
                              type="button"
                              className="btn sm danger"
                              onClick={() => {
                                void (async () => {
                                  const ok = await confirm({
                                    title: "删除会话",
                                    message: `确定删除「${s.title}」？相关对话记录将无法恢复。`,
                                    confirmLabel: "删除",
                                    tone: "danger",
                                  });
                                  if (ok) onDeleteSession(s.id);
                                })();
                              }}
                            >
                              删除
                            </button>
                          </div>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className="card-panel history-block">
              <div className="history-block-hd">
                <h3>Plan 运行历史</h3>
              </div>
              {planHistory.length === 0 ? (
                <p className="hint">还没有 Plan 记录。到 Plan 页跑一次即可出现。</p>
              ) : (
                <ul className="history-session-list">
                  {planHistory.map((h) => (
                    <li key={h.id + String(h.at)}>
                      <button
                        type="button"
                        className="history-session-main"
                        onClick={() => onLoadPlan(h)}
                      >
                        <strong>{h.goal.slice(0, 64) || h.id}</strong>
                        <span className="hint">
                          {h.preset} · {h.threads} threads ·{" "}
                          {new Date(h.at).toLocaleString()}
                        </span>
                      </button>
                      <div className="row-actions">
                        <button
                          type="button"
                          className="btn sm primary"
                          onClick={() => onLoadPlan(h)}
                        >
                          载入目标
                        </button>
                        <button
                          type="button"
                          className="btn sm danger"
                          onClick={() => {
                            void (async () => {
                              const label = h.goal.slice(0, 48) || h.id;
                              const ok = await confirm({
                                title: "删除 Plan 记录",
                                message: `确定删除「${label}」？`,
                                confirmLabel: "删除",
                                tone: "danger",
                              });
                              if (ok) onDeletePlan(h);
                            })();
                          }}
                        >
                          删除
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        ) : null}
    </div>
  );
}
