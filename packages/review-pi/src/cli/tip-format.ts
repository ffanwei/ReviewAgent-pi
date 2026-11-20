/**
 * 上报 tips 的 Markdown 段落格式化（ADR-0111，B 方案：只改输出面）。
 *
 * 模型经常把 `[缺陷类型]` / 影响评估 / `[重构思路]` / 代码示例写在同一行，
 * 平台渲染时整条意见挤成一段。本模块只做**确定性断段**：
 *
 * - `review`：`影响评估` 前没有换行时补一个空行（Markdown 段落分隔）；
 * - `suggestion`：`代码示例` 前没有换行时补一个空行；`代码示例：` 后面同一行
 *   还有内容时，把内容移到下一行（代码示例不跟标签挤在同一行）；
 * - 已有换行的文本原样保留；不增删任何文字、不改 `code`、不改其他字段；
 * - 幂等：重复调用不会叠加空行。
 *
 * 放在 CLI 输出层而不是候选归一化层：不改变 Phase 5 / Phase 6 的请求字节，
 * 只影响 `mrReviewResult` 与 `reviews_tips_zh.json` 的最终文本。
 */

const REVIEW_ASSESSMENT = /(?:\[影响评估\]|影响评估\s*[:：])/u;
const SUGGESTION_EXAMPLE = /(?:\[代码示例\]|代码示例\s*[:：])/u;

/** 在标签前确保一个 Markdown 段落分隔；已有换行则不动 */
function ensureParagraphBefore(text: string, label: RegExp): string {
  const trimmed = text.trim();
  const match = label.exec(trimmed);
  if (match === null || match.index <= 0) {
    return trimmed;
  }
  const before = trimmed.slice(0, match.index);
  if (/\n[ \t]*$/u.test(before)) {
    return trimmed;
  }
  return `${before.replace(/[ \t]+$/u, "")}\n\n${trimmed.slice(match.index)}`;
}

/** 标签后同一行还有内容时换到下一行（fenced code block 因此能从行首开始） */
function ensureLineAfterLabel(text: string, label: RegExp): string {
  const match = label.exec(text);
  if (match === null) {
    return text;
  }
  const afterIndex = match.index + match[0].length;
  const after = text.slice(afterIndex);
  if (/^\s*\n/u.test(after)) {
    return text;
  }
  const content = after.replace(/^[ \t]+/u, "");
  if (content === "") {
    return text;
  }
  return `${text.slice(0, afterIndex)}\n${content}`;
}

/** 意见正文：`[缺陷类型] …` 与 `影响评估 …` 分段 */
export function formatTipReview(text: string): string {
  return ensureParagraphBefore(text, REVIEW_ASSESSMENT);
}

/** 修改建议：`[重构思路] …` 与 `代码示例` 分段，且代码示例另起一行 */
export function formatTipSuggestion(text: string): string {
  return ensureLineAfterLabel(
    ensureParagraphBefore(text, SUGGESTION_EXAMPLE),
    SUGGESTION_EXAMPLE,
  );
}
