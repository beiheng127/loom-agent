/**
 * 上下文压缩（context compaction）。
 *
 * 本模块对标 DSH（DeepSeek Harness）的 **dsh-compaction-basic** 插件，
 * 默认参数与公式照抄它的权威来源：
 *
 * 1) 触发阈值：设上下文窗口 W、本次生效的请求输出上限 O、硬余量 B，则
 *      thresholdTokens = floor(min(W * thresholdRatio, W - O - B))
 *    其中 thresholdRatio 默认 0.8，B = headroomTokens 默认 65536，
 *    O = maxOutputTokens 默认 8192。
 * 2) 逐字保留的近期历史预算：
 *      retainBudgetTokens = (W - O) * retainRatio      // retainRatio 默认 0.16
 * 3) 行为：把最旧的一段「平衡范围」替换成**一条摘要消息**，近期尾部逐字不变，
 *    对话从摘要继续；报告压缩了多少条历史与估算释放的 token。
 * 4) 没有可安全压缩的内容时什么都不做；没有模型可写摘要时失败并给明确错误（不静默）。
 * 5) token 估算：**分宽窄**的启发式——ASCII 4 字符 ≈ 1 token（与 DSH 的 dsh-token-meter 同源），
 *    但 CJK（汉字/假名/谚文/全角标点）**1 个字符就约 1 个 token**。中文项目里一律按 4 字符估，
 *    会把压力算成实际的 1/2~1/4，压缩迟迟不触发、真到窗口边上才动手（见 `estimateTextTokens`）。
 *
 * 安全边界：从尾部按 token 预算扫出保留起点后，只允许停在 role === "user" 的消息上，
 * 因此绝不会把 tool-result 与其配对的 assistant tool-call 切开。
 */

import { generateText, type LanguageModel, type ModelMessage } from "ai";

/** 默认参数常量，导出以便 UI / 文档引用 */
export const COMPACT_DEFAULTS: {
  thresholdRatio: number;
  retainRatio: number;
  headroomTokens: number;
  maxOutputTokens: number;
  charsPerToken: number;
} = {
  thresholdRatio: 0.8,
  retainRatio: 0.16,
  headroomTokens: 65536,
  maxOutputTokens: 8192,
  charsPerToken: 4,
};

/** 摘要硬上限：800 字 */
const MAX_SUMMARY_CHARS = 800;
/** 拼摘要提示词时，单条旧消息最多带多少字符 */
const MAX_PROMPT_MESSAGE_CHARS = 4000;
/** 拼摘要提示词的总字符上限 */
const MAX_PROMPT_CHARS = 120_000;

export type CompactOptions = {
  messages: ModelMessage[];
  model: LanguageModel;
  /** 上下文窗口（token） */
  contextWindow: number;
  /** 触发比例，默认 0.8 */
  thresholdRatio?: number;
  /** 保留尾部比例，默认 0.16 */
  retainRatio?: number;
  /** 硬余量 token，默认 65536 */
  headroomTokens?: number;
  /** 单次请求输出上限，默认 8192 */
  maxOutputTokens?: number;
  signal?: AbortSignal;
};

export type CompactResult = {
  /** 压缩后的消息；未触发则原样返回同一数组内容 */
  messages: ModelMessage[];
  compacted: boolean;
  /** 被压缩掉的历史条数 */
  compactedCount: number;
  /** 估算释放的 token */
  releasedTokens: number;
  summary?: string;
  /** 触发判定时的估算 token 压力 */
  pressureTokens: number;
  /** 本次生效的阈值（token） */
  thresholdTokens: number;
  /** 保留的尾部条数 */
  retainedCount: number;
  /** 未压缩的原因（未触发 / 无可压缩内容 / 摘要失败），失败不静默 */
  reason?: string;
};

/** 4 字符 ≈ 1 token（仅对窄字符成立；宽字符见 estimateTextTokens）；对 content 为数组的消息同样适用 */
export function estimateMessagesTokens(messages: ModelMessage[]): number {
  let total = 0;
  for (const message of messages) {
    total += estimateMessageTokens(message);
  }
  return total;
}

/**
 * 宽字符（CJK 系）码点区间。
 *
 * 为什么单列：BPE 词表里一个汉字/假名/谚文基本就是一个 token，
 * 而 ASCII 平均 4 字符才 1 个 token。用同一个 charsPerToken 估中文，
 * 会低估算压力 3~4 倍——压缩该触发时不触发。
 */
const WIDE_CODE_RANGES: readonly (readonly [number, number])[] = [
  [0x1100, 0x11ff], // 谚文字母
  [0x2e80, 0x303f], // 部首扩展 + CJK 符号与标点
  [0x3040, 0x30ff], // 平假名 / 片假名
  [0x3130, 0x318f], // 谚文兼容字母
  [0x3400, 0x4dbf], // CJK 扩展 A
  [0x4e00, 0x9fff], // CJK 基本区（常用汉字）
  [0xa960, 0xa97f], // 谚文字母扩展 A
  [0xac00, 0xd7af], // 谚文音节
  [0xf900, 0xfaff], // CJK 兼容汉字
  [0xfe30, 0xfe4f], // CJK 兼容形式
  [0xff00, 0xff60], // 全角 ASCII
  [0xffe0, 0xffe6], // 全角符号（￥ 等）
];

function isWideCodePoint(code: number): boolean {
  for (const [low, high] of WIDE_CODE_RANGES) {
    if (code >= low && code <= high) return true;
  }
  return false;
}

/**
 * 估算一段文本的 token：宽字符 1 字符 ≈ 1 token，窄字符按 `charsPerToken`（默认 4）折。
 *
 * 这是**估算**，不是分词器。它的用途是决定「什么时候该压缩」，所以要的是别低估算压力；
 * 真实用量仍以模型回传的 usage 为准（`loop/run.ts` 的逐步计量）。
 */
export function estimateTextTokens(text: string, charsPerToken: number = COMPACT_DEFAULTS.charsPerToken): number {
  if (text.length === 0) return 0;
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (isWideCodePoint(code)) wide += 1;
    else narrow += 1;
  }
  if (wide === 0) return Math.ceil(narrow / charsPerToken);
  return Math.ceil(wide + narrow / charsPerToken);
}

/** 单条消息的估算 token（content 逐 part 估，宽窄分开算） */
function estimateMessageTokens(message: ModelMessage): number {
  return estimateContentTokens(message.content);
}

/** content 的估算 token：字符串直接估；数组逐 part 累加（文本按宽窄估，其余按 JSON 串折 4） */
function estimateContentTokens(content: unknown): number {
  if (typeof content === "string") return estimateTextTokens(content);
  if (!Array.isArray(content)) return 0;
  let tokens = 0;
  for (const part of content as readonly unknown[]) {
    tokens += estimatePartTokens(part);
  }
  return tokens;
}

function estimatePartTokens(part: unknown): number {
  const text = textOfPart(part);
  if (text !== null) return estimateTextTokens(text);
  return Math.ceil(safeStringify(part).length / COMPACT_DEFAULTS.charsPerToken);
}

/** content 的可读文本，用于拼摘要提示词 */
function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return (content as readonly unknown[]).map((part) => textOfPart(part) ?? safeStringify(part)).join("\n");
}

/** part 里现成的文本（text / reasoning 等）；没有则返回 null */
function textOfPart(part: unknown): string | null {
  if (typeof part !== "object" || part === null) return null;
  if (!("text" in part)) return null;
  const text = (part as { text?: unknown }).text;
  return typeof text === "string" ? text : null;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return String(value);
  }
}

/**
 * 本次生效的请求输出上限。
 *
 * DSH 的默认 O = 8192 是按 128k+ 窗口定的；W=4000 的小窗口上 `W - O` 已经为负，
 * 阈值会被夹到 0（实测过，不是推测），于是每轮都触发压缩。默认值跟着窗口收缩到
 * `min(8192, W * 0.25)`；**显式传入的值不缩放**，那是调用方的明确意图。
 */
function effectiveMaxOutputTokens(input: {
  contextWindow: number;
  maxOutputTokens: number;
  explicitOutput: boolean;
}): number {
  if (input.explicitOutput) return input.maxOutputTokens;
  return Math.min(input.maxOutputTokens, input.contextWindow * 0.25);
}

/**
 * 触发阈值：floor(min(W * thresholdRatio, W - O - B))
 *
 * 对 DSH 的两处必要偏离（都是小上下文模型下的真实缺陷，不是口味问题）：
 * 1) DSH 的 headroom 默认固定 65,536，那是按 128k+ 窗口定的。套到本项目的
 *    32k 模型上会算成 32000-8192-65536 = 负数 —— 阈值小于零意味着**永远不压缩**，
 *    压缩功能等于死掉。这里改成 headroom 取 `min(默认值, W * 0.25)`。
 * 2) 输出上限 O 同理按窗口收缩（见 effectiveMaxOutputTokens）。
 * 3) 算完再夹到 >= 0，保证「阈值」是个可比较的非负数。
 *
 * 缩放只作用于**默认值**：显式传入的 headroomTokens / maxOutputTokens 原样使用。
 */
function computeThresholdTokens(input: {
  contextWindow: number;
  thresholdRatio: number;
  /** 已经过 effectiveMaxOutputTokens 处理 */
  maxOutputTokens: number;
  headroomTokens: number;
  /** headroomTokens 是否由调用方显式传入（显式 → 不参与小窗口缩放） */
  explicitHeadroom: boolean;
}): number {
  const scaled = Math.min(input.headroomTokens, input.contextWindow * 0.25);
  const headroom = input.explicitHeadroom ? input.headroomTokens : scaled;
  const byRatio = input.contextWindow * input.thresholdRatio;
  const byHeadroom = input.contextWindow - input.maxOutputTokens - headroom;
  return Math.max(0, Math.floor(Math.min(byRatio, byHeadroom)));
}

/** 逐字保留的近期历史预算：(W - O) * retainRatio */
function computeRetainBudgetTokens(input: {
  contextWindow: number;
  maxOutputTokens: number;
  retainRatio: number;
}): number {
  const usable = Math.max(0, input.contextWindow - input.maxOutputTokens);
  return usable * input.retainRatio;
}

/** 从尾部按 token 预算扫保留起点；至少保留最后一条 */
function scanRetainStart(messages: ModelMessage[], budgetTokens: number): number {
  let acc = 0;
  let k = messages.length;
  while (k > 0) {
    const cost = estimateMessageTokens(messages[k - 1]);
    if (acc > 0 && acc + cost > budgetTokens) break;
    acc += cost;
    k -= 1;
  }
  return k;
}

function buildSummaryPrompt(dropped: ModelMessage[]): string {
  const blocks: string[] = [];
  let used = 0;
  for (let i = 0; i < dropped.length; i += 1) {
    const raw = contentText(dropped[i].content);
    const text =
      raw.length > MAX_PROMPT_MESSAGE_CHARS
        ? `${raw.slice(0, MAX_PROMPT_MESSAGE_CHARS)}…（本段过长，已截断）`
        : raw;
    const block = `#${i + 1} [${dropped[i].role}] ${text}`;
    if (used + block.length > MAX_PROMPT_CHARS) {
      blocks.push("…（更早的消息已省略）");
      break;
    }
    blocks.push(block);
    used += block.length;
  }

  return [
    "你是上下文压缩器。下面是一段即将从对话历史中裁掉的旧消息（按时间顺序）。",
    "请输出**要点式**中文摘要，务必保留：",
    "1) 任务目标（用户到底要什么）",
    "2) 已确认的结论",
    "3) 已改动的文件路径（路径要逐字保留，不要改写）",
    "4) 未完成的待办",
    "只写旧消息里出现过的事实，不要臆造。全文不超过 800 字。",
    "",
    "【旧消息开始】",
    blocks.join("\n\n"),
    "【旧消息结束】",
  ].join("\n");
}

function describeError(err: unknown, signal?: AbortSignal): string {
  const name =
    typeof err === "object" && err !== null && "name" in err
      ? String((err as { name?: unknown }).name)
      : "";
  const message = err instanceof Error ? err.message : String(err);
  if (signal?.aborted || name === "AbortError") {
    return `请求已中止（${name || "aborted"}）：${message}`;
  }
  return message;
}

export async function compactHistory(opts: CompactOptions): Promise<CompactResult> {
  const messages = opts.messages;
  const thresholdRatio = opts.thresholdRatio ?? COMPACT_DEFAULTS.thresholdRatio;
  const retainRatio = opts.retainRatio ?? COMPACT_DEFAULTS.retainRatio;
  const headroomTokens = opts.headroomTokens ?? COMPACT_DEFAULTS.headroomTokens;

  const maxOutputTokens = effectiveMaxOutputTokens({
    contextWindow: opts.contextWindow,
    maxOutputTokens: opts.maxOutputTokens ?? COMPACT_DEFAULTS.maxOutputTokens,
    explicitOutput: opts.maxOutputTokens !== undefined,
  });

  const thresholdTokens = computeThresholdTokens({
    contextWindow: opts.contextWindow,
    thresholdRatio,
    maxOutputTokens,
    headroomTokens,
    explicitHeadroom: opts.headroomTokens !== undefined,
  });
  const pressureTokens = estimateMessagesTokens(messages);

  const untouched = (reason: string): CompactResult => ({
    messages,
    compacted: false,
    compactedCount: 0,
    releasedTokens: 0,
    pressureTokens,
    thresholdTokens,
    retainedCount: messages.length,
    reason,
  });

  if (messages.length === 0) {
    return untouched("没有可安全压缩的旧内容");
  }

  if (pressureTokens <= thresholdTokens) {
    return untouched(`未触发压缩阈值（压力 ${pressureTokens} ≤ 阈值 ${thresholdTokens}）`);
  }

  const retainBudgetTokens = computeRetainBudgetTokens({
    contextWindow: opts.contextWindow,
    maxOutputTokens,
    retainRatio,
  });

  const k = scanRetainStart(messages, retainBudgetTokens);
  if (k === 0) {
    return untouched("没有可安全压缩的旧内容");
  }

  // 边界安全：保留起点只允许落在 user 消息上，绝不切开 tool-call / tool-result 配对
  let start = k;
  while (start > 0 && messages[start].role !== "user") {
    start -= 1;
  }
  if (messages[start].role !== "user") {
    return untouched("找不到可安全保留的边界");
  }
  if (start === 0) {
    return untouched("没有可安全压缩的旧内容");
  }

  const dropped = messages.slice(0, start);
  const retained = messages.slice(start);

  let summary: string;
  try {
    const generated = await generateText({
      model: opts.model,
      prompt: buildSummaryPrompt(dropped),
      abortSignal: opts.signal,
      maxRetries: 1,
    });
    summary = generated.text.trim();
  } catch (err) {
    return untouched(`摘要生成失败：${describeError(err, opts.signal)}`);
  }

  if (!summary) {
    return untouched("摘要为空，未压缩");
  }
  if (summary.length > MAX_SUMMARY_CHARS) {
    summary = `${summary.slice(0, MAX_SUMMARY_CHARS)}…`;
  }

  const summaryMessage: ModelMessage = {
    role: "user",
    content: `<context_summary>\n${summary}\n</context_summary>`,
  };
  const next: ModelMessage[] = [summaryMessage, ...retained];

  const afterTokens = estimateMessagesTokens(next);
  const releasedTokens = Math.max(0, pressureTokens - afterTokens);

  return {
    messages: next,
    compacted: true,
    compactedCount: start,
    releasedTokens,
    summary,
    pressureTokens,
    thresholdTokens,
    retainedCount: retained.length,
  };
}
