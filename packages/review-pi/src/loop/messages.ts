// MR 初始 user 消息构造。消息骨架与空白语义由 src/loop/messages.test.ts 把守；
// 不再与 DSH 历史审计记录逐字节对照（ADR-0038）。
export function buildInitialUserMessage(
  caseId: string,
  issueDescription: string,
  diff: string,
): string {
  // DSH 线语义：判空看 trim，注入看原文（前后空白保留）。
  const description = issueDescription.trim().length > 0 ? issueDescription : "(none)";
  return [
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
}
