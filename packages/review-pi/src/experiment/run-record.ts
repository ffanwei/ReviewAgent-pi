import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../contracts/finding.js";
import type { LedgerEntry } from "../contracts/ledger.js";
import type { LlmUsage } from "../contracts/llm.js";
import type {
  CacheBreakRecord,
  CandidateRejection,
  PhaseRecord,
  RuleSkillAudit,
  RuleSkillPassRecord,
  RunAudit,
  RunResult,
  TipsFilterRecord,
  ToolCallRecord,
} from "../contracts/run.js";

// RunRecord 投影（测量常量面）：三级键序以 t-series 记录为地面真源
// （src/experiment/run-record.test.ts 断言）。落盘路径：
// `<runsRoot>/runs/run.json`（ADR-0032：无 case / rep / source 目录层，
// `caseId` 只作为数据字段保留）。
//
// 请求字节不重复落盘：审计文件（auditPath）承载全部请求的可重放字节，
// 本记录保留指标所需的最小审计面（toolCallLog / phaseLog / rejections 等）。

/** 数据源标识（一次 MR 触发一次检视） */
export type ExperimentSource = "mr";

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
  /** Context Ledger 快照（恒投影——零工具调用为空数组） */
  readonly ledger?: readonly LedgerEntry[];
  /** 规则 Skill 装载留痕（N=0 ⇒ 空数组） */
  readonly ruleSkill?: readonly RuleSkillAudit[];
  /** skill 会话执行留痕（round × skill） */
  readonly skillPassLog?: readonly RuleSkillPassRecord[];
  /** 中文 tips 置信度过滤留痕（ADR-0052）：配置缺席时省键 */
  readonly tipsFilter?: TipsFilterRecord;
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

/** 分片记录（ADR-0039 决策 7）：只在分片模式出现；单片路径整键缺席 */
export interface ShardRecord {
  /** 1-based 片号 */
  readonly index: number;
  /** 该片首次模型请求时刻派生的 runId */
  readonly runId: string;
  /** 本片文件块数 */
  readonly files: number;
  /** 本片 diff 字符数 */
  readonly chars: number;
  readonly complete: boolean;
  readonly truncated: boolean;
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  /** 片内主转录：`<runsRoot>` 相对 POSIX 路径（export 寻址用） */
  readonly transcriptFile: string;
  /** 片内完整审计：`<runsRoot>` 相对 POSIX 路径 */
  readonly auditFile: string;
  /** 全局边界护栏派生的降级文案（未降级省键） */
  readonly domainWarning?: string;
}

/** 一次运行的持久化记录（断点续跑与报告重建的数据源） */
export interface RunRecord {
  readonly source: ExperimentSource;
  readonly caseId: string;
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
  /** 分片留痕（ADR-0039）：多片时在场，单片/旧记录整键缺席 */
  readonly shards?: readonly ShardRecord[];
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
    ...(audit.ledger !== undefined ? { ledger: audit.ledger } : {}),
    ...(audit.ruleSkill !== undefined ? { ruleSkill: audit.ruleSkill } : {}),
    ...(audit.skillPassLog !== undefined ? { skillPassLog: audit.skillPassLog } : {}),
    ...(audit.tipsFilter !== undefined ? { tipsFilter: audit.tipsFilter } : {}),
  };
}

/** 组装 baseline-only 记录（verifier off 档：effective / verifierPass 恒 null） */
export function buildRunRecord(args: {
  readonly source: ExperimentSource;
  readonly caseId: string;
  readonly rep: number;
  readonly model: string;
  readonly completedAt: Date;
  readonly result: RunResult;
  /** 分片留痕（ADR-0039）：只在多片时传入；缺席 = 单片零变更 */
  readonly shards?: readonly ShardRecord[];
}): RunRecord {
  return {
    source: args.source,
    caseId: args.caseId,
    rep: args.rep,
    model: args.model,
    verifier: "off",
    completedAt: args.completedAt.toISOString(),
    baseline: toRunSnapshot(args.result),
    effective: null,
    verifierPass: null,
    ...(args.shards !== undefined ? { shards: args.shards } : {}),
  };
}

/**
 * 运行输出目录：`<runsRoot>/runs`（ADR-0032）。
 * 运行记录（`run.json`）、检视转录（`session-*.json`）与检视意见导出
 * （`reviews_*.json`）共用此目录——单点定义防布局漂移。
 * 不再有 `<source>/<caseId>/rep-<N>` 层：一个 `--out` 就是一次 run 的输出。
 */
export function runDirPath(runsRoot: string): string {
  return path.join(runsRoot, "runs");
}

/** 记录文件路径：`<runsRoot>/runs/run.json` */
export function runRecordPath(runsRoot: string): string {
  return path.join(runDirPath(runsRoot), "run.json");
}

/** 落盘记录（mkdir 递归 + 2 空格缩进 + 尾随换行）；失败显式抛错 */
export async function writeRunRecord(runsRoot: string, record: RunRecord): Promise<string> {
  const filePath = runRecordPath(runsRoot);
  try {
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to persist run record ${record.source}/${record.caseId}/rep-${record.rep}: ${message}`,
      { cause: error },
    );
  }
}
