import { expect, test } from "vitest";

import type { Finding } from "../contracts/finding.js";
import { findingMergeKey } from "../run/findings-merge.js";
import type { ReviewTipsDocumentLike } from "./presentation-projection.js";
import type { SemanticTipEntry } from "./report-payload.js";
import { assembleUnifiedTips, countTips, withUnifiedKeys } from "./unified-tips.js";

// 统一 tips 组装（ADR-0045）：语义登记按合并键 join 回 merged findings，
// 12 键（10 键 + id + level，只增不删）；(file,line) 去重沿用 ADR-0023。

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    severity: "P1",
    category: "SECURITY",
    file: "src/Foo.java",
    line: 42,
    title: "Unsafe redirect",
    description: "User input flows into a redirect target.",
    evidence: ["src/Foo.java:42 redirect(target);"],
    rule: "",
    confidence: 0.9,
    ...overrides,
  };
}

function entry(overrides: Partial<SemanticTipEntry> = {}): SemanticTipEntry {
  return {
    review: "[安全] 未校验的重定向。影响评估：钓鱼跳转。",
    suggestion: "[重构思路] 白名单校验。代码示例：```…```",
    category: "安全",
    subcategory: "URL 注入",
    source: "common-reviewer",
    ruleId: "",
    ...overrides,
  };
}

function semanticMap(
  findings: readonly Finding[],
  entries: readonly (SemanticTipEntry | undefined)[],
): Map<string, SemanticTipEntry> {
  const map = new Map<string, SemanticTipEntry>();
  findings.forEach((item, index) => {
    const value = entries[index];
    if (value !== undefined) {
      map.set(findingMergeKey(item), value);
    }
  });
  return map;
}

test("12 键形态：10 键全保留 + id + level；severity 三档与 level 四档并存", async () => {
  const merged = [finding()];
  const outcome = assembleUnifiedTips({
    mergedFindings: merged,
    semanticByMergeKey: semanticMap(merged, [entry()]),
    codeByFinding: { F001: "redirect(target);" },
  });

  expect(outcome.uncovered).toEqual([]);
  expect(outcome.tips).toHaveLength(1);
  const tip = outcome.tips[0]?.reviewTips[0];
  expect(tip).toEqual({
    id: "F001",
    code: "redirect(target);",
    review: "[安全] 未校验的重定向。影响评估：钓鱼跳转。",
    suggestion: "[重构思路] 白名单校验。代码示例：```…```",
    category: "安全",
    subcategory: "URL 注入",
    severity: "Major", // P1 → 三档 Major（ADR-0017 单源）
    level: "Major", // P1 → 四档 Major（Q18）
    ruleId: "",
    lineNum: 42,
    source: "common-reviewer",
    confidence: "High", // 0.9 ≥ 0.8
  });
  // 键序（只增不删的形态锚定）：id 在首、level 紧随 severity
  expect(Object.keys(tip ?? {})).toEqual([
    "id",
    "code",
    "review",
    "suggestion",
    "category",
    "subcategory",
    "severity",
    "level",
    "ruleId",
    "lineNum",
    "source",
    "confidence",
  ]);
});

test("P3 双档分叉：tips severity=Minor（ADR-0017 折叠）与 level=Suggestion（Q18 四档）", async () => {
  const merged = [finding({ severity: "P3", confidence: 0.3 })];
  const outcome = assembleUnifiedTips({
    mergedFindings: merged,
    semanticByMergeKey: semanticMap(merged, [entry()]),
    codeByFinding: {},
  });
  const tip = outcome.tips[0]?.reviewTips[0];
  expect(tip?.severity).toBe("Minor");
  expect(tip?.level).toBe("Suggestion");
  expect(tip?.confidence).toBe("Low");
  expect(tip?.code).toBe(""); // code 允许空串（ADR-0017 老契约——与报文的差异点）
});

test("未覆盖的 merged finding：uncovered 留痕、缺席 tips（Q26b 尽力而为）", async () => {
  const merged = [finding(), finding({ id: "F002", file: "src/Bar.java", line: 7 })];
  const outcome = assembleUnifiedTips({
    mergedFindings: merged,
    semanticByMergeKey: semanticMap(merged, [entry(), undefined]),
    codeByFinding: {},
  });
  expect(outcome.tips).toHaveLength(1);
  expect(outcome.tips[0]?.filePath).toBe("src/Foo.java");
  expect(outcome.uncovered).toEqual(["src/Bar.java:7 (F002)"]);
  expect(countTips(outcome.tips)).toBe(1);
});

test("同文件同 line 去重只留首条（ADR-0023）；被去重者不算 uncovered", async () => {
  const merged = [
    finding({ line: 10 }),
    finding({ id: "F002", line: 10, title: "another view of the same line" }),
    finding({ id: "F003", line: 20 }),
  ];
  const outcome = assembleUnifiedTips({
    mergedFindings: merged,
    // F002 无条目——它被去重丢弃，不产生 uncovered
    semanticByMergeKey: semanticMap(merged, [entry(), undefined, entry()]),
    codeByFinding: {},
  });
  const tips = outcome.tips[0]?.reviewTips ?? [];
  expect(tips.map((tip) => tip.lineNum)).toEqual([10, 20]);
  expect(tips.map((tip) => tip.id)).toEqual(["F001", "F003"]);
  expect(outcome.uncovered).toEqual([]);
});

test("合并键 join：跨片重复条目（同 file/line/title）共享一条语义登记", async () => {
  // 片内 finding 与 merged finding 的 id 不同（聚合重编号），但合并键一致
  const shardFinding = finding({ id: "RULE-CHECK@sample@src/Foo.java:42", rule: "sample-rule" });
  const merged = [finding({ id: "F007" })];
  const map = new Map<string, SemanticTipEntry>([
    [
      findingMergeKey(shardFinding),
      entry({ source: "rule-reviewer", ruleId: "sample-rule" }),
    ],
  ]);
  const outcome = assembleUnifiedTips({
    mergedFindings: merged,
    semanticByMergeKey: map,
    codeByFinding: {},
  });
  const tip = outcome.tips[0]?.reviewTips[0];
  expect(tip?.id).toBe("F007"); // id 来自 merged finding
  expect(tip?.source).toBe("rule-reviewer"); // source/ruleId 来自片级登记（重编号后无法重推）
  expect(tip?.ruleId).toBe("sample-rule");
});

test("零 findings：空文档（[]，「没发现问题」本身是结论）；零覆盖同理", async () => {
  const empty = assembleUnifiedTips({
    mergedFindings: [],
    semanticByMergeKey: new Map(),
    codeByFinding: {},
  });
  expect(empty.tips).toEqual([]);
  expect(empty.uncovered).toEqual([]);
  expect(countTips(empty.tips)).toBe(0);
});

test("withUnifiedKeys：engine 回落的 10 键 tips 注入 id/level（按 file+line join）", async () => {
  const merged = [
    finding({ id: "F001" }),
    finding({ id: "F002", file: "src/Bar.java", line: 7, severity: "P3" }),
  ];
  const engineTips: ReviewTipsDocumentLike = [
    {
      filePath: "src/Foo.java",
      reviewTips: [
        {
          code: "x",
          review: "r",
          suggestion: "s",
          category: "安全",
          subcategory: "u",
          severity: "Major",
          ruleId: "",
          lineNum: 42,
          source: "common-reviewer",
          confidence: "High",
        },
      ],
    },
    {
      filePath: "src/Bar.java",
      reviewTips: [
        {
          code: "y",
          review: "r2",
          suggestion: "s2",
          category: "可靠性",
          subcategory: "u2",
          severity: "Minor",
          ruleId: "",
          lineNum: 7,
          source: "common-reviewer",
          confidence: "Low",
        },
      ],
    },
  ];
  const augmented = withUnifiedKeys(engineTips, merged);
  expect(augmented[0]?.reviewTips[0]).toMatchObject({ id: "F001", level: "Major" });
  expect(augmented[1]?.reviewTips[0]).toMatchObject({ id: "F002", level: "Suggestion" });
  // 原 10 键全保留（只增不删）
  expect(Object.keys(augmented[0]?.reviewTips[0] ?? {})).toContain("confidence");
});
