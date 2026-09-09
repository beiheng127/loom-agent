"use client";

import { DiffBlock } from "@/components/DiffBlock";

export type ThreadItem =
  | { kind: "user"; id: string; text: string; at: number }
  | { kind: "assistant"; id: string; text: string; at: number; streaming?: boolean }
  | {
      kind: "tool";
      id: string;
      name: string;
      args?: Record<string, unknown>;
      ok?: boolean;
      preview?: string;
      statusHint?: "not_configured" | "call" | "ok" | "error";
      at: number;
    }
  | { kind: "phase"; id: string; phase: string; at: number }
  | {
      kind: "hitl";
      id: string;
      hitlKind?: "write" | "cmd";
      path: string;
      content: string;
      command?: string;
      diff?: string;
      additions?: number;
      deletions?: number;
      at: number;
    };

export function ComposerThread({
  items,
  onApprove,
  onReject,
  onApproveCmd,
  onRejectCmd,
}: {
  items: ThreadItem[];
  onApprove?: (w: {
    path: string;
    content: string;
  }) => void;
  onReject?: (w: { path: string; content: string }) => void;
  onApproveCmd?: (c: { command: string }) => void;
  onRejectCmd?: (c: { command: string }) => void;
}) {
  if (items.length === 0) {
    return (
      <div className="empty composer-empty">
        <strong>Composer</strong>
        <p>
          左侧 Explorer 点文件可附加为 @context，底部输入目标。Ask
          只读 · Agent 可写（Diff 审批）· Plan 走并行 Board。
        </p>
        <p className="hint">快捷键 ⌘K 打开命令面板</p>
      </div>
    );
  }

  return (
    <div className="composer-thread">
      {items.map((it) => {
        switch (it.kind) {
          case "user":
            return (
              <div key={it.id} className="bubble user">
                <div className="bubble-role">You</div>
                <div className="bubble-body">{it.text}</div>
              </div>
            );
          case "assistant":
            return (
              <div key={it.id} className="bubble assistant">
                <div className="bubble-role">
                  Agent{it.streaming ? " · streaming" : ""}
                </div>
                <div className="bubble-body mono">{it.text || "…"}</div>
              </div>
            );
          case "phase":
            return (
              <div key={it.id} className="phase-pill">
                <span className="phase-dot" />
                {it.phase}
              </div>
            );
          case "hitl": {
            const isCmd = it.hitlKind === "cmd";
            const command = it.command ?? it.path;
            return (
              <div key={it.id} className="hitl-inline">
                <div className="tool-hd">
                  <span className="mono">
                    {isCmd ? `cmd · ${command}` : `write · ${it.path}`}
                  </span>
                  <span className="badge pending">needs approval</span>
                </div>
                {isCmd ? (
                  <pre className="tool-preview">{command}</pre>
                ) : (
                  <>
                    <DiffBlock
                      path={it.path}
                      diff={it.diff}
                      additions={it.additions}
                      deletions={it.deletions}
                    />
                    {!it.diff ? (
                      <pre className="tool-preview">
                        {it.content.slice(0, 800)}
                      </pre>
                    ) : null}
                  </>
                )}
                <div className="row-actions">
                  <button
                    type="button"
                    className="btn ok sm"
                    onClick={() =>
                      isCmd
                        ? onApproveCmd?.({ command })
                        : onApprove?.({ path: it.path, content: it.content })
                    }
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn danger sm"
                    onClick={() =>
                      isCmd
                        ? onRejectCmd?.({ command })
                        : onReject?.({ path: it.path, content: it.content })
                    }
                  >
                    Reject
                  </button>
                </div>
              </div>
            );
          }
          case "tool": {
            const badge =
              it.statusHint === "not_configured"
                ? "pending"
                : it.ok === false || it.statusHint === "error"
                  ? "failed"
                  : it.ok || it.statusHint === "ok"
                    ? "done"
                    : "pending";
            const badgeLabel =
              it.statusHint === "not_configured"
                ? "not configured"
                : it.ok === false || it.statusHint === "error"
                  ? "error"
                  : it.ok || it.statusHint === "ok"
                    ? "ok"
                    : "call";
            return (
              <div key={it.id} className="tool-card">
                <div className="tool-hd">
                  <span className="mono">{it.name}</span>
                  <span className={`badge ${badge}`}>{badgeLabel}</span>
                </div>
                {it.args ? (
                  <pre className="tool-args">
                    {JSON.stringify(it.args, null, 2)}
                  </pre>
                ) : null}
                {it.preview ? (
                  <pre className="tool-preview">{it.preview}</pre>
                ) : null}
              </div>
            );
          }
          default: {
            const _exhaustive: never = it;
            return _exhaustive;
          }
        }
      })}
    </div>
  );
}
