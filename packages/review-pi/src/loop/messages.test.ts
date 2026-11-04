import { expect, test } from "vitest";
import { buildInitialUserMessage } from "./messages.js";

// MR 消息不再对 DSH 审计真源逐字节对照（ADR-0038）。
// 保留的是消息骨架与空白语义（见下面两条）：Case ID 行、issue 空值回落 (none)、
// diff 原样入栏不做 trim 或改写。
test("issue 描述纯空白时回落 (none)，非空时保留原文不 trim", () => {
  // DSH 线语义：issueDescription.trim().length > 0 ? issueDescription : "(none)"
  // —— 判空看 trim，注入看原文（前后空白保留）。
  expect(buildInitialUserMessage("X-1", "   ", "+ a\n")).toContain("Issue description:\n(none)");
  expect(buildInitialUserMessage("X-1", "  fastjson deserialization  ", "+ a\n")).toContain(
    "Issue description:\n  fastjson deserialization  ",
  );
});

test("issue 描述缺省时回落到 (none)", () => {
  expect(buildInitialUserMessage("X-1", "", "+ a\n")).toBe(
    [
      "Merge request under review.",
      "",
      "Case ID: X-1",
      "Issue description:",
      "(none)",
      "",
      "Unified diff:",
      "```diff",
      "+ a\n",
      "```",
    ].join("\n"),
  );
});
