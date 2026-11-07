import { expect, test } from "vitest";

import type { FetchFunction } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import type { ReviewTipsDocumentLike } from "./presentation-projection.js";
import { buildReviewSummary } from "./review-summary.js";

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

test("模型失败 → 确定性模板：非空、按文件清单、degradedReason 留痕", async () => {
  const fetch: FetchFunction = async () => new Response("boom", { status: 502 });

  const result = await buildReviewSummary({
    findings: [finding("src/A.java", "P1"), finding("src/B.java", "P2")],
    runtime: RUNTIME,
    fetch,
  });

  expect(result.degradedReason).toContain("HTTP 502");
  expect(result.markdown).toContain("2 条问题");
  expect(result.markdown).toContain("src/A.java");
  expect(result.markdown).toContain("src/B.java");
  expect(result.markdown).toContain("Unsafe redirect");
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
  expect(result.markdown).toContain("1 条问题");
});

test("零 finding：固定文案直出，不调用模型、不留降级痕", async () => {
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
  expect(result.markdown).toBe("# 检视总结\n\n本次检视未发现缺陷。");
  expect(result.degradedReason).toBeUndefined();
});
