// MR 初始 user 消息构造（测量常量面：消息格式与 DSH 线逐字节一致）。
//
// 字节真源：DSH 线 t-series requests[0].messages[2]
// （testdata/golden/mr-message-vul4j-1.txt），由 src/loop/messages.test.ts 断言。
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
