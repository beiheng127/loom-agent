"use client";

import type { LoomSettings, ThemeId, DensityId, AccentId } from "@/lib/settings";

export function SettingsView({
  settings,
  onChange,
  capability,
}: {
  settings: LoomSettings;
  onChange: (next: LoomSettings) => void;
  capability?: {
    search: { configured: boolean; envHints: string[]; note: string };
    fetch: { live: boolean; timeoutMs: number; maxChars: number; redirect: string };
    safeCmd: {
      live: boolean;
      prefixes: string[];
      envExtra: string;
      timeoutMs: number;
    };
  } | null;
}) {
  const patch = (partial: Partial<LoomSettings>) =>
    onChange({ ...settings, ...partial });

  return (
    <div className="view settings">
      <div className="section-title">外观与交互</div>
      <p className="hint" style={{ marginBottom: 16, maxWidth: 640 }}>
        只调整 Studio 外观（主题 / 密度 / 强调色），不影响 Agent 能力与工具行为。
      </p>

      <div className="cards settings-grid">
        <div className="card">
          <h3>主题</h3>
          <div className="seg">
            {(
              [
                ["studio", "Studio 浅色"],
                ["dark", "深色"],
                ["compact", "深色紧凑"],
              ] as Array<[ThemeId, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`btn sm ${settings.theme === id ? "primary" : ""}`}
                onClick={() => patch({ theme: id })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <h3>密度</h3>
          <div className="seg">
            {(
              [
                ["comfortable", "舒适"],
                ["compact", "紧凑"],
              ] as Array<[DensityId, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`btn sm ${settings.density === id ? "primary" : ""}`}
                onClick={() => patch({ density: id })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <h3>强调色</h3>
          <div className="seg">
            {(
              [
                ["blue", "蓝"],
                ["amber", "琥珀"],
                ["teal", "青绿"],
              ] as Array<[AccentId, string]>
            ).map(([id, label]) => (
              <button
                key={id}
                type="button"
                className={`btn sm ${settings.accent === id ? "primary" : ""}`}
                onClick={() => patch({ accent: id })}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        <div className="card">
          <h3>界面开关</h3>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.showStatusStrip}
              onChange={(e) => patch({ showStatusStrip: e.target.checked })}
            />
            显示顶部状态条
          </label>
          <label className="check-row">
            <input
              type="checkbox"
              checked={settings.showRailLabels}
              onChange={(e) => patch({ showRailLabels: e.target.checked })}
            />
            侧栏显示文字标签
          </label>
        </div>
      </div>

      {capability ? (
        <>
          <div className="section-title" style={{ marginTop: 28 }}>
            已接通工具（只读）
          </div>
          <p className="hint" style={{ marginBottom: 12 }}>
            仅展示当前可用的工具能力；未实现的能力不会列在这里。
          </p>
          <div className="cards">
            <div className="card">
              <h3>
                fetch_url <span className="badge done">live</span>
              </h3>
              <div className="kv">
                <span>timeout</span>
                <span>{capability.fetch.timeoutMs} ms</span>
                <span>maxChars</span>
                <span>{capability.fetch.maxChars}</span>
              </div>
            </div>
            <div className="card">
              <h3>
                web_search{" "}
                <span
                  className={`badge ${capability.search.configured ? "done" : "pending"}`}
                >
                  {capability.search.configured ? "live" : "需 Key"}
                </span>
              </h3>
              <div className="kv">
                <span>env</span>
                <span>{capability.search.envHints.join(" / ")}</span>
                <span>说明</span>
                <span>{capability.search.note}</span>
              </div>
            </div>
            <div className="card">
              <h3>
                run_safe_cmd <span className="badge done">live</span>
              </h3>
              <div className="kv">
                <span>白名单</span>
                <span>{capability.safeCmd.prefixes.join(" · ")}</span>
              </div>
            </div>
          </div>
        </>
      ) : null}
    </div>
  );
}
