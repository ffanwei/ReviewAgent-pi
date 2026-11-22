// 证据接地（F-04，P0-4）：把 evidence 从「非空字符串」升级为可机器核对的代码锚点。
//
// 口径（历史数据校准，见 issues/F-04-evidence-grounding/discussion.md）：
// - 接地基准是 **head 侧完整文件**，不是只看 diff hunk：模型会引用 diff 之外
//   的上下文，hunk 内匹配会大量误杀。
// - 只要求**至少一条** evidence 能定位；整段逐字命中在历史 v3 只有 2.5%，
//   因此支持多行 / 分号 / 省略号 / 中文追加的拆分与窗口匹配。
// - 纯中文描述不算代码证据；没有可解析代码片段 = `unverified`。
// - 文件读不到 / side 非 head = `unverifiable`，由调用方 fail-open。
import type { Finding } from "../contracts/finding.js";

export type EvidenceGroundingStatus = "grounded" | "unverified" | "unverifiable";

export interface EvidenceGroundingResult {
  readonly status: EvidenceGroundingStatus;
  /** evidence 数组长度（不是拆分后的代码片段数） */
  readonly checkedEntries: number;
  /** 命中的 evidence 条数 */
  readonly matchedEntries: number;
}

/** `path:line — code` / `path:line-range - code` 的引用前缀 */
const EVIDENCE_REFERENCE = /^(.*?):\d+(?:-\d+)?\s+(?:—|–|-)\s+(.+)$/s;

/** 至少 8 个字符且包含代码信号，才当作可核对代码；纯中文描述跳过 */
function looksLikeCode(text: string): boolean {
  if (text.length < 8) {
    return false;
  }
  return /[(){}\[\]=<>+\-*/&|!?:;]/.test(text) || /[A-Za-z_]\w*\s*\(/.test(text);
}

function normalize(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

/** 把一条 evidence 拆成候选代码片段：保留原文，不做语义改写 */
export function evidenceCodeSegments(entry: string): readonly string[] {
  const reference = EVIDENCE_REFERENCE.exec(entry.trim());
  const body = reference?.[2] ?? entry;
  return body
    .split(/\r?\n|;|\.{3,}|…/)
    .map((segment) => segment.replace(/^[\s`"'*\-•]+/, "").replace(/[\s`"']+$/, ""))
    .map(normalize)
    .filter((segment) => looksLikeCode(segment));
}

/**
 * 判定一个候选的 evidence 是否至少有一条能在 `fileText` 中定位。
 *
 * - `fileText === null`：不可核对，调用方应 fail-open；
 * - 无代码片段 / 有片段但都不命中：`unverified`；
 * - 命中：`grounded`。
 */
export function groundFindingEvidence(
  candidate: Pick<Finding, "evidence"> | { readonly evidence?: unknown },
  fileText: string | null,
  minMatchChars: number,
): EvidenceGroundingResult {
  const evidence = Array.isArray((candidate as { evidence?: unknown }).evidence)
    ? ((candidate as { evidence: readonly unknown[] }).evidence)
    : [];
  const entries = evidence.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
  if (fileText === null) {
    return { status: "unverifiable", checkedEntries: entries.length, matchedEntries: 0 };
  }
  const normalizedFile = normalize(fileText);
  const windowSize = Math.max(8, Math.min(200, Math.floor(minMatchChars)));
  let matchedEntries = 0;
  for (const entry of entries) {
    const segments = evidenceCodeSegments(entry);
    const matched = segments.some((segment) => {
      if (segment.length <= windowSize) {
        return normalizedFile.includes(segment);
      }
      // 长片段允许“前缀窗口”命中：模型常在代码后追加中文解释或把多行拼成一段。
      return normalizedFile.includes(segment.slice(0, windowSize));
    });
    if (matched) {
      matchedEntries += 1;
    }
  }
  return {
    status: matchedEntries > 0 ? "grounded" : "unverified",
    checkedEntries: entries.length,
    matchedEntries,
  };
}
