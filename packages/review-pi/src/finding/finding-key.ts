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

/**
 * 同根因定位键（跨入口单源）：同文件、同 category、行号相差不超过
 * ±5 行，并且标题高相似（字符二元组 Jaccard ≥ 0.5）或 rule 相同。
 *
 * 「候选门跨轮去重」与「skill 候选预合并」共用本模块，保证两处对
 * 「同一缺陷」的判定不会各说各话。只用位置会把同位置的另一个独立缺陷
 * 一起吞掉（实测 `filament` 误杀），所以必须叠加 category + rule/标题相似度。
 */
export const ROOT_CAUSE_WINDOW_LINES = 5;
export const ROOT_CAUSE_TITLE_SIMILARITY = 0.5;

export type RootCauseCandidate = Pick<
  Finding,
  "file" | "line" | "category" | "rule" | "title"
>;

function normalizeRootFile(file: string): string {
  return file.replace(/\\/g, "/").trim().replace(/^\.\//, "").toLowerCase();
}

function rootCauseKey(located: RootCauseCandidate): string {
  return [
    normalizeRootFile(located.file),
    located.category.trim().toLowerCase(),
    String(located.line),
    encodeURIComponent(located.rule.trim().toLowerCase()),
    encodeURIComponent(located.title),
  ].join("\u0000");
}

/** 把一条候选登记进同根因桶；桶内保留 rule 与标题，供后续精确比较 */
export function addRootCauseKey(target: Set<string>, located: RootCauseCandidate): void {
  target.add(rootCauseKey(located));
}

/** 候选是否命中桶内某条同根因意见（同文件 / 同 category / ±5 行 + rule 或标题相似） */
export function hasRootCauseKey(
  target: ReadonlySet<string>,
  candidate: RootCauseCandidate,
): boolean {
  const file = normalizeRootFile(candidate.file);
  const category = candidate.category.trim().toLowerCase();
  const rule = candidate.rule.trim().toLowerCase();
  for (let delta = -ROOT_CAUSE_WINDOW_LINES; delta <= ROOT_CAUSE_WINDOW_LINES; delta += 1) {
    const linePrefix = `${file}\u0000${category}\u0000${String(candidate.line + delta)}\u0000`;
    for (const entry of target) {
      if (!entry.startsWith(linePrefix)) {
        continue;
      }
      const rest = entry.slice(linePrefix.length);
      const separator = rest.indexOf("\u0000");
      if (separator < 0) {
        continue;
      }
      const emittedRule = decodeURIComponent(rest.slice(0, separator));
      const emittedTitle = decodeURIComponent(rest.slice(separator + 1));
      if (rule.length > 0 && emittedRule === rule) {
        return true;
      }
      if (titleSimilarity(candidate.title, emittedTitle) >= ROOT_CAUSE_TITLE_SIMILARITY) {
        return true;
      }
    }
  }
  return false;
}

/** 标题归一化：大小写、空白与标点/符号不计入相似度 */
function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, "");
}

/** 字符二元组集合；单字符标题退化为字符集合 */
function titleBigrams(text: string): ReadonlySet<string> {
  const chars = [...text];
  if (chars.length <= 1) {
    return new Set(chars);
  }
  const grams = new Set<string>();
  for (let index = 0; index < chars.length - 1; index += 1) {
    grams.add(`${chars[index] ?? ""}${chars[index + 1] ?? ""}`);
  }
  return grams;
}

/** 标题相似度：字符二元组 Jaccard；完全相同返回 1，空标题返回 0 */
function titleSimilarity(left: string, right: string): number {
  const a = normalizeTitle(left);
  const b = normalizeTitle(right);
  if (a.length === 0 || b.length === 0) {
    return 0;
  }
  if (a === b) {
    return 1;
  }
  const leftGrams = titleBigrams(a);
  const rightGrams = titleBigrams(b);
  let intersection = 0;
  for (const gram of leftGrams) {
    if (rightGrams.has(gram)) {
      intersection += 1;
    }
  }
  const union = leftGrams.size + rightGrams.size - intersection;
  return union === 0 ? 0 : intersection / union;
}
