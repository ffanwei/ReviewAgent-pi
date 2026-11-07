import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { TaskCallTrace } from "../mcp/report.js";

/**
 * 业务 tool 调用留痕（`mcp.json`）：把 **startTask / mrReviewResult /
 * saveReviewSummary / endTask** 四个 MCP 业务调用的输入、输出与调用时间
 * 落到 `<tasks 根>/<taskId>/runs/`——与 `session-<ts>.json` 转录同目录，
 * 便于事后单文件核对「平台到底收到了什么、回了什么、花了多久」。
 *
 * 纪律：
 * - **旁路**：留痕在内存累积，写盘失败只落 stderr 一行，绝不改退出码；
 * - 不含秘密：业务 tool 参数本身只有 taskId / 文件路径 / tips 正文；
 * - 原子写（同目录临时文件 + rename），避免半截 JSON；
 * - 只在业务 tool 开启时写（事件通道 / 纯本地 run 不产这个文件）。
 */

/** 留痕文件名（与 session 转录同目录：`<tasks 根>/<taskId>/runs/`） */
export const MCP_CALL_LOG_FILENAME = "mcp.json";

/** 文件形状版本（变更时递增） */
export const MCP_CALL_LOG_VERSION = 1;

/** 单次调用的输出：成功只有 `ok:true`；失败带人话原因；有回包正文时一并保留 */
export interface McpCallOutput {
  readonly ok: boolean;
  readonly reason?: string;
  /** 服务端 `tools/call` 返回的文本内容（传输失败 / 无正文时缺席） */
  readonly response?: string;
}

/** 一次业务 tool 调用 */
export interface McpCallRecord {
  /** tool 名：startTask / mrReviewResult / saveReviewSummary / endTask */
  readonly tool: string;
  /** 首次尝试开始时刻（ISO 8601，含重试的总时段的起点） */
  readonly startedAt: string;
  /** 含重试的总耗时（毫秒） */
  readonly durationMs: number;
  /** 与 `output.ok` 同值（方便直接过滤失败调用） */
  readonly ok: boolean;
  /** 平铺参数原样（即 MCP `tools/call.arguments`） */
  readonly input: unknown;
  /** 调用结果（成功 / 失败原因 / 服务端原始回包） */
  readonly output: McpCallOutput;
}

export interface McpCallLogDocument {
  readonly version: typeof MCP_CALL_LOG_VERSION;
  readonly taskId: string;
  readonly calls: readonly McpCallRecord[];
}

/**
 * 内存累积器：把 `createMcpReporter({ onTaskCall })` 的回调收集成文档。
 * 时钟只用于把 epoch ms 转 ISO（测试可注入确定性转换）。
 */
export class McpCallLog {
  private readonly calls: McpCallRecord[] = [];

  constructor(
    private readonly toIso: (epochMs: number) => string = (epochMs) =>
      new Date(epochMs).toISOString(),
  ) {}

  /** 记录一次调用（同步、不抛错；形状由 Trace 定义，绝不补造输出） */
  record(trace: TaskCallTrace): void {
    this.calls.push({
      tool: trace.tool,
      startedAt: this.toIso(trace.startedAt),
      durationMs: trace.durationMs,
      ok: trace.ok,
      input: trace.arguments,
      output: {
        ok: trace.ok,
        ...(trace.ok ? {} : { reason: trace.reason ?? "unknown error" }),
        ...(trace.responseText !== undefined ? { response: trace.responseText } : {}),
      },
    });
  }

  /** 调用条数（0 = 没发生任何业务调用，调用方据此决定不写文件） */
  get size(): number {
    return this.calls.length;
  }

  /** 组装落盘文档（深拷贝 calls 数组，避免调用方后续追加影响已写内容） */
  document(taskId: string): McpCallLogDocument {
    return {
      version: MCP_CALL_LOG_VERSION,
      taskId,
      calls: [...this.calls],
    };
  }
}

/**
 * 原子写 `mcp.json` 到指定目录（通常是 `<tasks 根>/<taskId>/runs/`）。
 * 目录不存在时创建（预检失败路径也要能留痕）；失败直接抛错，由调用方降级。
 */
export async function writeMcpCallLog(
  dir: string,
  document: McpCallLogDocument,
): Promise<string> {
  await mkdir(dir, { recursive: true });
  const target = join(dir, MCP_CALL_LOG_FILENAME);
  const temp = `${target}.${String(process.pid)}.tmp`;
  try {
    await writeFile(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    await rename(temp, target);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return target;
}
