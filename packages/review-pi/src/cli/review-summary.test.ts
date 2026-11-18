import { expect, test } from "vitest";

import type { FetchFunction } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import type { ReviewTipsDocumentLike } from "./presentation-projection.js";
import {
  buildReviewSummary,
  NO_FINDING_NOTE,
  NO_REPORTED_NOTE,
} from "./review-summary.js";

// 收尾总结（ADR-0045）：模型调用产出 Markdown；失败降级确定性模板
// （degradedReason 留痕）——saveReviewSummary 一定有内容可发。

const RUNTIME = {
  apiKey: "offline-test",
  baseUrl: "http://127.0.0.1:9/v1",
  modelId: "test-model",
  timeoutMs: 5_000,
  // 单次尝试：本文件测总结降级链，重试行为在 llm-retry 的专用用例覆盖。
  retry: { maxAttempts: 1, baseDelayMs: 0, maxDelayMs: 0, maxRetryAfterMs: 0 },
} as const;

function finding(file: string, severity: Finding["severity"]): Finding {
  return {
    id: `F-${file}-${severity}`,
    severity,
    category: "SECURITY",
    file,
    line: 10,
    title: "Unsafe redirect",
    description: "User input flows into a redirect target.",
    evidence: [`${file}:10 redirect(target);`],
    rule: "",
    confidence: 0.9,
  };
}

const TIPS: ReviewTipsDocumentLike = [
  {
    filePath: "src/Foo.java",
    reviewTips: [
      {
        code: "redirect(target);",
        review: "不安全的重定向。影响：钓鱼。",
        suggestion: "白名单校验。",
        category: "安全",
        subcategory: "",
        severity: "Major",
        ruleId: "",
        lineNum: 10,
        source: "common-reviewer",
        confidence: "High",
      },
    ],
  },
];

test("模型路径：Markdown 直传；请求 user 消息含 tips 与结构化摘要", async () => {
  const bodies: string[] = [];
  const fetch: FetchFunction = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return new Response(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "# 检视总结\n\n本次……" } }],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };

  const result = await buildReviewSummary({
    tips: TIPS,
    findings: [finding("src/Foo.java", "P1")],
    reportedFiles: ["src/Foo.java"],
    runtime: RUNTIME,
    fetch,
  });

  expect(result.markdown).toContain("# 检视总结");
  expect(result.degradedReason).toBeUndefined();
  const body = JSON.parse(bodies[0] ?? "{}") as { messages: { role: string; content: string }[] };
  expect(body.messages[1]?.content).toContain("不安全的重定向");
  expect(body.messages[1]?.content).toContain('"bySeverity"');
  expect(body.messages[1]?.content).toContain("src/Foo.java");
  // key 纪律
  expect(bodies[0] ?? "").not.toContain("offline-test");
});

test("模型失败 → 确定性模板：非空、结构化规范、degradedReason 留痕", async () => {
  const fetch: FetchFunction = async () => new Response("boom", { status: 502 });

  const result = await buildReviewSummary({
    findings: [finding("src/A.java", "P1"), finding("src/B.java", "P2")],
    runtime: RUNTIME,
    fetch,
  });

  expect(result.degradedReason).toContain("HTTP 502");
  expect(result.markdown).toContain("## 检视总览");
  expect(result.markdown).toContain("### 意见分布");
  expect(result.markdown).toContain("| major | 1 | src/A.java |");
  expect(result.markdown).toContain("| minor | 1 | src/B.java |");
  expect(result.markdown).toContain("### 高优先级意见速览");
  expect(result.markdown).toContain("1. [major] src/A.java:10 — Unsafe redirect");
  expect(result.markdown).toContain("### 星级评价");
  expect(result.markdown).toContain("⭐⭐ — 存在 ≥1 条 major 或 fatal 意见");
});

test("模型回空串 → 模板降级（空总结不外发）", async () => {
  const fetch: FetchFunction = async () =>
    new Response(
      JSON.stringify({ choices: [{ message: { role: "assistant", content: "   " } }] }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const result = await buildReviewSummary({
    findings: [finding("src/A.java", "P1")],
    runtime: RUNTIME,
    fetch,
  });
  expect(result.degradedReason).toContain("empty summary");
  expect(result.markdown).toContain("| major | 1 | src/A.java |");
});

test("星级硬判据：仅 P2/P3 ⇒ ⭐⭐⭐；仅 P3 ⇒ ⭐⭐⭐⭐", async () => {
  const fetch: FetchFunction = async () => new Response("boom", { status: 502 });
  const onlyMinor = await buildReviewSummary({
    findings: [finding("src/A.java", "P2"), finding("src/B.java", "P3")],
    runtime: RUNTIME,
    fetch,
  });
  expect(onlyMinor.markdown).toContain("⭐⭐⭐ — 0 条 fatal，0 条 major");
  const onlySuggestion = await buildReviewSummary({
    findings: [finding("src/A.java", "P3")],
    runtime: RUNTIME,
    fetch,
  });
  expect(onlySuggestion.markdown).toContain("⭐⭐⭐⭐ — 0 条 fatal / major / minor");
});

test("metrics：变更规模 / 预算使用 / 资源加载三行按权威数据渲染", async () => {
  const fetch: FetchFunction = async () => new Response("boom", { status: 502 });
  const result = await buildReviewSummary({
    findings: [finding("src/A.java", "P2")],
    metrics: {
      changedFiles: 3,
      changedHunks: 5,
      changedLines: 120,
      modelCalls: 17,
      inputTokens: 41200,
    },
    runtime: RUNTIME,
    fetch,
  });
  expect(result.markdown).toContain("| 变更规模 | 3 个文件 / 5 个 hunk（120 行变更） |");
  expect(result.markdown).toContain("| 预算使用 | 17 次调用 |");
  expect(result.markdown).toContain("| 资源加载 | 约 41,200 tokens |");
});

test("零 finding：结构化模板（无速览 / 未发现缺陷 / ⭐⭐⭐⭐），不调用模型", async () => {
  let calls = 0;
  const fetch: FetchFunction = async () => {
    calls += 1;
    return new Response("boom", { status: 500 });
  };
  const result = await buildReviewSummary({
    findings: [],
    runtime: RUNTIME,
    fetch,
  });
  expect(calls).toBe(0);
  expect(result.markdown).toContain("## 检视总览");
  expect(result.markdown).toContain("### 意见分布");
  expect(result.markdown).toContain("| fatal | 0 | — |");
  expect(result.markdown).toContain(NO_FINDING_NOTE);
  expect(result.markdown).not.toContain("### 高优先级意见速览");
  expect(result.markdown).toContain("⭐⭐⭐⭐ — 0 条 fatal / major / minor / suggestion（未发现缺陷）");
  expect(result.degradedReason).toBeUndefined();
});

test("零已上报（含有意见但全部未上报）：四节结构 + 诚实说明，不作星级评价（ADR-0103）", async () => {
  let calls = 0;
  const fetch: FetchFunction = async () => {
    calls += 1;
    return new Response("boom", { status: 500 });
  };
  const result = await buildReviewSummary({
    findings: [],
    unreportedFindings: 2,
    metrics: {
      changedFiles: 3,
      changedHunks: 5,
      changedLines: 120,
      modelCalls: 0,
      inputTokens: 0,
    },
    runtime: RUNTIME,
    fetch,
  });
  expect(calls).toBe(0);
  expect(result.markdown).toContain("## 检视总览");
  expect(result.markdown).toContain("| 预算使用 | 0 次调用 |");
  expect(result.markdown).toContain(NO_REPORTED_NOTE);
  expect(result.markdown).not.toContain("未发现缺陷");
  expect(result.markdown).not.toContain("### 高优先级意见速览");
  expect(result.markdown).toContain("—（未上报任何检视意见，不作星级评价）");
  expect(result.degradedReason).toBeUndefined();
});
