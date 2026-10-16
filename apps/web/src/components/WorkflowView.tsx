"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { MarkdownPreview } from "@/components/MarkdownPreview";
import { useConfirm } from "@/lib/confirm";
import {
  STAGE_DEFS,
  WORKFLOW_EVENT,
  createSampleTicket,
  createTicket,
  loadTickets,
  markStage,
  nextStageId,
  recoverStaleRunningStages,
  saveTickets,
  stageStatusLabel,
  type StageId,
  type WorkflowTicket,
} from "@/lib/workflow";

export function WorkflowView({
  busy,
  onRunStage,
}: {
  busy: boolean;
  onRunStage: (input: {
    ticketId: string;
    stageId: StageId;
    goal: string;
    preferAgent?: boolean;
  }) => void;
}) {
  const confirm = useConfirm();
  const [tickets, setTickets] = useState<WorkflowTicket[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [draftTitle, setDraftTitle] = useState("");
  const [coachNote, setCoachNote] = useState("");
  const [editingTitle, setEditingTitle] = useState(false);
  const [titleDraft, setTitleDraft] = useState("");

  const reload = useCallback(() => {
    const list = loadTickets();
    setTickets(list);
    setActiveId((prev) => {
      if (prev && list.some((t) => t.id === prev)) return prev;
      return list[0]?.id ?? null;
    });
  }, []);

  useEffect(() => {
    // 仅首次挂载：清理历史残留的 running（当前若 busy 说明本页正在跑，勿误伤）
    if (!busy) recoverStaleRunningStages();
    reload();
    const onEvt = () => reload();
    window.addEventListener(WORKFLOW_EVENT, onEvt);
    window.addEventListener("storage", onEvt);
    return () => {
      window.removeEventListener(WORKFLOW_EVENT, onEvt);
      window.removeEventListener("storage", onEvt);
    };
    // 依赖数组刻意只留 [reload]（reload 是 useCallback 稳定的）：
    // 这个 effect 只在挂载时订阅一次事件。不挂 eslint-disable 指令 ——
    // 仓库没有注册 react-hooks 插件，那行注释自身会报 “rule not found”。
  }, [reload]);

  // Run 结束后刷新（结果已由 LoomShell 写入 localStorage）
  useEffect(() => {
    if (!busy) reload();
  }, [busy, reload]);

  const persist = (next: WorkflowTicket[]) => {
    setTickets(next);
    saveTickets(next);
  };

  const active = useMemo(
    () => tickets.find((t) => t.id === activeId) ?? null,
    [tickets, activeId],
  );

  const activeStage = active
    ? active.stages.find((s) => s.id === active.currentStage)
    : null;

  const addTicket = () => {
    const t = createTicket(draftTitle || "新任务");
    persist([t, ...tickets]);
    setActiveId(t.id);
    setDraftTitle("");
  };

  const addSample = () => {
    const t = createSampleTicket();
    persist([t, ...tickets]);
    setActiveId(t.id);
  };

  const removeTicket = (id: string) => {
    void (async () => {
      const ok = await confirm({
        title: "删除任务",
        message: "确定删除该任务？相关步骤产出将一并清除。",
        confirmLabel: "删除",
        tone: "danger",
      });
      if (!ok) return;
      const next = tickets.filter((t) => t.id !== id);
      persist(next);
      if (activeId === id) setActiveId(next[0]?.id ?? null);
    })();
  };

  const updateActive = (ticket: WorkflowTicket) => {
    persist(tickets.map((t) => (t.id === ticket.id ? ticket : t)));
  };

  const renameActive = () => {
    if (!active) return;
    const title = titleDraft.trim();
    if (!title) return;
    updateActive({ ...active, title, updatedAt: Date.now() });
    setEditingTitle(false);
  };

  const runCurrent = () => {
    if (!active || busy) return;
    const def = STAGE_DEFS.find((s) => s.id === active.currentStage);
    if (!def) return;
    const goal = coachNote.trim() || def.defaultGoal(active.title);
    updateActive(
      markStage(active, active.currentStage, { status: "running" }),
    );
    onRunStage({
      ticketId: active.id,
      stageId: active.currentStage,
      goal,
      preferAgent: active.currentStage === "code",
    });
  };

  const completeAndAdvance = () => {
    if (!active) return;
    const existing =
      active.stages.find((s) => s.id === active.currentStage)?.summary ?? "";
    let ticket = markStage(active, active.currentStage, {
      status: "done",
      summary:
        coachNote.trim() ||
        existing ||
        "本步已确认完成（无补充说明）",
    });
    const nxt = nextStageId(active.currentStage);
    if (nxt) {
      ticket = { ...ticket, currentStage: nxt };
      ticket = markStage(ticket, nxt, { status: "pending" });
    }
    updateActive(ticket);
    setCoachNote("");
  };

  const retryFailed = () => {
    if (!active) return;
    updateActive(
      markStage(active, active.currentStage, {
        status: "pending",
      }),
    );
  };

  return (
    <div className="view workflow">
      <div className="workflow-layout">
        <aside className="workflow-list">
          <div className="col-hd">
            <span>多步任务</span>
            <div className="row-actions">
              <button type="button" className="btn sm" onClick={addSample}>
                示例
              </button>
              <button
                type="button"
                className="btn sm primary"
                onClick={addTicket}
              >
                新建
              </button>
            </div>
          </div>
          <div className="workflow-new">
            <input
              value={draftTitle}
              onChange={(e) => setDraftTitle(e.target.value)}
              placeholder="简述需求标题…"
              onKeyDown={(e) => {
                if (e.key === "Enter") addTicket();
              }}
            />
          </div>
          <ul className="ticket-list">
            {tickets.length === 0 ? (
              <li className="empty">
                还没有任务。点「示例」或新建一条，按四步推进。
              </li>
            ) : (
              tickets.map((t) => {
                const cur = STAGE_DEFS.find((s) => s.id === t.currentStage);
                const doneCount = t.stages.filter(
                  (s) => s.status === "done",
                ).length;
                const awaiting = t.stages.some(
                  (s) => s.status === "awaiting_confirm",
                );
                const failed = t.stages.some((s) => s.status === "failed");
                return (
                  <li key={t.id}>
                    <button
                      type="button"
                      className={`ticket-row ${activeId === t.id ? "active" : ""}`}
                      onClick={() => setActiveId(t.id)}
                    >
                      <div className="ticket-title">{t.title}</div>
                      <div className="ticket-meta">
                        <span
                          className={`badge ${failed ? "failed" : awaiting ? "pending" : "done"}`}
                        >
                          {cur?.title ?? "—"}
                        </span>
                        <span className="hint">
                          {doneCount}/{t.stages.length}
                          {awaiting ? " · 待确认" : ""}
                          {failed ? " · 有失败" : ""}
                        </span>
                      </div>
                    </button>
                  </li>
                );
              })
            )}
          </ul>
        </aside>

        <section className="workflow-detail">
          {!active ? (
            <div className="empty composer-empty">
              <strong>多步任务</strong>
              <p>
                把一次改码拆成四步：摸清现状 → 拟定改法 → 动手改码 →
                核对结果。每步跑完可审阅摘要再确认进入下一步（类似 Cursor
                分阶段推进，但步骤显式可见）。
              </p>
              <button type="button" className="btn primary" onClick={addSample}>
                创建示例任务
              </button>
            </div>
          ) : (
            <>
              <div className="workflow-hd">
                <div style={{ flex: 1, minWidth: 0 }}>
                  {editingTitle ? (
                    <form
                      className="row-actions"
                      onSubmit={(e) => {
                        e.preventDefault();
                        renameActive();
                      }}
                    >
                      <input
                        autoFocus
                        value={titleDraft}
                        onChange={(e) => setTitleDraft(e.target.value)}
                        style={{ flex: 1 }}
                      />
                      <button type="submit" className="btn sm primary">
                        保存
                      </button>
                      <button
                        type="button"
                        className="btn sm"
                        onClick={() => setEditingTitle(false)}
                      >
                        取消
                      </button>
                    </form>
                  ) : (
                    <>
                      <h2>{active.title}</h2>
                      <p className="hint">
                        本地多步任务 · 每步摘要回写 · 写文件走 Diff 审批
                      </p>
                    </>
                  )}
                </div>
                <div className="row-actions">
                  {!editingTitle ? (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={() => {
                        setTitleDraft(active.title);
                        setEditingTitle(true);
                      }}
                    >
                      重命名
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="btn sm danger"
                    onClick={() => removeTicket(active.id)}
                  >
                    删除
                  </button>
                </div>
              </div>

              <ol className="pipeline">
                {STAGE_DEFS.map((def, i) => {
                  const st = active.stages.find((s) => s.id === def.id);
                  const isCurrent = active.currentStage === def.id;
                  const status = st?.status ?? "pending";
                  const cls = [
                    "pipe-step",
                    status === "done" ? "done" : "",
                    status === "running" ? "running" : "",
                    status === "awaiting_confirm" ? "awaiting" : "",
                    status === "failed" ? "failed" : "",
                    isCurrent ? "current" : "",
                  ]
                    .filter(Boolean)
                    .join(" ");
                  return (
                    <li key={def.id} className={cls}>
                      <button
                        type="button"
                        className="pipe-btn"
                        onClick={() =>
                          updateActive({ ...active, currentStage: def.id })
                        }
                      >
                        <span className="pipe-idx">{i + 1}</span>
                        <span className="pipe-body">
                          <strong>{def.title}</strong>
                          <em>{def.hint}</em>
                        </span>
                        <span
                          className={`badge ${
                            status === "done"
                              ? "done"
                              : status === "failed"
                                ? "failed"
                                : status === "awaiting_confirm"
                                  ? "warn"
                                  : "pending"
                          }`}
                        >
                          {stageStatusLabel(status, isCurrent)}
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>

              <div className="workflow-panel card-panel">
                <h3>
                  {
                    STAGE_DEFS.find((s) => s.id === active.currentStage)
                      ?.title
                  }
                </h3>
                <p className="hint">
                  {
                    STAGE_DEFS.find((s) => s.id === active.currentStage)
                      ?.hint
                  }
                  {activeStage?.status === "awaiting_confirm"
                    ? " · 本步已跑完，请审阅摘要后确认"
                    : null}
                  {activeStage?.status === "failed"
                    ? " · 上次运行失败或中止，可重试"
                    : null}
                  {activeStage?.status === "running" && busy
                    ? " · 正在 Run 页执行…"
                    : null}
                </p>

                {activeStage?.summary ? (
                  <div className="stage-summary">
                    <div className="section-title" style={{ marginTop: 8 }}>
                      本步产出
                    </div>
                    <MarkdownPreview
                      source={activeStage.summary}
                      className="stage-summary-body"
                    />
                  </div>
                ) : (
                  <div className="callout">
                    尚未有产出。点「启动本步」后会跳到 Run，结果自动回写到这里。
                  </div>
                )}

                <label className="field-label">
                  补充说明 / 覆盖默认目标（可选）
                </label>
                <textarea
                  value={coachNote}
                  onChange={(e) => setCoachNote(e.target.value)}
                  placeholder="例如：只改入院申请单默认病区联动，不要动其他模块…"
                  rows={3}
                />

                <div className="row-actions" style={{ marginTop: 12 }}>
                  <button
                    type="button"
                    className="btn primary"
                    disabled={busy || activeStage?.status === "running"}
                    onClick={runCurrent}
                  >
                    {busy
                      ? "运行中…"
                      : activeStage?.status === "failed"
                        ? "重新启动本步"
                        : activeStage?.summary
                          ? "再跑一遍本步"
                          : "启动本步"}
                  </button>
                  <button
                    type="button"
                    className="btn ok"
                    disabled={busy}
                    onClick={completeAndAdvance}
                  >
                    {activeStage?.status === "awaiting_confirm"
                      ? "确认完成本步并进入下一步"
                      : nextStageId(active.currentStage)
                        ? "确认完成本步并进入下一步"
                        : "确认完成（最后一步）"}
                  </button>
                  {activeStage?.status === "failed" ? (
                    <button
                      type="button"
                      className="btn sm"
                      onClick={retryFailed}
                    >
                      清除失败状态
                    </button>
                  ) : null}
                </div>
              </div>

              <div className="workflow-history">
                <div className="section-title">各步产出时间线</div>
                {active.stages.every((s) => !s.summary) ? (
                  <p className="hint">跑过步骤后，摘要会出现在这里。</p>
                ) : (
                  <ul className="history-list">
                    {active.stages
                      .filter((s) => s.summary)
                      .map((s) => (
                        <li key={s.id}>
                          <div className="history-hd">
                            <strong>{s.title}</strong>
                            <span className="badge done">
                              {stageStatusLabel(s.status, false)}
                            </span>
                            {s.updatedAt ? (
                              <span className="hint">
                                {new Date(s.updatedAt).toLocaleString()}
                              </span>
                            ) : null}
                          </div>
                          <MarkdownPreview
                            source={s.summary!.slice(0, 600)}
                            compact
                            truncated={s.summary!.length > 600}
                            className="stage-summary-body sm"
                          />
                        </li>
                      ))}
                  </ul>
                )}
              </div>
            </>
          )}
        </section>
      </div>
    </div>
  );
}
