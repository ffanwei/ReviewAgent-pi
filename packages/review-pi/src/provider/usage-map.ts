// usage 口径映射与累加（测量常量面：pi-ai Usage ↔ DSH 口径 LlmUsage）。
//
// 口径对账（DSH deepseek 路径为真源）：
// - inputTokens    ← pi Usage.input（pi-ai openai-completions 已按
//   max(0, prompt_tokens − cacheRead − cacheWrite) 折算出 miss 口径）
// - outputTokens   ← pi Usage.output（含思考 token）
// - cacheReadTokens ← pi Usage.cacheRead（DSH deepseek 路径恒置，含 0）
// - cacheWriteTokens：DeepSeek 无对应字段（pi 恒 0）→ 仅在 > 0 时置，不虚增
import type { Usage } from "@review-agent-pi/pi-ai";
import type { LlmUsage } from "../contracts/llm.js";

export function piUsageToLlmUsage(usage: Usage): LlmUsage {
  return {
    inputTokens: usage.input,
    outputTokens: usage.output,
    cacheReadTokens: usage.cacheRead,
    ...(usage.cacheWrite > 0 ? { cacheWriteTokens: usage.cacheWrite } : {}),
  };
}

/** 零值 usage（累计起点） */
export const ZERO_USAGE: LlmUsage = { inputTokens: 0, outputTokens: 0 };

/**
 * DSH 口径 → pi-ai `Usage`（反方向映射；只用于「拿累计 usage 重算成本」这类
 * 需要 pi 侧形状的场合——缺省 `cost` 全零，由 `calculateCost` 就地填充）。
 * 单点存在，避免调用方各自手搓一个字段不全的 `Usage`。
 */
export function llmUsageToPiUsage(usage: LlmUsage): Usage {
  const cacheRead = usage.cacheReadTokens ?? 0;
  const cacheWrite = usage.cacheWriteTokens ?? 0;
  return {
    input: usage.inputTokens,
    output: usage.outputTokens,
    cacheRead,
    cacheWrite,
    totalTokens: usage.inputTokens + usage.outputTokens + cacheRead + cacheWrite,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/** 纯函数累加：返回新对象，不改写入参；cache 字段任一操作数出现即保持 */
export function addUsage(a: LlmUsage, b: LlmUsage): LlmUsage {
  const hasCacheRead = a.cacheReadTokens !== undefined || b.cacheReadTokens !== undefined;
  const hasCacheWrite = a.cacheWriteTokens !== undefined || b.cacheWriteTokens !== undefined;
  return {
    inputTokens: a.inputTokens + b.inputTokens,
    outputTokens: a.outputTokens + b.outputTokens,
    ...(hasCacheRead ? { cacheReadTokens: (a.cacheReadTokens ?? 0) + (b.cacheReadTokens ?? 0) } : {}),
    ...(hasCacheWrite ? { cacheWriteTokens: (a.cacheWriteTokens ?? 0) + (b.cacheWriteTokens ?? 0) } : {}),
  };
}
