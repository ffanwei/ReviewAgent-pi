import { expect, test } from "vitest";
import type { AuditFileContent } from "../audit/audit-writer.js";
import type { Finding } from "../contracts/finding.js";
import { renderReviewOutcome } from "./render.js";

// CLI 结果呈现契约（#7 P3b）：review 命令的整个 stdout = 单个 JSON 文档
// （机器可读、进程烟测锁形状）。形状对齐 DSH 线 render.ts 的域内呈现面：
// ok 包络 + 审计顶层摘要 + auditPath，2 空格缩进 + 尾随换行。
// 字段集经 Pick<AuditFileContent> 锚定——审计字段漂移即编译错，不靠手抄对齐。

/** 形状锚定：呈现面字段必须是 AuditFileContent 的真子集（编译期锁） */
const ANCHOR: Pick<
  AuditFileContent,
  "caseId" | "runId" | "truncated" | "rounds" | "toolCalls" | "findings"
> = {
  caseId: "VUL4J-1",
  runId: "20260920T000000.000-VUL4J-1",
  truncated: false,
  rounds: 1,
  toolCalls: 0,
  findings: [],
};

test("renderReviewOutcome：ok 包络 + 字段集 + 2 空格缩进 + 尾随换行", () => {
  const text = renderReviewOutcome({ ...ANCHOR, auditPath: "runs/x/audit.json" });
  expect(text).toBe(
    `${JSON.stringify(
      {
        ok: true,
        caseId: "VUL4J-1",
        runId: "20260920T000000.000-VUL4J-1",
        truncated: false,
        rounds: 1,
        toolCalls: 0,
        findings: [],
        auditPath: "runs/x/audit.json",
      },
      null,
      2,
    )}\n`,
  );
  // 单 JSON 文档契约：恰好一个可解析文档（首尾无多余内容）
  expect(text.trimStart().startsWith("{")).toBe(true);
  expect(JSON.parse(text)).toEqual({
    ok: true,
    ...ANCHOR,
    auditPath: "runs/x/audit.json",
  });
});

test("renderReviewOutcome：truncated=true 形态（截断路径退出码 0，JSON 携带截断信号）", () => {
  const findings: readonly Finding[] = [];
  const text = renderReviewOutcome({
    caseId: "CASE-9",
    runId: "run-9",
    truncated: true,
    rounds: 5,
    toolCalls: 0,
    findings,
    auditPath: "runs/y/audit.json",
  });
  const parsed = JSON.parse(text) as { ok: boolean; truncated: boolean; rounds: number };
  expect(parsed.ok).toBe(true);
  expect(parsed.truncated).toBe(true);
  expect(parsed.rounds).toBe(5);
});
