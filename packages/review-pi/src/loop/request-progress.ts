import type { LlmUsage } from "../contracts/llm.js";
import type { RunProgressSink } from "../contracts/progress.js";

/**
 * 请求首尾发射器（ADR-0016）：主会话、零工具路径（A/B）与 skill 会话三处共用
 * 同一份「序号 + 计时」语义，避免三处各写一遍 `Date.now()` 差值而在某处漂移。
 *
 * 只发射事件、不持业务状态：请求序号的作用域由调用方决定（每个 `Agent` 会话
 * 各自一个实例，序号天然从 1 开始）。计时仅用于显示，不写入任何产物。
 */
export interface RequestProgress {
  /** 请求真正发出（`onPayload`）：递增序号并开始计时 */
  readonly start: () => void;
  /** 回合结束（`shouldStopAfterTurn`）：报该回合 usage 与耗时 */
  readonly end: (usage: LlmUsage) => void;
}

export function createRequestProgress(
  emit: RunProgressSink,
  now: () => number = Date.now,
): RequestProgress {
  let requestId = 0;
  let startedAt = 0;
  return {
    start: () => {
      requestId += 1;
      startedAt = now();
      emit({ kind: "request", state: "start", requestId });
    },
    end: (usage) => {
      emit({
        kind: "request",
        state: "end",
        requestId,
        durationMs: Math.max(0, now() - startedAt),
        usage,
      });
    },
  };
}
