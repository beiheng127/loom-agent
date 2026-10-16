#!/usr/bin/env node
/**
 * 加载仓库根目录 .env 到 process.env。
 * 背景：Next dev 的 cwd 是 apps/web，只会自动加载 apps/web/.env*，
 * 根目录 .env（DEEPSEEK_API_KEY 等）默认不会被任何进程读取。
 * studio.mjs 启动 next/tsc 子进程前先加载，子进程继承即可生效。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(__dirname, "..");
export const DEFAULT_ENV_FILE = path.join(REPO_ROOT, ".env");

export function parseDotenv(content) {
  const out = {};
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const cleaned = line.startsWith("export ")
      ? line.slice("export ".length).trim()
      : line;
    const eq = cleaned.indexOf("=");
    if (eq === -1) continue;
    const key = cleaned.slice(0, eq).trim();
    let val = cleaned.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) out[key] = val;
  }
  return out;
}

/**
 * @returns {{ file: string | null, loaded: string[] }}
 * 已存在于 shell 环境中的变量不会被覆盖（shell 优先）。
 */
export function loadRootEnv(file = DEFAULT_ENV_FILE) {
  if (!fs.existsSync(file)) return { file: null, loaded: [] };
  const parsed = parseDotenv(fs.readFileSync(file, "utf8"));
  const loaded = [];
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined || process.env[k] === "") {
      process.env[k] = v;
    }
    loaded.push(k);
  }
  return { file, loaded };
}
