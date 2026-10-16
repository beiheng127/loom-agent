/**
 * Plan 动态拆步：让**模型**把一句总目标拆成一份带依赖的 Worker 清单。
 *
 * 在此之前，Plan Board 的 Worker 只能来自预设或人工配置（README 自己写明的边界：
 * 「能编排已知的长链路，不能自己长出链路」）。planner 补的就是这一环。
 *
 * 刻意做小，只干三件事：
 * 1. 一句总目标 → 一份 JSON 清单（`workers[]`，每条含 title/goal/agentId/modelId/dependsOn）
 * 2. 清单过三道校验：形状（缺字段直接拒）、数量上限（超了截断并记 note）、
 *    依赖合法（越界 / 自依赖直接拒，成环交给 `topoBatches` 抛错）
 * 3. 模型不给力就 `ok:false` + reason 交回去，由调用方回落到预设 Worker——
 *    **不假装规划成功**，更不会把半截清单塞进调度器
 *
 * 执行侧不在这里：清单产出后仍然交给 `runParallelPlan` 的调度器（依赖分批 / 重试 / 上游下沉）。
 */
import { generateText, type LanguageModel } from "ai";
import { getModelConfig, resolveLanguageModel } from "../models/registry.js";
import {
  PlanDependencyError,
  topoBatches,
  type PlanBatchIndex,
  type PlanJudge,
  type PlanReplanner,
  type PlanWorkerDef,
} from "./orchestrator.js";

export const PLANNER_DEFAULTS = {
  /** 超过这个数量的 Worker 会被截断（并记进 notes） */
  maxWorkers: 4,
  /** 规划用温度：要的是稳定清单，不是文采 */
  temperature: 0,
  /** 模型输出超过这个字符数就不费劲解析了 */
  maxOutputChars: 16000,
} as const;

/**
 * 重规划给的新步，没写 modelId 时兜底用这个。
 * 刻意不沿用失败步的模型——那一步刚刚证明自己跑不通，沿用等于再撞一次同一堵墙。
 */
const PLANNER_FALLBACK_MODEL = "mock-local";

/** 规划失败（形状不对 / 依赖不合法 / 模型没吐 JSON）——调用方据此回落预设 */
export class PlanPlannerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlanPlannerError";
  }
}

export type PlanWorkerDraft = {
  title: string;
  goal: string;
  agentId?: string;
  modelId?: string;
  /** 依赖的 Worker 下标（0 基）；成环会在校验阶段被拒 */
  dependsOn?: number[];
};

export type PlanPlannerInput = {
  goal: string;
  /** 直接注入 LanguageModel（测试缝）；不给则按 modelId 解析 */
  languageModel?: LanguageModel | null;
  modelId?: string;
  maxWorkers?: number;
  /** 模型可以挑的 Agent 档案；不在列表里的会回落默认值并记 note */
  allowedAgentIds?: string[];
  defaultAgentId?: string;
  defaultModelId?: string;
  signal?: AbortSignal;
};

export type PlanPlannerResult =
  | {
      ok: true;
      source: "llm";
      workers: PlanWorkerDef[];
      batches: PlanBatchIndex[];
      notes: string[];
      rawText: string;
      elapsedMs: number;
    }
  | { ok: false; source: "llm"; reason: string; elapsedMs: number };

/** 规划提示词：System 讲协议，User 只给目标 */
export function buildPlannerPrompt(
  goal: string,
  options: {
    maxWorkers?: number;
    allowedAgentIds?: string[];
  } = {},
): { system: string; prompt: string } {
  const max = options.maxWorkers ?? PLANNER_DEFAULTS.maxWorkers;
  const agents =
    options.allowedAgentIds && options.allowedAgentIds.length
      ? options.allowedAgentIds.join(" / ")
      : "(任意)";
  const system = [
    "你是一个任务编排器。把用户的总目标拆成若干可以并行的 Worker，并给出依赖关系。",
    "",
    "严格只输出一个 JSON 对象（不要解释、不要 Markdown 围栏），形状：",
    '{"workers":[{"title":"短标题","goal":"这一步要干什么","agentId":"reader","dependsOn":[]}]}',
    "",
    "规则：",
    `- workers 最多 ${max} 条，宁少勿多；能并行的步骤别串起来`,
    `- agentId 从这些里挑：${agents}`,
    "- dependsOn 是**下标数组**（0 基），指向前面的 Worker；没有依赖就写 []",
    "- dependsOn 不许指向自己，也不许成环",
    "- goal 要写成能直接交给一个 Agent 执行的一句话，别写「同前」这种废话",
  ].join("\n");
  const prompt = [`总目标：${goal}`, "", "请只输出 JSON 清单。"].join("\n");
  return { system, prompt };
}

/**
 * 从模型输出里抠出 JSON 对象。
 * 依次尝试：整体 JSON → ```json 围栏 → 第一个 `{` 到最后一个 `}`。
 * 三段都失败才抛错（错误信息带上输出开头，方便看模型到底吐了什么）。
 */
export function extractJsonBlock(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) throw new PlanPlannerError("模型输出是空的");
  if (trimmed.length > PLANNER_DEFAULTS.maxOutputChars) {
    throw new PlanPlannerError(
      `模型输出太长（${trimmed.length} 字符 > ${PLANNER_DEFAULTS.maxOutputChars}），不像一份清单`,
    );
  }
  const candidates: string[] = [trimmed];
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenced?.[1]) candidates.push(fenced[1].trim());
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first !== -1 && last > first) candidates.push(trimmed.slice(first, last + 1));
  const errors: string[] = [];
  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate) as unknown;
    } catch (err) {
      errors.push(err instanceof Error ? err.message : String(err));
    }
  }
  throw new PlanPlannerError(
    `模型没吐出能解析的 JSON（试了 ${candidates.length} 种抠法）。原文开头：${trimmed.slice(0, 120)}`,
  );
}

/** 从 `{workers:[...]}` 或裸数组里取出草稿数组 */
export function extractDrafts(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const list = (raw as { workers?: unknown }).workers;
    if (Array.isArray(list)) return list;
    throw new PlanPlannerError(
      `JSON 里没有 workers 数组（对象的键：${Object.keys(raw as object).join(", ") || "无"}）`,
    );
  }
  throw new PlanPlannerError(
    `JSON 顶层既不是数组也不是对象（实际是 ${raw === null ? "null" : typeof raw}）`,
  );
}

function nonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/**
 * 草稿 → `PlanWorkerDef[]`：逐字段校验，不合法就整份拒掉（别让半份清单跑起来）。
 * 只有「agentId 不在允许列表」和「超出数量上限」是可修复的，修复动作记进 notes。
 */
export function normalizePlannerDrafts(
  raw: unknown,
  options: {
    maxWorkers?: number;
    allowedAgentIds?: string[];
    defaultAgentId?: string;
    defaultModelId?: string;
  } = {},
): { workers: PlanWorkerDef[]; notes: string[] } {
  const max = options.maxWorkers ?? PLANNER_DEFAULTS.maxWorkers;
  const defaultAgentId = options.defaultAgentId ?? "reader";
  const defaultModelId = options.defaultModelId ?? "mock-local";
  const allowed = options.allowedAgentIds ?? [];
  const notes: string[] = [];
  const drafts = extractDrafts(raw);
  if (drafts.length === 0) throw new PlanPlannerError("workers 是空数组，等于没规划");

  let kept = drafts;
  if (drafts.length > max) {
    kept = drafts.slice(0, max);
    notes.push(`模型给了 ${drafts.length} 个 Worker，超过上限 ${max}，只留前 ${max} 个`);
  }

  const workers: PlanWorkerDef[] = kept.map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) {
      throw new PlanPlannerError(`第 ${index} 个 Worker 不是对象`);
    }
    const draft = item as PlanWorkerDraft;
    const title = nonEmptyString(draft.title);
    if (!title) throw new PlanPlannerError(`第 ${index} 个 Worker 缺 title（或不是非空字符串）`);
    const goal = nonEmptyString(draft.goal);
    if (!goal) throw new PlanPlannerError(`第 ${index} 个 Worker 缺 goal（或不是非空字符串）`);

    let agentId = nonEmptyString(draft.agentId) ?? defaultAgentId;
    if (allowed.length && !allowed.includes(agentId)) {
      notes.push(`第 ${index} 个 Worker 用了不在列表里的 agentId「${agentId}」，回落 ${defaultAgentId}`);
      agentId = defaultAgentId;
    }
    const modelId = nonEmptyString(draft.modelId) ?? defaultModelId;

    let dependsOn: number[] | undefined;
    if (draft.dependsOn !== undefined) {
      const rawDeps = draft.dependsOn;
      if (!Array.isArray(rawDeps)) {
        throw new PlanPlannerError(`第 ${index} 个 Worker 的 dependsOn 不是数组`);
      }
      const deps: number[] = [];
      for (const dep of rawDeps) {
        if (typeof dep !== "number" || !Number.isInteger(dep)) {
          throw new PlanPlannerError(`第 ${index} 个 Worker 的依赖「${String(dep)}」不是整数下标`);
        }
        if (dep === index) {
          throw new PlanPlannerError(`第 ${index} 个 Worker 依赖自己（dependsOn 里写了 ${index}）`);
        }
        if (dep < 0 || dep >= kept.length) {
          throw new PlanPlannerError(
            `第 ${index} 个 Worker 依赖下标 ${dep}，但这次只有 ${kept.length} 个 Worker（下标 0..${kept.length - 1}）`,
          );
        }
        if (!deps.includes(dep)) deps.push(dep);
      }
      if (deps.length) dependsOn = deps.sort((a, b) => a - b);
    }

    const worker: PlanWorkerDef = { agentId, modelId, title, goal };
    if (dependsOn) worker.dependsOn = dependsOn;
    return worker;
  });

  return { workers, notes };
}

/**
 * 主入口：总目标 → Worker 清单（带依赖分批）。
 * 任何一步失败都返回 `ok:false`，绝不抛给调用方去做 500——规划失败是可预期的。
 */
export async function planWorkers(input: PlanPlannerInput): Promise<PlanPlannerResult> {
  const started = Date.now();
  const done = (result: Omit<Extract<PlanPlannerResult, { ok: false }>, "elapsedMs">) => ({
    ...result,
    elapsedMs: Date.now() - started,
  });

  let model = input.languageModel ?? null;
  if (!model && input.modelId) {
    model = resolveLanguageModel(getModelConfig(input.modelId));
  }
  if (!model) {
    return done({
      ok: false,
      source: "llm",
      reason: input.modelId
        ? `模型「${input.modelId}」不是能规划的模型（mock 只照剧本演，没有真模型就不拆步）`
        : "没给模型：规划要真模型，mock 模型只照剧本演",
    });
  }

  const maxWorkers = input.maxWorkers ?? PLANNER_DEFAULTS.maxWorkers;
  const { system, prompt } = buildPlannerPrompt(input.goal, {
    maxWorkers,
    allowedAgentIds: input.allowedAgentIds,
  });

  let text: string;
  try {
    const result = await generateText({
      model,
      system,
      prompt,
      temperature: PLANNER_DEFAULTS.temperature,
      maxRetries: 1,
      abortSignal: input.signal,
    });
    text = result.text;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return done({
      ok: false,
      source: "llm",
      reason: input.signal?.aborted ? `规划被取消：${message}` : `模型调用失败：${message}`,
    });
  }

  try {
    const raw = extractJsonBlock(text);
    const { workers, notes } = normalizePlannerDrafts(raw, {
      maxWorkers,
      allowedAgentIds: input.allowedAgentIds,
      defaultAgentId: input.defaultAgentId,
      defaultModelId: input.defaultModelId,
    });
    const batches = topoBatches(workers); // 成环 / 依赖越界在这里兜底
    return {
      ok: true,
      source: "llm",
      workers,
      batches,
      notes,
      rawText: text,
      elapsedMs: Date.now() - started,
    };
  } catch (err) {
    const message =
      err instanceof PlanDependencyError
        ? `模型给的依赖成环了：${err.message}`
        : err instanceof Error
          ? err.message
          : String(err);
    return done({ ok: false, source: "llm", reason: message });
  }
}

/** 把规划结果写成一行人类可读的摘要（API 响应 / 日志都能用） */
export function describePlannerResult(result: PlanPlannerResult): string {
  if (!result.ok) return `规划失败：${result.reason}`;
  const shape = result.batches.map((b) => b.length).join(" → ");
  const notes = result.notes.length ? `；附注 ${result.notes.length} 条` : "";
  return `模型拆出 ${result.workers.length} 个 Worker，批次 ${shape}（${result.elapsedMs}ms）${notes}`;
}

/** 失败重规划的请求体：让模型看着「原目标 + 哪步挂了 + 已完成的结论」重排剩下的 */
export function buildReplanPrompt(input: {
  goal: string;
  failedTitle: string;
  failedGoal: string;
  error: string;
  doneTitles: string[];
  remainingTitles: string[];
}): { system: string; prompt: string } {
  const done = input.doneTitles.length
    ? input.doneTitles.map((t) => `- ${t}`).join("\n")
    : "-（还没有完成的步骤）";
  const remaining = input.remainingTitles.map((t) => `- ${t}`).join("\n");
  const system = [
    "你是一个任务编排器。一次执行里某一步失败了，你要把**剩下没跑的步骤**重新拆一遍，绕开这个失败。",
    "",
    "严格只输出一个 JSON 对象（不要解释、不要 Markdown 围栏），形状：",
    '{"workers":[{"title":"短标题","goal":"这一步要干什么","agentId":"reader","dependsOn":[]}]}',
    "",
    "规则：",
    `- 必须正好 ${input.remainingTitles.length} 条 Worker（替换下面列出的这些步骤，一条对一个）`,
    "- dependsOn 是**下标数组**（0 基），指向**这份新清单内部**的其它 Worker；不许指向已完成的步骤",
    "- 不许依赖失败的那一步（它已经挂了），要换成别的路径完成同一个总目标",
    "- 不许成环，不许依赖自己",
    "- goal 要写成能直接交给一个 Agent 执行的一句话",
  ].join("\n");
  const prompt = [
    `总目标：${input.goal}`,
    "",
    `失败的步骤：${input.failedTitle}（要做的是：${input.failedGoal}）`,
    `失败原因：${input.error}`,
    "",
    `已经完成的步骤：\n${done}`,
    "",
    `需要你重排的 ${input.remainingTitles.length} 个步骤（按这个顺序给出）：\n${remaining}`,
    "",
    "请只输出 JSON 清单。",
  ].join("\n");
  return { system, prompt };
}

/** best-of-N 的裁判提示词：给 N 份候选，让模型只回一个下标 */
export function buildJudgePrompt(input: {
  goal: string;
  candidates: string[];
}): { system: string; prompt: string } {
  const system = [
    "你是一个评审。下面有若干份针对同一目标的候选结论，你要挑出最好的那份。",
    "",
    "严格只输出一个 JSON 对象（不要解释、不要 Markdown 围栏），形状：",
    '{"index":0}',
    "",
    "规则：",
    `- index 是 0 基下标，必须在 0..${input.candidates.length - 1} 之间`,
    "- 只看「对目标的完成度、准确性、可执行性」，不要因为某份更长就选它",
    "- 打不开局面就选第 0 份，别输出别的东西",
  ].join("\n");
  const prompt = [
    `目标：${input.goal}`,
    "",
    ...input.candidates.map(
      (c, k) => `### 候选 ${k}\n${c.slice(0, 4000)}\n`,
    ),
    "请只输出 JSON。",
  ].join("\n");
  return { system, prompt };
}

/** 从模型输出里抠出 `{"index":n}`；抠不出来就返回 null（调用方退回第 0 份） */
export function extractJudgeIndex(text: string, total: number): number | null {
  const trimmed = text.trim();
  const bare = trimmed.match(/^\s*(\d+)\s*$/);
  if (bare) {
    const n = Number(bare[1]);
    return n >= 0 && n < total ? n : null;
  }
  try {
    const raw = extractJsonBlock(text) as { index?: unknown };
    const n = Number(raw?.index);
    if (!Number.isInteger(n) || n < 0 || n >= total) return null;
    return n;
  } catch {
    return null;
  }
}

/**
 * 造一个 best-of-N 裁判：让模型从 N 份候选里挑一份。
 *
 * 和 replanner 一样是工厂：调度器只认回调。模型不给力（吐不出下标 / 越界 / 报错）
 * 就抛错——调度器会退回第 0 份候选并把原因写进 `step.error`，**不会**假装择优成功。
 */
export function makePlannerJudge(input: {
  modelId?: string;
  languageModel?: LanguageModel | null;
  signal?: AbortSignal;
}): PlanJudge {
  return async ({ goal, candidates }) => {
    if (candidates.length < 2) return 0;
    let model = input.languageModel ?? null;
    if (!model && input.modelId) {
      model = resolveLanguageModel(getModelConfig(input.modelId));
    }
    if (!model) return 0;

    const { system, prompt } = buildJudgePrompt({ goal, candidates });
    const result = await generateText({
      model,
      system,
      prompt,
      temperature: PLANNER_DEFAULTS.temperature,
      maxRetries: 1,
      abortSignal: input.signal,
    });
    const picked = extractJudgeIndex(result.text, candidates.length);
    if (picked === null) {
      throw new Error(
        `裁判没给出合法下标（共 ${candidates.length} 个候选）。原文开头：${result.text.trim().slice(0, 80)}`,
      );
    }
    return picked;
  };
}

/**
 * 造一个接在调度器上的 `PlanReplanner`：失败时请模型重排**剩下没跑**的步。
 *
 * 为什么是工厂：调度器只认回调（不认模型），要不要烧 token 重规划由调用方决定。
 * 模型不给力 / 数量对不上 → 返回 null，调度器会照旧把剩下的标 skipped，
 * **不会**拿一份半截清单去跑。
 */
export function makePlannerReplanner(input: {
  modelId?: string;
  languageModel?: LanguageModel | null;
  maxWorkers?: number;
  allowedAgentIds?: string[];
  defaultAgentId?: string;
  defaultModelId?: string;
  signal?: AbortSignal;
  onNote?: (note: string) => void;
}): PlanReplanner {
  const maxWorkers = input.maxWorkers ?? PLANNER_DEFAULTS.maxWorkers;
  return async ({ goal, failed, error, workers, remaining }) => {
    let model = input.languageModel ?? null;
    if (!model && input.modelId) {
      model = resolveLanguageModel(getModelConfig(input.modelId));
    }
    if (!model) return null;

    const doneTitles = workers
      .filter((_, i) => !remaining.includes(i))
      .map((w) => w.title);
    const { system, prompt } = buildReplanPrompt({
      goal,
      failedTitle: failed.title,
      failedGoal: failed.goal,
      error,
      doneTitles,
      remainingTitles: remaining.map((i) => workers[i]?.title ?? `第 ${i + 1} 步`),
    });

    let text: string;
    try {
      const result = await generateText({
        model,
        system,
        prompt,
        temperature: PLANNER_DEFAULTS.temperature,
        maxRetries: 1,
        abortSignal: input.signal,
      });
      text = result.text;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      input.onNote?.(`重规划时模型调用失败，照旧跳过剩余步骤：${message}`);
      return null;
    }

    try {
      const raw = extractJsonBlock(text);
      // 关键：默认模型绝不能沿用**失败那一步**的模型——它刚证明自己跑不通。
      // 用重规划自己这个模型（它刚才成功返回了清单），都没有才退回默认。
      const fallbackModel =
        input.defaultModelId ?? input.modelId ?? PLANNER_FALLBACK_MODEL;
      const { workers: next, notes } = normalizePlannerDrafts(raw, {
        maxWorkers: Math.max(maxWorkers, remaining.length),
        allowedAgentIds: input.allowedAgentIds,
        defaultAgentId: input.defaultAgentId,
        defaultModelId: fallbackModel,
      });
      // 模型若照抄了失败步的模型，就地换掉：不然重排出来的一步会接着撞同一堵墙
      if (input.defaultModelId === undefined && failed.modelId) {
        for (const w of next) {
          if (w.modelId === failed.modelId) w.modelId = fallbackModel;
        }
      }
      for (const note of notes) input.onNote?.(note);
      // 数量对不上 → 整个作废（调度器会因此保留原步并跳过，绝不错位执行）
      if (next.length !== remaining.length) {
        input.onNote?.(
          `重规划给了 ${next.length} 个 Worker，但需要 ${remaining.length} 个，作废`,
        );
        return null;
      }
      return next;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      input.onNote?.(`重规划结果不可用，照旧跳过剩余步骤：${message}`);
      return null;
    }
  };
}
