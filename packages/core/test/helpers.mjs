import { MockLanguageModelV3 } from "ai/test";

/** 把一串 v3 流分片包成 ReadableStream */
export function partsStream(parts) {
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i >= parts.length) {
        controller.close();
        return;
      }
      controller.enqueue(parts[i++]);
    },
  });
}

/** 造一个 usage 对象 */
export function usage(input, output) {
  return {
    inputTokens: { total: input, noCache: input, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: output, text: output, reasoning: 0 },
  };
}

/** 一轮：可选文本 + 可选若干工具调用 */
export function turn({ text, toolCalls = [], usage: u, withUsage = true }) {
  const parts = [];
  if (text) {
    parts.push({ type: "text-start", id: "t" });
    parts.push({ type: "text-delta", id: "t", delta: text });
    parts.push({ type: "text-end", id: "t" });
  }
  for (const tc of toolCalls) {
    const id = tc.toolCallId;
    const payload = JSON.stringify(tc.input ?? {});
    parts.push({ type: "tool-input-start", id, toolName: tc.toolName });
    parts.push({ type: "tool-input-delta", id, delta: payload });
    parts.push({ type: "tool-input-end", id });
    parts.push({
      type: "tool-call",
      toolCallId: id,
      toolName: tc.toolName,
      input: payload,
    });
  }
  const finish = {
    type: "finish",
    finishReason: {
      unified: toolCalls.length ? "tool-calls" : "stop",
      raw: toolCalls.length ? "tool_calls" : "stop",
    },
  };
  if (withUsage) finish.usage = u ?? usage(100, text ? 10 : 0);
  parts.push(finish);
  return parts;
}

/**
 * 造一个按剧本演的模型：scripts 是按调用次数依次取用的「轮」。
 * 注意 MockLanguageModelV3 的数组形式有 off-by-one（用 length 取下标），
 * 所以这里一律用函数形式手动取下标。
 */
export function scriptedModel(turns, { provider = "test", modelId = "test-model" } = {}) {
  let n = 0;
  return new MockLanguageModelV3({
    provider,
    modelId,
    doStream: async () => {
      const t = turns[Math.min(n, turns.length - 1)];
      n += 1;
      const parts = typeof t === "function" ? t(n) : t;
      return { stream: partsStream(parts) };
    },
    doGenerate: async () => {
      throw new Error("测试只走 doStream");
    },
  });
}
