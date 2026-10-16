import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";
import type {
  ModelAvailability,
  ModelConfig,
  ModelProviderId,
} from "../types/index.js";

export const BUILTIN_MODELS: ModelConfig[] = [
  {
    id: "mock-local",
    provider: "mock",
    model: "mock-v1",
    blurb: "离线确定性脚本 · 探索 / 读文件",
    temperature: 0,
  },
  {
    id: "mock-editor",
    provider: "mock",
    model: "mock-editor-v1",
    blurb: "离线脚本 · 强制走 write_file 人工审批",
    temperature: 0,
  },
  {
    id: "deepseek-chat",
    provider: "deepseek",
    model: "deepseek-chat",
    baseURL: "https://api.deepseek.com/v1",
    apiKeyEnv: "DEEPSEEK_API_KEY",
    blurb: "性价比高 · 适合 Worker / 日常改码",
    temperature: 0.3,
  },
  {
    id: "openai-mini",
    provider: "openai",
    model: "gpt-4o-mini",
    baseURL: "https://api.openai.com/v1",
    apiKeyEnv: "OPENAI_API_KEY",
    blurb: "轻量 OpenAI · 适合快速拆任务",
    temperature: 0.4,
  },
  {
    id: "ollama-local",
    provider: "ollama",
    model: "llama3.2",
    baseURL: "http://127.0.0.1:11434/v1",
    apiKeyEnv: "OLLAMA_API_KEY",
    blurb: "本机 Ollama · 无云端 Key 时可真并行",
    temperature: 0.2,
  },
];

export function listModels(): ModelConfig[] {
  return BUILTIN_MODELS;
}

export function getModelConfig(id: string): ModelConfig {
  const found = BUILTIN_MODELS.find((m) => m.id === id);
  if (!found) throw new Error(`未知模型配置: ${id}`);
  return found;
}

export function isModelKeyConfigured(config: ModelConfig): boolean {
  if (config.provider === "mock") return true;
  if (config.provider === "ollama") return true;
  const envName = config.apiKeyEnv ?? "OPENAI_API_KEY";
  return Boolean(process.env[envName]?.trim());
}

export function describeModelAvailability(
  config: ModelConfig,
): ModelAvailability {
  if (config.provider === "mock") {
    return {
      id: config.id,
      ready: true,
      reason: "无需 API Key，走本地 mock 脚本",
      keyConfigured: true,
    };
  }
  if (config.provider === "ollama") {
    // 同步路径：未探测时不标 ready，避免无服务仍被自动选用
    const force = process.env.LOOM_USE_OLLAMA === "1";
    return {
      id: config.id,
      ready: force,
      reason: force
        ? "已设 LOOM_USE_OLLAMA=1（未做实时探测，请确认服务已启动）"
        : "本机 Ollama：打开 Models 探测，或设 LOOM_USE_OLLAMA=1",
      keyEnv: config.apiKeyEnv,
      keyConfigured: true,
    };
  }
  const envName = config.apiKeyEnv ?? "OPENAI_API_KEY";
  const keyConfigured = Boolean(process.env[envName]?.trim());
  return {
    id: config.id,
    ready: keyConfigured,
    reason: keyConfigured
      ? `已配置 ${envName}`
      : `缺少 ${envName}，请改用 mock 或补 Key`,
    keyEnv: envName,
    keyConfigured,
  };
}

export function listModelsWithAvailability(): Array<
  ModelConfig & { availability: ModelAvailability }
> {
  return BUILTIN_MODELS.map((m) => ({
    ...m,
    availability: describeModelAvailability(m),
  }));
}

/** 探测本机 Ollama（/api/tags），超时约 1.5s */
export async function probeOllama(
  baseURL = "http://127.0.0.1:11434/v1",
): Promise<{ ok: boolean; detail: string; modelCount: number }> {
  const root = baseURL.replace(/\/v1\/?$/, "");
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 1500);
    const res = await fetch(`${root}/api/tags`, { signal: ctrl.signal });
    clearTimeout(timer);
    if (!res.ok) {
      return {
        ok: false,
        detail: `Ollama 返回 HTTP ${res.status}`,
        modelCount: 0,
      };
    }
    const data = (await res.json()) as { models?: unknown[] };
    const modelCount = Array.isArray(data.models) ? data.models.length : 0;
    return {
      ok: true,
      detail: `本机 Ollama 可达 · ${modelCount} 个模型`,
      modelCount,
    };
  } catch {
    return {
      ok: false,
      detail: "本机 Ollama 未响应（未启动或端口不通）",
      modelCount: 0,
    };
  }
}

/** Models / meta 用：对 Ollama 做实时探测 */
export async function listModelsWithAvailabilityAsync(): Promise<
  Array<ModelConfig & { availability: ModelAvailability }>
> {
  const ollamaCfg = BUILTIN_MODELS.find((m) => m.provider === "ollama");
  const probe = await probeOllama(ollamaCfg?.baseURL);
  return BUILTIN_MODELS.map((m) => {
    if (m.provider !== "ollama") {
      return { ...m, availability: describeModelAvailability(m) };
    }
    const force = process.env.LOOM_USE_OLLAMA === "1";
    const ready = probe.ok || force;
    return {
      ...m,
      availability: {
        id: m.id,
        ready,
        reason: probe.ok
          ? probe.detail
          : force
            ? `${probe.detail} · 仍因 LOOM_USE_OLLAMA=1 标为可用`
            : probe.detail,
        keyEnv: m.apiKeyEnv,
        keyConfigured: true,
      },
    };
  });
}

export function resolveLanguageModel(config: ModelConfig): LanguageModel | null {
  if (config.provider === "mock") return null;

  const envName = config.apiKeyEnv ?? "OPENAI_API_KEY";
  const apiKey =
    process.env[envName] ||
    (config.provider === "ollama" ? "ollama" : undefined);

  if (!apiKey) {
    throw new Error(`缺少环境变量 ${envName}（模型 ${config.id}）`);
  }

  const provider = createOpenAI({
    apiKey,
    baseURL: config.baseURL,
  });
  return provider.chat(config.model);
}

export function providerLabel(id: ModelProviderId): string {
  switch (id) {
    case "mock":
      return "Mock（离线）";
    case "deepseek":
      return "DeepSeek";
    case "openai":
      return "OpenAI";
    case "ollama":
      return "Ollama 本地";
    default: {
      const _exhaustive: never = id;
      return _exhaustive;
    }
  }
}

/** 第一个就绪的非 mock 模型（Composer 默认优先） */
export function preferredComposerModelId(
  models?: Array<ModelConfig & { availability: ModelAvailability }>,
): string | null {
  return listAutoSelectableRealModels(models)[0]?.id ?? null;
}

/**
 * Plan Worker 角色 → 真模型 id。
 * 无任一真模型就绪时返回 null（调用方回落 mock）。
 */
export function preferredRealModelRoles(
  models?: Array<ModelConfig & { availability: ModelAvailability }>,
): {
  reader: string;
  auditor: string;
  editor: string;
} | null {
  const ready = listAutoSelectableRealModels(models);
  if (ready.length === 0) return null;

  const by = (provider: ModelProviderId) =>
    ready.find((m) => m.provider === provider);
  const deepseek = by("deepseek");
  const ollama = by("ollama");
  const openai = by("openai");
  const any = deepseek ?? ollama ?? openai ?? ready[0];
  if (!any) return null;

  return {
    reader: (ollama ?? deepseek ?? openai ?? any).id,
    auditor: (deepseek ?? openai ?? ollama ?? any).id,
    editor: (deepseek ?? openai ?? ollama ?? any).id,
  };
}

/**
 * 可自动选用的真模型：
 * - DeepSeek / OpenAI：需 Key
 * - Ollama：探测可达，或 LOOM_USE_OLLAMA=1
 */
export function listAutoSelectableRealModels(
  models = listModelsWithAvailability(),
): Array<ModelConfig & { availability: ModelAvailability }> {
  return models.filter((m) => {
    if (!m.availability.ready || m.provider === "mock") return false;
    if (m.provider === "ollama") {
      return m.availability.ready;
    }
    return m.availability.keyConfigured;
  });
}

export async function listAutoSelectableRealModelsAsync(): Promise<
  Array<ModelConfig & { availability: ModelAvailability }>
> {
  return listAutoSelectableRealModels(await listModelsWithAvailabilityAsync());
}
