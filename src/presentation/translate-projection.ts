import type { Finding, RunResult, ToolCallRecord } from "review-pi";
import { TERMINOLOGY, TERMINOLOGY_VERSION, type TerminologyEntry } from "./terminology.js";

/**
 * 翻译投影（#13，生产化四必做之二——ADR-0010）：检视输出恒英文（测量面冻结：
 * Zone A 提示词 / 请求字节 / golden bytes / S 级结论有效域全部不动），中文呈现
 * 经本投影实现——把英文检视产物投影为目标呈现语言的呈现文档。
 *
 * 核内/核外边界（CONTEXT.md）：语言是呈现配置不是检视行为——翻译投影属核外
 * 工具链（消费端关注点），内核零改动、语言参数化缝根本不存在（检视执行缝无
 * 语言键，回归断言见 tests/presentation/no-language-in-plan-or-kernel.test.ts）。
 *
 * 字段分类（单源真值，本模块核心正确性）：
 * - 自然语言字段（唯一可翻译面）：Finding.title / Finding.description /
 *   审计工具摘要 ToolCallRecord.resultSummary；
 * - 结构化字段（绝不翻译，字节原样直通）：Finding 的 id / severity（P0–P3
 *   代码）/ category / file / line / evidence[]（代码摘录）/ rule / confidence，
 *   工具调用的 name / argumentsJson。
 *
 * 语言切换：language "en" = 恒等直通（零引擎调用——英文呈现档就是源文档本身，
 * 同引用返回）；"zh" = 注入引擎只翻自然语言字段，调用次序确定（finding 序
 * title→description，再 toolCall 序 resultSummary——可复现、可断言）。
 * 翻译引擎是注入缝：真引擎（LLM/网关）由消费端装配（本票范围外），翻译保真
 * 抽检同为消费端责任（30 案语言抽样已随 ADR-0010 取消）。
 *
 * 投影留痕（替代检视审计留痕——检视审计恒无语言键、审计文件零改动）：投影
 * 文档自带 provenance = { 呈现语言 language、术语表版本 terminologyVersion、
 * 源 finding 关联 findingLinks }。findingLinks 与源 findings 同长同序一一对应
 * （sourceFindingId ↔ projectedFindingId 可回溯）；id 属结构化字段不译，投影侧
 * id 恒等于源 id——显式列出关联是留痕形态（也为未来投影侧独立 id 预留）。
 *
 * 模块纪律：纯依赖注入、零 pi 运行时依赖——共享契约（Finding / RunResult /
 * ToolCallRecord）以 review-pi 为**类型单源**（type-only import，ADR-0024），
 * 运行时永不 import pi 内核或其转译路径（import 面由
 * tests/presentation/translate-projection.test.ts 机器锁定）。
 */

/** 呈现语言（ADR-0010：检视产物恒 en；zh = 经核外翻译投影的呈现档） */
export type PresentationLanguage = "en" | "zh";

/** 投影源：检视产物中呈现面消费的字段子集（findings + 审计工具摘要） */
export interface ReviewPresentationSource {
  readonly findings: readonly Finding[];
  /** resultSummary 为自然语言字段；name / argumentsJson 结构化直通 */
  readonly toolCallLog: readonly ToolCallRecord[];
}

/** 术语上下文（随每次引擎调用注入——引擎拿单源术语表作参考，非硬替换） */
export interface TerminologyContext {
  readonly targetLanguage: PresentationLanguage;
  readonly terminologyVersion: number;
  readonly entries: readonly TerminologyEntry[];
}

/** 翻译引擎注入缝：文本 + 术语上下文 → 译文（真引擎消费端装配；返回非空由本模块校验） */
export type TranslateEngine = (text: string, context: TerminologyContext) => Promise<string>;

/** 源 finding 关联留痕（一一对应可回溯；id 不译 → v1 恒等映射，显式列出备未来投影侧独立 id） */
export interface FindingLink {
  readonly sourceFindingId: string;
  readonly projectedFindingId: string;
}

/** 投影留痕：呈现语言 + 术语表版本 + 源 finding 关联（en/zh 两档同形携带） */
export interface ProjectionProvenance {
  readonly language: PresentationLanguage;
  readonly terminologyVersion: number;
  readonly findingLinks: readonly FindingLink[];
}

/** 投影产物：呈现文档（自然语言字段已译、结构化字段字节直通）+ 留痕 */
export interface ProjectedReviewDocument {
  readonly provenance: ProjectionProvenance;
  readonly findings: readonly Finding[];
  readonly toolCallLog: readonly ToolCallRecord[];
}

export interface ProjectionDeps {
  /** 翻译引擎（en 恒等直通零调用；zh 恰对每个非空自然语言字段调用一次） */
  readonly engine: TranslateEngine;
}

export interface ProjectionInput {
  /** 投影源（检视产物的呈现面子集） */
  readonly source: ReviewPresentationSource;
  /** 呈现语言（en 恒等直通 / zh 翻译投影） */
  readonly language: PresentationLanguage;
}

/** 从 RunResult 圈出呈现源（findings + audit.toolCallLog 引用直通——消费端便捷缝） */
export function presentationSourceOf(result: RunResult): ReviewPresentationSource {
  return { findings: result.findings, toolCallLog: result.audit.toolCallLog };
}

/**
 * 跑翻译投影：en = 恒等直通（零引擎调用）；zh = 引擎翻自然语言字段。
 * 输入形状错误（装配面问题）抛 Error；引擎对非空输入产出空译文同样抛错
 * （零静默丢检视内容）。
 */
export async function projectReviewDocument(
  deps: ProjectionDeps,
  input: ProjectionInput,
): Promise<ProjectedReviewDocument> {
  validateProjectionInput(input);
  if (input.language === "en") {
    return identityProjection(input.source);
  }
  return translateProjection(deps.engine, input.source);
}

/** en 恒等直通：呈现文档就是源文档本身（同引用），留痕照常完整 */
function identityProjection(source: ReviewPresentationSource): ProjectedReviewDocument {
  return {
    provenance: provenanceOf("en", source),
    findings: source.findings,
    toolCallLog: source.toolCallLog,
  };
}

/** zh 翻译投影：引擎只翻自然语言字段（次序确定），结构化字段 spread 直通 */
async function translateProjection(
  engine: TranslateEngine,
  source: ReviewPresentationSource,
): Promise<ProjectedReviewDocument> {
  const context: TerminologyContext = {
    targetLanguage: "zh",
    terminologyVersion: TERMINOLOGY_VERSION,
    entries: TERMINOLOGY,
  };
  const findings: Finding[] = [];
  for (const [index, finding] of source.findings.entries()) {
    findings.push({
      ...finding,
      title: await translateField(engine, finding.title, `findings[${index}].title`, context),
      description: await translateField(
        engine,
        finding.description,
        `findings[${index}].description`,
        context,
      ),
    });
  }
  const toolCallLog: ToolCallRecord[] = [];
  for (const [index, record] of source.toolCallLog.entries()) {
    toolCallLog.push({
      ...record,
      resultSummary: await translateField(
        engine,
        record.resultSummary,
        `toolCallLog[${index}].resultSummary`,
        context,
      ),
    });
  }
  return { provenance: provenanceOf("zh", source), findings, toolCallLog };
}

/** 单字段翻译：空串直通零调用（无事可译）；非空输入得空译文 = 静默丢内容，拒绝 */
async function translateField(
  engine: TranslateEngine,
  text: string,
  fieldPath: string,
  context: TerminologyContext,
): Promise<string> {
  if (typeof text !== "string") {
    throw new Error(
      `translate projection: ${fieldPath} must be a string (got ${typeof text}) — malformed source document`,
    );
  }
  if (text === "") {
    return "";
  }
  const translated = await engine(text, context);
  if (typeof translated !== "string" || translated.trim() === "") {
    throw new Error(
      `translate projection: engine returned an empty translation for ${fieldPath} ` +
        "(source text is non-empty) — refusing to silently drop review content",
    );
  }
  return translated;
}

/** 投影留痕（语言档 + 术语表版本 + 源 finding 关联，同长同序） */
function provenanceOf(
  language: PresentationLanguage,
  source: ReviewPresentationSource,
): ProjectionProvenance {
  return {
    language,
    terminologyVersion: TERMINOLOGY_VERSION,
    findingLinks: source.findings.map((finding) => ({
      sourceFindingId: finding.id,
      projectedFindingId: finding.id,
    })),
  };
}

/** 入参形状校验（装配面错误 fail fast，不进引擎） */
function validateProjectionInput(input: ProjectionInput): void {
  if (input === null || typeof input !== "object") {
    throw new Error("translate projection: input must be a ProjectionInput object");
  }
  if (input.language !== "en" && input.language !== "zh") {
    throw new Error(
      `translate projection: input.language must be "en" or "zh" (got ${JSON.stringify(input.language)})`,
    );
  }
  if (input.source === null || typeof input.source !== "object" || Array.isArray(input.source)) {
    throw new Error("translate projection: input.source must be a ReviewPresentationSource object");
  }
  if (!Array.isArray(input.source.findings)) {
    throw new Error("translate projection: input.source.findings must be an array of Finding");
  }
  if (!Array.isArray(input.source.toolCallLog)) {
    throw new Error("translate projection: input.source.toolCallLog must be an array of ToolCallRecord");
  }
}
