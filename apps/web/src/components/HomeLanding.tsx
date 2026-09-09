"use client";

import type { HomeTab } from "@/components/HomeView";

const FEATURES = [
  {
    id: "run",
    kicker: "Composer",
    title: "Ask / Agent 双模式",
    desc: "只读探索与可写改码同一界面；Diff 审批后再落盘。",
    accent: "accent-2",
  },
  {
    id: "workflow",
    kicker: "多步任务",
    title: "摸清 → 拟定 → 改码 → 核对",
    desc: "分步推进复杂需求，每步产出自动回写任务板。",
    accent: "accent",
  },
  {
    id: "plan",
    kicker: "Plan Board",
    title: "多线程并行规划",
    desc: "异构模型协作织计划，历史目标一键载入。",
    accent: "ok",
  },
  {
    id: "skills",
    kicker: "Skills",
    title: "可导入的能力包",
    desc: "内置导览 / 审计 / Changelog；支持 Markdown 自定义。",
    accent: "accent-2",
  },
] as const;

export function HomeLanding({
  sessionCount,
  planCount,
  demoDone,
  demoTotal,
  readyModels,
  modelTotal,
  onOpenNav,
  onTabChange,
}: {
  sessionCount: number;
  planCount: number;
  demoDone: number;
  demoTotal: number;
  readyModels: number;
  modelTotal: number;
  onOpenNav: (id: string) => void;
  onTabChange: (t: HomeTab) => void;
}) {
  const progressPct =
    demoTotal > 0 ? Math.round((demoDone / demoTotal) * 100) : 0;

  return (
    <div className="home-landing">
      <div className="landing-bg" aria-hidden>
        <div className="landing-orb o1" />
        <div className="landing-orb o2" />
        <div className="landing-orb o3" />
        <div className="landing-grid" />
      </div>

      <section className="landing-hero">
        <p className="landing-eyebrow">Loom Agent Studio</p>
        <h1 className="landing-title">
          本地优先的
          <span className="landing-gradient"> Coding Agent </span>
          工作台
        </h1>
        <p className="landing-lead">
          用法贴近 Cursor / Qoder：Composer、Diff 审批、Plan 并行、Agents /
          Skills 可配置。能力按本仓库真实实现裁剪，无虚假入口。
        </p>
        <div className="landing-cta">
          <button
            type="button"
            className="btn primary landing-btn-main"
            onClick={() => onOpenNav("run")}
          >
            打开 Composer
          </button>
          <button
            type="button"
            className="btn landing-btn-ghost"
            onClick={() => onTabChange("demos")}
          >
            上手 Demo
          </button>
          <button
            type="button"
            className="btn landing-btn-ghost"
            onClick={() => onTabChange("guide")}
          >
            功能说明
          </button>
        </div>
      </section>

      <section className="landing-stats" aria-label="概览数据">
        <div className="landing-stat">
          <span className="landing-stat-n">{sessionCount}</span>
          <span className="landing-stat-l">Run 会话</span>
        </div>
        <div className="landing-stat">
          <span className="landing-stat-n">{planCount}</span>
          <span className="landing-stat-l">Plan 记录</span>
        </div>
        <div className="landing-stat">
          <span className="landing-stat-n">
            {demoDone}/{demoTotal}
          </span>
          <span className="landing-stat-l">Demo 完成</span>
        </div>
        <div className="landing-stat">
          <span className="landing-stat-n">
            {readyModels}/{modelTotal}
          </span>
          <span className="landing-stat-l">就绪模型</span>
        </div>
      </section>

      <div className="landing-progress-wrap">
        <div className="landing-progress-hd">
          <span>Demo 学习进度</span>
          <span className="mono">{progressPct}%</span>
        </div>
        <div className="landing-progress-track">
          <div
            className="landing-progress-fill"
            style={{ width: `${progressPct}%` }}
          />
        </div>
      </div>

      <section className="landing-features">
        {FEATURES.map((f) => (
          <button
            key={f.id}
            type="button"
            className={`landing-feature ${f.accent}`}
            onClick={() => onOpenNav(f.id)}
          >
            <span className="landing-feature-k">{f.kicker}</span>
            <strong>{f.title}</strong>
            <span className="landing-feature-d">{f.desc}</span>
            <span className="landing-feature-go">进入 →</span>
          </button>
        ))}
      </section>

      <section className="landing-pipeline card-panel">
        <div className="landing-pipeline-hd">
          <h3>推荐工作流</h3>
          <button
            type="button"
            className="chip-link"
            onClick={() => onOpenNav("workflow")}
          >
            打开多步任务
          </button>
        </div>
        <div className="landing-steps">
          {[
            ["1", "摸清现状", "探索仓库与约束"],
            ["2", "拟定改法", "步骤、风险、拟改文件"],
            ["3", "动手改码", "提议写入 · Diff 批准"],
            ["4", "核对结果", "对照验收 · 汇总剩余"],
          ].map(([n, t, d]) => (
            <div key={n} className="landing-step">
              <span className="landing-step-n">{n}</span>
              <strong>{t}</strong>
              <span>{d}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
