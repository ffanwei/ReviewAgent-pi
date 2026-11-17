// MR 初始 user 消息构造。消息骨架与空白语义由 src/loop/messages.test.ts 把守；
// 不再与 DSH 历史审计记录逐字节对照（ADR-0038）。
export function buildInitialUserMessage(
  caseId: string,
  issueDescription: string,
  diff: string,
  extraSection?: string,
): string {
  // DSH 线语义：判空看 trim，注入看原文（前后空白保留）。
  const description = issueDescription.trim().length > 0 ? issueDescription : "(none)";
  const message = [
    "Merge request under review.",
    "",
    `Case ID: ${caseId}`,
    "Issue description:",
    description,
    "",
    "Unified diff:",
    "```diff",
    diff,
    "```",
  ].join("\n");
  // 额外检视清单（skill 包等）：缺席 / 纯空白时逐字节保持原消息。
  return extraSection === undefined || extraSection.trim().length === 0
    ? message
    : `${message}\n\n${extraSection}`;
}
