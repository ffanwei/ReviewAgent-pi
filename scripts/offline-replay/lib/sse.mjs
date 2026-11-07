/**
 * SSE 渲染器：与 `packages/review-pi/src/provider/fake-fetch.ts` 的 `sseBody`
 * 逐帧同格式（两段 content delta → tool_calls → finish → usage → [DONE]）。
 *
 * 为什么要在这里复制一份：录制/回放工具是仓库工具链（`.mjs`），不参与
 * review-pi 的 TypeScript 构建，也不应要求先 `pnpm build`。帧形态如果需要
 * 演进，两处必须同步——录制出来的 trace 是冻结字节，改渲染器不会改旧 trace。
 */

const FAKE_MODEL_ID = "deepseek-v4-flash";

export function sseBody(reply) {
  const frames = [
    ...contentDeltas(reply.text ?? "").map((delta) => contentChunk(delta)),
    ...(reply.toolCalls ?? []).map((call, index) => toolCallChunk(call, index)),
    finishChunk(reply.finishReason ?? defaultFinishReason(reply)),
    usageChunk(reply.usage),
    "data: [DONE]",
  ];
  return `${frames.join("\n\n")}\n\n`;
}

function defaultFinishReason(reply) {
  return (reply.toolCalls ?? []).length > 0 ? "tool_calls" : "stop";
}

function toolCallChunk(call, index) {
  return dataFrame({
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index,
              id: call.id,
              type: "function",
              function: { name: call.name, arguments: JSON.stringify(call.arguments) },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  });
}

function contentDeltas(text) {
  if (text.length === 0) {
    return [];
  }
  if (text.length === 1) {
    return [text];
  }
  const half = Math.ceil(text.length / 2);
  return [text.slice(0, half), text.slice(half)];
}

function contentChunk(content) {
  return dataFrame({ choices: [{ index: 0, delta: { content }, finish_reason: null }] });
}

function finishChunk(finishReason) {
  return dataFrame({ choices: [{ index: 0, delta: {}, finish_reason: finishReason }] });
}

function usageChunk(usage) {
  return dataFrame({
    choices: [],
    usage: {
      prompt_tokens: usage.promptTokens,
      completion_tokens: usage.completionTokens,
      prompt_cache_hit_tokens: usage.cacheReadTokens,
    },
  });
}

function dataFrame(chunk) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-fake",
    object: "chat.completion.chunk",
    model: FAKE_MODEL_ID,
    ...chunk,
  })}`;
}
