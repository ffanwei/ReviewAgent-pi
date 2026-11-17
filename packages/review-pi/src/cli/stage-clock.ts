import type { StageSpan } from "./progress-render.js";

/** 审计内的一个阶段分段（收到 `phase` 事件时打点；闭合点 = 下一段或审计结束） */
export interface PhaseSpan {
  readonly round: number;
  readonly index: number;
  readonly phase: string;
  readonly start: number;
  readonly shardIndex?: number;
  /** run 层给出的真实结束时刻（分片路径）；缺席 = 沿用事件顺序推断 */
  readonly endedAt?: number;
}

/**
 * 进程级阶段账本：只在 CLI 内存里累计，**不落盘、不进审计、不改退出码**。
 * 时间来自 CLI 自身时钟与进度事件；进度关闭（`--no-progress`）时事件仍会
 * 经过 `onProgress`，所以账本照常成立。
 */
export interface StageClock {
  readonly commandStartedAt: number;
  runStartedAt?: number;
  auditEndedAt?: number;
  auditMs?: number;
  reportMs: number;
  tipsMs: number;
  summaryMs: number;
  settleMs: number;
  readonly phaseSpans: PhaseSpan[];
  readonly skillSpans: StageSpan[];
  skillStartedAt: number | undefined;
}

/** 把内存账本换算成可打印的阶段账本（纯函数边界：便于单测与口径统一） */
export function buildStageBreakdown(
  clock: StageClock,
  now: number,
): {
  readonly totalMs: number;
  readonly stages: readonly StageSpan[];
  readonly phases: readonly StageSpan[];
  readonly nested: readonly StageSpan[];
} {
  const runStartedAt = clock.runStartedAt ?? clock.commandStartedAt;
  const auditMs = clock.auditMs ?? 0;
  const auditEndedAt = runStartedAt + auditMs;
  const startupMs = Math.max(0, runStartedAt - clock.commandStartedAt);
  const knownMs =
    startupMs + auditMs + clock.reportMs + clock.tipsMs + clock.summaryMs + clock.settleMs;
  const totalMs = Math.max(0, now - clock.commandStartedAt);
  const otherMs = Math.max(0, totalMs - knownMs);
  const phases: StageSpan[] = clock.phaseSpans.map((span, index) => {
    const next = clock.phaseSpans[index + 1];
    const endedAt = span.endedAt ?? next?.start ?? auditEndedAt;
    const roundLabel = span.round > 1 ? `R${String(span.round)}` : "";
    const shardLabel = span.shardIndex !== undefined ? `S${String(span.shardIndex)}` : "";
    return {
      label: `${shardLabel}${roundLabel}P${String(span.index)}`,
      durationMs: Math.max(0, endedAt - span.start),
    };
  });
  return {
    totalMs,
    stages: [
      { label: "准备/建连（配置/规则包/MCP）", durationMs: startupMs },
      { label: "六阶段审计", durationMs: auditMs },
      { label: "报文生成+上报", durationMs: clock.reportMs },
      { label: "中文 tips 组装/落盘", durationMs: clock.tipsMs },
      { label: "总结生成", durationMs: clock.summaryMs },
      { label: "固定沉降", durationMs: clock.settleMs },
      { label: "其他/收尾（HTTP/落盘/事件 flush）", durationMs: otherMs },
    ],
    phases,
    nested: clock.skillSpans,
  };
}
