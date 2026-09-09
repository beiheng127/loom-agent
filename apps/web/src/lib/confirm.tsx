"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

export type ConfirmTone = "default" | "danger";

export type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  tone?: ConfirmTone;
};

type ConfirmState = ConfirmRequest & { open: true };

const ConfirmContext = createContext<{
  confirm: (req: ConfirmRequest) => Promise<boolean>;
} | null>(null);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<ConfirmState | null>(null);
  const resolverRef = useRef<((value: boolean) => void) | null>(null);

  const confirm = useCallback((req: ConfirmRequest) => {
    return new Promise<boolean>((resolve) => {
      resolverRef.current = resolve;
      setState({ ...req, open: true });
    });
  }, []);

  const close = useCallback((result: boolean) => {
    resolverRef.current?.(result);
    resolverRef.current = null;
    setState(null);
  }, []);

  useEffect(() => {
    if (!state) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, close]);

  const tone = state?.tone ?? "default";

  return (
    <ConfirmContext.Provider value={{ confirm }}>
      {children}
      {state ? (
        <div
          className="confirm-overlay"
          role="presentation"
          onClick={() => close(false)}
        >
          <div
            className={`confirm-dialog ${tone}`}
            role="alertdialog"
            aria-modal="true"
            aria-labelledby="confirm-title"
            aria-describedby="confirm-message"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="confirm-icon" aria-hidden>
              {tone === "danger" ? "!" : "?"}
            </div>
            <div className="confirm-body">
              <h2 id="confirm-title">{state.title}</h2>
              <p id="confirm-message">{state.message}</p>
            </div>
            <div className="confirm-actions">
              <button
                type="button"
                className="btn"
                autoFocus
                onClick={() => close(false)}
              >
                {state.cancelLabel ?? "取消"}
              </button>
              <button
                type="button"
                className={`btn ${tone === "danger" ? "danger" : "primary"}`}
                onClick={() => close(true)}
              >
                {state.confirmLabel ?? "确定"}
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </ConfirmContext.Provider>
  );
}

export function useConfirm() {
  const ctx = useContext(ConfirmContext);
  if (!ctx) {
    throw new Error("useConfirm must be used within ConfirmProvider");
  }
  return ctx.confirm;
}
