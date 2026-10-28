import { SKILL_BASH_TOOL_NAME } from "../tools/skill-bash.js";
import type { LlmUsage } from "../contracts/llm.js";
import type { RunProgressEvent } from "../contracts/progress.js";

/**
 * 运行进度投影的呈现层（ADR-0016）：把核内事件流写成 `stderr` 的人读行。
 *
 * 形态（验收：TTY 混合刷新 / 非 TTY 纯追加）：
 * - 事件行：一行一件事，永远追加（阶段推进 / 请求完成 / 工具完成 / skill 起止 /
 *   收尾摘要）。日志重定向后可 grep，`\r` 不出现。
 * - 状态行：仅 TTY 绘制，`\r` 原地重画（空格补白，不用 ANSI 清行——老 ConHost
 *   兼容）；任何事件行开写前先擦除，收尾后不留残影。状态行只显示**在飞**的
 *   请求与当前阶段——请求一旦结束就撤下，否则 bash 卡 120s 会被误读成网关慢。
 *
 * 脱敏：本层只消费事件里已投影好的 `argumentsSummary` / `detail`（内核侧已
 * 截断），永不接触工具结果全文与审计 `resultSummary`。
 */

/** 收尾摘要（计数由呈现层自身累计，token/成本/耗时由调用方按审计同源口径给出） */
export interface ProgressFinishInput {
  readonly durationMs: number;
  /** 与 `record.baseline.usage` 同源（已含 skill 会话折算） */
  readonly usage: LlmUsage;
  readonly costUsd: number;
}

/** 展示用的完整摘要（`doneLine` 的入参） */
export interface ProgressSummary extends ProgressFinishInput {
  /** 本次 run 的模型请求总数（主会话 + skill 会话） */
  readonly requests: number;
  /** 工具调用数（review 工具 / skill bash 分列） */
  readonly reviewToolCalls: number;
  readonly bashToolCalls: number;
}

export interface ProgressRendererOptions {
  readonly write: (text: string) => void;
  /** TTY 判定：false 时只追加事件行，永不绘制状态行 */
  readonly isTty: boolean;
  /** 时钟注入（测试确定性；缺省 Date.now） */
  readonly now?: () => number;
  /** 状态行重画周期（仅 TTY；缺省 1000ms） */
  readonly heartbeatMs?: number;
}

export interface ProgressRenderer {
  readonly onEvent: (event: RunProgressEvent) => void;
  /** 启动状态行心跳（仅 TTY）；未启动时事件行照常追加 */
  readonly start: () => void;
  /** 收尾：擦除状态行 + 输出 done 行（幂等） */
  readonly finish: (input: ProgressFinishInput) => void;
  /** 异常路径清理（幂等；只擦状态行，不输出摘要） */
  readonly dispose: () => void;
}

export function createProgressRenderer(options: ProgressRendererOptions): ProgressRenderer {
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? 1000;
  let requestCount = 0;
  let reviewToolCalls = 0;
  let bashToolCalls = 0;
  let phaseIndex: number | undefined;
  let phaseTotal: number | undefined;
  let round: number | undefined;
  let phaseToolCalls = 0;
  let currentRequest: { readonly id: number; readonly startedAt: number } | undefined;
  let currentSkill: string | undefined;
  let statusLine: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let finished = false;

  function scopePrefix(): string {
    return currentSkill === undefined ? "" : `[skill:${currentSkill}] `;
  }

  /** 事件行（先擦状态行，再追加，再重画状态行） */
  function writeLine(line: string): void {
    eraseStatus();
    options.write(`${line}\n`);
    redrawStatus();
  }

  function statusText(): string | undefined {
    if (!options.isTty) {
      return undefined;
    }
    const parts: string[] = [];
    if (currentRequest !== undefined) {
      const elapsed = Math.max(0, Math.round((now() - currentRequest.startedAt) / 1000));
      parts.push(`req ${currentRequest.id} ${elapsed}s`);
    }
    if (phaseIndex !== undefined && phaseTotal !== undefined) {
      parts.push(`phase ${phaseIndex}/${phaseTotal}`);
    }
    if (round !== undefined) {
      parts.push(`round ${round}`);
    }
    if (phaseToolCalls > 0) {
      parts.push(`tools ${phaseToolCalls}`);
    }
    if (currentSkill !== undefined) {
      parts.push(`skill ${currentSkill}`);
    }
    return parts.length === 0 ? undefined : `… ${parts.join(" · ")}`;
  }

  function redrawStatus(): void {
    if (!options.isTty || finished) {
      return;
    }
    const text = statusText();
    if (text === undefined) {
      return;
    }
    const width = statusLine?.length ?? 0;
    const padded = text.length < width ? text + " ".repeat(width - text.length) : text;
    options.write(`\r${padded}`);
    statusLine = text;
  }

  /** 擦除状态行（空格补白 + 回车归零）；不在 TTY 或没画过时零输出 */
  function eraseStatus(): void {
    if (statusLine === undefined) {
      return;
    }
    options.write(`\r${" ".repeat(statusLine.length)}\r`);
    statusLine = undefined;
  }

  function handle(event: RunProgressEvent): void {
    switch (event.kind) {
      case "phase": {
        phaseIndex = event.index;
        phaseTotal = event.total;
        round = event.round;
        phaseToolCalls = 0;
        writeLine(`▶ phase ${event.index}/${event.total} ${event.phase} (round ${event.round})`);
        return;
      }
      case "request": {
        if (event.state === "start") {
          currentRequest = { id: event.requestId, startedAt: now() };
          requestCount += 1;
          redrawStatus();
          return;
        }
        // 请求已落地：状态行不该再显示它（否则等待工具的时间会被算进「请求在飞」）
        currentRequest = undefined;
        writeLine(
          `  ${scopePrefix()}req ${event.requestId} ${formatSeconds(event.durationMs)}s · ` +
            `in ${formatInt(event.usage.inputTokens)} ` +
            `(cache ${formatInt(event.usage.cacheReadTokens ?? 0)}, ${cacheHit(event.usage)}) · ` +
            `out ${formatInt(event.usage.outputTokens)}`,
        );
        return;
      }
      case "tool": {
        if (event.state === "start") {
          phaseToolCalls += 1;
          redrawStatus();
          return;
        }
        if (event.name === SKILL_BASH_TOOL_NAME) {
          bashToolCalls += 1;
        } else {
          reviewToolCalls += 1;
        }
        const status = event.ok ? "ok" : "FAIL";
        const parts = [
          `  ${scopePrefix()}tool ${event.name} ${status} ${formatSeconds(event.durationMs)}s`,
        ];
        if (event.argumentsSummary.length > 0) {
          parts.push(event.argumentsSummary);
        }
        // 结果只报尺寸（原文字符数 + 行数），全文永不落地
        parts.push(`${formatInt(event.resultChars)} chars / ${formatInt(event.resultLines)} lines`);
        if (!event.ok && event.detail !== undefined) {
          parts.push(event.detail);
        }
        writeLine(parts.join(" · "));
        return;
      }
      case "skill": {
        if (event.state === "start") {
          currentSkill = event.skill;
          writeLine(`■ skill ${event.skill} (round ${event.round})`);
          return;
        }
        const status =
          event.status === "ok" ? "done" : event.status === "empty" ? "empty" : "FAILED";
        const parts = [
          `■ skill ${event.skill} ${status} · ${event.requestCount} req · ${event.toolCallCount} tools · ${formatSeconds(event.durationMs)}s`,
        ];
        if (event.detail !== undefined) {
          parts.push(event.detail);
        }
        writeLine(parts.join(" · "));
        currentSkill = undefined;
        return;
      }
    }
  }

  return {
    onEvent: (event) => {
      if (!finished) {
        handle(event);
      }
    },
    start: () => {
      if (!options.isTty || timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        redrawStatus();
      }, heartbeatMs);
      // 定时器不保活进程（CLI 自然排干后必须能退出）
      (timer as { unref?: () => void }).unref?.();
    },
    finish: (input) => {
      if (finished) {
        return;
      }
      finished = true;
      stopTimer();
      eraseStatus();
      options.write(
        `${doneLine({
          ...input,
          requests: requestCount,
          reviewToolCalls,
          bashToolCalls,
        })}\n`,
      );
    },
    dispose: () => {
      finished = true;
      stopTimer();
      eraseStatus();
    },
  };

  function stopTimer(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }
}

/**
 * 收尾摘要行（`$` 成本与审计同源：同样的 model 画像 + 同样的 token 累加）。
 *
 * `tools` 只数 review 工具（= `record.baseline.toolCalls` 口径），skill 的
 * `bash` 另列——指标口径不含 bash（ADR-0014），显示层不能把两件事合成一个数
 * 让人误以为能与记录直接对账。
 */
export function doneLine(summary: ProgressSummary): string {
  const bash = summary.bashToolCalls > 0 ? ` · bash ${summary.bashToolCalls}` : "";
  return (
    `✓ done · req ${summary.requests} · tools ${summary.reviewToolCalls}${bash} · ` +
    `${formatSeconds(summary.durationMs)}s · cache ${cacheHit(summary.usage)} · ` +
    `$${summary.costUsd.toFixed(4)}`
  );
}

/**
 * 缓存命中率：**单一定义**。分母 = 未命中输入 + 缓读 + 缓写（等价于 provider 的
 * prompt 总量），请求行与 done 行共用，避免一次 run 里出现两个不可比的百分比。
 */
function cacheHit(usage: LlmUsage): string {
  const prompt = usage.inputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
  if (prompt === 0) {
    return "0%";
  }
  return `${((100 * (usage.cacheReadTokens ?? 0)) / prompt).toFixed(1)}%`;
}

function formatInt(value: number): string {
  return value.toLocaleString("en-US");
}

function formatSeconds(ms: number): string {
  return (ms / 1000).toFixed(1);
}
