import { expect, test } from "vitest";

import { validateFinding } from "../finding/finding-schema.js";
import {
  normalizeCandidates,
  normalizeCategoryValue,
} from "./candidate-normalize.js";

// 候选确定性归一化（P1 字段合规修复）：只修信封 / 格式字段，
// 绝不补写证据、行号、文件路径。不可用的定位字段原样留给 SCHEMA_INVALID。
// ADR-0090：category 归一到中文七类；tips 块按宽容规则兜底。

const VALID = {
  id: "F001",
  severity: "P1",
  category: "可靠性",
  file: "src/Foo.java",
  line: 42,
  title: "空指针解引用",
  description: "该调用点的返回值可能为 null。",
  evidence: ["src/Foo.java:42 user.getName()"],
  rule: "CORRECTNESS-001",
  confidence: 0.8,
  tips: {
    review: "[缺陷类型] 未判空即解引用。影响评估：抛 NullPointerException。",
    suggestion: "[重构思路] 判空。代码示例：`if (x == null) return;`",
    subcategory: "空指针安全",
  },
};

test("合法候选原样通过，零修复留痕（零漂移）", () => {
  const out = normalizeCandidates({ candidates: [VALID], round: 1 });
  expect(out.candidates).toEqual([VALID]);
  expect(out.records).toEqual([]);
});

test("格式字段归一化：severity 别名 / confidence 百分比 / line 带前缀 / evidence 单串 / 反斜杠路径", () => {
  const out = normalizeCandidates({
    candidates: [
      {
        ...VALID,
        severity: "critical",
        confidence: "82%",
        line: "L147",
        evidence: "src/Foo.java:147 user.getName()",
        file: "src\\Foo.java",
      },
    ],
    round: 2,
  });
  const candidate = out.candidates[0] as Record<string, unknown>;
  expect(candidate.severity).toBe("P0");
  expect(candidate.confidence).toBeCloseTo(0.82);
  expect(candidate.line).toBe(147);
  expect(candidate.evidence).toEqual(["src/Foo.java:147 user.getName()"]);
  expect(candidate.file).toBe("src/Foo.java");
  expect(out.records[0]?.fields).toEqual(
    expect.arrayContaining(["severity", "confidence", "line", "evidence", "file"]),
  );
});

test("缺 id → 位置兜底 id；id 是裁决对齐键，必须可复现", () => {
  const { id: _omit, ...withoutId } = VALID;
  const out = normalizeCandidates({ candidates: [withoutId], round: 3 });
  expect((out.candidates[0] as Record<string, unknown>).id).toBe("round-3-candidate-0");
  expect(out.records[0]?.fields).toContain("id");
});

test("缺 file / line / evidence 不编造：归一化后仍非法，交给 SCHEMA_INVALID", () => {
  const { file: _file, line: _line, evidence: _evidence, ...rest } = VALID;
  const out = normalizeCandidates({ candidates: [rest], round: 1 });
  const candidate = out.candidates[0];
  expect(candidate).not.toHaveProperty("file");
  expect(candidate).not.toHaveProperty("line");
  expect(candidate).not.toHaveProperty("evidence");
  expect(validateFinding(candidate).length).toBeGreaterThan(0);
});

test("缺 category / rule → 保守默认；title / description 互相补齐但不补事实", () => {
  const { category: _category, rule: _rule, description: _description, ...rest } = VALID;
  const out = normalizeCandidates({ candidates: [rest], round: 1 });
  const candidate = out.candidates[0] as Record<string, unknown>;
  expect(candidate.category).toBe("可维护");
  expect(candidate.rule).toBe("GENERAL");
  expect(candidate.description).toBe(VALID.title);
  expect(validateFinding(candidate)).toEqual([]);
});

test("非对象候选原样保留（不伪造对象）", () => {
  const out = normalizeCandidates({ candidates: ["not an object", null, 42], round: 1 });
  expect(out.candidates).toEqual(["not an object", null, 42]);
  expect(out.records).toEqual([]);
});

test("category 归一（ADR-0090）：英文七类映射 → 中文；未识别回落可维护", () => {
  const out = normalizeCandidates({
    candidates: [
      { ...VALID, category: " null-safety " },
      { ...VALID, id: "F002", category: "error handling" },
      { ...VALID, id: "F003", category: "secrets" },
      { ...VALID, id: "F004", category: "input_validation" },
      { ...VALID, id: "F005", category: "resource-exhaustion" },
      { ...VALID, id: "F006", category: "performance" },
      { ...VALID, id: "F007", category: "SOME_UNKNOWN_THING" },
    ],
    round: 1,
  });
  expect(out.candidates.map((entry) => (entry as Record<string, unknown>).category)).toEqual([
    "可靠性",
    "可靠性",
    "安全",
    "安全",
    "性能",
    "性能",
    "可维护",
  ]);
  expect(normalizeCategoryValue("  null-safety ")).toBe("可靠性");
  expect(normalizeCategoryValue("RESOURCE_MANAGEMENT")).toBe("可靠性");
  expect(normalizeCategoryValue("uncategorized")).toBe("可维护");
  expect(normalizeCategoryValue("可读性")).toBe("可读性");
});

test("tips 宽容兜底（ADR-0090）：缺失字段从 finding 派生，不丢候选", () => {
  const { tips: _tips, ...withoutTips } = VALID;
  const out = normalizeCandidates({ candidates: [withoutTips], round: 1 });
  const candidate = out.candidates[0] as Record<string, unknown>;

  expect(candidate.tips).toEqual({
    review: withoutTips.description,
    suggestion: "",
    subcategory: "",
  });
  expect(out.records[0]?.fields).toContain("tips");
});

test("tips 部分非法：仅补缺失字段，合法字段原样", () => {
  const out = normalizeCandidates({
    candidates: [
      {
        ...VALID,
        tips: { review: "  ", suggestion: "保持原样", subcategory: 42 },
      },
    ],
    round: 1,
  });
  const candidate = out.candidates[0] as Record<string, unknown>;
  expect(candidate.tips).toEqual({
    review: VALID.description,
    suggestion: "保持原样",
    subcategory: "",
  });
});
