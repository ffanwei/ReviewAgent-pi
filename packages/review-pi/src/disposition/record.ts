import { readFile } from "node:fs/promises";
import path from "node:path";
import { CONFIGS, type ConfigId } from "../contracts/config.js";
import type { ExperimentSource } from "../experiment/run-record.js";

/**
 * #15 Finding 处置记录契约（票面四要素 + 回溯锚）。
 *
 * - 处置三值 accept / reject / false-positive：KPI 口径里只有 accept 算
 *   「接受」（reject 与 false-positive 都不是——聚合见 kpi.ts）；
 * - notedAt = ISO 8601 时间戳（时间要素）；note 可选人工备注（缺席省键，
 *   不落 undefined 值——不可变纪律下的可选字段形态）；
 * - 案例关联与回溯锚同体：source / caseId / configId / rep / model 与
 *   RunRecord（experiment/run-record.ts）身份块逐键同序——处置记录前五键
 *   与 RunRecord 前五键完全一致，凭锚可重定位产生该 finding 的检视运行
 *   （referredRunRecordPath 与 runRecordPath 同构）；
 * - 写入侧 fail fast（回溯 AC 的核心）：findingId 必须存在于所引 run
 *   record 的 baseline.findings；文件缺席 / JSON 不可解析 / 形状不符 /
 *   findingId 不在其中 → 人话错误（含 caseId/configId/findingId 定位）。
 *
 * RunRecordRef 是 RunRecord 的结构性窄化（只取身份锚 + findings 的 id
 * 投影）——真 RunRecord 天然满足，record.test.ts 用 buildRunRecord 夹具
 * 全链路锁定这一对齐。本模块 config 无关（2026-10-19 决策评论）：任意
 * configId 的 run record 都能处置；KPI 产生面用生产入口 E 的产出是使用
 * 约定，不是模块耦合。本文件同时承载处置模块的共享字段校验器（store.ts
 * 的条目校验复用——单源，不复制枚举/边界口径）。
 */

/** 处置三值：接受 / 拒绝 / 误报（票面原文顺序） */
export type DispositionDecision = "accept" | "reject" | "false-positive";

/** 处置三值枚举表（args.ts parse 层与 store 读取侧校验共用单源） */
export const DISPOSITION_DECISIONS: readonly DispositionDecision[] = [
  "accept",
  "reject",
  "false-positive",
];

/** RunRecord 的处置读取面：身份锚 + baseline.findings 的 id 投影（结构窄化） */
export interface RunRecordRef {
  readonly source: ExperimentSource;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly rep: number;
  readonly model: string;
  readonly baseline: { readonly findings: readonly { readonly id: string }[] };
}

/** 一条 Finding 处置记录（append-only 处置库的最小落库单元） */
export interface DispositionRecord {
  readonly source: ExperimentSource;
  readonly caseId: string;
  readonly configId: ConfigId;
  readonly rep: number;
  readonly model: string;
  readonly findingId: string;
  readonly disposition: DispositionDecision;
  readonly notedAt: string;
  /** 可选人工备注（缺席省键） */
  readonly note?: string;
}

// ---- 共享字段校验器（外部 JSON 数据 fail fast；where = 调用方定位前缀） ----

/** 非空字符串字段（全空白同拒） */
export function nonEmptyString(value: unknown, field: string, where: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${where}: field "${field}" must be a non-empty string`);
  }
  return value;
}

/** source 枚举（ExperimentSource 当前单值——Vul4J 评测集；新源加入时同步） */
export function validatedSource(source: unknown, where: string): ExperimentSource {
  if (source !== "vul4j") {
    throw new Error(`${where}: field "source" must be "vul4j" (got ${JSON.stringify(source)})`);
  }
  return source;
}

/** configId ∈ CONFIGS 注册表（A–F 矩阵真源：F = E + 规则 Skill，ADR-0012） */
export function validatedConfigId(configId: unknown, where: string): ConfigId {
  if (typeof configId !== "string" || !(configId in CONFIGS)) {
    throw new Error(
      `${where}: field "configId" must be one of A, B, C, D, E, F (got ${JSON.stringify(configId)})`,
    );
  }
  // in CONFIGS 已收窄运行时值；字面量联合需显式断言（TS 不做 in 收窄）
  return configId as ConfigId;
}

/** rep：>= 1 的整数（运行编号从 1 起） */
export function validatedRep(rep: unknown, where: string): number {
  if (typeof rep !== "number" || !Number.isInteger(rep) || rep < 1) {
    throw new Error(`${where}: field "rep" must be an integer >= 1`);
  }
  return rep;
}

// ---- run record 读取面 ----

/** unknown 错误 → 消息文本（cause 由调用方透传；人话包装的单源，store.ts 复用） */
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 读 run record 文件 → 身份锚 + findings 投影；缺席 / 不可解析 / 形状不符 → 人话错误 */
export async function readRunRecordRef(runRecordPath: string): Promise<RunRecordRef> {
  let text: string;
  try {
    text = await readFile(runRecordPath, "utf8");
  } catch (error) {
    if (error instanceof Error && (error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        `run record file not found: ${runRecordPath} (--run must point at the run record JSON produced by a review run)`,
      );
    }
    throw new Error(`cannot read run record file ${runRecordPath}: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`run record file ${runRecordPath} is not valid JSON: ${errorMessage(error)}`, {
      cause: error,
    });
  }
  return toRunRecordRef(parsed, runRecordPath);
}

/** JSON 形状校验：RunRecord 身份锚 + findings id 投影 */
function toRunRecordRef(parsed: unknown, runRecordPath: string): RunRecordRef {
  const where = `run record file ${runRecordPath}`;
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new Error(`${where}: expected a JSON object (RunRecord)`);
  }
  const raw = parsed as Record<string, unknown>;
  const baseline = raw.baseline;
  if (typeof baseline !== "object" || baseline === null || Array.isArray(baseline)) {
    throw new Error(`${where}: field "baseline" must be an object`);
  }
  const findings = (baseline as Record<string, unknown>).findings;
  if (!Array.isArray(findings)) {
    throw new Error(`${where}: field "baseline.findings" must be an array`);
  }
  return {
    source: validatedSource(raw.source, where),
    caseId: nonEmptyString(raw.caseId, "caseId", where),
    configId: validatedConfigId(raw.configId, where),
    rep: validatedRep(raw.rep, where),
    model: nonEmptyString(raw.model, "model", where),
    baseline: { findings: findings.map((entry, index) => ({ id: findingId(entry, index, where) })) },
  };
}

/** 单条 finding 的 id 校验（baseline.findings[i].id 定位） */
function findingId(entry: unknown, index: number, where: string): string {
  const id =
    typeof entry === "object" && entry !== null
      ? (entry as Record<string, unknown>).id
      : undefined;
  if (typeof id !== "string" || id.length === 0) {
    throw new Error(`${where}: field "baseline.findings[${index}].id" must be a non-empty string`);
  }
  return id;
}

// ---- 处置记录组装面 ----

/** 组装处置记录（写入前校验）：findingId 必须存在于所引 run record 的 baseline.findings */
export function buildDispositionRecord(args: {
  readonly runRecord: RunRecordRef;
  readonly findingId: string;
  readonly decision: DispositionDecision;
  readonly notedAt: Date;
  readonly note?: string;
}): DispositionRecord {
  if (args.note !== undefined && args.note.trim().length === 0) {
    throw new Error("note must be non-empty text (omit it for no note)");
  }
  const { runRecord } = args;
  const found = runRecord.baseline.findings.some((finding) => finding.id === args.findingId);
  if (!found) {
    const ids = runRecord.baseline.findings.map((finding) => finding.id);
    const available =
      ids.length === 0
        ? "baseline.findings is empty: the run produced no findings, nothing to dispose"
        : `baseline.findings ids: ${ids.join(", ")}`;
    throw new Error(
      `finding ${JSON.stringify(args.findingId)} not found in run record ${describeRunRecordRef(runRecord)} (${available})`,
    );
  }
  return {
    source: runRecord.source,
    caseId: runRecord.caseId,
    configId: runRecord.configId,
    rep: runRecord.rep,
    model: runRecord.model,
    findingId: args.findingId,
    disposition: args.decision,
    notedAt: args.notedAt.toISOString(),
    ...(args.note !== undefined ? { note: args.note } : {}),
  };
}

/**
 * 处置记录 → 产生它的 run record 文件路径（回溯的重定位面）。
 * 路径规则与 experiment/run-record.ts 的 runRecordPath 同构（该模块本票
 * 只读、不能收窄签名复用——漂移锚点：runRecordPath 语义变更时此处同步，
 * record.test.ts 有同构断言）。caseId 文件名消毒同则。
 */
export function referredRunRecordPath(
  runsRoot: string,
  experimentId: string,
  record: DispositionRecord,
): string {
  const safeCaseId = record.caseId.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(
    runsRoot,
    experimentId,
    "runs",
    record.source,
    safeCaseId,
    record.configId,
    `rep-${record.rep}.json`,
  );
}

/** 身份锚定位串（错误信息用，与 writeRunRecord 的错误文案同形） */
export function describeRunRecordRef(ref: RunRecordRef): string {
  return `${ref.source}/${ref.caseId}/${ref.configId}/rep-${ref.rep}`;
}
