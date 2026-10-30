import type { Finding } from "../instrument/contracts/finding.js";

/**
 * 分组式检视意见（`reviews_tips_zh.json`，ADR-0017）的**纯映射层**：
 * Finding → `files[].reviewTips[]`（10 键严格封闭，无信封、无附加键）。
 *
 * 边界纪律（与 translate-projection.ts 同档）：
 * - 本模块零网络零文件系统零 pi import——`code` 与 `suggestion` 由调用方
 *   取好/生成好再注入（CLI 侧读 `--repo`，引擎侧调网关），本层只做确定性
 *   映射、分组、排序；
 * - 映射表是单源真值（ADR-0017 §字段映射）：severity 三档、confidence 三档、
 *   source 结构性判定、ruleId 白名单、subcategory 恒空串；
 * - 分组与排序确定：`files[]` 按 finding 首见序，`reviewTips[]` 按 lineNum
 *   升序（同行多条保持源序——稳定排序）。
 */

/** 严重级三档（ADR-0017：P3 折进 Minor，不丢条） */
export type ReviewTipSeverity = "Fatal" | "Major" | "Minor";

/** 置信度三档（ADR-0017：≥0.8 High、≥0.5 Medium、其余 Low） */
export type ReviewTipConfidence = "High" | "Medium" | "Low";

/** 判据来源（ADR-0017：规则会话产出 vs 主会话语义推理） */
export type ReviewTipSource = "rule-reviewer" | "common-reviewer";

/** 单条检视意见（10 键严格封闭——键名与顺序即对外契约） */
export interface ReviewTip {
  readonly code: string;
  readonly review: string;
  readonly suggestion: string;
  readonly category: string;
  readonly subcategory: string;
  readonly severity: ReviewTipSeverity;
  readonly ruleId: string;
  readonly lineNum: number;
  readonly source: ReviewTipSource;
  readonly confidence: ReviewTipConfidence;
}

/** 一个文件下的意见分组（空组不落盘——ADR-0017：只含有意见的文件） */
export interface ReviewTipsFile {
  readonly filePath: string;
  readonly reviewTips: readonly ReviewTip[];
}

/** 分组文档顶层：严格 `{ files }`（无信封；ADR-0022：中文交付物只有这一份） */
export interface ReviewTipsDocument {
  readonly files: readonly ReviewTipsFile[];
}

/** 严重级映射（单源：P0 致命 / P1 高 / P2 中 / P3 中——P3 不丢） */
const SEVERITY_BY_CODE: Readonly<Record<Finding["severity"], ReviewTipSeverity>> = {
  P0: "Fatal",
  P1: "Major",
  P2: "Minor",
  P3: "Minor",
};

/** 规则会话候选 id 前缀（模板单源在 packages/review-pi/src/knowledge/skill-pass-brief.ts） */
export const RULE_REVIEWER_ID_PREFIX = "RULE-CHECK@";

/** 置信度分档阈值（高/中；其余落低） */
const CONFIDENCE_HIGH_MIN = 0.8;
const CONFIDENCE_MEDIUM_MIN = 0.5;

/** P0–P3 → Fatal/Major/Minor */
export function severityOf(code: Finding["severity"]): ReviewTipSeverity {
  return SEVERITY_BY_CODE[code];
}

/** confidence 0–1 → High/Medium/Low（非有限数按 Low——不编高置信） */
export function confidenceOf(value: number): ReviewTipConfidence {
  if (!Number.isFinite(value)) {
    return "Low";
  }
  if (value >= CONFIDENCE_HIGH_MIN) {
    return "High";
  }
  if (value >= CONFIDENCE_MEDIUM_MIN) {
    return "Medium";
  }
  return "Low";
}

/** 判据来源：规则会话产出的候选 id 恒以 RULE-CHECK@ 开头（结构性判定，不看配置） */
export function sourceOf(findingId: string): ReviewTipSource {
  return findingId.startsWith(RULE_REVIEWER_ID_PREFIX) ? "rule-reviewer" : "common-reviewer";
}

/** review 正文 = 中文 title + 「。」+ 中文 description（description 为空时只出 title） */
export function reviewOf(title: string, description: string): string {
  if (description.trim() === "") {
    return title;
  }
  if (title.trim() === "") {
    return description;
  }
  return `${title}。${description}`;
}

/**
 * ruleId：只有 `Finding.rule` 落在本次规则包的真规则 id 集合里才填，
 * 否则空串（common-reviewer 恒空；规则会话无法归因时的包名兜底也落空）。
 */
export function ruleIdOf(finding: Finding, knownRuleIds: ReadonlySet<string>): string {
  return knownRuleIds.has(finding.rule) ? finding.rule : "";
}

/** 映射入参（code/suggestion 由调用方取好/生成好；缺省即空串——绝不编） */
export interface BuildTipsInput {
  /** 呈现档 findings（zh 投影后的 title/description 已译中文） */
  readonly findings: readonly Finding[];
  /** 源码行（键 = finding id；CLI 按 --repo 抽取，取不到即缺席） */
  readonly codeByFinding?: Readonly<Record<string, string>>;
  /** 真规则 id 白名单（规则包 frontmatter id；无规则包即空集） */
  readonly knownRuleIds?: ReadonlySet<string>;
  /** 中文改法建议（键 = finding id；生成失败即缺席 ⇒ 空串） */
  readonly suggestions?: Readonly<Record<string, string>>;
}

/** Finding → 单条 tip（10 键固定顺序；缺失来源一律空串） */
function toTip(finding: Finding, input: BuildTipsInput): ReviewTip {
  return {
    code: input.codeByFinding?.[finding.id] ?? "",
    review: reviewOf(finding.title, finding.description),
    suggestion: input.suggestions?.[finding.id] ?? "",
    category: finding.category,
    subcategory: "",
    severity: severityOf(finding.severity),
    ruleId: ruleIdOf(finding, input.knownRuleIds ?? EMPTY_RULE_IDS),
    lineNum: finding.line,
    source: sourceOf(finding.id),
    confidence: confidenceOf(finding.confidence),
  };
}

const EMPTY_RULE_IDS: ReadonlySet<string> = new Set<string>();

/**
 * 组装分组文档：按 finding 首见序建文件组，组内按 lineNum 升序（稳定排序）。
 * 零 finding ⇒ `{ files: [] }`（照产——「本次没发现问题」本身是结论）。
 */
export function buildReviewTipsDocument(input: BuildTipsInput): ReviewTipsDocument {
  const groups = new Map<string, ReviewTip[]>();
  for (const finding of input.findings) {
    const tips = groups.get(finding.file);
    const tip = toTip(finding, input);
    if (tips === undefined) {
      groups.set(finding.file, [tip]);
    } else {
      tips.push(tip);
    }
  }
  const files: ReviewTipsFile[] = [];
  for (const [filePath, reviewTips] of groups) {
    // 稳定排序：同 lineNum 保持 finding 源序（Array#sort 在 ES2019+ 稳定）
    files.push({ filePath, reviewTips: [...reviewTips].sort((a, b) => a.lineNum - b.lineNum) });
  }
  return { files };
}
