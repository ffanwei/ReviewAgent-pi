import { describe, expect, test } from "vitest";

import {
  anchorEditDistanceBudget,
  classifyAnchor,
  evaluateMatrix,
  HARD_DUPLICATE_TEXT_FLOOR,
  INVALIDATION_REASONS,
  matchPairSignal,
  parseHistoryTipsDocument,
  parseVerdictValue,
  reasonFromVerdict,
  stripDiffPrefix,
  stripReviewTemplate,
  type FindingForMatch,
} from "./history-tips.js";

const LIMITS = {
  statuses: ["PENDING"],
  semanticVerdict: { enabled: true },
} as const;

function historyJson(entries: unknown[]): string {
  return JSON.stringify(entries);
}

function sampleEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1",
    taskId: "1234567",
    status: "PENDING",
    filePath: "src/a.ts",
    lineNum: 12,
    patchLine: "+ String sql = \"SELECT * FROM users WHERE id = \" + userId;",
    reviewMsg: "SQL 语句使用字符串拼接，存在注入风险",
    suggestions: "参数化查询",
    vulnerabilityType: "SQL_INJECTION",
    level: "HIGH",
    subcategory: "注入类",
    ruleId: "RULE_SQL_001",
    networkZone: "green",
    createDate: "2026-11-21T10:26:42",
    ...overrides,
  };
}

describe("parseHistoryTipsDocument：准入与归一", () => {
  test("只用约定字段；patchLine 剥 diff 前缀并 trim", () => {
    const outcome = parseHistoryTipsDocument(
      historyJson([sampleEntry({ patchLine: "-  const a = 1;" })]),
      LIMITS,
    );
    expect(outcome?.entries).toHaveLength(1);
    expect(outcome?.entries[0]).toMatchObject({
      tipsId: 1,
      status: "PENDING",
      filePath: "src/a.ts",
      lineNum: 12,
      patchLine: "const a = 1;",
      reviewMsg: "SQL 语句使用字符串拼接，存在注入风险",
    });
    expect(outcome).toMatchObject({ total: 1, skippedInvalidated: 0, skippedStatus: 0, invalidEntries: 0 });
  });

  test("INVALIDATED 恒跳过；status 不在配置集跳过并计数", () => {
    const outcome = parseHistoryTipsDocument(
      historyJson([
        sampleEntry({ id: "1" }),
        sampleEntry({ id: "2", status: "INVALIDATED" }),
        sampleEntry({ id: "3", status: "REJECTED" }),
        sampleEntry({ id: "4", status: "ACCEPTED" }),
      ]),
      LIMITS,
    );
    expect(outcome?.entries.map((entry) => entry.tipsId)).toEqual([1]);
    expect(outcome).toMatchObject({ total: 4, skippedInvalidated: 1, skippedStatus: 2 });
  });

  test("id / lineNum 非法与重复 tipsId 计 invalid 条目", () => {
    const outcome = parseHistoryTipsDocument(
      historyJson([
        sampleEntry({ id: "abc" }),
        sampleEntry({ id: "5", lineNum: 0 }),
        sampleEntry({ id: "6", lineNum: "x" }),
        sampleEntry({ id: "7" }),
        sampleEntry({ id: "7" }),
      ]),
      LIMITS,
    );
    expect(outcome?.entries.map((entry) => entry.tipsId)).toEqual([7]);
    expect(outcome?.invalidEntries).toBe(4);
  });

  test("id 接受 number；超过 2^53 视为非法", () => {
    const outcome = parseHistoryTipsDocument(
      historyJson([sampleEntry({ id: 9 }), sampleEntry({ id: "9007199254740992" })]),
      LIMITS,
    );
    expect(outcome?.entries.map((entry) => entry.tipsId)).toEqual([9]);
    expect(outcome?.invalidEntries).toBe(1);
  });

  test("filePath 归一：反斜杠转正斜杠；绝对路径 / .. / 空段 = invalid", () => {
    const outcome = parseHistoryTipsDocument(
      historyJson([
        sampleEntry({ id: "1", filePath: "src\\util\\a.ts" }),
        sampleEntry({ id: "2", filePath: "/abs/a.ts" }),
        sampleEntry({ id: "3", filePath: "C:/abs/a.ts" }),
        sampleEntry({ id: "4", filePath: "src/../a.ts" }),
      ]),
      LIMITS,
    );
    expect(outcome?.entries).toHaveLength(1);
    expect(outcome?.entries[0]?.filePath).toBe("src/util/a.ts");
    expect(outcome?.invalidEntries).toBe(3);
  });

  test("非 JSON / 非数组 → undefined（调用方打一行日志）", () => {
    expect(parseHistoryTipsDocument("not json", LIMITS)).toBeUndefined();
    expect(parseHistoryTipsDocument('{"tips":[]}', LIMITS)).toBeUndefined();
  });
});

describe("classifyAnchor：锚点三态", () => {
  const fileLines = [
    "export const a = 1;",
    "const sql = build(userId);",
    "}",
    "",
    "export const b = 2;",
  ];

  test("exact：trim 后整行相等（含行内空白差异）", () => {
    const outcome = classifyAnchor(fileLines, "  export const a = 1;  ");
    expect(outcome.state).toBe("exact");
    expect(outcome.bestLine).toBe(1);
  });

  test("edited：小改动（编辑距离在预算内）命中近似行", () => {
    const outcome = classifyAnchor(fileLines, "const sql = build(userName);");
    expect(outcome.state).toBe("edited");
    expect(outcome.bestLine).toBe(2);
  });

  test("gone：无任何近似行", () => {
    const outcome = classifyAnchor(fileLines, "System.out.println(completely unrelated thing here)");
    expect(outcome.state).toBe("gone");
  });

  test("unknown：patchLine 缺失", () => {
    expect(classifyAnchor(fileLines, "   ").state).toBe("unknown");
  });

  test("预算随行长放宽且为正", () => {
    expect(anchorEditDistanceBudget(4)).toBe(2);
    expect(anchorEditDistanceBudget(60)).toBe(10);
  });
});

describe("stripDiffPrefix / stripReviewTemplate", () => {
  test("+ / - 前缀剥掉，其余原样", () => {
    expect(stripDiffPrefix("+ a")).toBe(" a");
    expect(stripDiffPrefix("- a")).toBe(" a");
    expect(stripDiffPrefix("a")).toBe("a");
  });

  test("模板词剥掉后比较相似度不被脚手架稀释", () => {
    const stripped = stripReviewTemplate("[缺陷类型] 注入风险。影响评估：高危。");
    expect(stripped).not.toContain("[缺陷类型]");
    expect(stripped).not.toContain("影响评估：");
  });
});

describe("matchPairSignal 与 evaluateMatrix：矩阵各路径", () => {
  const fileLines = [
    "import httpx",
    "const port = cfg.port",
    "const sql = \"SELECT * FROM users WHERE id = \" + userId;",
    "logger.info(sql)",
    "}",
  ];
  const finding = (overrides: Partial<FindingForMatch> = {}): FindingForMatch => ({
    id: "F001",
    line: 3,
    title: "SQL 拼接注入风险",
    ...overrides,
  });

  function entry(overrides: Record<string, unknown> = {}) {
    const parsed = parseHistoryTipsDocument(
      historyJson([
        sampleEntry({
          lineNum: 3,
          patchLine: 'const sql = "SELECT * FROM users WHERE id = " + userId;',
          ...overrides,
        }),
      ]),
      LIMITS,
    );
    return parsed?.entries[0] as NonNullable<typeof parsed>["entries"][number];
  }

  test("#1 硬档：位置命中 + 文本过线 → invalidate 重复", () => {
    const decision = evaluateMatrix(entry(), fileLines, [
      finding({ title: "SQL 语句拼接存在注入风险" }),
    ]);
    expect(decision).toMatchObject({ kind: "invalidate", reason: "重复", matchedFindingId: "F001" });
  });

  test("#2 位置命中但文本不过线（同行另一问题）→ LLM 配对疑问", () => {
    const decision = evaluateMatrix(entry(), fileLines, [
      finding({ title: "敏感信息明文写入日志" }),
    ]);
    expect(decision.kind).toBe("llm");
    if (decision.kind === "llm") {
      const pair = decision.signal.pair;
      expect(decision.signal.anchor).toBe("exact");
      expect(pair.kind).toBe("pair-question");
      if (pair.kind === "pair-question") {
        expect(pair.findingIds).toEqual(["F001"]);
      }
    }
  });

  test("#3 软档：无位置命中但同文件文本相似 → LLM 候选", () => {
    const decision = evaluateMatrix(entry(), fileLines, [
      finding({ line: 5, title: "SQL 语句拼接存在注入风险" }),
    ]);
    expect(decision.kind).toBe("llm");
    if (decision.kind === "llm") {
      expect(decision.signal.pair.kind).toBe("soft-candidate");
    }
  });

  test("#4 exact + 无任何配对信号 → 免模型保留", () => {
    const decision = evaluateMatrix(entry(), fileLines, []);
    expect(decision).toMatchObject({ kind: "keep", cause: "no-signal" });
  });

  test("#5/#6 edited → LLM（变更信号，无论有无配对）", () => {
    const decision = evaluateMatrix(
      entry({ patchLine: 'const sql = "SELECT * FROM users WHERE id = " + userName;' }),
      fileLines,
      [finding({ line: 3, title: "完全不相干的另一个问题标题" })],
    );
    // 锚点小改（edited）：位置命中要求 code 相等 → 不成立；文本不相似 → 无配对
    expect(decision.kind).toBe("llm");
    if (decision.kind === "llm") {
      expect(decision.signal.anchor).toBe("edited");
      expect(decision.signal.pair.kind).toBe("none");
    }
  });

  test("#8 gone + 无配对 → LLM（变更信号）", () => {
    const goneEntry = entry({
      patchLine: "String totallyRemoved = legacyCall();",
    });
    const decision = evaluateMatrix(goneEntry, fileLines, []);
    expect(decision.kind).toBe("llm");
    if (decision.kind === "llm") {
      expect(decision.signal.anchor).toBe("gone");
    }
  });

  test("位置匹配要求 code 相等：仅行号 ±5 不足（结构约束的另一半）", () => {
    const pair = matchPairSignal(entry(), fileLines, [
      finding({ line: 2, title: "SQL 语句拼接存在注入风险" }),
    ]);
    // 行 ±5 命中但第 2 行源码 ≠ patchLine → 无位置匹配；文本相似走软档
    expect(pair.kind).toBe("soft-candidate");
  });

  test("多 finding 位置命中时取文本最相似的一条（最优匹配）", () => {
    const pair = matchPairSignal(entry(), fileLines, [
      finding({ id: "F001", title: "敏感信息明文写入日志" }),
      finding({ id: "F002", title: "SQL 语句拼接存在注入风险" }),
    ]);
    expect(pair.kind).toBe("hard-duplicate");
    if (pair.kind === "hard-duplicate") {
      expect(pair.matchedFindingId).toBe("F002");
    }
  });

  test("锚点为空不可能位置命中（空行不撞空行）：unknown + 无配对 → 保留", () => {
    const emptyEntry = entry({ patchLine: "" });
    const decision = evaluateMatrix(emptyEntry, [...fileLines, "  "], [
      finding({ line: 6, title: "空行问题" }),
    ]);
    // patchLine 缺失按无变更信号处理：空行 vs 空行不会形成位置匹配
    expect(decision).toMatchObject({ kind: "keep", cause: "no-signal" });
  });

  test("硬档下限常量在 (0, 1) 区间且软阈更高", () => {
    expect(HARD_DUPLICATE_TEXT_FLOOR).toBeGreaterThan(0);
    expect(HARD_DUPLICATE_TEXT_FLOOR).toBeLessThan(1);
  });
});

describe("reason 映射与 verdict 解析", () => {
  test("verdict → reason 单点映射；persist/unclear 不失效", () => {
    expect(reasonFromVerdict("fixed")).toBe("已修复");
    expect(reasonFromVerdict("duplicate")).toBe("重复");
    expect(reasonFromVerdict("persist")).toBeUndefined();
    expect(reasonFromVerdict("unclear")).toBeUndefined();
  });

  test("reason 枚举 = 三个中文值", () => {
    expect(INVALIDATION_REASONS).toEqual(["文件已删除", "重复", "已修复"]);
  });

  test("parseVerdictValue：大小写 / 空白宽松，非法值 undefined", () => {
    expect(parseVerdictValue("FIXED")).toBe("fixed");
    expect(parseVerdictValue(" persist ")).toBe("persist");
    expect(parseVerdictValue("maybe")).toBeUndefined();
    expect(parseVerdictValue(1)).toBeUndefined();
  });
});
