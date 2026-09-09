"use client";

import type { ReactNode } from "react";

export type GuideModelRow = {
  id: string;
  label: string;
  blurb?: string;
  apiKeyEnv?: string;
  availability: { ready: boolean; reason: string; keyConfigured: boolean };
};

function EnvTag({ children }: { children: ReactNode }) {
  return (
    <code
      className="mono"
      style={{
        background: "var(--bg-inset, rgba(127,127,127,.12))",
        padding: "1px 6px",
        borderRadius: 4,
        fontSize: "0.85em",
      }}
    >
      {children}
    </code>
  );
}

/**
 * 模型 Key 配置指引：列出未就绪模型需要的 env，并给出可照做的三步操作。
 * 所有模型就绪时仅显示一行成功状态。
 */
export function ModelKeyGuide({
  models,
  compact = false,
}: {
  models: GuideModelRow[];
  compact?: boolean;
}) {
  const missing = models.filter((m) => !m.availability.ready);

  if (models.length === 0) return null;

  if (missing.length === 0) {
    return (
      <div className="callout" style={{ borderColor: "transparent" }}>
        ✅ 全部 {models.length} 个模型已就绪，可在 Run / Composer / Plan 中直接选用。
      </div>
    );
  }

  return (
    <div className="callout">
      <strong>
        {missing.length} 个模型未就绪（缺 API Key 或未启用）— 按以下三步配置：
      </strong>
      <ol style={{ margin: "10px 0 10px 18px", padding: 0, lineHeight: 1.9 }}>
        <li>
          在项目根目录，把 <EnvTag>.env.example</EnvTag> 复制为{" "}
          <EnvTag>.env</EnvTag>（已有则跳过）；
        </li>
        <li>
          按下方列表，把对应的 Key 填进 <EnvTag>.env</EnvTag>，格式：
          <EnvTag>变量名=你的Key</EnvTag>；
        </li>
        <li>
          重启 Studio（<EnvTag>Ctrl+C</EnvTag> 后重新 <EnvTag>npm run studio</EnvTag>
          ），回到本页即可看到状态刷新。
        </li>
      </ol>
      <div className="cards" style={{ margin: "8px 0 0" }}>
        {missing.map((m) => (
          <div key={m.id} className="card" style={{ padding: "10px 12px" }}>
            <h3 style={{ margin: 0, fontSize: "0.95em" }}>
              <span
                className={`ready-dot ${m.availability.ready ? "on" : "off"}`}
              />
              {m.id}
              <span style={{ fontWeight: 400, opacity: 0.7 }}>
                {" "}
                · {m.label}
              </span>
            </h3>
            {m.blurb ? (
              <p style={{ margin: "6px 0", opacity: 0.75 }}>{m.blurb}</p>
            ) : null}
            <div className="kv">
              <span>需要</span>
              <span>
                {m.availability.keyConfigured ? (
                  m.availability.reason
                ) : (
                  <>
                    设置 <EnvTag>{m.apiKeyEnv || "OPENAI_API_KEY"}</EnvTag>
                  </>
                )}
              </span>
            </div>
          </div>
        ))}
      </div>
      {compact ? null : (
        <p className="hint" style={{ marginTop: 10, marginBottom: 0 }}>
          说明：mock 模型无需任何 Key；Ollama 为本机服务，需设{" "}
          <EnvTag>LOOM_USE_OLLAMA=1</EnvTag> 或在本页点击探测；云端 Key 只存本机{" "}
          <EnvTag>.env</EnvTag>，不会上传。
        </p>
      )}
    </div>
  );
}
