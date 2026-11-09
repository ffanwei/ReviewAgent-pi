// 网关 chat completion 响应的原始 usage 解析（非流式回包与 SSE usage 帧共用）。
//
// 单源纪律：一次性调用（报文 / 总结 / 候选修复）、冒烟探针与 e2e 录制都从这里
// 取 usage，避免各调用面各写一份字段兜底口径。这里只做**原始字段**提取，
// 不折算成 DSH 口径（`LlmUsage`）；折算由调用方按自己的语义完成。
//
// 兼容的字段形态（实测网关族）：
// - 标准 OpenAI：`usage.prompt_tokens` / `usage.completion_tokens`
// - DeepSeek：`usage.prompt_cache_hit_tokens`
// - OpenRouter 系：`usage.prompt_tokens_details.cached_tokens` /
//   `usage.prompt_tokens_details.cache_write_tokens`
// - 部分网关直接给 `usage.cached_tokens`

/** 网关原始 usage（chat completion 响应 usage 字段，未经口径折算） */
export interface RawWireUsage {
  readonly promptTokens: number;
  readonly completionTokens: number;
  readonly cacheReadTokens: number;
  /** prompt_tokens_details.cache_write_tokens（OpenRouter 系；缺席 = 0，pi-ai 折算同口径） */
  readonly cacheWriteTokens?: number;
}

/**
 * chat 响应 usage 投影（探测与真跑 recording-fetch 的单源提取器）：
 * 缺 usage 视为不可用（返回 null）。choices 有效性由各调用面自判
 * （SSE usage 帧合法地携带空 choices，不能在这里一并要求）。
 */
export function extractChatUsage(parsed: unknown): RawWireUsage | null {
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as { usage?: unknown };
  if (typeof record.usage !== "object" || record.usage === null) {
    return null;
  }
  const usage = record.usage as {
    prompt_tokens?: unknown;
    completion_tokens?: unknown;
    prompt_cache_hit_tokens?: unknown;
    cached_tokens?: unknown;
    prompt_tokens_details?: { cached_tokens?: unknown; cache_write_tokens?: unknown };
  };
  const promptTokens = numberOf(usage.prompt_tokens);
  const completionTokens = numberOf(usage.completion_tokens);
  if (promptTokens === null || completionTokens === null) {
    return null;
  }
  const cacheReadTokens =
    numberOf(usage.prompt_tokens_details?.cached_tokens) ??
    numberOf(usage.prompt_cache_hit_tokens) ??
    numberOf(usage.cached_tokens) ??
    0;
  const cacheWriteTokens = numberOf(usage.prompt_tokens_details?.cache_write_tokens);
  return {
    promptTokens,
    completionTokens,
    cacheReadTokens,
    ...(cacheWriteTokens !== null ? { cacheWriteTokens } : {}),
  };
}

function numberOf(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}
