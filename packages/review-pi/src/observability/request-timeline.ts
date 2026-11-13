import { closeSync, openSync, writeSync } from "node:fs";
import { join } from "node:path";

import type { LlmUsage } from "../contracts/llm.js";

/**
 * 请求时间线（ADR-0076）：模型调用的**时间戳留痕**。
 *
 * 定位：只观测。它不是审计（`audit/<ts>.json`）、不是运行记录（`run.json`）、
 * 不是转录（`session-*.json`）、不是运行日志（`review-pi.log`）——它是
 * 「失败现场」：一次 run 里每次模型调用的发出 / 响应头 / 首末增量 / 结束时刻，
 * 以及那次调用的错误类别与 `cause.code`。
 *
 * 纪律（ADR-0076 决策 5）：本文件是本仓**唯一**允许把时钟写进产物的内核产物。
 * 该豁免仅限本文件，不外溢到审计 / 运行记录 / 进度事件。
 *
 * 抗崩溃：每行 `writeSync` 同步追加。进程被 kill / 走 uncaught 兜底时，已发出
 * 的行仍在磁盘上——这正是「流中途断开」类失败最需要的性质。
 *
 * 隐私（ADR-0076 决策 4）：白名单取字段。绝不写入请求体、messages、工具入参、
 * 代码片段、apiKey；headers 只留五个安全键。
 */

/** 单片 / 分片产物目录下的固定文件名 */
export const REQUEST_TIMELINE_FILENAME = "request-timeline.jsonl";

/** 硬上限：先到者停止追加（防病态 run 把盘写满；正常 run 只有几十 KB） */
export const REQUEST_TIMELINE_MAX_BYTES = 4 * 1024 * 1024;
export const REQUEST_TIMELINE_MAX_LINES = 20_000;

/** 错误消息截断（服务端错误体可能回显大段文本） */
const ERROR_MESSAGE_MAX_CHARS = 500;

/**
 * headers 白名单（ADR-0076 决策 4）：未列出的键一律不写。
 * 绝不包含 authorization / set-cookie / x-api-key / openai-organization。
 */
export const TIMELINE_HEADER_ALLOWLIST: readonly string[] = [
  "content-type",
  "retry-after",
  "x-should-retry",
  "x-request-id",
  "server",
];

/** 调用点归属；`one-shot` 是用途未知时的诚实回落（绝不冒名顶替 summary） */
export type TimelineSite =
  | "main"
  | "skill"
  | "repair"
  | "shard-report"
  | "summary"
  | "one-shot";

/** 分片标签（与进度事件 `ShardLabel` 同形） */
export interface TimelineShard {
  readonly index: number;
  readonly total: number;
}

/** 失败归因（只收结构化信号，绝不靠字符串猜状态码） */
export interface TimelineError {
  readonly kind: "transport" | "timeout" | "http" | "malformed" | "provider";
  readonly name?: string;
  readonly code?: string;
  readonly errno?: number | string;
  readonly syscall?: string;
  readonly status?: number;
  /** 已截断到 500 字符的人话 */
  readonly message: string;
}

/** 一次调用的静态归属（由调用方在请求发出时求值） */
export interface TimelineScope {
  readonly site: TimelineSite;
  readonly skill?: string;
  readonly shard?: TimelineShard;
  readonly round?: number;
  readonly phase?: string;
  readonly phaseIndex?: number;
  readonly model: string;
  /** 只 host（不含 path / query / key） */
  readonly baseUrlHost: string;
}

interface TimelineBase extends TimelineScope {
  readonly v: 1;
  readonly ts: number;
  /**
   * 与审计 / 转录同源；首个请求完成前未知（`runId` 由首次请求时刻决定）。
   * 与 `run.end` 进度事件的 `runId?` 同口径：异常路径可能缺席。
   */
  readonly runId: string | null;
  readonly requestId: number;
  /**
   * 重放序号（ADR-0077）：0 = 首次尝试，1.. = 第 N 次断流重放。同一次逻辑请求的
   * 所有行共享 `requestId`，靠 `replay` 区分；`streamAttempts = 1` 时恒 0。
   */
  readonly replay: number;
}

/** 一次 HTTP 尝试（pi-ai 内部重试唯一可见的地方） */
export interface TimelineAttemptLine extends TimelineBase {
  readonly kind: "attempt";
  readonly attempt: number;
  readonly sentAt: number;
  readonly headersAt: number | null;
  readonly status: number | null;
  /** 白名单投影；无命中键时缺席 */
  readonly headers?: Readonly<Record<string, string>>;
  readonly error: TimelineError | null;
  readonly durationMs: number;
}

/** 一次逻辑模型调用 */
export interface TimelineRequestLine extends TimelineBase {
  readonly kind: "request";
  readonly sentAt: number;
  readonly headersAt: number | null;
  readonly streamStartedAt: number | null;
  readonly firstDeltaAt: number | null;
  readonly lastDeltaAt: number | null;
  readonly endedAt: number;
  readonly stopReason: string | null;
  /** 增量事件条数（不是字节数：真字节要 tee body，ADR-0076 决策 2 拒绝） */
  readonly deltaCount: number;
  /** 增量字符总数 */
  readonly deltaChars: number;
  /**
   * 响应体真实字节数（ADR-0077 起由 body 包裹统计）。缺席 = 未走到 body（建连失败 /
   * 同步抛错）。与 `deltaChars` 不同：后者是解析后增量文本的长度。
   */
  readonly bytes?: number;
  readonly attempts: number;
  readonly error: TimelineError | null;
  readonly usage?: LlmUsage;
}

export type RequestTimelineEntry = TimelineAttemptLine | TimelineRequestLine;

/** 观测缝：缺省 null = 零行为变化、零 IO */
export type RequestTimelineSink = (entry: RequestTimelineEntry) => void;

let timelineSink: RequestTimelineSink | null = null;

/** 安装 / 清除进程级观测器（只影响留痕采集，不改变任何调用结果） */
export function setRequestTimelineSink(sink: RequestTimelineSink | null): void {
  timelineSink = sink;
}

/** 是否已安装观测器（kernel 侧据此决定要不要包 fetch / 流） */
export function hasRequestTimelineSink(): boolean {
  return timelineSink !== null;
}

/** 发射一条时间线（缺省 sink = 空操作） */
export function emitRequestTimeline(entry: RequestTimelineEntry): void {
  timelineSink?.(entry);
}

export interface RequestTimelineWriter {
  readonly path: string;
  readonly sink: RequestTimelineSink;
  /** 最后一条失败的人读摘要；没有失败返回 null */
  summary(): string | null;
  /** 释放文件描述符（可重复调用） */
  close(): void;
}

/**
 * 打开一份时间线文件。
 *
 * - `mode: "w"` = 本片独占（pass 开始清空）；`"a"` = 追加（收尾阶段续写同一次 run
 *   的顶层文件，保留单片 pass 已写的行）；
 * - 写失败一律吞掉：时间线是旁路，绝不影响检视与退出码；
 * - 触顶后写一条 `truncated` 行并停止追加。
 */
export function createRequestTimelineWriter(
  dir: string,
  options: {
    readonly mode?: "w" | "a";
    /** 上限覆盖（测试用；缺省 = 生产常量） */
    readonly maxBytes?: number;
    readonly maxLines?: number;
    /**
     * 已知 runId（收尾阶段的追加写入用）：行的 `runId` 为 null 时用它补齐。
     * pass 阶段的写入发生在 runId 决定之前（runId = 首次请求时刻），故保持 null。
     */
    readonly runId?: string | null;
  } = {},
): RequestTimelineWriter {
  const filePath = join(dir, REQUEST_TIMELINE_FILENAME);
  const maxBytes = options.maxBytes ?? REQUEST_TIMELINE_MAX_BYTES;
  const maxLines = options.maxLines ?? REQUEST_TIMELINE_MAX_LINES;
  let fd: number | null = null;
  try {
    fd = openSync(filePath, options.mode ?? "w");
  } catch {
    fd = null;
  }

  let bytes = 0;
  let lines = 0;
  let closed = false;
  let lastFailure: TimelineRequestLine | undefined;
  let lastAttemptFailure: TimelineAttemptLine | undefined;

  const write = (payload: unknown): void => {
    if (fd === null || closed) {
      return;
    }
    let line: string;
    try {
      line = `${JSON.stringify(payload)}\n`;
    } catch {
      return;
    }
    const size = Buffer.byteLength(line, "utf8");
    if (lines >= maxLines || bytes + size > maxBytes) {
      try {
        writeSync(
          fd,
          `${JSON.stringify({
            v: 1,
            ts: Date.now(),
            kind: "truncated",
            reason: "request timeline size cap reached",
            lines,
            bytes,
          })}\n`,
        );
      } catch {
        // 旁路
      }
      lines = maxLines;
      return;
    }
    try {
      writeSync(fd, line);
      lines += 1;
      bytes += size;
    } catch {
      // 旁路：写失败绝不影响调用方
    }
  };

  const sink: RequestTimelineSink = (entry) => {
    const runId = options.runId;
    write(
      entry.runId === null && runId !== undefined && runId !== null
        ? { ...entry, runId }
        : entry,
    );
    if (entry.kind === "request") {
      if (entry.error !== null) {
        lastFailure = entry;
      }
    } else if (entry.error !== null) {
      lastAttemptFailure = entry;
    }
  };

  return {
    path: filePath,
    sink,
    summary: () => {
      if (lastFailure !== undefined) {
        return formatRequestTimelineSummary(lastFailure);
      }
      return lastAttemptFailure === undefined
        ? null
        : formatAttemptTimelineSummary(lastAttemptFailure);
    },
    close: () => {
      if (closed) {
        return;
      }
      closed = true;
      if (fd !== null) {
        try {
          closeSync(fd);
        } catch {
          // 旁路
        }
        fd = null;
      }
    },
  };
}

/**
 * 在给定目录上临时续写时间线（追加模式）：用于 pass 之后、仍属同一次 run 的
 * 一次性调用（片级报文的 `mrReviewResult` 载荷生成）。串行执行，无并发写。
 */
export async function withRequestTimelineAppend<T>(
  dir: string,
  run: () => Promise<T>,
): Promise<T> {
  const writer = createRequestTimelineWriter(dir, { mode: "a" });
  setRequestTimelineSink(writer.sink);
  try {
    return await run();
  } finally {
    setRequestTimelineSink(null);
    writer.close();
  }
}

/** 人读摘要（失败时 stderr 一行；grep 前缀 `request-timeline:`） */export function formatRequestTimelineSummary(entry: TimelineRequestLine): string {
  const parts = [
    `#${String(entry.requestId)}`,
    entry.skill !== undefined ? `${entry.site}:${entry.skill}` : entry.site,
    entry.shard !== undefined ? `s${String(entry.shard.index)}/${String(entry.shard.total)}` : null,
    entry.phaseIndex !== undefined
      ? `phase ${String(entry.phaseIndex)}${entry.phase !== undefined ? ` ${entry.phase}` : ""}`
      : null,
    entry.round !== undefined ? `r${String(entry.round)}` : null,
    `尝试 ${String(entry.attempts)} 次`,
    entry.firstDeltaAt !== null
      ? `首字 ${seconds(entry.firstDeltaAt - entry.sentAt)}`
      : "首字 未到达",
    entry.firstDeltaAt !== null && entry.lastDeltaAt !== null
      ? `流 ${seconds(entry.lastDeltaAt - entry.firstDeltaAt)}`
      : null,
    entry.lastDeltaAt !== null ? `断流空档 ${seconds(entry.endedAt - entry.lastDeltaAt)}` : null,
    entry.stopReason !== null ? `停因 ${entry.stopReason}` : null,
    entry.error !== null ? describeError(entry.error) : null,
  ].filter((part): part is string => part !== null);
  return `request-timeline: ${parts.join(" · ")}`;
}

/** attempt 级回落摘要（逻辑请求行缺席时用） */
export function formatAttemptTimelineSummary(entry: TimelineAttemptLine): string {
  const parts = [
    `#${String(entry.requestId)}`,
    entry.site,
    `尝试 #${String(entry.attempt)}`,
    entry.status !== null ? `HTTP ${String(entry.status)}` : "无响应头",
    entry.error !== null ? describeError(entry.error) : null,
  ].filter((part): part is string => part !== null);
  return `request-timeline: ${parts.join(" · ")}`;
}

function describeError(error: TimelineError): string {
  const code = error.code !== undefined ? `/${error.code}` : "";
  return `错误 ${error.kind}${code} (${error.message})`;
}

function seconds(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)}s`;
}

/** headers 白名单投影（`Headers` → 仅安全键；无命中返回 undefined） */
export function pickTimelineHeaders(
  headers: Headers,
): Readonly<Record<string, string>> | undefined {
  const picked: Record<string, string> = {};
  for (const name of TIMELINE_HEADER_ALLOWLIST) {
    const value = headers.get(name);
    if (value !== null) {
      picked[name] = value;
    }
  }
  return Object.keys(picked).length > 0 ? picked : undefined;
}

/** 异常 → 结构化归因（只取第一层 cause；丢弃 address/port/hostname） */
export function describeThrownError(
  error: unknown,
  kind: TimelineError["kind"] = "transport",
): TimelineError {
  const record = (typeof error === "object" && error !== null ? error : {}) as {
    name?: unknown;
    message?: unknown;
    code?: unknown;
    errno?: unknown;
    syscall?: unknown;
    cause?: { code?: unknown; errno?: unknown; syscall?: unknown } | undefined;
  };
  const cause = record.cause;
  const name = typeof record.name === "string" ? record.name : undefined;
  const code = firstString(record.code, cause?.code);
  const errno = firstNumberOrString(record.errno, cause?.errno);
  const syscall = firstString(record.syscall, cause?.syscall);
  const message = truncate(
    typeof record.message === "string" ? record.message : String(error),
    ERROR_MESSAGE_MAX_CHARS,
  );
  const resolvedKind =
    name === "AbortError" || name === "TimeoutError" ? ("timeout" as const) : kind;
  return {
    kind: resolvedKind,
    ...(name !== undefined ? { name } : {}),
    ...(code !== undefined ? { code } : {}),
    ...(errno !== undefined ? { errno } : {}),
    ...(syscall !== undefined ? { syscall } : {}),
    message,
  };
}

function firstString(...values: readonly unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

function firstNumberOrString(...values: readonly unknown[]): number | string | undefined {
  for (const value of values) {
    if (typeof value === "number") {
      return value;
    }
    if (typeof value === "string" && value !== "") {
      return value;
    }
  }
  return undefined;
}

function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : `${text.slice(0, maxChars)}…`;
}

/** 错误 / 归因消息截断（两个采集点共用，避免各写一份长度） */
export function truncateTimelineMessage(message: string | undefined): string {
  return truncate(
    message === undefined || message === "" ? "provider error" : message,
    ERROR_MESSAGE_MAX_CHARS,
  );
}

/** baseUrl → host（只留 host；path / query 可能含凭据，绝不写入） */
export function hostOfBaseUrl(baseUrl: string | undefined): string {
  const raw = (baseUrl ?? "").trim();
  if (raw === "") {
    return "api.deepseek.com";
  }
  try {
    return new URL(raw).host;
  } catch {
    return "(unparsed)";
  }
}
