"use client";

import { useEffect, useMemo, useState } from "react";

export type PaletteAction = {
  id: string;
  label: string;
  hint?: string;
  group: string;
  run: () => void;
};

export function CommandPalette({
  open,
  onClose,
  actions,
}: {
  open: boolean;
  onClose: () => void;
  actions: PaletteAction[];
}) {
  const [q, setQ] = useState("");
  const [idx, setIdx] = useState(0);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return actions;
    return actions.filter(
      (a) =>
        a.label.toLowerCase().includes(s) ||
        a.hint?.toLowerCase().includes(s) ||
        a.group.toLowerCase().includes(s),
    );
  }, [actions, q]);

  useEffect(() => {
    if (!open) {
      setQ("");
      setIdx(0);
    }
  }, [open]);

  useEffect(() => {
    setIdx(0);
  }, [q]);

  if (!open) return null;

  return (
    <div
      className="palette-backdrop"
      onClick={onClose}
      onKeyDown={(e) => {
        if (e.key === "Escape") onClose();
      }}
    >
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setIdx((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setIdx((i) => Math.max(i - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            const a = filtered[idx];
            if (a) {
              a.run();
              onClose();
            }
          } else if (e.key === "Escape") {
            onClose();
          }
        }}
      >
        <input
          autoFocus
          className="palette-input"
          placeholder="Type a command… (Ask / Agent / Plan / Demo / Nav)"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <div className="palette-list">
          {filtered.length === 0 ? (
            <div className="empty">No matches</div>
          ) : (
            filtered.map((a, i) => (
              <button
                key={a.id}
                type="button"
                className={`palette-item ${i === idx ? "active" : ""}`}
                onMouseEnter={() => setIdx(i)}
                onClick={() => {
                  a.run();
                  onClose();
                }}
              >
                <span className="palette-group">{a.group}</span>
                <span className="palette-label">{a.label}</span>
                {a.hint ? <span className="palette-hint">{a.hint}</span> : null}
              </button>
            ))
          )}
        </div>
      </div>
    </div>
  );
}
