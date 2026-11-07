// 候选拦截链（测量常量面：六阶段语义的 Evidence Gate 部分）。
// "No Evidence, No Finding"：SCHEMA_INVALID → NON_ENGLISH → NO_EVIDENCE
// → VERIFICATION_FAILED → DUPLICATE_ID，每候选至多留痕一条（首个失败阶段）。
//
// 跨轮去重口径（P1）：**按内容键** `(normalize(file), line, normalize(title))`
// 判重，不按模型给的 `id`。模型每轮都可能从 F001 重新编号，id 复用不代表
// 同一问题；只有内容相同才丢弃。
import type { Finding } from "../contracts/finding.js";
import type { CandidateRejection } from "../contracts/run.js";
import { findingContentKey } from "../finding/finding-key.js";
import { validateFinding } from "../finding/finding-schema.js";
import type { VerificationVerdict } from "../loop/parse.js";

export interface GateInput {
  /** Deep Reasoning 阶段产出的原始候选对象 */
  readonly candidates: readonly unknown[];
  /** Evidence Verification 阶段的裁决（按候选 id 索引） */
  readonly verdicts: ReadonlyMap<string, VerificationVerdict>;
  /** 已产出的 Finding id 集合（跨轮去重；不会被本函数修改） */
  readonly emittedIds: ReadonlySet<string>;
  /** 已产出 Finding 的内容键集合（跨轮去重的真实依据；不会被本函数修改） */
  readonly emittedContentKeys?: ReadonlySet<string>;
  readonly round: number;
}

export interface GateOutput {
  readonly findings: readonly Finding[];
  readonly rejections: readonly CandidateRejection[];
  readonly emittedIds: ReadonlySet<string>;
  readonly emittedContentKeys: ReadonlySet<string>;
}

export function applyCandidateGate(input: GateInput): GateOutput {
  const findings: Finding[] = [];
  const rejections: CandidateRejection[] = [];
  const emittedIds = new Set(input.emittedIds);
  const emittedContentKeys = new Set(input.emittedContentKeys ?? []);
  const resolvedVerdicts = resolveVerdicts(input.candidates, input.verdicts, input.round);

  input.candidates.forEach((candidate, index) => {
    const candidateId = readCandidateId(candidate, input.round, index);
    const rejection = firstFailingStage(
      candidate,
      candidateId,
      resolvedVerdicts[index],
      emittedContentKeys,
    );
    if (rejection !== undefined) {
      rejections.push(rejection);
      return;
    }
    const finding = toFinding(candidate);
    findings.push(finding);
    emittedIds.add(candidateId);
    emittedContentKeys.add(findingContentKey(finding));
  });

  return { findings, rejections, emittedIds, emittedContentKeys };
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
): CandidateRejection | undefined {
  const schemaErrors = validateFinding(candidate);
  if (schemaErrors.length > 0) {
    return { candidateId, stage: "SCHEMA_INVALID", reason: schemaErrors.join("; ") };
  }
  if (containsNonEnglish(candidate)) {
    return { candidateId, stage: "NON_ENGLISH", reason: "finding text must be English only" };
  }
  if (!hasEvidence(candidate)) {
    return { candidateId, stage: "NO_EVIDENCE", reason: "no evidence cited (No Evidence, No Finding)" };
  }
  if (verdict === undefined) {
    return { candidateId, stage: "VERIFICATION_FAILED", reason: "no verification verdict for candidate" };
  }
  if (!verdict.pass) {
    const detail = verdict.reason.length > 0 ? `: ${verdict.reason}` : "";
    return {
      candidateId,
      stage: "VERIFICATION_FAILED",
      reason: `evidence verification rejected the candidate${detail}`,
    };
  }
  const contentKey = findingContentKey(candidate as { file: string; line: number; title: string });
  if (emittedContentKeys.has(contentKey)) {
    return {
      candidateId,
      stage: "DUPLICATE_ID",
      reason: "a finding with the same (file, line, title) was already emitted in an earlier round",
    };
  }
  return undefined;
}

/** 检查候选文本字段是否含 CJK 字符（输出全英文纪律） */
const CJK_PATTERN = /[㐀-䶿一-鿿豈-﫿　-〿＀-￯]/;

function containsNonEnglish(candidate: unknown): boolean {
  const record = candidate as Record<string, unknown>;
  const evidence = Array.isArray(record.evidence) ? record.evidence : [];
  const texts = [record.title, record.description, ...evidence];
  return texts.some((text) => typeof text === "string" && CJK_PATTERN.test(text));
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
  };
}
