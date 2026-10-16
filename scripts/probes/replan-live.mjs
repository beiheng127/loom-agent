/**
 * 真模型端到端重规划验证（一次性探针，不是门禁的一部分）。
 *
 * 目的：证明「失败重规划」在真模型 + 真 HTTP 链路上真的会触发，
 * 而不是只在单测的假 runner 里成立。
 *
 * 故意让第 1 步失败：给它一个没配 Key 的模型（openai-mini），调用必然抛错。
 * 第 2 步依赖第 1 步 → 只有在重规划把它摘开之后才跑得起来。
 *
 * 用法：node scripts/probes/replan-live.mjs
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const BASE = process.env.STUDIO_BASE ?? "http://localhost:3010";
const OUT = path.join(ROOT, "scripts", "probes", "replan-live.out.txt");

const goal = "读 README 并总结这个仓库";
const body = {
  goal,
  workspace: ROOT,
  preset: "custom",
  maxConcurrency: 1,
  maxRetries: 0,
  replan: true,
  plannerModelId: "deepseek-chat",
  workers: [
    {
      // 没配 Key 的模型：调用必然失败 → 触发重规划
      title: "读文件（故意用没配 Key 的模型）",
      agentId: "reader",
      modelId: "openai-mini",
      goal: "读 README.md 的开头两段",
    },
    {
      title: "基于上一步写总结",
      agentId: "reader",
      modelId: "deepseek-chat",
      goal: "用一句话总结这个仓库是干什么的",
      dependsOn: [0],
    },
  ],
};

const res = await fetch(`${BASE}/api/plan`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
const data = await res.json();

const lines = [];
lines.push(`HTTP ${res.status}`);
lines.push(`目标：${goal}`);
lines.push("");
lines.push("--- steps ---");
for (const [i, s] of (data.steps ?? []).entries()) {
  lines.push(
    `W${i + 1} ${s.title} | status=${s.status} | batch=${s.batch} | attempts=${s.attempts ?? 1}`,
  );
  lines.push(`   error=${s.error ?? "—"}`);
  lines.push(`   preview=${(s.resultPreview ?? "").slice(0, 160).replace(/\n/g, " ")}`);
}
lines.push("");
lines.push("--- replan ---");
lines.push(JSON.stringify(data.replan ?? null, null, 2));
lines.push("");
lines.push("--- merged 的择优/状态行 ---");
for (const line of String(data.merged ?? "").split("\n")) {
  if (/状态：|择优：|原因：|^## /.test(line)) lines.push(line);
}

const text = lines.join("\n");
await fsp.writeFile(OUT, text, "utf8");
console.log(text);
