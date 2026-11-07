import { describe, expect, test } from "vitest";

import {
  AGENT_REVIEW_CATEGORIES,
  AGENT_REVIEW_LEVELS,
  MCP_TASK_TOOL_NAMES,
  TASK_TOOL_SETTLE_ENV,
  TASK_TOOL_SETTLE_MS,
  agentReviewTipFromUnknown,
  normalizeReportFilePath,
  resolveTaskToolSettleMs,
} from "./task-tools.js";

// 业务 tool 契约（ADR-0045）：名字硬编码、报文严格校验（坏条目跳过不连累
// 整文件）、filePath 规范化（本地绝对路径不出进程）。

function validTip(): Record<string, unknown> {
  return {
    code: "return new FileInputStream(path);",
    review: "[资源泄漏] 打开的流未关闭。影响评估：句柄耗尽。",
    suggestion: "[重构思路] 用 try-with-resources 包住。代码示例：`try (var in = …) {}`",
    category: "可靠性",
    subcategory: "资源管理",
    level: "Major",
    ruleId: null,
    lineNum: 42,
  };
}

describe("MCP_TASK_TOOL_NAMES", () => {
  test("四个业务 tool 名 = 服务端契约（ADR-0045 决策 1）", () => {
    expect(MCP_TASK_TOOL_NAMES).toEqual({
      startTask: "startTask",
      endTask: "endTask",
      saveReviewSummary: "saveReviewSummary",
      mrReviewResult: "mrReviewResult",
    });
  });
});

describe("resolveTaskToolSettleMs", () => {
  test("缺省恒为固定 5 秒（生产路径没有任何环境变量入口）", () => {
    expect(TASK_TOOL_SETTLE_MS).toBe(5_000);
    expect(resolveTaskToolSettleMs({})).toBe(5_000);
    expect(resolveTaskToolSettleMs({ OTHER: "0" })).toBe(5_000);
  });

  test("测试专用 env 只接受非负整数；0 = 关闭等待", () => {
    expect(resolveTaskToolSettleMs({ [TASK_TOOL_SETTLE_ENV]: "0" })).toBe(0);
    expect(resolveTaskToolSettleMs({ [TASK_TOOL_SETTLE_ENV]: "30" })).toBe(30);
    // 非法值一律回落缺省，绝不把运行期等待变成负 / NaN
    for (const bad of ["-1", "1.5", "abc", "", " 5"]) {
      expect(resolveTaskToolSettleMs({ [TASK_TOOL_SETTLE_ENV]: bad })).toBe(5_000);
    }
  });
});

describe("normalizeReportFilePath", () => {
  test("反斜杠 → 正斜杠；相对路径原样保留", () => {
    expect(normalizeReportFilePath("src\\main\\Foo.java")).toBe("src/main/Foo.java");
    expect(normalizeReportFilePath("src/main/Foo.java")).toBe("src/main/Foo.java");
    expect(normalizeReportFilePath("  a/b.txt  ")).toBe("a/b.txt");
  });

  test("绝对路径 / 盘符 / .. / . / 空段 / 空串 → null（整组跳过）", () => {
    expect(normalizeReportFilePath("/abs/path")).toBeNull();
    expect(normalizeReportFilePath("C:\\repo\\a.java")).toBeNull();
    expect(normalizeReportFilePath("a/../b")).toBeNull();
    expect(normalizeReportFilePath("./a")).toBeNull();
    expect(normalizeReportFilePath("a//b")).toBeNull();
    expect(normalizeReportFilePath("")).toBeNull();
    expect(normalizeReportFilePath("   ")).toBeNull();
  });

  test("含点但不是 `..` 段的文件名合法（隐藏文件 / 版本号）", () => {
    expect(normalizeReportFilePath(".github/workflows/ci.yml")).toBe(".github/workflows/ci.yml");
    expect(normalizeReportFilePath("lib/foo-1.2.3.min.js")).toBe("lib/foo-1.2.3.min.js");
  });
});

describe("agentReviewTipFromUnknown", () => {
  test("合法 tip：number lineNum 转 string，null ruleId 保留", () => {
    const outcome = agentReviewTipFromUnknown(validTip());
    expect(outcome.tip).toEqual({
      code: "return new FileInputStream(path);",
      review: "[资源泄漏] 打开的流未关闭。影响评估：句柄耗尽。",
      suggestion: "[重构思路] 用 try-with-resources 包住。代码示例：`try (var in = …) {}`",
      category: "可靠性",
      subcategory: "资源管理",
      level: "Major",
      ruleId: null,
      lineNum: "42",
    });
  });

  test("字符串 lineNum 与字符串 ruleId 也可；空串 ruleId → null", () => {
    const outcome = agentReviewTipFromUnknown({
      ...validTip(),
      lineNum: "7",
      ruleId: "RULE-42",
    });
    expect(outcome.tip?.lineNum).toBe("7");
    expect(outcome.tip?.ruleId).toBe("RULE-42");
    expect(agentReviewTipFromUnknown({ ...validTip(), ruleId: "" }).tip?.ruleId).toBeNull();
    expect(agentReviewTipFromUnknown({ ...validTip(), ruleId: undefined }).tip?.ruleId).toBeNull();
  });

  test("category / level 不在枚举 → 拒（枚举值单源）", () => {
    expect(agentReviewTipFromUnknown({ ...validTip(), category: "CORRECTNESS" }).problem).toContain(
      "category must be one of",
    );
    expect(agentReviewTipFromUnknown({ ...validTip(), level: "P1" }).problem).toContain(
      "level must be one of",
    );
    // 枚举全集与工具契约一致
    expect(AGENT_REVIEW_CATEGORIES).toHaveLength(7);
    expect(AGENT_REVIEW_LEVELS).toEqual(["Suggestion", "Minor", "Major", "Fatal"]);
  });

  test("code 必填单行：空 / 带换行都拒（code 无材料时绝不编）", () => {
    expect(agentReviewTipFromUnknown({ ...validTip(), code: "" }).problem).toContain(
      "code must be a non-empty string",
    );
    expect(agentReviewTipFromUnknown({ ...validTip(), code: "a\nb" }).problem).toContain(
      "single line",
    );
  });

  test("其余必填缺席 / 非法类型 → 拒", () => {
    for (const key of ["review", "suggestion", "subcategory"] as const) {
      expect(agentReviewTipFromUnknown({ ...validTip(), [key]: " " }).problem).toBeTruthy();
    }
    expect(agentReviewTipFromUnknown(null).problem).toBeTruthy();
    expect(agentReviewTipFromUnknown("x").problem).toBeTruthy();
    expect(agentReviewTipFromUnknown({ ...validTip(), lineNum: 0 }).problem).toContain(
      "lineNum must be",
    );
    expect(agentReviewTipFromUnknown({ ...validTip(), lineNum: "4.5" }).problem).toBeTruthy();
    expect(agentReviewTipFromUnknown({ ...validTip(), ruleId: 42 }).problem).toBeTruthy();
  });
});
