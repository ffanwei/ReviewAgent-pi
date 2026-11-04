import type { LlmUsage } from "./llm.js";
import type { RuleSkillPassStatus } from "./run.js";

/**
 * 出站上报契约（ADR-0037）。
 *
 * 与 `contracts/progress.ts` 的内部进度事件**分离**：内部事件随内核演进，
 * 出站面只在 `schemaVersion` 升级时才允许破坏性变更。消费方（机器流水）按
 * `(streamId, seq)` 去重、按 `type` + `phaseKey` 判断语义。
 *
 * 字段白名单（出站最小化）：**不含**代码片段、finding 正文、工具入参原文、
 * 本地绝对路径、任何密钥。要正文请读 `reviews_en.json`。
 */

/** 出站事件类型全集（配置 `mcp.report.include` 的合法值） */
export const MCP_REPORT_EVENT_TYPES = [
  "run.start",
  "run.end",
  "phase",
  "request.start",
  "request.end",
  "tool.start",
  "tool.end",
  "skill.start",
  "skill.end",
] as const;

export type McpReportEventType = (typeof MCP_REPORT_EVENT_TYPES)[number];

/** findings 摘要：只给条数与严重度分布（`mcp.report.findings` 的 `summary` 档） */
export interface McpFindingSummary {
  readonly count: number;
  readonly bySeverity: Readonly<Record<"P0" | "P1" | "P2" | "P3", number>>;
}

export type McpReportEvent =
  | {
      readonly type: "run.start";
      readonly caseId: string;
      readonly model: string;
      /** ISO-8601 */
      readonly startedAt: string;
    }
  | {
      readonly type: "run.end";
      readonly status: "ok" | "failed";
      /** 产物 id；run 在首次模型请求之前失败时缺席 */
      readonly runId?: string;
      readonly durationMs: number;
      readonly usage?: LlmUsage;
      readonly truncated?: boolean;
      readonly findings?: McpFindingSummary;
      /** 上报层自身状态（核心不知道，由 reporter 在映射 `run.end` 时注入） */
      readonly dropped: number;
      readonly failed: number;
    }
  | {
      readonly type: "phase";
      readonly round: number;
      /** 阶段名（v1：`ReviewPhase` 字面量） */
      readonly phase: string;
      /** 稳定标识：v1 恒等于 `phase`，消费方按它判断语义，不按 `index` */
      readonly phaseKey: string;
      readonly index: number;
      readonly total: number;
    }
  | { readonly type: "request.start"; readonly requestId: number }
  | {
      readonly type: "request.end";
      readonly requestId: number;
      readonly durationMs: number;
      readonly usage: LlmUsage;
    }
  | { readonly type: "tool.start"; readonly name: string }
  | {
      readonly type: "tool.end";
      readonly name: string;
      readonly durationMs: number;
      readonly ok: boolean;
      readonly resultChars: number;
      readonly resultLines: number;
    }
  | { readonly type: "skill.start"; readonly round: number; readonly skill: string }
  | {
      readonly type: "skill.end";
      readonly round: number;
      readonly skill: string;
      readonly status: RuleSkillPassStatus;
      readonly requestCount: number;
      readonly toolCallCount: number;
      readonly durationMs: number;
    };

/** 单事件信封：`seq` 在单 run（单 stream）内 1-based 严格递增 */
export interface McpReportEnvelope {
  readonly schemaVersion: 1;
  /** 上报流标识（reporter 生成）：`runId` 在 run 结束前不可知，不能当流键 */
  readonly streamId: string;
  readonly seq: number;
  /** 事件发生时刻（ISO-8601），不是发送时刻 */
  readonly at: string;
  readonly event: McpReportEvent;
}

/** 一批 `tools/call` 的 `arguments`（批量语义是**业务层**的，不是 JSON-RPC batch） */
export interface McpReportBatch {
  readonly schemaVersion: 1;
  readonly streamId: string;
  readonly events: readonly McpReportEnvelope[];
}

/** 上报统计（收尾 stderr 一行摘要与 `run.end` 的 `dropped` / `failed` 同源） */
export interface McpReportStats {
  /** 服务端确认接收的事件条数 */
  readonly sent: number;
  /** 重试耗尽后放弃的事件条数 */
  readonly failed: number;
  /** 队列上限溢出丢弃的事件条数 */
  readonly dropped: number;
  /** 实际发出的 `tools/call` 次数（含重试） */
  readonly batches: number;
}
