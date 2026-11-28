import { expect, test } from "vitest";

import type { FetchFunction } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import type { ReviewTipsDocumentLike } from "./presentation-projection.js";
import {
  buildReviewSummary,
  NO_FINDING_NOTE,
  NO_REPORTED_NOTE,
  type ReviewSummaryMetrics,
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

/** 规范总结正文（模型路径的合法回包；可替换星级行构造「改判」用例） */
function validSummary(starLine = "⭐⭐ — 存在 ≥1 条 major 或 fatal 意见"): string {
  return [
    "## 检视总览",
    "",
    "| 维度 | 统计 |",
    "|------|------|",
    "| 变更规模 | — |",
    "| 预算使用 | — |",
    "| 资源加载 | — |",
    "",
    "### 意见分布",
    "",
    "| severity | 数量 | 涉及文件 |",
    "|----------|------|---------|",
    "| fatal | 0 | — |",
    "| major | 1 | src/Foo.java |",
    "| minor | 0 | — |",
    "| suggestion | 0 | — |",
    "",
    "### 高优先级意见速览",
    "",
    "1. [major] src/Foo.java:10 — 不安全重定向",
    "",
    "### 星级评价",
    "",
    starLine,
  ].join("\n");
}

function modelReply(
  content: string,
  extra: { finishReason?: string; reasoningTokens?: number } = {},
): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: { role: "assistant", content },
          ...(extra.finishReason !== undefined ? { finish_reason: extra.finishReason } : {}),
        },
      ],
      ...(extra.reasoningTokens !== undefined
        ? {
            usage: {
              prompt_tokens: 10,
              completion_tokens: 5,
              completion_tokens_details: { reasoning_tokens: extra.reasoningTokens },
            },
          }
        : {}),
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

test("模型路径：Markdown 直传；请求 user 消息含 tips 与结构化摘要", async () => {
  const bodies: string[] = [];
  const fetch: FetchFunction = async (_input, init) => {
    bodies.push(String(init?.body ?? ""));
    return modelReply(validSummary());
  };

  const result = await buildReviewSummary({
    tips: TIPS,
    findings: [finding("src/Foo.java", "P1")],
    reportedFiles: ["src/Foo.java"],
    runtime: RUNTIME,
    fetch,
  });

  expect(result.markdown).toContain("## 检视总览");
  expect(result.markdown).toContain("### 星级评价");
  expect(result.degradedReason).toBeUndefined();
  const body = JSON.parse(bodies[0] ?? "{}") as { messages: { role: string; content: string }[] };
  expect(body.messages[1]?.content).toContain("不安全的重定向");
  expect(body.messages[1]?.content).toContain('"bySeverity"');
  expect(body.messages[1]?.content).toContain('"overviewRows"');
  expect(body.messages[1]?.content).toContain('"distributionRows"');
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

// ---- 输出面兜底（方案一）：模型把思考写进 content 时，裁剪到规范正文 ----

test("前言 + 草稿 + 正式文档：取最后一份完整文档，思考被丢弃", async () => {
  const reply = [
    "我们根据指令撰写中文 Markdown 总结报告。需要严格按结构输出，不增删小节。",
    "",
    "首先，检视总览表格三行：变更规模 / 预算使用 / 资源加载。",
    "",
    "## 检视总览",
    "",
    "草稿：表格还没写完……",
    "",
    validSummary(),
  ].join("\n");

  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(reply),
  });

  expect(result.degradedReason).toBeUndefined();
  expect(result.markdown.startsWith("## 检视总览")).toBe(true);
  expect(result.markdown).not.toContain("我们根据指令");
  expect(result.markdown).not.toContain("草稿");
  expect(result.markdown).toContain("### 星级评价");
});

test("思考闭合标签与正式标题同一行：先剥标签再取文档", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(`我们根据给的权威数据撰写总结。</think>${validSummary()}`),
  });

  expect(result.degradedReason).toBeUndefined();
  expect(result.markdown.startsWith("## 检视总览")).toBe(true);
  expect(result.markdown).not.toContain("</think>");
  expect(result.markdown).not.toContain("我们根据给的权威数据");
});

test("思考闭合标签单独一行：前言同样被丢弃", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(`我们根据给的权威数据撰写总结。\n</think>\n${validSummary()}`),
  });

  expect(result.degradedReason).toBeUndefined();
  expect(result.markdown.startsWith("## 检视总览")).toBe(true);
  expect(result.markdown).not.toContain("</think>");
});

test("只有思考与闭合标签、没有正式标题：仍回落确定性模板", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply("我们根据给的权威数据，还在思考。</think>"),
  });

  expect(result.degradedReason).toContain("rejected");
  expect(result.markdown.startsWith("## 检视总览")).toBe(true);
  expect(result.markdown).not.toContain("</think>");
  expect(result.markdown).not.toContain("我们根据给的权威数据");
});

test("思考草稿里带完整 ## 检视总览：闭合标签之前的内容也不得外发", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () =>
      modelReply(`我们根据给的权威数据起草总结。\n\n${validSummary()}\n</think>`),
  });

  expect(result.degradedReason).toContain("rejected");
  expect(result.markdown.startsWith("## 检视总览")).toBe(true);
  expect(result.markdown).not.toContain("</think>");
  expect(result.markdown).not.toContain("不安全重定向"); // 思考草稿里的正文
});

test("思考草稿的标题在闭合标签之前、正式文档在之后：取正式文档", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () =>
      modelReply(`我们根据给的权威数据起草。\n\n## 检视总览\n\n草稿内容\n</think>\n${validSummary()}`),
  });

  expect(result.degradedReason).toBeUndefined();
  expect(result.markdown.startsWith("## 检视总览")).toBe(true);
  expect(result.markdown).not.toContain("草稿内容");
  expect(result.markdown).toContain("不安全重定向");
});

test("平台实测泄漏形态（用户报告）：思考 + 闭合标签 + 标题同行 不外发", async () => {
  // 用户平台实测看到的形态：草稿文本 + 闭合标签 + "## 检视总览" 连在一行
  const closeTag = ["</thi", "nk>"].join("");
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(`xxxxxx。${closeTag}## 检视总览\n${validSummary()}`),
  });
  expect(result.markdown.startsWith("## 检视总览")).toBe(true);
  expect(result.markdown).not.toContain("xxxxxx");
  expect(result.markdown).not.toContain("我们根据");
});

test("标记变体带内部空白：同样剥掉思考包装", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(["思考草稿。</ thi", "nk>", validSummary()].join("\n")),
  });
  expect(result.degradedReason).toBeUndefined();
  expect(result.markdown.startsWith("## 检视总览")).toBe(true);
  expect(result.markdown).not.toContain("思考草稿");

  const spaced = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(["思考草稿。< /thi", "nk  >", validSummary()].join("\n")),
  });
  expect(spaced.degradedReason).toBeUndefined();
  expect(spaced.markdown.startsWith("## 检视总览")).toBe(true);
  expect(spaced.markdown).not.toContain("思考草稿");
});

test("整篇被代码围栏包住：剥围栏后照常通过", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(`\`\`\`markdown\n${validSummary()}\n\`\`\``),
  });

  expect(result.degradedReason).toBeUndefined();
  expect(result.markdown.startsWith("## 检视总览")).toBe(true);
  expect(result.markdown).not.toContain("```");
});

test("星级行之后的客套话被截掉（只保留到星级行为止）", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(`${validSummary()}\n\n以上是本次检视总结，感谢阅读。`),
  });

  expect(result.degradedReason).toBeUndefined();
  expect(result.markdown).not.toContain("感谢阅读");
  expect(result.markdown.trimEnd().endsWith("⭐⭐ — 存在 ≥1 条 major 或 fatal 意见")).toBe(true);
});

test("缺小节：拒绝模型回包，降级确定性模板并留痕", async () => {
  const withoutPriority = validSummary().replace(
    "### 高优先级意见速览\n\n1. [major] src/Foo.java:10 — 不安全重定向\n\n",
    "",
  );
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(withoutPriority),
  });

  expect(result.degradedReason).toContain("rejected");
  expect(result.degradedReason).toContain("missing or malformed sections");
  // 模板与规范同构：结构仍然完整
  expect(result.markdown).toContain("### 高优先级意见速览");
  expect(result.markdown).toContain("### 星级评价");
});

test("模型改判星级：拒绝回包（星级只复述，不得自行改判）", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(validSummary("⭐⭐⭐ — 0 条 fatal，0 条 major")),
  });

  expect(result.degradedReason).toContain("rejected");
  // 模板用权威星数覆盖模型的改判
  expect(result.markdown).toContain("⭐⭐ — 存在 ≥1 条 major 或 fatal 意见");
});

test("finish_reason=length：截断回包不外发，降级模板并留痕（方案二）", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(validSummary(), { finishReason: "length" }),
  });

  expect(result.degradedReason).toContain("finish_reason=length");
  expect(result.markdown).toContain("| major | 1 | src/Foo.java |");
});

test("星级行带列表符 / 加粗：仍按星数判定，不误伤合法回包", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () =>
      modelReply(validSummary("- **⭐⭐** — 存在 ≥1 条 major 或 fatal 意见")),
  });

  expect(result.degradedReason).toBeUndefined();
  expect(result.markdown).toContain("**⭐⭐**");
});

test("reasoning_tokens：透传为观测字段，不影响内容判定", async () => {
  const result = await buildReviewSummary({
    findings: [finding("src/Foo.java", "P1")],
    runtime: RUNTIME,
    fetch: async () => modelReply(validSummary(), { reasoningTokens: 7 }),
  });

  expect(result.degradedReason).toBeUndefined();
  expect(result.reasoningTokens).toBe(7);
});

// ---- 内容校验（ADR-0104 追加层）：结构对还不够，数字 / 清单 / 速览必须与权威一致 ----

const METRICS: ReviewSummaryMetrics = {
  changedFiles: 3,
  changedHunks: 5,
  changedLines: 120,
  modelCalls: 17,
  inputTokens: 41200,
};

/** 用降级模板取「权威内容」：与校验器共用同一套渲染单源 */
async function authoritativeSummary(
  findings: readonly Finding[],
  metrics?: ReviewSummaryMetrics,
): Promise<string> {
  const result = await buildReviewSummary({
    findings,
    ...(metrics !== undefined ? { metrics } : {}),
    runtime: RUNTIME,
    fetch: async () => new Response("boom", { status: 502 }),
  });
  expect(result.degradedReason).toContain("HTTP 502");
  return result.markdown;
}

test("权威模板回灌：结构 + 内容逐项一致时通过（渲染与校验共用单源）", async () => {
  const findings = [finding("src/A.java", "P1"), finding("src/B.java", "P0")];
  const template = await authoritativeSummary(findings, METRICS);

  const result = await buildReviewSummary({
    findings,
    metrics: METRICS,
    runtime: RUNTIME,
    fetch: async () => modelReply(template),
  });

  expect(result.degradedReason).toBeUndefined();
  expect(result.markdown).toBe(template.trimEnd());
});

test("总览数字与权威数据不一致：拒绝回包，模板使用权威值", async () => {
  const findings = [finding("src/A.java", "P1")];
  const template = await authoritativeSummary(findings, METRICS);
  const tampered = template.replace("17 次调用", "99 次调用");

  const result = await buildReviewSummary({
    findings,
    metrics: METRICS,
    runtime: RUNTIME,
    fetch: async () => modelReply(tampered),
  });

  expect(result.degradedReason).toContain("content does not match authoritative data");
  expect(result.markdown).toContain("| 预算使用 | 17 次调用 |");
});

test("总览表多出一行：拒绝（必须恰好三行）", async () => {
  const findings = [finding("src/A.java", "P1")];
  const template = await authoritativeSummary(findings, METRICS);
  const tampered = template.replace("| 资源加载 |", "| 其它 | 1 |\n| 资源加载 |");

  const result = await buildReviewSummary({
    findings,
    metrics: METRICS,
    runtime: RUNTIME,
    fetch: async () => modelReply(tampered),
  });

  expect(result.degradedReason).toContain("content does not match authoritative data");
});

test("意见分布的数量 / 文件清单与权威不一致：拒绝", async () => {
  const findings = [finding("src/A.java", "P1")];
  const template = await authoritativeSummary(findings);
  const countMismatch = template.replace("| major | 1 | src/A.java |", "| major | 2 | src/A.java |");
  const filesMismatch = template.replace(
    "| major | 1 | src/A.java |",
    "| major | 1 | src/A.java, src/Z.java |",
  );

  const countResult = await buildReviewSummary({
    findings,
    runtime: RUNTIME,
    fetch: async () => modelReply(countMismatch),
  });
  const filesResult = await buildReviewSummary({
    findings,
    runtime: RUNTIME,
    fetch: async () => modelReply(filesMismatch),
  });

  expect(countResult.degradedReason).toContain("content does not match authoritative data");
  expect(filesResult.degradedReason).toContain("content does not match authoritative data");
});

test("高优先级速览漏项：拒绝（条数必须与权威一致）", async () => {
  const findings = [finding("src/A.java", "P1"), finding("src/B.java", "P1")];
  const template = await authoritativeSummary(findings);
  const tampered = template
    .split("\n")
    .filter((line) => !line.startsWith("2. [major]"))
    .join("\n");

  const result = await buildReviewSummary({
    findings,
    runtime: RUNTIME,
    fetch: async () => modelReply(tampered),
  });

  expect(result.degradedReason).toContain("content does not match authoritative data");
});

test("高优先级速览的位置被改写：拒绝（顺序与 file:line 必须一致）", async () => {
  const findings = [finding("src/A.java", "P1")];
  const template = await authoritativeSummary(findings);
  const tampered = template.replace(
    "1. [major] src/A.java:10",
    "1. [major] src/Z.java:10",
  );

  const result = await buildReviewSummary({
    findings,
    runtime: RUNTIME,
    fetch: async () => modelReply(tampered),
  });

  expect(result.degradedReason).toContain("content does not match authoritative data");
});

test("没有 fatal/major 时速览必须恰好是「无。」：追加说明被拒绝", async () => {
  const findings = [finding("src/A.java", "P2")];
  const template = await authoritativeSummary(findings);
  const tampered = template.replace("无。", "无。\n\n补充说明：无需关注。");

  const result = await buildReviewSummary({
    findings,
    runtime: RUNTIME,
    fetch: async () => modelReply(tampered),
  });

  expect(result.degradedReason).toContain("content does not match authoritative data");
});

test("多出规定外的 ### 小节：直接拒绝", async () => {
  const findings = [finding("src/A.java", "P1")];
  const template = await authoritativeSummary(findings);
  const tampered = template.replace(
    "### 星级评价",
    "### 风险提示\n\n补充说明。\n\n### 星级评价",
  );

  const result = await buildReviewSummary({
    findings,
    runtime: RUNTIME,
    fetch: async () => modelReply(tampered),
  });

  expect(result.degradedReason).toContain("unexpected heading");
});
