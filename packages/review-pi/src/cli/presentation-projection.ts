import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import type { Finding } from "../contracts/finding.js";
import type { ToolCallRecord } from "../contracts/run.js";

/**
 * 呈现投影注入缝（ADR-0010「英文产出 + 核外翻译投影」的消费端接线）：
 * CLI 呈现面（stdout）的可选投影步——检视产物恒英文（测量面冻结），中文
 * 呈现经环境变量注入的外部引擎模块投影后呈现。
 *
 * 边界纪律（ADR-0010 Considered Options：翻译进 pi 内核包被否）：
 * 翻译算法、术语表与真引擎（网络/密钥）全部留在核外（root
 * src/presentation/——本包反向依赖不存在）；本缝只做三件事：动态加载
 * 引擎模块 → 调用 → 形状校验。检视行为本体（Zone A 提示词 / 请求字节 /
 * 审计 / RunRecord）零触碰，缺席路径（未配置引擎）stdout 逐字节同现状。
 *
 * 引擎模块协议（消费端契约，JSON 可序列化跨模块边界）：
 * - ESM 模块，default export 一个 async 函数；
 * - 入参 = 呈现源 { findings, toolCallLog, codeByFinding?, rulePackDirs? }（内核
 *   Finding / ToolCallRecord 形状；后两项为 ADR-0017 的分组意见附加输入——
 *   源码行由 CLI 按 `--repo` 抽好、规则包只给目录，引擎仍零文件系统解析）；
 *   返回 { provenance, findings, toolCallLog, tips? }——自然语言字段已译、
 *   结构化字段字节直通（直通由核外投影模块逐字段锁定，本缝不复查内容）；
 * - provenance = { language, terminologyVersion, findingLinks }（投影留痕，
 *   ADR-0010：投影自带留痕、检视审计零改动）；
 * - tips = 分组式检视意见（ADR-0017，严格 10 键封闭）；**与 zh 弱耦合**：
 *   缺省或形状非法 ⇒ 只不产 tips 文件，投影本身仍然成功。
 *
 * 三态结局（main 呈现分流）：
 * - identity：未配置引擎（REVIEW_PI_PRESENTATION_ENGINE 缺席）——恒等直通，
 *   stdout 无 presentation 键（现状形态）；
 * - projected：投影成功——stdout findings 用投影版，尾部追加 presentation 键；
 * - degraded：引擎失败（加载/协议/调用/超时）——检视产物绝不能因呈现层
 *   失败丢失：stdout 回退英文源文档 + presentation 降级标注，人话原因走
 *   stderr，退出码不受影响（呈现降级不是运行失败——对齐诚实截断哲学）。
 */

/** 呈现源：检视产物中呈现面消费的字段子集（对齐核外 ReviewPresentationSource 形状） */
export interface PresentationSource {
  readonly findings: readonly Finding[];
  readonly toolCallLog: readonly ToolCallRecord[];
  /**
   * 源码行（键 = finding id；ADR-0017：`code` 由 CLI 按 `--repo` 抽取，
   * 引擎保持零文件系统访问；取不到即缺席 ⇒ 产空串）。
   */
  readonly codeByFinding?: Readonly<Record<string, string>>;
  /**
   * 本次 run 的规则包解压目录（ADR-0017：核外据此建真规则 id 白名单；
   * 只给目录，不在内核解析规则文件）。
   */
  readonly rulePackDirs?: readonly string[];
}

/** 分组式检视意见（ADR-0017）：单条 tip 的 10 键严格封闭结构 */
export interface ReviewTipLike {
  readonly code: string;
  readonly review: string;
  readonly suggestion: string;
  readonly category: string;
  readonly subcategory: string;
  readonly severity: string;
  readonly ruleId: string;
  readonly lineNum: number;
  readonly source: string;
  readonly confidence: string;
}

/** 分组文档（顶层严格 `{ files }`） */
export interface ReviewTipsDocumentLike {
  readonly files: readonly {
    readonly filePath: string;
    readonly reviewTips: readonly ReviewTipLike[];
  }[];
}

/** 投影留痕（引擎返回；形状对齐核外 ProjectionProvenance） */
export interface PresentationProvenance {
  readonly language: string;
  readonly terminologyVersion: number;
  readonly findingLinks: readonly {
    readonly sourceFindingId: string;
    readonly projectedFindingId: string;
  }[];
}

/** 引擎模块 default export 的调用协议（跨动态 import 边界，运行时形状校验） */
type PresentationEngine = (source: PresentationSource) => Promise<EngineProjection>;

interface EngineProjection {
  readonly provenance: PresentationProvenance;
  readonly findings: readonly Finding[];
  readonly toolCallLog: readonly ToolCallRecord[];
  /** 分组式检视意见（ADR-0017；形状由本缝校验，非法只影响 tips 不拖累 zh） */
  readonly tips?: unknown;
}

/** 呈现投影三态结局 */
export type PresentationProjectionOutcome =
  /** 未配置引擎：恒等直通（stdout 无 presentation 键——现状形态） */
  | { readonly kind: "identity" }
  /**
   * 投影成功：findings 已译，presentation 键 = provenance。
   * `tips`（ADR-0017）与 zh 弱耦合：形状非法/缺席 ⇒ 只有 `tipsProblem`，
   * projected 仍然成立（zh 照常落盘与呈现）。
   */
  | {
      readonly kind: "projected";
      readonly findings: readonly Finding[];
      readonly provenance: PresentationProvenance;
      readonly tips?: ReviewTipsDocumentLike;
      readonly tipsProblem?: string;
    }
  /** 引擎失败：stdout 回退英文源 + presentation 降级标注；reason 走 stderr */
  | { readonly kind: "degraded"; readonly reason: string };

/** 引擎模块路径环境变量（.env.local 注入面；相对路径按进程 cwd 解析） */
export const PRESENTATION_ENGINE_ENV_VAR = "REVIEW_PI_PRESENTATION_ENGINE";

/**
 * 投影总超时预算（引擎内部另有单请求超时；这是 CLI 呈现面的兜底）。
 * 按字段数推导：呈现源的自然语言字段数 × 单请求上界 + 缓冲——引擎逐字段
 * 串行调用（投影模块「次序确定」纪律），慢但可达的网关下预算随字段数伸缩
 * 而非拍一个静态数（2026-10-20 真跑实测：长 description 的非流式翻译单
 * 字段可 >30s）。
 */
const PER_FIELD_TIMEOUT_MS = 90_000;
const TIMEOUT_BUFFER_MS = 30_000;
/** 建议生成并发上限（ADR-0017：与内核侧口径同源；核外引擎按此并发） */
const SUGGESTION_CONCURRENCY = 4;

/**
 * 依呈现源推导总超时（findings × title/description + toolCallLog × resultSummary
 * + 建议生成批次——每条 finding 一次，按并发上限折算批数）。
 */
function deriveTimeoutMs(source: PresentationSource): number {
  const fieldCount = source.findings.length * 2 + source.toolCallLog.length;
  const suggestionBatches =
    source.findings.length === 0 ? 0 : Math.ceil(source.findings.length / SUGGESTION_CONCURRENCY);
  return (fieldCount + suggestionBatches) * PER_FIELD_TIMEOUT_MS + TIMEOUT_BUFFER_MS;
}

/** 引擎是否配置（未配置 = 恒等直通；main 侧「投影进行中」提示的单源谓词） */
export function isPresentationProjectionConfigured(
  env: Record<string, string | undefined> = process.env,
): boolean {
  const enginePath = env[PRESENTATION_ENGINE_ENV_VAR]?.trim();
  return enginePath !== undefined && enginePath !== "";
}

export interface ProjectionOptions {
  /** 环境变量源（缺省 process.env；测试注入） */
  readonly env?: Record<string, string | undefined>;
  /** 总超时上界毫秒（缺省按呈现源字段数推导；测试注入短值） */
  readonly timeoutMs?: number;
}

/**
 * 应用呈现投影：读引擎环境变量 → 加载 → 调用 → 形状校验。
 * 任何失败路径都归 degraded（人话 reason），绝不向上抛——检视产物已落袋，
 * 呈现层的失败必须降级而不是终止命令。
 */
export async function applyPresentationProjection(
  source: PresentationSource,
  options: ProjectionOptions = {},
): Promise<PresentationProjectionOutcome> {
  const env = options.env ?? process.env;
  const enginePath = env[PRESENTATION_ENGINE_ENV_VAR]?.trim();
  if (enginePath === undefined || enginePath === "") {
    return { kind: "identity" };
  }

  let engine: PresentationEngine;
  try {
    const moduleUrl = pathToFileURL(resolve(enginePath)).href;
    const loaded = (await import(moduleUrl)) as { default?: unknown };
    if (typeof loaded.default !== "function") {
      return {
        kind: "degraded",
        reason: `presentation engine module has no default function export: ${enginePath}`,
      };
    }
    engine = loaded.default as PresentationEngine;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      kind: "degraded",
      reason: `failed to load presentation engine module (${enginePath}): ${message}`,
    };
  }

  // 引擎调用统一 Promise 化：同步 throw（非 async 工厂）与同步返回非
  // Promise 都是合法引擎形态，Promise.resolve 一并兜住——契约「任何失败
  // 路径都归 degraded，绝不向上抛」在此收口（否则检视成功后 stdout 整丢）。
  let call: Promise<EngineProjection>;
  try {
    call = Promise.resolve(engine(source));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "degraded", reason: `presentation engine failed to start: ${message}` };
  }
  // 兜住 race 落败方的迟到 rejection（超时降级后引擎请求仍在飞）
  call.catch(() => {});
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeoutMs = options.timeoutMs ?? deriveTimeoutMs(source);
  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutHandle = setTimeout(
      () => reject(new Error(`presentation engine did not finish within ${timeoutMs}ms`)),
      timeoutMs,
    );
  });
  let projection: EngineProjection;
  try {
    projection = await Promise.race([call, timeoutPromise]);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { kind: "degraded", reason: `presentation engine failed: ${message}` };
  } finally {
    clearTimeout(timeoutHandle);
  }

  const shapeError = validateProjection(projection);
  if (shapeError !== undefined) {
    return { kind: "degraded", reason: `presentation engine returned an invalid document: ${shapeError}` };
  }
  // 分组意见（ADR-0017）：与 zh 弱耦合——形状非法/缺席只折损这一份产物，
  // zh 与 stdout 呈现照旧（投影已成功，绝不因 tips 拖累整次投影）
  const tipsProblem = validateTipsDocument(projection.tips);
  if (tipsProblem !== undefined) {
    return {
      kind: "projected",
      findings: projection.findings,
      provenance: projection.provenance,
      tipsProblem,
    };
  }
  return {
    kind: "projected",
    findings: projection.findings,
    provenance: projection.provenance,
    tips: projection.tips as ReviewTipsDocumentLike,
  };
}

/** 单条 tip 的键集与顺序（ADR-0017：严格封闭 10 键，多余/缺失都算协议违规） */
const TIP_KEYS = [
  "code",
  "review",
  "suggestion",
  "category",
  "subcategory",
  "severity",
  "ruleId",
  "lineNum",
  "source",
  "confidence",
] as const;

const TIP_SEVERITIES = new Set(["Fatal", "Major", "Minor"]);
const TIP_SOURCES = new Set(["rule-reviewer", "common-reviewer"]);
const TIP_CONFIDENCES = new Set(["High", "Medium", "Low"]);

/**
 * 分组意见形状校验（ADR-0017）：顶层严格 `{ files }`、每文件
 * `{ filePath, reviewTips }`、每 tip 严格 10 键且值域受限。返回英文错误，
 * 空/undefined = 合法。
 */
function validateTipsDocument(input: unknown): string | undefined {
  if (input === undefined) {
    return "presentation engine returned no grouped tips document (ADR-0017)";
  }
  if (input === null || typeof input !== "object") {
    return "tips must be an object";
  }
  const record = input as { readonly files?: unknown };
  if (!Array.isArray(record.files)) {
    return "tips.files must be an array";
  }
  for (const [fileIndex, file] of record.files.entries()) {
    if (file === null || typeof file !== "object") {
      return `tips.files[${fileIndex}] must be an object`;
    }
    const group = file as { readonly filePath?: unknown; readonly reviewTips?: unknown };
    if (typeof group.filePath !== "string" || group.filePath === "") {
      return `tips.files[${fileIndex}].filePath must be a non-empty string`;
    }
    if (!Array.isArray(group.reviewTips)) {
      return `tips.files[${fileIndex}].reviewTips must be an array`;
    }
    for (const [tipIndex, tip] of group.reviewTips.entries()) {
      const problem = validateTip(tip);
      if (problem !== undefined) {
        return `tips.files[${fileIndex}].reviewTips[${tipIndex}]: ${problem}`;
      }
    }
  }
  return undefined;
}

/** 单条 tip 校验：键集严格相等 + 值域（形状即契约，宁缺勿滥） */
function validateTip(input: unknown): string | undefined {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    return "tip must be an object";
  }
  const tip = input as Record<string, unknown>;
  const keys = Object.keys(tip);
  if (keys.length !== TIP_KEYS.length || !TIP_KEYS.every((key) => key in tip)) {
    return `tip must have exactly these keys: ${TIP_KEYS.join(", ")}`;
  }
  for (const key of ["code", "review", "suggestion", "category", "subcategory", "ruleId"] as const) {
    if (typeof tip[key] !== "string") {
      return `${key} must be a string`;
    }
  }
  if (typeof tip.lineNum !== "number" || !Number.isInteger(tip.lineNum) || tip.lineNum < 1) {
    return "lineNum must be an integer >= 1";
  }
  if (typeof tip.severity !== "string" || !TIP_SEVERITIES.has(tip.severity)) {
    return 'severity must be one of "Fatal", "Major", "Minor"';
  }
  if (typeof tip.source !== "string" || !TIP_SOURCES.has(tip.source)) {
    return 'source must be one of "rule-reviewer", "common-reviewer"';
  }
  if (typeof tip.confidence !== "string" || !TIP_CONFIDENCES.has(tip.confidence)) {
    return 'confidence must be one of "High", "Medium", "Low"';
  }
  return undefined;
}

/**
 * 引擎返回形状校验（坏形状 = 协议违规，降级不静默——stdout 是机器读契约，
 * 畸形投影宁可降级英文源也不输出垃圾）。字段级内容由核外投影模块逐字段
 * 锁定；本缝查条目级形状与长度一致性（provenance.findingLinks 与 findings
 * 同长同序是留痕纪律，长度不一致 = 引擎协议违规）。
 */
function validateProjection(projection: EngineProjection): string | undefined {
  if (projection === null || typeof projection !== "object") {
    return "projection must be an object";
  }
  if (!Array.isArray(projection.findings)) {
    return "findings must be an array";
  }
  if (!projection.findings.every((finding) => finding !== null && typeof finding === "object")) {
    return "each finding must be an object";
  }
  if (!Array.isArray(projection.toolCallLog)) {
    return "toolCallLog must be an array";
  }
  const provenance = projection.provenance;
  if (provenance === null || typeof provenance !== "object") {
    return "provenance must be an object";
  }
  if (typeof provenance.language !== "string" || provenance.language === "") {
    return "provenance.language must be a non-empty string";
  }
  if (typeof provenance.terminologyVersion !== "number" || !Number.isFinite(provenance.terminologyVersion)) {
    return "provenance.terminologyVersion must be a finite number";
  }
  if (!Array.isArray(provenance.findingLinks)) {
    return "provenance.findingLinks must be an array";
  }
  if (provenance.findingLinks.length !== projection.findings.length) {
    return "provenance.findingLinks must match findings one-to-one (same length, same order)";
  }
  return undefined;
}
