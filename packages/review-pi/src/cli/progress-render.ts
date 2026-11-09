import type { LlmUsage } from "../contracts/llm.js";
import type { RunProgressEvent } from "../contracts/progress.js";
import { addUsage } from "../provider/usage-map.js";

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

/** 收尾摘要（计数由调用方按审计同源口径给出：主会话 + skill 会话合并） */
export interface ProgressSummary {
  readonly durationMs: number;
  /** 与 `record.baseline.usage` 同源（已含 skill 会话折算） */
  readonly usage: LlmUsage;
  readonly costUsd: number;
  /** 模型调用次数 = 主会话请求 + skill 会话请求 */
  readonly modelCalls: number;
  /** 工具调用总数 = 主会话 + 规则 Skill 的检视工具（指标口径，ADR-0014 不含 bash） */
  readonly toolCalls: number;
  readonly mainToolCalls: number;
  readonly skillToolCalls: number;
  /** 规则 Skill 会话里的 `bash` 调用数（指标 `toolCalls` 不含它，单列） */
  readonly skillBashCalls: number;
  /** Context Ledger 命中次数（重复读取返回引用，未再读原文） */
  readonly ledgerHits: number;
}

/** 一个可命名的耗时片段（阶段明细 / 审计内明细共用） */
export interface StageSpan {
  readonly label: string;
  readonly durationMs: number;
}

/**
 * 收尾阶段账本（在 doneLine 之后、进程退出前打印）。
 *
 * `stages` 是**可相加的主链路**：准备 → 审计 → 报文 → 投影 → tips → 总结 →
 * 沉降 → 其他，合计应约等于 `totalMs`。`phases` 是审计内部的分段（不加总），
 * `nested` 是嵌在审计里的规则 Skill（不重复计入主链路）。
 */
export interface StageBreakdown {
  readonly totalMs: number;
  readonly stages: readonly StageSpan[];
  /** 审计内的六阶段分段；相对百分比的分母 = 这些分段之和 */
  readonly phases: readonly StageSpan[];
  /** 嵌套在审计里的规则 Skill（百分比相对总墙钟，但标注不重复计入） */
  readonly nested: readonly StageSpan[];
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
  readonly finish: (input: ProgressSummary) => void;
  /** 异常路径清理（幂等；只擦状态行，不输出摘要） */
  readonly dispose: () => void;
}

export function createProgressRenderer(options: ProgressRendererOptions): ProgressRenderer {
  const now = options.now ?? Date.now;
  const heartbeatMs = options.heartbeatMs ?? 1000;
  let phaseIndex: number | undefined;
  let phaseTotal: number | undefined;
  let round: number | undefined;
  let phaseToolCalls = 0;
  let currentRequest: { readonly id: number; readonly startedAt: number } | undefined;
  let currentSkill: string | undefined;
  let statusLine: string | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let finished = false;
  /** 分片标签前缀（ADR-0039：多片事件才更新；单片路径恒为空串） */
  let shardPrefix = "";

  function scopePrefix(): string {
    return currentSkill === undefined ? "" : `[skill:${currentSkill}] `;
  }

  /** 事件行（先擦状态行，再追加，再重画状态行） */
  function writeLine(line: string): void {
    eraseStatus();
    options.write(`${shardPrefix}${line}\n`);
    redrawStatus();
  }

  function statusText(): string | undefined {
    if (!options.isTty) {
      return undefined;
    }
    const parts: string[] = [];
    if (shardPrefix !== "") {
      parts.push(shardPrefix.trim());
    }
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
    // 分片标签：非 run 事件带 `shard` 时更新前缀（ADR-0039 决策 8）
    if (event.kind !== "run" && event.shard !== undefined) {
      shardPrefix = `[s${String(event.shard.index)}/${String(event.shard.total)}] `;
    }
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
      options.write(`${doneLine(input)}\n`);
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
 * 收尾摘要行：一行报全本次 run 的账。
 *
 * - 耗时 = CLI 自身计时（检视本体，不含之后的呈现投影）；
 * - token 三段 = 未命中输入 / 输出 / 缓存命中（与审计 `usage` 同源，含 skill 会话）；
 * - 模型调用 = 主会话请求 + skill 会话请求（`skillPassLog[].requestCount`）；
 * - 工具调用 = 主会话 + 规则 Skill（与 `record.baseline.toolCalls` 同口径，
 *   ADR-0014 指标不含 bash）；skill 内 `bash` 真跑过时单列一段；
 * - Ledger 命中 = 重复读取返回引用的次数（原文没有第二次进上下文）；
 * - 成本与审计同源：同样的 model 画像 + 同样的 token 累加。
 */
export function doneLine(summary: ProgressSummary): string {
  const bash = summary.skillBashCalls > 0 ? ` · skill bash ${formatInt(summary.skillBashCalls)} 次` : "";
  return (
    `✓ 完成 · 耗时 ${formatSeconds(summary.durationMs)}s · 模型调用 ${formatInt(summary.modelCalls)} 次 · ` +
    `token 输入 ${formatInt(summary.usage.inputTokens)}（未命中） · ` +
    `输出 ${formatInt(summary.usage.outputTokens)} · ` +
    `缓存命中 ${formatInt(summary.usage.cacheReadTokens ?? 0)}（${cacheHit(summary.usage)}） · ` +
    `工具 ${formatInt(summary.toolCalls)} 次（主会话 ${formatInt(summary.mainToolCalls)} + ` +
    `规则 Skill ${formatInt(summary.skillToolCalls)}）${bash} · ` +
    `Ledger 命中 ${formatInt(summary.ledgerHits)} 次（未重复读取原文） · ` +
    `$${summary.costUsd.toFixed(4)}`
  );
}

/**
 * 阶段账本行（grep 前缀 `[time]`）：主链路一段一行，审计明细压成一行。
 *
 * 与 `doneLine` 的分工：doneLine 是「检视本体」的账（审计 + 报文，不含总结 /
 * 沉降），本函数是「整次进程」的账——两者数字不同是**有意为之**，标签也明确
 * 区分（`耗时` vs `总墙钟`）。
 */
export function stageBreakdownLines(input: StageBreakdown): string[] {
  if (input.totalMs <= 0) {
    return [];
  }
  const total = input.totalMs;
  const pct = (ms: number): string => `${((100 * ms) / total).toFixed(1)}%`;
  const lines = [
    `[time] 阶段耗时 | 总墙钟 ${formatSeconds(total)}s（含总结 / 沉降 / 收尾）`,
  ];
  for (const span of input.stages) {
    lines.push(`[time] 阶段 | ${span.label} ${formatSeconds(span.durationMs)}s (${pct(span.durationMs)})`);
  }
  const phaseTotal = input.phases.reduce((sum, span) => sum + span.durationMs, 0);
  if (input.phases.length > 0 && phaseTotal > 0) {
    const parts = input.phases.map((span) => {
      const share = ((100 * span.durationMs) / phaseTotal).toFixed(1);
      return `${span.label} ${formatSeconds(span.durationMs)}s (${share}%)`;
    });
    lines.push(`[time] 审计明细 | ${parts.join(" | ")}`);
  }
  if (input.nested.length > 0) {
    const parts = input.nested.map(
      (span) => `${span.label} ${formatSeconds(span.durationMs)}s (${pct(span.durationMs)})`,
    );
    lines.push(`[time] 嵌套明细 | ${parts.join(" | ")}（含于审计，不重复计入）`);
  }
  return lines;
}

/** 一次性调用的一条用途明细（标签由调用方按展示语义给） */
export interface TaskUsagePurposeLine {
  readonly label: string;
  readonly calls: number;
  readonly usage: LlmUsage;
  readonly usageMissingCalls: number;
}

/** 整任务 LLM 账本输入：Agent 内 usage + 一次性调用 usage（成本已按模型分桶加总） */
export interface TaskUsageLineInput {
  readonly agentCalls: number;
  readonly agentUsage: LlmUsage;
  readonly oneShotCalls: number;
  readonly oneShotUsage: LlmUsage;
  readonly oneShotMissingUsageCalls: number;
  readonly purposes: readonly TaskUsagePurposeLine[];
  readonly costUsd: number;
}

/**
 * 整任务 LLM 账本（grep 前缀 `[usage]`）：Agent 内 + Agent 之后的一次性调用。
 *
 * 与 `doneLine` 的分工：doneLine 只算「检视本体」（主会话 + 规则 Skill），打印点
 * 在 tips / 总结之前；本函数在进程收尾时打印**整任务总账**，是日志里唯一能回答
 * 「这次任务一共花了多少 token」的行。
 *
 * 口径纪律：
 * - 总有模型调用才输出（早退路径不刷空行）；
 * - token 三段沿用 doneLine：未命中输入 / 输出 / 缓存命中；
 * - 一次性调用按用途拆一行（tips / 总结 / 候选修复），便于直接看出钱花在哪；
 * - 响应未带 usage 的调用计入次数、token 记 0，并在行内显式标注。
 */
export function taskUsageLines(input: TaskUsageLineInput): string[] {
  const totalCalls = input.agentCalls + input.oneShotCalls;
  if (totalCalls <= 0) {
    return [];
  }
  const totalUsage = addUsage(input.agentUsage, input.oneShotUsage);
  const missing =
    input.oneShotMissingUsageCalls > 0
      ? ` | 未带 usage ${formatInt(input.oneShotMissingUsageCalls)} 次`
      : "";
  const lines = [
    `[usage] 任务总计 | 模型调用 ${formatInt(totalCalls)} 次（Agent ${formatInt(input.agentCalls)} + ` +
      `一次性 ${formatInt(input.oneShotCalls)}） | ` +
      `token 输入 ${formatInt(totalUsage.inputTokens)}（未命中） | ` +
      `输出 ${formatInt(totalUsage.outputTokens)} | ` +
      `缓存命中 ${formatInt(totalUsage.cacheReadTokens ?? 0)}（${cacheHit(totalUsage)}）` +
      `${missing} | $${input.costUsd.toFixed(4)}`,
  ];
  if (input.oneShotCalls > 0) {
    const parts = input.purposes.map((purpose) => {
      const absent =
        purpose.usageMissingCalls > 0
          ? `，${formatInt(purpose.usageMissingCalls)} 次无 usage`
          : "";
      return (
        `${purpose.label} ${formatInt(purpose.calls)} 次（输入 ${formatInt(purpose.usage.inputTokens)} / ` +
        `输出 ${formatInt(purpose.usage.outputTokens)} / ` +
        `缓存 ${formatInt(purpose.usage.cacheReadTokens ?? 0)}${absent}）`
      );
    });
    lines.push(`[usage] 一次性明细 | ${parts.join(" | ")}`);
  }
  return lines;
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
