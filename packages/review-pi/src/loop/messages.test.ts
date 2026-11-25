import { expect, test } from "vitest";
import { buildInitialUserMessage, buildRepoInitialUserMessage } from "./messages.js";

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

test("extraSection 缺席 / 纯空白时保持原消息逐字节不变", () => {
  const base = buildInitialUserMessage("X-1", "", "+ a\n");
  expect(buildInitialUserMessage("X-1", "", "+ a\n", undefined)).toBe(base);
  expect(buildInitialUserMessage("X-1", "", "+ a\n", "")).toBe(base);
  expect(buildInitialUserMessage("X-1", "", "+ a\n", "  \n\t")).toBe(base);
});

test("extraSection 非空时追加在 diff 围栏之后", () => {
  const message = buildInitialUserMessage("X-1", "", "+ a\n", "## Skill 包检视");
  expect(message.endsWith("```\n\n## Skill 包检视")).toBe(true);
  expect(message.indexOf("## Skill 包检视")).toBeGreaterThan(message.indexOf("```diff"));
});

test("repo 模式初始消息：中性文件快照，不出现 MR / diff 头", () => {
  const message = buildRepoInitialUserMessage("R-1", "", [
    { path: "src/a.ts", content: "export const a = 1;" },
    { path: "src/b.ts", content: "export const b = 2;" },
  ]);
  expect(message).toContain("Repository snapshot under review.");
  expect(message).toContain("=== src/a.ts ===\nexport const a = 1;");
  expect(message).toContain("=== src/b.ts ===\nexport const b = 2;");
  expect(message).toContain("Files (2):");
  expect(message).not.toContain("Merge request");
  expect(message).not.toContain("Unified diff");
  expect(message).not.toContain("new file mode");
  expect(message).not.toContain("--- /dev/null");
});

test("repo 模式：issue 空值回落 (none)，extraSection 追加在文件快照之后", () => {
  const message = buildRepoInitialUserMessage(
    "R-1",
    "   ",
    [{ path: "a.ts", content: "a" }],
    "## 规则包",
  );
  expect(message).toContain("Issue description:\n(none)");
  expect(message.endsWith("a\n\n## 规则包")).toBe(true);
});
