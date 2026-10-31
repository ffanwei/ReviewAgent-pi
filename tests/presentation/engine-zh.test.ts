import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test, vi } from "vitest";

import { createGatewayTranslateEngine } from "../../src/presentation/engine-zh.js";
import projectZhPresentation from "../../src/presentation/engine-zh.js";
import type { Finding, PresentationRuntime, RunResult, ToolCallRecord } from "review-pi";
import { TERMINOLOGY, TERMINOLOGY_VERSION } from "../../src/presentation/terminology.js";

// 真引擎装配单测（ADR-0010 消费端接线件）：网关引擎的请求形状 / 译文回填 /
// 错误人话（全注入 fake fetch，零网络）；default export 的装配接线
// （runtime 显式穿参 → projectReviewDocument zh 档 → 结构化字段直通）。
// key 纪律：哨兵 key 只允许出现在 Authorization 头（错误消息与译文绝不含 key）。
// ADR-0025：引擎零环境变量读取——runtime 是唯一接入点（env 设了也不该生效）。

const SENTINEL_KEY = "sk-presentation-engine-sentinel-a1";

/** OpenAI 兼容成功响应（非流式 completion） */
function completionResponse(content: string): Response {
  return new Response(
    JSON.stringify({
      model: "fake",
      choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    }),
    { status: 200, headers: { "content-type": "application/json" } },
  );
}

/** 引擎装配入参（fake fetch 缺省回一个可区分的译文） */
function engineOptions(overrides: Partial<Parameters<typeof createGatewayTranslateEngine>[0]> = {}) {
  return {
    endpointUrl: "https://gw.example.com/v1/chat/completions",
    apiKey: SENTINEL_KEY,
    modelId: "test-model",
    fetchFn: vi.fn(async () => completionResponse("【译】")),
    ...overrides,
  };
}

/** TerminologyContext（术语表单源取真实值——断言引擎消费单源词表） */
const CONTEXT = {
  targetLanguage: "zh" as const,
  terminologyVersion: TERMINOLOGY_VERSION,
  entries: TERMINOLOGY,
};

// ---- createGatewayTranslateEngine：请求形状与错误路径 ----

test("请求形状：POST completions + Bearer 哨兵 + model/messages/temperature/stream:false + 术语表进 system", async () => {
  const options = engineOptions();
  const engine = createGatewayTranslateEngine(options);
  const translated = await engine("TypeVariable branch feeds unresolved type", CONTEXT);

  expect(translated).toBe("【译】");
  expect(options.fetchFn).toHaveBeenCalledTimes(1);
  const [url, init] = (options.fetchFn as ReturnType<typeof vi.fn>).mock.calls[0] as [
    string,
    RequestInit,
  ];
  expect(url).toBe("https://gw.example.com/v1/chat/completions");
  expect(init.method).toBe("POST");
  // key 只进 Authorization 头
  expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${SENTINEL_KEY}`);
  const body = JSON.parse(String(init.body)) as {
    model: string;
    messages: { role: string; content: string }[];
    stream: boolean;
    temperature: number;
  };
  expect(body.model).toBe("test-model");
  expect(body.stream).toBe(false);
  expect(body.temperature).toBe(0);
  // 单请求超时已接线（AbortSignal——网关挂死时请求有界，而非无限等）
  expect(init.signal).toBeInstanceOf(AbortSignal);
  expect(init.signal?.aborted).toBe(false);
  // user = 待译文本原样；system = 翻译口径 + 术语表（单源真实词表条目在场）
  expect(body.messages[1]).toEqual({ role: "user", content: "TypeVariable branch feeds unresolved type" });
  expect(body.messages[0]?.role).toBe("system");
  expect(body.messages[0]?.content).toContain("简体中文");
  expect(body.messages[0]?.content).toContain("P0–P3");
  expect(body.messages[0]?.content).toContain("Finding → 检视结论");
  expect(body.messages[0]?.content).toContain(`v${TERMINOLOGY_VERSION}`);
});

test("非 2xx → 人话错误（HTTP 状态 + 报文摘要；不含 key）", async () => {
  const options = engineOptions({
    fetchFn: vi.fn(
      async () => new Response(JSON.stringify({ error: { message: "rate limited" } }), { status: 429 }),
    ),
  });
  const engine = createGatewayTranslateEngine(options);
  const failure = engine("some text", CONTEXT);
  await expect(failure).rejects.toThrow("HTTP 429");
  await expect(failure).rejects.toThrow("rate limited");
  await expect(failure).rejects.not.toThrow(SENTINEL_KEY);
});

test("空 completion → 人话错误（零静默丢内容由投影模块与引擎双层拒绝）", async () => {
  const options = engineOptions({ fetchFn: vi.fn(async () => completionResponse("   ")) });
  const engine = createGatewayTranslateEngine(options);
  await expect(engine("some text", CONTEXT)).rejects.toThrow("empty completion");
});

test("2xx 但报文非 JSON → 人话错误（网关返回 HTML 错误页等形态）", async () => {
  const options = engineOptions({
    fetchFn: vi.fn(
      async () => new Response("<html>gateway error page</html>", { status: 200, headers: { "content-type": "text/html" } }),
    ),
  });
  const engine = createGatewayTranslateEngine(options);
  await expect(engine("some text", CONTEXT)).rejects.toThrow("non-JSON body");
});

test("网络异常 → 人话错误（fetch 抛错映射）", async () => {
  const options = engineOptions({
    fetchFn: vi.fn(async () => {
      throw new Error("connect ECONNREFUSED");
    }),
  });
  const engine = createGatewayTranslateEngine(options);
  await expect(engine("some text", CONTEXT)).rejects.toThrow("request failed");
  await expect(engine("some text", CONTEXT)).rejects.toThrow("ECONNREFUSED");
});

// ---- projectZhPresentation（default export）：装配接线集成 ----

/** 呈现运行时接入点（ADR-0025：CLI 从配置快照解析后显式穿参） */
const RUNTIME: PresentationRuntime = {
  apiKey: SENTINEL_KEY,
  baseUrl: "https://gw.example.com/v1",
  modelId: "test-model",
  concurrency: 4,
  requestTimeoutMs: 90_000,
};

/** 一次检视产物的呈现源（结构化 + 自然语言字段各就各位） */
function sampleSource() {
  const finding: Finding = {
    id: "F001",
    severity: "P2",
    category: "CORRECTNESS",
    file: "src/Main.java",
    line: 177,
    title: "TypeVariable branch feeds an unresolved TypeVariable to parseArray",
    description: "The fix changes the argument passed to parseArray(componentType, array, fieldName).",
    evidence: ["ObjectArrayCodec.java:177: parser.parseArray(componentType, array, fieldName);"],
    rule: "CORRECTNESS-001",
    confidence: 0.4,
  };
  const toolCallLog: ToolCallRecord[] = [
    { name: "review.readFile", argumentsJson: "{\"path\":\"src/Main.java\"}", resultSummary: "read the changed hunk" },
  ];
  return { findings: [finding], toolCallLog, runtime: RUNTIME };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

test("default export：runtime 显式穿参 → zh 档投影（自然语言译、结构化直通、provenance 留痕）", async () => {
  const calls: { url: string; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const body = String(init?.body);
      calls.push({ url: String(url), body });
      // ADR-0017：建议生成是第二类调用（system 含「修复建议作者」）
      return completionResponse(body.includes("修复建议作者") ? "改为判空后再取值" : "【中译】");
    }),
  );

  const projected = await projectZhPresentation(sampleSource());

  // 全部自然语言字段各一次调用（1 finding × title/description + 1 toolCall × resultSummary = 3）
  // + 建议生成 1 次（ADR-0017：每条 finding 一次）
  expect(calls).toHaveLength(4);
  for (const call of calls) {
    expect(call.url).toBe("https://gw.example.com/v1/chat/completions");
    const body = JSON.parse(call.body) as { model: string };
    expect(body.model).toBe(RUNTIME.modelId);
  }
  // 译文回填：仅自然语言字段；结构化字段字节直通
  expect(projected.findings).toHaveLength(1);
  expect(projected.findings[0]).toMatchObject({
    id: "F001",
    severity: "P2",
    category: "CORRECTNESS",
    file: "src/Main.java",
    line: 177,
    title: "【中译】",
    description: "【中译】",
    evidence: ["ObjectArrayCodec.java:177: parser.parseArray(componentType, array, fieldName);"],
    rule: "CORRECTNESS-001",
    confidence: 0.4,
  });
  expect(projected.toolCallLog[0]).toMatchObject({
    name: "review.readFile",
    argumentsJson: "{\"path\":\"src/Main.java\"}",
    resultSummary: "【中译】",
  });
  // provenance 留痕（投影自带，术语表版本单源）
  expect(projected.provenance).toEqual({
    language: "zh",
    terminologyVersion: TERMINOLOGY_VERSION,
    findingLinks: [{ sourceFindingId: "F001", projectedFindingId: "F001" }],
  });
  // 分组意见（ADR-0017）：10 键封闭 + 映射表逐值
  expect(projected.tips).toEqual({
    files: [
      {
        filePath: "src/Main.java",
        reviewTips: [
          {
            code: "",
            review: "【中译】。【中译】",
            suggestion: "改为判空后再取值",
            category: "CORRECTNESS",
            subcategory: "",
            severity: "Minor",
            ruleId: "",
            lineNum: 177,
            source: "common-reviewer",
            confidence: "Low",
          },
        ],
      },
    ],
  });
});

test("default export：环境变量已关闭——REVIEWER_* / REVIEW_PI_* 设了也不生效（runtime 是唯一接入点）", async () => {
  vi.stubEnv("REVIEWER_URL", "https://env-should-be-ignored.example.com/v1");
  vi.stubEnv("REVIEWER_API_KEY", "sk-env-should-be-ignored");
  vi.stubEnv("REVIEW_PI_PRESENTATION_MODEL", "env-presentation-model");
  const calls: { url: string; headers: Record<string, string>; body: string }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      calls.push({
        url: String(url),
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: String(init?.body),
      });
      return completionResponse("【中译】");
    }),
  );

  await projectZhPresentation(sampleSource());

  expect(calls.length).toBeGreaterThan(0);
  for (const call of calls) {
    expect(call.url).toBe("https://gw.example.com/v1/chat/completions");
    expect(call.headers.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
    expect((JSON.parse(call.body) as { model: string }).model).toBe(RUNTIME.modelId);
  }
});

test("default export：同文件同行多条 finding → tips 只留首条，且只为它生成 suggestion（ADR-0023）", async () => {
  const suggestionCalls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      const body = String(init?.body);
      if (body.includes("修复建议作者")) {
        suggestionCalls.push(body);
        return completionResponse("改为判空后再取值");
      }
      return completionResponse("【中译】");
    }),
  );
  const base = sampleSource().findings[0] as Finding;
  const projected = await projectZhPresentation({
    findings: [
      base,
      { ...base, id: "F002", title: "duplicate view of the same line", severity: "P0" },
      { ...base, id: "F003", line: 178, title: "another line" },
    ],
    toolCallLog: [],
    runtime: RUNTIME,
  });

  // 输出去重：line 177 只出现一次（保留首条 F001，不因 P0 择优）
  const tips = projected.tips.files.flatMap((group) => group.reviewTips);
  expect(tips.map((tip) => tip.lineNum)).toEqual([177, 178]);
  expect(tips[0]?.severity).toBe("Minor");
  // 建议只为保留行生成：2 条（不是 3 条）
  expect(suggestionCalls).toHaveLength(2);
});

test("default export：runtime 缺席 → 装配期人话错误（CLI 缝归呈现降级）", async () => {
  await expect(
    projectZhPresentation({ findings: [], toolCallLog: [] }),
  ).rejects.toThrow("presentation runtime is missing");
});

test("default export：runtime apiKey 为空 → 装配期人话错误（不回落环境变量）", async () => {
  vi.stubEnv("REVIEWER_API_KEY", SENTINEL_KEY);
  await expect(
    projectZhPresentation({ findings: [], toolCallLog: [], runtime: { ...RUNTIME, apiKey: "  " } }),
  ).rejects.toThrow("apiKey is missing");
});

test("default export：codeByFinding 填 code、规则包 frontmatter id 建白名单、RULE-CHECK@ 前缀判 rule-reviewer", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL, init?: RequestInit) =>
      completionResponse(String(init?.body).includes("修复建议作者") ? "改用 PreparedStatement" : "【中译】"),
    ),
  );
  const packRoot = await mkdtemp(path.join(tmpdir(), "review-tips-pack-"));
  try {
    const rulesDir = path.join(packRoot, "general-code-review", "rules");
    await mkdir(rulesDir, { recursive: true });
    await writeFile(
      path.join(rulesDir, "07-sql-injection.md"),
      "---\nid: GEN-SQL-001\ntitle: Query built by string concatenation\n---\n\nbody\n",
      "utf8",
    );
    const finding: Finding = {
      id: "RULE-CHECK@general-code-review@src/Main.java:88",
      severity: "P0",
      category: "ERROR-HANDLING",
      file: "src/Main.java",
      line: 88,
      title: "Swallowed exception",
      description: "The catch block discards the error.",
      evidence: ["Main.java:88: catch (Exception e) { }"],
      rule: "GEN-SQL-001",
      confidence: 0.9,
    };
    const projected = await projectZhPresentation({
      findings: [finding],
      toolCallLog: [],
      codeByFinding: { [finding.id]: "catch (Exception e) { }" },
      rulePackDirs: [packRoot],
      runtime: RUNTIME,
    });
    const tip = projected.tips.files[0]?.reviewTips[0];
    expect(tip).toMatchObject({
      code: "catch (Exception e) { }",
      suggestion: "改用 PreparedStatement",
      severity: "Fatal",
      ruleId: "GEN-SQL-001",
      source: "rule-reviewer",
      confidence: "High",
    });
  } finally {
    await rm(packRoot, { recursive: true, force: true });
  }
});

test("default export：单条建议生成失败 ⇒ 该条 suggestion 空串，zh 投影照常（弱耦合）", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url: string | URL, init?: RequestInit) => {
      if (String(init?.body).includes("修复建议作者")) {
        throw new Error("connect ECONNREFUSED");
      }
      return completionResponse("【中译】");
    }),
  );

  const projected = await projectZhPresentation(sampleSource());

  expect(projected.findings[0]?.title).toBe("【中译】");
  expect(projected.tips.files[0]?.reviewTips[0]?.suggestion).toBe("");
  expect(projected.tips.files[0]?.reviewTips[0]?.review).toBe("【中译】。【中译】");
});

// 类型形状锚定：default export 即 CLI 缝协议（(source + runtime) => ProjectedReviewDocument）
const _typeAnchor: (
  source: Pick<RunResult, "findings"> & {
    toolCallLog: readonly ToolCallRecord[];
    runtime: PresentationRuntime;
  },
) => Promise<unknown> = projectZhPresentation;
void _typeAnchor;
