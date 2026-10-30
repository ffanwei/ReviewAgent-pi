import { describe, expect, it } from "vitest";

import type { Finding } from "../../src/instrument/contracts/finding.js";
import {
  buildReviewTipsDocument,
  confidenceOf,
  reviewOf,
  ruleIdOf,
  severityOf,
  sourceOf,
  type ReviewTip,
} from "../../src/presentation/tips.js";

/**
 * 分组式检视意见映射层单测（ADR-0017）：纯函数、零网络零文件系统。
 *
 * 锁定面 = ADR-0017 §字段映射表逐行：
 * - severity 三档（P3 折 Minor，不丢条）、confidence 三档（0.8 / 0.5 边界）；
 * - source 结构性判定（RULE-CHECK@ 前缀）、ruleId 白名单、subcategory 恒空串；
 * - code / suggestion 缺席即空串（绝不编）；
 * - files 首见序 + reviewTips 按 lineNum 升序（同文件同行去重，留首条——ADR-0023）；
 * - 零 finding ⇒ 照产 `{ files: [] }`；
 * - 单条 tip 的键集严格 10 个、顺序固定（对外契约）。
 */

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    severity: "P1",
    category: "CORRECTNESS",
    file: "src/main/java/Foo.java",
    line: 42,
    title: "Null dereference",
    description: "The value may be null.",
    evidence: ["Foo.java:42"],
    rule: "CORRECTNESS-001",
    confidence: 0.7,
    ...overrides,
  };
}

describe("severityOf", () => {
  it("四档映射到三档，P3 折进 Minor（不丢条）", () => {
    expect(severityOf("P0")).toBe("Fatal");
    expect(severityOf("P1")).toBe("Major");
    expect(severityOf("P2")).toBe("Minor");
    expect(severityOf("P3")).toBe("Minor");
  });
});

describe("confidenceOf", () => {
  it("边界：0.8 High、0.5 Medium、其余 Low", () => {
    expect(confidenceOf(1)).toBe("High");
    expect(confidenceOf(0.8)).toBe("High");
    expect(confidenceOf(0.79)).toBe("Medium");
    expect(confidenceOf(0.5)).toBe("Medium");
    expect(confidenceOf(0.49)).toBe("Low");
    expect(confidenceOf(0)).toBe("Low");
  });

  it("非有限数按 Low（不编高置信）", () => {
    expect(confidenceOf(Number.NaN)).toBe("Low");
    expect(confidenceOf(Number.POSITIVE_INFINITY)).toBe("Low");
  });
});

describe("sourceOf", () => {
  it("规则会话候选 id 前缀 => rule-reviewer，其余 => common-reviewer", () => {
    expect(sourceOf("RULE-CHECK@general-code-review@src/Foo.java:167")).toBe("rule-reviewer");
    expect(sourceOf("F001")).toBe("common-reviewer");
    expect(sourceOf("RULE-CHECKED")).toBe("common-reviewer");
  });
});

describe("ruleIdOf", () => {
  it("只有落在白名单里的真规则 id 才填", () => {
    const known = new Set(["GEN-SQL-001"]);
    expect(ruleIdOf(finding({ rule: "GEN-SQL-001" }), known)).toBe("GEN-SQL-001");
    expect(ruleIdOf(finding({ rule: "general-code-review" }), known)).toBe("");
    expect(ruleIdOf(finding({ rule: "CORRECTNESS-001" }), known)).toBe("");
  });
});

describe("reviewOf", () => {
  it("title + 「。」 + description；空侧退化", () => {
    expect(reviewOf("标题", "说明")).toBe("标题。说明");
    expect(reviewOf("标题", "")).toBe("标题");
    expect(reviewOf("", "说明")).toBe("说明");
  });
});

describe("buildReviewTipsDocument", () => {
  it("键集严格 10 个且顺序固定（对外契约）", () => {
    const doc = buildReviewTipsDocument({ findings: [finding()] });
    const tip = doc.files[0]?.reviewTips[0];
    expect(tip).toBeDefined();
    expect(Object.keys(tip as ReviewTip)).toEqual([
      "code",
      "review",
      "suggestion",
      "category",
      "subcategory",
      "severity",
      "ruleId",
      "lineNum",
      "source",
      "confidence",
    ]);
  });

  it("code / suggestion 缺席即空串，subcategory 恒空串", () => {
    const doc = buildReviewTipsDocument({ findings: [finding()] });
    const tip = doc.files[0]?.reviewTips[0];
    expect(tip?.code).toBe("");
    expect(tip?.suggestion).toBe("");
    expect(tip?.subcategory).toBe("");
  });

  it("注入的 code / suggestion 按 finding id 落到对应 tip", () => {
    const doc = buildReviewTipsDocument({
      findings: [finding({ id: "F001" }), finding({ id: "F002", line: 7 })],
      codeByFinding: { F002: "int x = y;" },
      suggestions: { F002: "改为 null 检查" },
    });
    const tips = doc.files[0]?.reviewTips ?? [];
    // F002 line 7 排在 F001 line 42 之前（组内按 lineNum 升序）
    expect(tips.map((tip) => tip.code)).toEqual(["int x = y;", ""]);
    expect(tips.map((tip) => tip.suggestion)).toEqual(["改为 null 检查", ""]);
  });

  it("files 按 finding 首见序；reviewTips 按 lineNum 升序", () => {
    const doc = buildReviewTipsDocument({
      findings: [
        finding({ id: "A1", file: "b.java", line: 30 }),
        finding({ id: "A2", file: "a.java", line: 10 }),
        finding({ id: "A3", file: "b.java", line: 5 }),
      ],
    });
    expect(doc.files.map((group) => group.filePath)).toEqual(["b.java", "a.java"]);
    expect(doc.files[0]?.reviewTips.map((tip) => tip.lineNum)).toEqual([5, 30]);
    expect(doc.files[1]?.reviewTips.map((tip) => tip.lineNum)).toEqual([10]);
  });

  it("同文件同 lineNum 多条 → 只留首条（源序），后续忽略（ADR-0023）", () => {
    const doc = buildReviewTipsDocument({
      findings: [
        finding({ id: "F1", line: 30, title: "first", severity: "P0" }),
        finding({ id: "F2", line: 30, title: "second", severity: "P3" }),
        finding({ id: "F3", line: 31, title: "other line" }),
      ],
      codeByFinding: { F1: "int a = b;", F2: "int a = b;", F3: "return c;" },
    });
    const tips = doc.files[0]?.reviewTips ?? [];
    // 输出去重：同行不再出现第二条
    expect(tips.map((tip) => tip.lineNum)).toEqual([30, 31]);
    // 首条 = 源序第一条（含它的 code / severity），不做「取更严重」之类的择优
    expect(tips[0]?.review).toBe("first。The value may be null.");
    expect(tips[0]?.severity).toBe("Fatal");
    expect(tips[0]?.code).toBe("int a = b;");
  });

  it("去重键是 (文件, 行)：不同文件的同号行各自保留", () => {
    const doc = buildReviewTipsDocument({
      findings: [
        finding({ id: "A1", file: "a.java", line: 12, title: "in a" }),
        finding({ id: "B1", file: "b.java", line: 12, title: "in b" }),
      ],
    });
    expect(doc.files.map((group) => group.filePath)).toEqual(["a.java", "b.java"]);
    expect(doc.files.map((group) => group.reviewTips[0]?.lineNum)).toEqual([12, 12]);
  });

  it("只含有意见的文件（空组不落盘）+ 零 finding 照产 { files: [] }", () => {
    expect(buildReviewTipsDocument({ findings: [] })).toEqual({ files: [] });
    const doc = buildReviewTipsDocument({ findings: [finding({ file: "a.java" })] });
    expect(doc.files).toHaveLength(1);
  });

  it("category 原值透传（不做大小写或词表归一）", () => {
    const doc = buildReviewTipsDocument({
      findings: [finding({ category: "ERROR-HANDLING" })],
    });
    expect(doc.files[0]?.reviewTips[0]?.category).toBe("ERROR-HANDLING");
  });
});
