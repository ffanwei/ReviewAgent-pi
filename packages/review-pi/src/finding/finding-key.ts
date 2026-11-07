import type { Finding } from "../contracts/finding.js";

/**
 * Finding 内容键（跨入口单源）：`(normalize(file), line, normalize(title))`。
 *
 * 用途与纪律：
 * - 分片合并（`run/findings-merge.ts`）与候选门跨轮去重共用同一口径；
 * - **不用 `id` 当唯一性真源**：模型每轮都可能从 `F001` 重新编号，跨轮复用
 *   同一 id 不代表同一问题；只有内容键相同才视为重复。
 * - 归一化只作用于键，不改变展示原文（trim + 空白折叠 + 小写）。
 */
export function normalizeFindingKeyPart(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 一条 finding / 候选的内容键（只要求定位三字段在场） */
export function findingContentKey(value: {
  readonly file: string;
  readonly line: number;
  readonly title: string;
}): string {
  return `${normalizeFindingKeyPart(value.file)}\u0000${String(value.line)}\u0000${normalizeFindingKeyPart(value.title)}`;
}

/** `Finding` 的合并键（分片合并历史入口名保留） */
export function findingMergeKey(finding: Finding): string {
  return findingContentKey(finding);
}
