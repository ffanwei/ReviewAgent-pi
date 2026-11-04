import type { Finding } from "../contracts/finding.js";

/**
 * 大 MR 第二期：分片 findings 的确定性合并（ADR-0039 决策 5）。
 *
 * 纯函数，只做规则合并，不做模糊聚类、不做跨文件合并、不做 LLM 二次裁决：
 *
 * - 去重键 `(normalize(file), line, normalize(title))`；
 * - 严重度 / confidence 取最高；evidence 并集（保序去重）；
 * - description 取 confidence 最高者（并列取更长）；title / category / rule
 *   取 confidence 最高者（并列取首次出现）；
 * - `id` 合并后按最终顺序重编号 `F001…`（每片都从 F001 起，直接合并必撞）；
 * - 排序 = 文件首次出现顺序 → 行号升序 → 严重度降序 → title。
 *
 * 纪律：宁可保留同文件相邻行的两条，也不要误合并——漏报比多报贵得多。
 */

const SEVERITY_RANK: Readonly<Record<Finding["severity"], number>> = {
  P0: 0,
  P1: 1,
  P2: 2,
  P3: 3,
};

/** 合并键用的归一化：trim + 空白折叠 + 小写（不改变展示原文） */
export function normalizeFindingKeyPart(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 一条 finding 的合并键 */
export function findingMergeKey(finding: Finding): string {
  return `${normalizeFindingKeyPart(finding.file)}\u0000${String(finding.line)}\u0000${normalizeFindingKeyPart(finding.title)}`;
}

/**
 * 合并分片 findings。
 *
 * @param shardFindings 按 shard 顺序排列的片内 findings（每片内部保持模型输出顺序）
 */
export function mergeShardFindings(shardFindings: readonly (readonly Finding[])[]): readonly Finding[] {
  const groups = new Map<string, Finding[]>();
  for (const findings of shardFindings) {
    for (const finding of findings) {
      const key = findingMergeKey(finding);
      const bucket = groups.get(key);
      if (bucket === undefined) {
        groups.set(key, [finding]);
      } else {
        bucket.push(finding);
      }
    }
  }

  const merged = [...groups.values()].map(mergeBucket);
  const fileOrder = new Map<string, number>();
  for (const finding of merged) {
    const file = normalizeFindingKeyPart(finding.file);
    if (!fileOrder.has(file)) {
      fileOrder.set(file, fileOrder.size);
    }
  }

  merged.sort((left, right) => {
    const byFile = (fileOrder.get(normalizeFindingKeyPart(left.file)) ?? 0) - (fileOrder.get(normalizeFindingKeyPart(right.file)) ?? 0);
    if (byFile !== 0) {
      return byFile;
    }
    if (left.line !== right.line) {
      return left.line - right.line;
    }
    const bySeverity = SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity];
    if (bySeverity !== 0) {
      return bySeverity;
    }
    if (left.title === right.title) {
      return 0;
    }
    return left.title < right.title ? -1 : 1;
  });

  return merged.map((finding, index) => ({
    ...finding,
    id: `F${String(index + 1).padStart(3, "0")}`,
  }));
}

function mergeBucket(bucket: readonly Finding[]): Finding {
  const representative = bucket.reduce((best, current) =>
    current.confidence > best.confidence ? current : best,
  );
  const topConfidence = representative.confidence;
  const description = bucket
    .filter((finding) => finding.confidence === topConfidence)
    .reduce((longest, current) => (current.description.length > longest.description.length ? current : longest))
    .description;

  let severity = representative.severity;
  const evidence: string[] = [];
  const seenEvidence = new Set<string>();
  for (const finding of bucket) {
    if (SEVERITY_RANK[finding.severity] < SEVERITY_RANK[severity]) {
      severity = finding.severity;
    }
    for (const item of finding.evidence) {
      if (!seenEvidence.has(item)) {
        seenEvidence.add(item);
        evidence.push(item);
      }
    }
  }

  return {
    id: representative.id,
    severity,
    category: representative.category,
    file: representative.file,
    line: representative.line,
    title: representative.title,
    description,
    evidence,
    rule: representative.rule,
    confidence: topConfidence,
  };
}
