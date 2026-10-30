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
 * - files 首见序 + reviewTips 按 lineNum 升序（同行稳定）；
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

  it("files 按 finding 首见序；reviewTips 按 lineNum 升序且同行稳定", () => {
    const doc = buildReviewTipsDocument({
      findings: [
        finding({ id: "A1", file: "b.java", line: 30 }),
        finding({ id: "A2", file: "a.java", line: 10 }),
        finding({ id: "A3", file: "b.java", line: 5 }),
        finding({ id: "A4", file: "b.java", line: 30 }),
      ],
    });
    expect(doc.files.map((group) => group.filePath)).toEqual(["b.java", "a.java"]);
    expect(doc.files[0]?.reviewTips.map((tip) => tip.lineNum)).toEqual([5, 30, 30]);
    // 同行稳定：A1 在 A4 之前（源序）
    expect(doc.files[0]?.reviewTips.map((tip) => tip.review)).toEqual([
      "Null dereference。The value may be null.",
      "Null dereference。The value may be null.",
      "Null dereference。The value may be null.",
    ]);
    expect(doc.files[0]?.reviewTips[2]?.lineNum).toBe(30);
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
