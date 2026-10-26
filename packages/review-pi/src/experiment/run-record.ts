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
  PhaseRecord,
  RuleSkillAudit,
  RunAudit,
  RunResult,
  ToolCallRecord,
} from "../contracts/run.js";

// RunRecord 投影（测量常量面）：与根仓 run-store 产出的 DSH 记录同构
// （三级键序以 t-series 记录为地面真源，src/experiment/run-record.test.ts 断言），
// 冻结 analyze 脚本原样消费。落盘路径：
// <runsRoot>/<experimentId>/runs/vul4j/<caseId>/<configId>/rep-<N>.json。
//
// 请求字节不重复落盘：审计文件（auditPath）承载全部请求的可重放字节，
// 本记录保留指标与判定链所需的最小审计面（toolCallLog / phaseLog / rejections 等）。

/** 数据源标识（P1a 评测集：Vul4J） */
export type ExperimentSource = "vul4j";

/** 二遍 Verifier 开关（P1a 恒 off） */
export type VerifierMode = "off" | "on";

/** runReview 审计的轻量投影（不含 requests；重放字节以 auditPath 为准） */
export interface AuditLight {
  readonly toolCallLog: readonly ToolCallRecord[];
  readonly phaseLog: readonly PhaseRecord[];
  readonly rejections: readonly CandidateRejection[];
  /** Cache Break 原因分类（小体量留痕，空时省键） */
  readonly cacheBreaks?: readonly CacheBreakRecord[];
  readonly truncated: boolean;
  readonly truncationReasons: readonly string[];
  readonly prefetch?: readonly PrefetchLayerRecord[];
  /** config C：全仓注入记账（budget/截断留痕；DSH C 真源同位键） */
  readonly fullRepo?: FullRepoRecord;
  /** config E：Context Ledger 快照（恒投影——零工具调用为空数组；C/D 键省略） */
  readonly ledger?: readonly LedgerEntry[];
  /** config F：规则 Skill 留痕（非 F 配置 / 未装载时省键） */
  readonly ruleSkill?: RuleSkillAudit;
}

/** RunResult 快照（audit 以轻量投影落盘） */
export interface RunSnapshot {
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly audit: AuditLight;
  readonly auditPath: string;
  /**
   * 域外显式降级标注（#12 MR 边界护栏）：结果顶层字段（非审计字段），
   * 界内缺席省键（旧记录无此键——缺席兼容）。
   */
  readonly domainWarning?: string;
}

/** 一次运行的持久化记录（断点续跑与报告重建的数据源） */
export interface RunRecord {
  readonly source: ExperimentSource;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly rep: number;
  readonly model: string;
  readonly verifier: VerifierMode;
  readonly completedAt: string;
  /** 基线（六阶段循环单遍自证）结果快照 */
  readonly baseline: RunSnapshot;
  /** P1a verifier off：复核档缺省 null */
  readonly effective: RunSnapshot | null;
  /** P1a verifier off：复核留痕缺省 null */
  readonly verifierPass: null;
}

/** RunResult → 轻量快照（去 requests；路径来自 RunResult.auditPath） */
export function toRunSnapshot(result: RunResult): RunSnapshot {
  return {
    findings: result.findings,
    usage: result.usage,
    rounds: result.rounds,
    toolCalls: result.toolCalls,
    audit: toAuditLight(result.audit),
    auditPath: result.auditPath ?? "",
    ...(result.domainWarning !== undefined ? { domainWarning: result.domainWarning } : {}),
  };
}

export function toAuditLight(audit: RunAudit): AuditLight {
  return {
    toolCallLog: audit.toolCallLog,
    phaseLog: audit.phaseLog,
    rejections: audit.rejections,
    ...(audit.cacheBreaks !== undefined && audit.cacheBreaks.length > 0
      ? { cacheBreaks: audit.cacheBreaks }
      : {}),
    truncated: audit.truncated,
    truncationReasons: audit.truncationReasons,
    ...(audit.prefetch !== undefined ? { prefetch: audit.prefetch } : {}),
    ...(audit.fullRepo !== undefined ? { fullRepo: audit.fullRepo } : {}),
    ...(audit.ledger !== undefined ? { ledger: audit.ledger } : {}),
    ...(audit.ruleSkill !== undefined ? { ruleSkill: audit.ruleSkill } : {}),
  };
}

/** 组装 baseline-only 记录（verifier off 档：effective / verifierPass 恒 null） */
export function buildRunRecord(args: {
  readonly source: ExperimentSource;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly rep: number;
  readonly model: string;
  readonly completedAt: Date;
  readonly result: RunResult;
}): RunRecord {
  return {
    source: args.source,
    caseId: args.caseId,
    configId: args.configId,
    rep: args.rep,
    model: args.model,
    verifier: "off",
    completedAt: args.completedAt.toISOString(),
    baseline: toRunSnapshot(args.result),
    effective: null,
    verifierPass: null,
  };
}

/** caseId 的文件系统安全形（runs 树目录键；与审计目录 / root RunStore 同规则） */
export function sanitizeCaseId(caseId: string): string {
  return caseId.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * 运行输出目录：`<runsRoot>/<experimentId>/runs/<source>/<safeCaseId>/<configId>`。
 * 运行记录（`rep-<N>.json`）、检视转录（`session-*.json`）与检视意见导出
 * （`rep-<N>/reviews_*.json`）共用此目录——单点定义防布局漂移。
 */
export function runDirPath(args: {
  readonly runsRoot: string;
  readonly experimentId: string;
  readonly source: ExperimentSource;
  readonly caseId: string;
  readonly configId: ConfigId;
}): string {
  return path.join(
    args.runsRoot,
    args.experimentId,
    "runs",
    args.source,
    sanitizeCaseId(args.caseId),
    args.configId,
  );
}

/** 记录文件路径：<runsRoot>/<experimentId>/runs/<source>/<caseId>/<configId>/rep-<rep>.json */
export function runRecordPath(runsRoot: string, experimentId: string, record: RunRecord): string {
  return path.join(
    runDirPath({
      runsRoot,
      experimentId,
      source: record.source,
      caseId: record.caseId,
      configId: record.configId,
    }),
    `rep-${record.rep}.json`,
  );
}

/** 落盘记录（mkdir 递归 + 2 空格缩进 + 尾随换行）；失败显式抛错 */
export async function writeRunRecord(
  runsRoot: string,
  experimentId: string,
  record: RunRecord,
): Promise<string> {
  const filePath = runRecordPath(runsRoot, experimentId, record);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to persist run record ${record.source}/${record.caseId}/${record.configId}/rep-${record.rep}: ${message}`,
      { cause: error },
    );
  }
}
