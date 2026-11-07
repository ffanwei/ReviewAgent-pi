import { expect, test } from "vitest";

import type { FetchFunction } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import { buildShardReport } from "./report-payload.js";

// 片级报文生成（ADR-0045 决策 4 修订）：模型只出语义字段（按 finding id 对齐），
// 结构字段（filePath / code / lineNum / ruleId / level / 分组）由代码确定性组装——
// 「模型不遵守提示词」的暴露面缩到 category + 三个非空字符串。

const RUNTIME = {
  apiKey: "offline-test",
  baseUrl: "http://127.0.0.1:9/v1",
  modelId: "test-model",
  timeoutMs: 5_000,
  // 单次尝试：本文件测报文组装，重试行为在 llm-retry 的专用用例覆盖。
  retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, maxRetryAfterMs: 0 },
} as const;

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
    rule: "RULE-URL-001",
    confidence: 0.9,
    ...overrides,
  };
}

/** 假网关：回一条 chat completion，正文 = text */
function gatewayReturning(text: string): { fetch: FetchFunction; bodies: string[] } {
  const bodies: string[] = [];
  const fetch: FetchFunction = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: text } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { fetch, bodies };
}

function failingGateway(): FetchFunction {
  return async () => new Response("boom", { status: 500 });
}

/** 模型形态：按 finding id 出语义字段 */
function modelTip(overrides: Partial<Record<"id" | "category" | "subcategory" | "review" | "suggestion", string>>): Record<string, string> {
  return {
    id: "F001",
    category: "安全",
    subcategory: "URL 注入",
    review: "[安全] 未校验的重定向。影响评估：钓鱼跳转。",
    suggestion: "[重构思路] 白名单校验。代码示例：```if (!ALLOWED.has(target)) …```",
    ...overrides,
  };
}

test("确定性组装：code/lineNum/level/ruleId/filePath 全部来自 finding 与源码行，不来自模型", async () => {
  const gateway = gatewayReturning(JSON.stringify({ tips: [modelTip({})] }));
  const outcome = await buildShardReport({
    findings: [finding()],
    codeByFinding: { F001: "redirect(target);" },
    runtime: RUNTIME,
    fetch: gateway.fetch,
  });

  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") {
    return;
  }
  expect(outcome.skippedTips).toEqual([]);
  expect(outcome.skippedFiles).toEqual([]);
  expect(outcome.files).toHaveLength(1);
  expect(outcome.files[0]?.filePath).toBe("src/Foo.java");
  expect(outcome.files[0]?.reviewTips).toHaveLength(1);
  expect(outcome.files[0]?.reviewTips[0]).toEqual({
    code: "redirect(target);",
    review: "[安全] 未校验的重定向。影响评估：钓鱼跳转。",
    suggestion: "[重构思路] 白名单校验。代码示例：```if (!ALLOWED.has(target)) …```",
    category: "安全",
    subcategory: "URL 注入",
    level: "Major", // P1 → Major（Q18 四档映射）
    ruleId: null, // id 无 RULE-CHECK@ 前缀 = 非规则会话产出
    lineNum: "42",
  });

  // 请求面：system/user 两条消息；user 含 findings JSON 与 sourceLine
  const body = JSON.parse(gateway.bodies[0] ?? "{}") as {
    messages: { role: string; content: string }[];
    stream: boolean;
  };
  expect(body.messages.map((message) => message.role)).toEqual(["system", "user"]);
  expect(body.stream).toBe(false);
  expect(body.messages[1]?.content).toContain('"sourceLine": "redirect(target);"');
  expect(body.messages[1]?.content).toContain("Unsafe redirect");
  // key 纪律：key 只进 Authorization 头
  expect(gateway.bodies[0] ?? "").not.toContain("offline-test");
});

test("severity 四档映射（Q18）与规则会话 ruleId（RULE-CHECK@ 前缀）", async () => {
  const gateway = gatewayReturning(
    JSON.stringify({
      tips: [
        modelTip({ id: "A" }),
        modelTip({ id: "B" }),
        modelTip({ id: "C" }),
        modelTip({ id: "D" }),
      ],
    }),
  );
  const outcome = await buildShardReport({
    findings: [
      finding({ id: "A", severity: "P0", file: "a.txt" }),
      finding({ id: "B", severity: "P1", file: "b.txt" }),
      finding({ id: "C", severity: "P2", file: "c.txt" }),
      finding({ id: "D", severity: "P3", file: "d.txt", rule: "sentinel-rule" }),
    ],
    codeByFinding: { A: "l", B: "l", C: "l", D: "l" },
    runtime: RUNTIME,
    fetch: gateway.fetch,
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") {
    return;
  }
  const byFile = new Map(outcome.files.map((file) => [file.filePath, file.reviewTips[0]]));
  expect(byFile.get("a.txt")?.level).toBe("Fatal");
  expect(byFile.get("b.txt")?.level).toBe("Major");
  expect(byFile.get("c.txt")?.level).toBe("Minor");
  expect(byFile.get("d.txt")?.level).toBe("Suggestion");

  // 规则会话产出（id 带 RULE-CHECK@ 前缀）才带 ruleId
  const ruleSession = await buildShardReport({
    findings: [finding({ id: "RULE-CHECK@sample-rule@src/Foo.java:42", rule: "sample-rule" })],
    codeByFinding: { "RULE-CHECK@sample-rule@src/Foo.java:42": "redirect(target);" },
    runtime: RUNTIME,
    fetch: gatewayReturning(
      JSON.stringify({ tips: [modelTip({ id: "RULE-CHECK@sample-rule@src/Foo.java:42" })] }),
    ).fetch,
  });
  expect(ruleSession.kind).toBe("ok");
  if (ruleSession.kind === "ok") {
    expect(ruleSession.files[0]?.reviewTips[0]?.ruleId).toBe("sample-rule");
  }
});

test("code 缺席 → 跳过该条（绝不编）；模型漏 id → 跳过并留痕；编造未知 id → 留痕", async () => {
  const gateway = gatewayReturning(
    JSON.stringify({
      tips: [modelTip({ id: "F001" }), modelTip({ id: "F002" }), modelTip({ id: "GHOST" })],
    }),
  );
  const outcome = await buildShardReport({
    findings: [finding(), finding({ id: "F002", file: "src/Bar.java", line: 7 })],
    codeByFinding: { F001: "redirect(target);" }, // F002 没有源码行
    runtime: RUNTIME,
    fetch: gateway.fetch,
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") {
    return;
  }
  expect(outcome.files).toHaveLength(1); // 只有 F001 的文件组
  expect(outcome.skippedTips).toHaveLength(2);
  // 顺序：未知 id 留痕（索引阶段）在前，逐 finding 缺席在后
  expect(outcome.skippedTips[0]).toContain("unknown finding id");
  expect(outcome.skippedTips[1]).toContain("F002");
  expect(outcome.skippedTips[1]).toContain("source line unavailable");
  // tips 复用面（semanticByKey）：F002 语义完整仍登记（tips 允许 code 空串）
  expect(outcome.semanticByKey.size).toBe(2);
});

test("category：模型枚举外 → 查 finding.category 兜底表（大小写不敏感）；表也没有 → 跳过", async () => {
  const fallback = await buildShardReport({
    findings: [finding({ category: "correctness" })], // 小写自由文本
    codeByFinding: { F001: "x" },
    runtime: RUNTIME,
    fetch: gatewayReturning(JSON.stringify({ tips: [modelTip({ category: "风险" })] })).fetch,
  });
  expect(fallback.kind).toBe("ok");
  if (fallback.kind === "ok") {
    expect(fallback.files[0]?.reviewTips[0]?.category).toBe("可靠性"); // correctness → 可靠性
  }

  const direct = await buildShardReport({
    findings: [finding({ category: "SECURITY" })],
    codeByFinding: { F001: "x" },
    runtime: RUNTIME,
    fetch: gatewayReturning(JSON.stringify({ tips: [modelTip({ category: "安全" })] })).fetch,
  });
  expect(direct.kind === "ok" && direct.files[0]?.reviewTips[0]?.category).toBe("安全");

  const miss = await buildShardReport({
    findings: [finding({ category: "NULL_POINTER_DEREFERENCE_ON_PATH_XYZ" })], // 表未命中
    codeByFinding: { F001: "x" },
    runtime: RUNTIME,
    fetch: gatewayReturning(JSON.stringify({ tips: [modelTip({ category: "不对" })] })).fetch,
  });
  expect(miss.kind).toBe("ok");
  if (miss.kind === "ok") {
    expect(miss.files).toEqual([]);
    expect(miss.skippedTips[0]).toContain("no fallback mapping");
  }
});

test("filePath：finding.file 带反斜杠 → 规范化为正斜杠；绝对路径 → 该文件组跳过（去重留痕）", async () => {
  const normalized = await buildShardReport({
    findings: [finding({ file: "src\\main\\Foo.java" })],
    codeByFinding: { F001: "x" },
    runtime: RUNTIME,
    fetch: gatewayReturning(JSON.stringify({ tips: [modelTip({})] })).fetch,
  });
  expect(normalized.kind === "ok" && normalized.files[0]?.filePath).toBe("src/main/Foo.java");

  const absolute = await buildShardReport({
    findings: [
      finding({ id: "F001", file: "C:\\repo\\src\\Foo.java", line: 1 }),
      finding({ id: "F002", file: "C:\\repo\\src\\Foo.java", line: 2 }),
    ],
    codeByFinding: { F001: "x", F002: "y" },
    runtime: RUNTIME,
    fetch: gatewayReturning(
      JSON.stringify({ tips: [modelTip({ id: "F001" }), modelTip({ id: "F002" })] }),
    ).fetch,
  });
  expect(absolute.kind).toBe("ok");
  if (absolute.kind === "ok") {
    expect(absolute.files).toEqual([]);
    // 同一非法路径只留痕一次
    expect(absolute.skippedFiles).toHaveLength(1);
    expect(absolute.skippedFiles[0]).toContain("not a repo-relative POSIX path");
  }
});

test("同文件多条 finding 归一组；review/suggestion 空值 → 跳过", async () => {
  const gateway = gatewayReturning(
    JSON.stringify({
      tips: [
        modelTip({ id: "F001" }),
        modelTip({ id: "F002", review: "  " }), // 空白 review
      ],
    }),
  );
  const outcome = await buildShardReport({
    findings: [finding({ line: 42 }), finding({ id: "F002", line: 43 })],
    codeByFinding: { F001: "a", F002: "b" },
    runtime: RUNTIME,
    fetch: gateway.fetch,
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind !== "ok") {
    return;
  }
  expect(outcome.files).toHaveLength(1);
  expect(outcome.files[0]?.reviewTips).toHaveLength(1);
  expect(outcome.files[0]?.reviewTips[0]?.lineNum).toBe("42");
  expect(outcome.skippedTips[0]).toContain("review must be a non-empty string");
});

test("模型输出包在 ```json 栅栏里也能解析", async () => {
  const gateway = gatewayReturning("```json\n" + JSON.stringify({ tips: [modelTip({})] }) + "\n```");
  const outcome = await buildShardReport({
    findings: [finding()],
    codeByFinding: { F001: "redirect(target);" },
    runtime: RUNTIME,
    fetch: gateway.fetch,
  });
  expect(outcome.kind).toBe("ok");
  if (outcome.kind === "ok") {
    expect(outcome.files[0]?.reviewTips[0]?.category).toBe("安全");
  }
});

test("零 finding：不发请求、files 为空、语义登记为空（零 finding 文件不发空包）", async () => {
  let requested = 0;
  const fetch: FetchFunction = async () => {
    requested += 1;
    return new Response("{}", { status: 200 });
  };
  const outcome = await buildShardReport({
    findings: [],
    codeByFinding: {},
    runtime: RUNTIME,
    fetch,
  });
  expect(outcome).toEqual({
    kind: "ok",
    files: [],
    skippedTips: [],
    skippedFiles: [],
    semanticByKey: new Map(),
  });
  expect(requested).toBe(0);
});

test("网关 5xx / 非法 JSON / 缺 tips 数组 → failed（绝不抛错）", async () => {
  const failed = await buildShardReport({
    findings: [finding()],
    codeByFinding: {},
    runtime: RUNTIME,
    fetch: failingGateway(),
  });
  expect(failed.kind).toBe("failed");
  if (failed.kind === "failed") {
    expect(failed.reason).toContain("HTTP 500");
  }

  const notJson = await buildShardReport({
    findings: [finding()],
    codeByFinding: {},
    runtime: RUNTIME,
    fetch: gatewayReturning("这不是 JSON").fetch,
  });
  expect(notJson.kind).toBe("failed");

  const noTips = await buildShardReport({
    findings: [finding()],
    codeByFinding: {},
    runtime: RUNTIME,
    fetch: gatewayReturning('{"nope": 1}').fetch,
  });
  expect(noTips.kind).toBe("failed");
});
