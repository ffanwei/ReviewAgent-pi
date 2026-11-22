// 候选拦截链（测量常量面：六阶段语义的 Evidence Gate 部分）。
// "No Evidence, No Finding"：SCHEMA_INVALID → NO_EVIDENCE
// → VERIFICATION_FAILED → OUT_OF_SCOPE → DUPLICATE_ID，每候选至多留痕一条
// （首个失败阶段）。ADR-0090：NON_ENGLISH 拦截已随中文原生检视退役。
//
// 跨轮去重口径（P1）：**按内容键** `(normalize(file), line, normalize(title))`
// 判重，不按模型给的 `id`。模型每轮都可能从 F001 重新编号，id 复用不代表
// 同一问题；只有内容相同才丢弃。
// 同根因去重（P2）：模型常把同一处代码的同一根因拆成两条（例如三元表达式
// 的两个分支各报一条），标题不同但位置相邻。内容键抓不到它们，因此再按
// `(normalize(file), category, ±5 行)` 定位相邻候选，并且只有**标题高相似**
// （字符二元组 Jaccard ≥ 0.5）或 **rule 相同**时才判同一根因；只保留先到的一条。
// 带 category 与相似度/rule 是为了避免把相邻但不同根因的独立缺陷一起吞掉。
import type { Finding, FindingTips } from "../contracts/finding.js";
import type { CandidateRejection } from "../contracts/run.js";
import {
  addRootCauseKey,
  findingContentKey,
  hasRootCauseKey,
  ROOT_CAUSE_WINDOW_LINES,
} from "../finding/finding-key.js";
import { validateFinding } from "../finding/finding-schema.js";
import { groundFindingEvidence, type EvidenceGroundingResult } from "./evidence-grounding.js";
import type { VerificationVerdict } from "../shared/parse.js";
import { describeScopeRejection, type DiffScope } from "./diff-scope.js";

export interface GateInput {
  /** Deep Reasoning 阶段产出的原始候选对象 */
  readonly candidates: readonly unknown[];
  /** Evidence Verification 阶段的裁决（按候选 id 索引） */
  readonly verdicts: ReadonlyMap<string, VerificationVerdict>;
  /** 已产出的 Finding id 集合（跨轮去重；不会被本函数修改） */
  readonly emittedIds: ReadonlySet<string>;
  /** 已产出 Finding 的内容键集合（跨轮去重的真实依据；不会被本函数修改） */
  readonly emittedContentKeys?: ReadonlySet<string>;
  /** 已产出 Finding 的同根因位置桶（跨轮去重；不会被本函数修改） */
  readonly emittedRootKeys?: ReadonlySet<string>;
  readonly round: number;
  /**
   * 非 diff 区域过滤（`limits.findingScope`）：缺省 undefined = 不过滤
   * （内核直调 / 单测零漂移）；run 层按配置构建后传入。
   */
  readonly scope?: DiffScope;
  /**
   * 证据接地（F-04）：缺省 undefined = 不核对（零行为变化）。
   * `fileText` 返回 null 表示不可核对（文件缺失 / side 非 head），fail-open。
   */
  readonly evidence?: EvidenceGateOptions;
}

export interface EvidenceGateOptions {
  readonly mode: "warn" | "drop";
  readonly minMatchChars: number;
  readonly fileText: (file: string) => string | null;
}

export interface GateOutput {
  readonly findings: readonly Finding[];
  readonly rejections: readonly CandidateRejection[];
  readonly emittedIds: ReadonlySet<string>;
  readonly emittedContentKeys: ReadonlySet<string>;
  readonly emittedRootKeys: ReadonlySet<string>;
  /** 只在 `evidence` 启用且检查过候选时在场 */
  readonly evidenceGrounding?: {
    readonly checked: number;
    readonly grounded: number;
    readonly unverified: number;
    readonly unverifiable: number;
    readonly dropped: number;
  };
}

export function applyCandidateGate(input: GateInput): GateOutput {
  const findings: Finding[] = [];
  const rejections: CandidateRejection[] = [];
  const emittedIds = new Set(input.emittedIds);
  const emittedContentKeys = new Set(input.emittedContentKeys ?? []);
  const emittedRootKeys = new Set(input.emittedRootKeys ?? []);
  const resolvedVerdicts = resolveVerdicts(input.candidates, input.verdicts, input.round);
  const evidenceCounts = { checked: 0, grounded: 0, unverified: 0, unverifiable: 0, dropped: 0 };

  input.candidates.forEach((candidate, index) => {
    const candidateId = readCandidateId(candidate, input.round, index);
    const grounding =
      input.evidence !== undefined &&
      validateFinding(candidate).length === 0 &&
      hasEvidence(candidate)
        ? groundCandidate(candidate, input.evidence)
        : undefined;
    if (grounding !== undefined) {
      evidenceCounts.checked += 1;
      evidenceCounts[grounding.status] += 1;
    }
    const rejection = firstFailingStage(
      candidate,
      candidateId,
      resolvedVerdicts[index],
      emittedContentKeys,
      emittedRootKeys,
      input.scope,
      input.evidence !== undefined && grounding !== undefined
        ? { mode: input.evidence.mode, grounding }
        : undefined,
    );
    if (rejection !== undefined) {
      rejections.push(rejection);
      return;
    }
    const finding = toFinding(candidate);
    findings.push(finding);
    emittedIds.add(candidateId);
    emittedContentKeys.add(findingContentKey(finding));
    addRootCauseKey(emittedRootKeys, finding);
  });

  if (input.evidence?.mode === "drop") {
    evidenceCounts.dropped = rejections.filter(
      (rejection) => rejection.stage === "EVIDENCE_UNGROUNDED",
    ).length;
  }
  return {
    findings,
    rejections,
    emittedIds,
    emittedContentKeys,
    emittedRootKeys,
    ...(evidenceCounts.checked > 0 ? { evidenceGrounding: evidenceCounts } : {}),
  };
}

/**
 * 裁决按候选 id 解析；id 对不上时退到**位置匹配**（同长度才启用）。
 *
 * 位置兜底只在模型把 id 写错 / 漏写时救场：裁决条数与候选条数一致才按序
 * 对应，避免把一条裁决错配给另一条候选。
 */
function resolveVerdicts(
  candidates: readonly unknown[],
  verdicts: ReadonlyMap<string, VerificationVerdict>,
  round: number,
): readonly (VerificationVerdict | undefined)[] {
  const lower = new Map<string, VerificationVerdict>();
  for (const [id, verdict] of verdicts) {
    lower.set(id.toLowerCase(), verdict);
  }
  const positional = [...verdicts.values()];
  const positionalUsable = positional.length === candidates.length;
  return candidates.map((candidate, index) => {
    const candidateId = readCandidateId(candidate, round, index);
    const byId = verdicts.get(candidateId) ?? lower.get(candidateId.toLowerCase());
    if (byId !== undefined) {
      return byId;
    }
    return positionalUsable ? positional[index] : undefined;
  });
}

function readCandidateId(candidate: unknown, round: number, index: number): string {
  if (typeof candidate === "object" && candidate !== null) {
    const id = (candidate as { id?: unknown }).id;
    if (typeof id === "string" && id.length > 0) {
      return id;
    }
  }
  return `round-${round}-candidate-${index}`;
}

function firstFailingStage(
  candidate: unknown,
  candidateId: string,
  verdict: VerificationVerdict | undefined,
  emittedContentKeys: ReadonlySet<string>,
  emittedRootKeys: ReadonlySet<string>,
  scope: DiffScope | undefined,
  evidence: { readonly mode: "warn" | "drop"; readonly grounding: EvidenceGroundingResult } | undefined,
): CandidateRejection | undefined {
  const schemaErrors = validateFinding(candidate);
  if (schemaErrors.length > 0) {
    return { candidateId, stage: "SCHEMA_INVALID", reason: schemaErrors.join("; ") };
  }
  if (!hasEvidence(candidate)) {
    return { candidateId, stage: "NO_EVIDENCE", reason: "未引用证据（No Evidence, No Finding）" };
  }
  if (
    evidence !== undefined &&
    evidence.mode === "drop" &&
    evidence.grounding.status === "unverified"
  ) {
    return {
      candidateId,
      stage: "EVIDENCE_UNGROUNDED",
      reason: "证据无法在 head 侧文件里定位到代码片段（Evidence must be checkable）",
    };
  }
  if (verdict === undefined) {
    return { candidateId, stage: "VERIFICATION_FAILED", reason: "没有该候选的裁决结论" };
  }
  if (!verdict.pass) {
    const detail = verdict.reason.length > 0 ? `：${verdict.reason}` : "";
    return {
      candidateId,
      stage: "VERIFICATION_FAILED",
      reason: `证据裁决驳回了该候选${detail}`,
    };
  }
  if (scope !== undefined) {
    const located = candidate as Pick<Finding, "file" | "line">;
    if (scope.classify(located.file, located.line) !== "in-scope") {
      return {
        candidateId,
        stage: "OUT_OF_SCOPE",
        reason: describeScopeRejection(scope, located),
      };
    }
  }
  const contentKey = findingContentKey(candidate as { file: string; line: number; title: string });
  if (emittedContentKeys.has(contentKey)) {
    return {
      candidateId,
      stage: "DUPLICATE_ID",
      reason: "同 (file, line, title) 的意见在更早的轮次已产出",
    };
  }
  const located = candidate as Pick<Finding, "file" | "line" | "category" | "rule" | "title">;
  if (hasRootCauseKey(emittedRootKeys, located)) {
    return {
      candidateId,
      stage: "DUPLICATE_ID",
      reason: `同一文件 ±${String(ROOT_CAUSE_WINDOW_LINES)} 行内、标题高度相似或 rule 相同的同根因意见已产出`,
    };
  }
  return undefined;
}

function groundCandidate(
  candidate: unknown,
  options: EvidenceGateOptions,
): EvidenceGroundingResult {
  const file = (candidate as { file?: unknown }).file;
  const fileText = typeof file === "string" ? options.fileText(file) : null;
  return groundFindingEvidence(
    candidate as { evidence?: unknown },
    fileText,
    options.minMatchChars,
  );
}

function hasEvidence(candidate: unknown): boolean {
  const evidence = (candidate as { evidence?: unknown }).evidence;
  return (
    Array.isArray(evidence) && evidence.some((entry) => typeof entry === "string" && entry.trim().length > 0)
  );
}

function toFinding(candidate: unknown): Finding {
  // 形状已由 validateFinding 保证；只投影已知字段（多余字段静默丢弃）
  const record = candidate as {
    id: string;
    severity: Finding["severity"];
    category: string;
    file: string;
    line: number;
    title: string;
    description: string;
    evidence: readonly string[];
    rule: string;
    confidence: number;
    tips?: FindingTips;
  };
  return {
    id: record.id,
    severity: record.severity,
    category: record.category,
    file: record.file,
    line: record.line,
    title: record.title,
    description: record.description,
    evidence: [...record.evidence],
    rule: record.rule,
    confidence: record.confidence,
    ...(record.tips !== undefined ? { tips: record.tips } : {}),
  };
}
