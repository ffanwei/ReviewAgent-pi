import { randomUUID } from "node:crypto";

import type {
  McpReportBatch,
  McpReportEnvelope,
  McpReportEvent,
  McpReportStats,
} from "../contracts/mcp-report.js";
import type { RunProgressEvent, RunProgressSink } from "../contracts/progress.js";
import { createMcpClient, MCP_CLIENT_NAME } from "./client.js";
import type { ReportConfig } from "./config.js";
import { createHttpTransport, type Transport } from "./transport.js";

/**
 * 上报投递（ADR-0037 决策 5）。
 *
 * 语义：
 * - `sink` 只入队：O(1)、绝不做 I/O、绝不抛错（内部错误一律吞掉）；
 * - 单 writer FIFO：`seq` 在入队时分配，批量按 `(streamId, seq)` 幂等；
 * - 批量：满 `batch.maxEvents` 或距首条超 `batch.maxDelayMs` 即发；
 * - 背压：队列上限 `queue.maxEvents`，溢出**丢最旧**并计入 `dropped`；
 * - 重试：单批最多 3 次（100 / 400 / 1600 ms 退避），耗尽计入 `failed`；
 * - `flush` 尽力排空，超时返回当前统计；`close` 之后 `sink` 静默丢弃。
 *
 * **永不改变退出码**：这里没有一处向外抛错，调用方（CLI）也不需要检查返回值。
 */

export interface CreateMcpReporterOptions {
  readonly config: ReportConfig;
  /** `clientInfo.version`（CLI 传产品版本） */
  readonly clientVersion: string;
  /** 时钟注入（测试确定性） */
  readonly now?: () => number;
  /** 传输注入（测试用假 server / 假 transport；缺省 HTTP） */
  readonly transport?: Transport;
  /** 上报流 id 注入（测试确定性；缺省 randomUUID） */
  readonly streamId?: string;
}

export interface McpReporter {
  /** 上报流标识：run 结束前 `runId` 不可知，流键只能由 reporter 分配 */
  readonly streamId: string;
  /** 直接传给 `runReview({ onProgress })`；永不抛错 */
  readonly sink: RunProgressSink;
  /** 等队列排空（最多 `timeoutMs`，缺省配置值）；超时返回当前统计，不抛错 */
  flush(timeoutMs?: number): Promise<McpReportStats>;
  /** 排空 + 取消在飞请求 + 关闭传输；幂等 */
  close(): Promise<void>;
}

const RETRY_BACKOFF_MS = [100, 400, 1600] as const;

export async function createMcpReporter(options: CreateMcpReporterOptions): Promise<McpReporter> {
  const { config } = options;
  const now = options.now ?? Date.now;
  const streamId = options.streamId ?? randomUUID();
  const abort = new AbortController();
  const transport =
    options.transport ??
    createHttpTransport({
      url: config.server.url,
      headers: config.server.headers,
      timeoutMs: config.server.timeoutMs,
    });
  const client = createMcpClient(transport, {
    clientName: MCP_CLIENT_NAME,
    clientVersion: options.clientVersion,
  });

  // 握手一次；失败 = 建 reporter 失败（CLI 降级为「不建 sink」）
  try {
    await client.initialize(combineSignal(abort.signal, config.server.timeoutMs));
  } catch (error) {
    await transport.close().catch(() => undefined);
    throw error;
  }

  let seq = 0;
  let sent = 0;
  let failed = 0;
  let dropped = 0;
  let batches = 0;
  /** sink 已停止接收（close 之后）——不影响排空在途/队内事件 */
  let sinkClosed = false;
  let closing = false;
  let running = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: McpReportEnvelope[] = [];

  function stats(): McpReportStats {
    return { sent, failed, dropped, batches };
  }

  function clearTimer(): void {
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  }

  function enqueue(event: McpReportEvent): void {
    const envelope: McpReportEnvelope = {
      schemaVersion: 1,
      streamId,
      seq: seq + 1,
      at: new Date(now()).toISOString(),
      event,
    };
    seq += 1;
    queue.push(envelope);
    if (queue.length > config.queue.maxEvents) {
      const overflow = queue.length - config.queue.maxEvents;
      queue.splice(0, overflow);
      dropped += overflow;
    }
    schedule();
  }

  function schedule(): void {
    if (closing || queue.length === 0) {
      return;
    }
    if (queue.length >= config.batch.maxEvents) {
      void drain();
      return;
    }
    if (timer === undefined) {
      timer = setTimeout(() => {
        timer = undefined;
        void drain();
      }, config.batch.maxDelayMs);
      // 定时器不保活进程：run 结束后由 flush/close 收尾
      timer.unref?.();
    }
  }

  async function drain(): Promise<void> {
    if (running) {
      return;
    }
    running = true;
    clearTimer();
    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, config.batch.maxEvents);
        await sendBatch(batch);
      }
    } finally {
      running = false;
      if (queue.length > 0) {
        schedule();
      }
    }
  }

  async function sendBatch(events: readonly McpReportEnvelope[]): Promise<void> {
    // run.end 是「这段流水是否完整」的唯一依据：在真正发送前用最终计数覆盖
    // 入队时的快照（入队那一刻还不知道这次入队自身引起的丢弃）
    const finalized = events.map((envelope) =>
      envelope.event.type === "run.end"
        ? {
            ...envelope,
            event: { ...envelope.event, dropped, failed },
          }
        : envelope,
    );
    const args: McpReportBatch = { schemaVersion: 1, streamId, events: finalized };
    for (let attempt = 0; attempt < RETRY_BACKOFF_MS.length; attempt += 1) {
      if (attempt > 0) {
        await sleep(RETRY_BACKOFF_MS[attempt - 1] ?? 1600);
      }
      batches += 1;
      try {
        const result = await client.callTool(
          config.tool,
          args,
          combineSignal(abort.signal, config.server.timeoutMs),
        );
        if (!result.isError) {
          sent += events.length;
          return;
        }
      } catch {
        // 网络 / 协议 / 服务端错误一律按「本批失败」计，接着退避重试
      }
    }
    failed += events.length;
  }

  const sink: RunProgressSink = (event: RunProgressEvent) => {
    try {
      if (sinkClosed) {
        return;
      }
      const mapped = toReportEvent(event, stats(), config.findings);
      if (mapped === null || !config.include.has(mapped.type)) {
        return;
      }
      enqueue(mapped);
    } catch {
      // 上报层任何内部错误都不许冒到主链（ADR-0016 三条纪律）
    }
  };

  async function flush(timeoutMs: number = config.flushTimeoutMs): Promise<McpReportStats> {
    const deadline = now() + Math.max(0, timeoutMs);
    void drain();
    while (queue.length > 0 || running) {
      const remaining = deadline - now();
      if (remaining <= 0) {
        break;
      }
      await sleep(Math.min(25, remaining), true);
    }
    return stats();
  }

  return {
    streamId,
    sink,
    flush,
    async close() {
      if (closing) {
        return;
      }
      closing = true;
      sinkClosed = true;
      clearTimer();
      try {
        // 已经显式 flush 过时这里是空转；否则给最后一次机会，但不二次等满整预算
        await flush(Math.min(config.flushTimeoutMs, 1_000));
      } catch {
        // 收尾失败不改变任何结果
      }
      abort.abort();
      await client.close().catch(() => undefined);
    },
  };
}

/**
 * 内部进度事件 → 出站事件（**字段白名单**）。
 *
 * 明确剔除：工具入参摘要 / 失败详情（可能含代码或路径）、finding 正文、
 * 任何本地绝对路径。返回 null = 该事件不上报（未知 kind / 未来新增的内部事件）。
 */
function toReportEvent(
  event: RunProgressEvent,
  stats: McpReportStats,
  findingsMode: "none" | "summary",
): McpReportEvent | null {
  switch (event.kind) {
    case "run":
      if (event.state === "start") {
        return {
          type: "run.start",
          caseId: event.caseId,
          model: event.model,
          startedAt: event.startedAt,
          ...(event.shards !== undefined ? { shards: event.shards } : {}),
        };
      }
      return {
        type: "run.end",
        status: event.status,
        durationMs: event.durationMs,
        // 上报层自身的完整性计数：核心不知道，也不该知道
        dropped: stats.dropped,
        failed: stats.failed,
        ...(event.runId !== undefined ? { runId: event.runId } : {}),
        ...(event.usage !== undefined ? { usage: event.usage } : {}),
        ...(event.truncated !== undefined ? { truncated: event.truncated } : {}),
        ...(event.findings !== undefined && findingsMode === "summary"
          ? { findings: event.findings }
          : {}),
        ...(event.shards !== undefined ? { shards: event.shards } : {}),
      };
    case "phase":
      return {
        type: "phase",
        round: event.round,
        phase: event.phase,
        // v1：phaseKey 恒等于阶段名；消费方按它判断语义，不按 index
        phaseKey: event.phase,
        index: event.index,
        total: event.total,
        ...(event.shard !== undefined ? { shard: event.shard } : {}),
      };
    case "request":
      return event.state === "start"
        ? {
            type: "request.start",
            requestId: event.requestId,
            ...(event.shard !== undefined ? { shard: event.shard } : {}),
          }
        : {
            type: "request.end",
            requestId: event.requestId,
            durationMs: event.durationMs,
            usage: event.usage,
            ...(event.shard !== undefined ? { shard: event.shard } : {}),
          };
    case "tool":
      return event.state === "start"
        ? {
            type: "tool.start",
            name: event.name,
            ...(event.shard !== undefined ? { shard: event.shard } : {}),
          }
        : {
            type: "tool.end",
            name: event.name,
            durationMs: event.durationMs,
            ok: event.ok,
            resultChars: event.resultChars,
            resultLines: event.resultLines,
            ...(event.shard !== undefined ? { shard: event.shard } : {}),
          };
    case "skill":
      return event.state === "start"
        ? {
            type: "skill.start",
            round: event.round,
            skill: event.skill,
            ...(event.shard !== undefined ? { shard: event.shard } : {}),
          }
        : {
            type: "skill.end",
            round: event.round,
            skill: event.skill,
            status: event.status,
            requestCount: event.requestCount,
            toolCallCount: event.toolCallCount,
            durationMs: event.durationMs,
            ...(event.shard !== undefined ? { shard: event.shard } : {}),
          };
    default:
      return null;
  }
}

function combineSignal(signal: AbortSignal, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  return typeof AbortSignal.any === "function" ? AbortSignal.any([signal, timeout]) : timeout;
}

function sleep(ms: number, keepAlive = false): Promise<void> {
  return new Promise((resolve) => {
    const handle = setTimeout(resolve, ms);
    // flush 的轮询必须保活（调用方 await 期间进程不能退出）；
    // 重试退避用 unref，避免拖住收尾
    if (!keepAlive) {
      handle.unref?.();
    }
  });
}
