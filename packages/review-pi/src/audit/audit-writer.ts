import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { ConfigId } from "../contracts/config.js";
import type { Finding } from "../contracts/finding.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import type { LlmUsage } from "../contracts/llm.js";
import type { PrefetchLayerRecord } from "../contracts/prefetch.js";
import type {
  CacheBreakRecord,
  CandidateRejection,
  FullRepoRecord,
  MrBoundaryRecord,
  PhaseRecord,
  RuleSkillAudit,
  RunAudit,
  ToolCallRecord,
  WireRequest,
} from "../contracts/run.js";

// 审计投影（测量常量面）：AuditFileContent 字段集与键序和 DSH 线审计文件
// 逐键一致（t-series 审计为地面真源，src/audit/audit-writer.test.ts 断言）。
// requests[] = onPayload 序列化点捕获（WireRequest：model/effort/messages/
// tools/wireBody），承载全部请求的可重放字节。

/**
 * 审计文件内容 = RunAudit + usage + findings + run 元数据。
 * 每次运行的请求字节（requests 数组即可重放的完整请求）、工具调用、usage
 * 记账、最终 Finding 全量落盘。
 */
export interface AuditFileContent {
  readonly runId: string;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly model: string;
  readonly effort: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly usage: LlmUsage;
  readonly findings: readonly Finding[];
  readonly phaseLog: readonly PhaseRecord[];
  readonly rejections: readonly CandidateRejection[];
  /** 相邻请求前缀分歧的 Cache Break 原因分类（与 rejections/phaseLog 同级留痕） */
  readonly cacheBreaks: readonly CacheBreakRecord[];
  readonly requests: readonly WireRequest[];
  readonly toolCallLog: readonly ToolCallRecord[];
  /** config B 预取注入层记账（非预取配置缺省） */
  readonly prefetch?: readonly PrefetchLayerRecord[];
  /** config C 全仓注入记账（非 C 配置缺省；DSH 真源键序在 toolCallLog 尾段） */
  readonly fullRepo?: FullRepoRecord;
  /** config E Context Ledger 快照（非 E 配置缺省；DSH 真源键序在 toolCallLog 尾段） */
  readonly ledger?: readonly LedgerEntry[];
  /**
   * MR 边界护栏降级留痕（#12：度量值 + 降级决策；界内缺省省键）。
   * 键序纪律：pi 线新增可选尾键，只加在 AuditFileContent 尾部
   * （同 prefetch/fullRepo/ledger 先例）。
   */
  readonly mrBoundary?: MrBoundaryRecord;
  /** config F 规则 Skill 留痕（非 F 配置 / 未装载时缺省；pi 线可选尾键纪律） */
  readonly ruleSkill?: RuleSkillAudit;
}

/** runId：毫秒时间戳 + 配置 + 用例，文件名安全 */
export function buildRunId(startedAt: Date, configId: ConfigId, caseId: string): string {
  const timestamp = startedAt.toISOString().replace(/[-:]/g, "").replace("Z", "");
  const safeCaseId = caseId.replace(/[^A-Za-z0-9_-]/g, "_");
  return `${timestamp}-${configId}-${safeCaseId}`;
}

export function buildAuditFileContent(args: {
  readonly runId: string;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly model: string;
  readonly effort: string;
  readonly startedAt: Date;
  readonly finishedAt: Date;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly usage: LlmUsage;
  readonly findings: readonly Finding[];
  readonly audit: RunAudit;
  readonly prefetch?: readonly PrefetchLayerRecord[];
  readonly fullRepo?: FullRepoRecord;
  readonly ledger?: readonly LedgerEntry[];
  readonly mrBoundary?: MrBoundaryRecord;
}): AuditFileContent {
  return {
    runId: args.runId,
    caseId: args.caseId,
    configId: args.configId,
    model: args.model,
    effort: args.effort,
    startedAt: args.startedAt.toISOString(),
    finishedAt: args.finishedAt.toISOString(),
    durationMs: args.finishedAt.getTime() - args.startedAt.getTime(),
    rounds: args.rounds,
    toolCalls: args.toolCalls,
    truncated: args.audit.truncated,
    truncationReasons: args.audit.truncationReasons,
    usage: args.usage,
    findings: args.findings,
    phaseLog: args.audit.phaseLog,
    rejections: args.audit.rejections,
    cacheBreaks: args.audit.cacheBreaks,
    requests: args.audit.requests,
    toolCallLog: args.audit.toolCallLog,
    ...(args.prefetch !== undefined ? { prefetch: args.prefetch } : {}),
    ...(args.fullRepo !== undefined ? { fullRepo: args.fullRepo } : {}),
    ...(args.ledger !== undefined ? { ledger: args.ledger } : {}),
    ...(args.mrBoundary !== undefined ? { mrBoundary: args.mrBoundary } : {}),
    ...(args.audit.ruleSkill !== undefined ? { ruleSkill: args.audit.ruleSkill } : {}),
  };
}

/** 写审计文件（<auditDir>/<runId>.json），返回绝对路径；失败显式抛错 */
export async function writeAuditFile(auditDir: string, content: AuditFileContent): Promise<string> {
  const dir = path.resolve(auditDir);
  try {
    await mkdir(dir, { recursive: true });
    const filePath = path.join(dir, `${content.runId}.json`);
    await writeFile(filePath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to persist audit file for run ${content.runId}: ${message}`, { cause: error });
  }
}
