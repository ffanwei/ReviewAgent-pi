import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  presentationSourceOf,
  projectReviewDocument,
  type ProjectionDeps,
  type ProjectionInput,
  type TerminologyContext,
} from "../../src/presentation/translate-projection.js";
import { TERMINOLOGY, TERMINOLOGY_VERSION } from "../../src/presentation/terminology.js";
import type { Finding, RunResult, ToolCallRecord } from "@baize/review-pi";

/**
 * 翻译投影单测（#13，生产化四必做之二——ADR-0010「英文产出 + 核外翻译投影」）：
 * 纯注入零 pi 依赖——fake 翻译引擎离线全覆盖（真引擎 = LLM/网关，消费端裁量
 * 装配，不在本票范围；零网络零密钥）。
 *
 * 锁定面（TDD 预先约定的接缝）：
 * - 字段分类单源真值：自然语言字段（Finding.title / Finding.description /
 *   ToolCallRecord.resultSummary）入引擎；结构化字段（id / severity（P0–P3 代码）/
 *   category / file / line / evidence[]（代码摘录）/ rule / confidence、工具
 *   name / argumentsJson）翻译前后逐字节相等（===）；
 * - 语言切换：en = 恒等直通零引擎调用（英文呈现档就是源文档本身）；zh = 引擎
 *   恰对每个非空自然语言字段调用一次、次序确定（finding 序 title→description，
 *   再 toolCall 序 resultSummary）、每次携带术语上下文；
 * - 投影留痕：呈现语言 + 术语表版本 + 源 finding 关联（一一对应可回溯）；
 * - 验证面 = 生产入口 E 形态（2026-10-19 决策评论 1；#11 P5b 对照报告 eb81397：
 *   E 为 pi 内核生产入口选型）——夹具即口径，零网关运行。
 */

/**
 * E 生产入口形态夹具（config E，Context Ledger 单遍直驱）：多条 finding、
 * title/description 英文叙述、evidence 含代码摘录、toolCallLog 含 resultSummary。
 * Finding 契约 config 无关——真实感英文产物即验证面口径。
 */
const E_FORM_FINDINGS: readonly Finding[] = [
  {
    id: "VUL4J-38-F1",
    severity: "P1",
    category: "SQL_INJECTION",
    file: "src/main/java/org/jasig/cas/client/util/HttpClient.java",
    line: 112,
    title: "SQL query assembled by concatenating user-controlled input",
    description:
      "The query at line 112 concatenates the request parameter directly into the SQL statement, " +
      "letting an attacker alter query semantics. Build the statement as a parameterized query instead.",
    evidence: [
      'L112: String sql = "SELECT * FROM users WHERE name=\'" + userName + "\'";',
      "symbol queryUsers(String userName) — reachable from PublicSearchController.search()",
    ],
    rule: "SQLI-001",
    confidence: 0.92,
  },
  {
    id: "VUL4J-38-F2",
    severity: "P2",
    category: "RESOURCE_LEAK",
    file: "src/main/java/org/jasig/cas/client/util/HttpClient.java",
    line: 87,
    title: "HTTP response entity not closed on the error path",
    description:
      "When execute() throws, the response entity obtained at line 87 is never closed, leaking the " +
      "connection. Wrap the call in try-finally and close the entity in the finally block.",
    evidence: [
      "L87-L95: HttpResponse resp = client.execute(get); if (resp.getStatusLine().getStatusCode() != 200) " +
        "{ throw new IOException(\"unexpected status\"); }",
    ],
    rule: "LEAK-014",
    confidence: 0.78,
  },
  {
    id: "VUL4J-38-F3",
    severity: "P3",
    category: "CODE_STYLE",
    file: "src/main/java/org/jasig/cas/client/util/HttpClient.java",
    line: 203,
    title: "Deprecated Date constructor used for the request timestamp",
    description:
      "new Date(int, int, int) is deprecated; prefer java.time.LocalDate.atStartOfDay() so the " +
      "timestamp stays correct across time zones.",
    evidence: ["L203: Date ts = new Date(121, 0, 1); // deprecated constructor"],
    rule: "STYLE-002",
    confidence: 0.55,
  },
];

const E_FORM_TOOL_CALL_LOG: readonly ToolCallRecord[] = [
  {
    name: "review.read_file",
    argumentsJson: '{"path":"src/main/java/org/jasig/cas/client/util/HttpClient.java"}',
    resultSummary:
      "Loaded 214 lines of HttpClient.java; the SQL builder and the response handling path are both inside this file.",
  },
  {
    name: "review.search_symbol",
    argumentsJson: '{"symbol":"queryUsers","scope":"org.jasig.cas.client"}',
    resultSummary:
      "Found 1 definition and 3 call sites of queryUsers; the controller call site passes an unescaped request parameter.",
  },
];

/** 空叙述 finding（边界夹具：description 空串的直通面） */
const ONE_FINDING_WITH_EMPTY_DESCRIPTION: Finding = {
  id: "VUL4J-38-F9",
  severity: "P3",
  category: "CODE_STYLE",
  file: "a.java",
  line: 1,
  title: "Unused import",
  description: "",
  evidence: ["L1: import java.util.List;"],
  rule: "STYLE-001",
  confidence: 0.4,
};

/** fake 引擎缝：捕获每次调用（文本 + 术语上下文）——断言调用次序与 en 直通零调用 */
function fakeEngine(
  translate: (text: string) => string = (text) => `【译】${text}`,
): {
  readonly deps: ProjectionDeps;
  readonly calls: { readonly text: string; readonly context: TerminologyContext }[];
} {
  const calls: { text: string; readonly context: TerminologyContext }[] = [];
  return {
    deps: {
      engine: async (text, context) => {
        calls.push({ text, context });
        return translate(text);
      },
    },
    calls,
  };
}

function projectionInput(overrides: Partial<ProjectionInput> = {}): ProjectionInput {
  return {
    source: { findings: E_FORM_FINDINGS, toolCallLog: E_FORM_TOOL_CALL_LOG },
    language: "zh",
    ...overrides,
  };
}

/** 最小 RunResult（presentationSourceOf 的输入面） */
function singleFormRunResult(): RunResult {
  return {
    caseId: "VUL4J-38",
    model: "deepseek-v4-flash",
    findings: E_FORM_FINDINGS,
    usage: { inputTokens: 118_400, outputTokens: 6_800, cacheReadTokens: 84_200 },
    rounds: 4,
    toolCalls: 6,
    audit: {
      requests: [],
      toolCallLog: E_FORM_TOOL_CALL_LOG,
      phaseLog: [],
      rejections: [],
      cacheBreaks: [],
      truncated: false,
      truncationReasons: [],
    },
  };
}

describe("projectReviewDocument — zh 翻译投影（E 生产入口形态）", () => {
  it("引擎恰对每个非空自然语言字段调用一次，次序确定：finding 序 title→description，再 toolCall 序 resultSummary", async () => {
    const harness = fakeEngine();
    await projectReviewDocument(harness.deps, projectionInput());

    expect(harness.calls.map((call) => call.text)).toEqual([
      E_FORM_FINDINGS[0]?.title,
      E_FORM_FINDINGS[0]?.description,
      E_FORM_FINDINGS[1]?.title,
      E_FORM_FINDINGS[1]?.description,
      E_FORM_FINDINGS[2]?.title,
      E_FORM_FINDINGS[2]?.description,
      E_FORM_TOOL_CALL_LOG[0]?.resultSummary,
      E_FORM_TOOL_CALL_LOG[1]?.resultSummary,
    ]);
  });

  it("每次调用携带术语上下文：目标语言 zh + 单源术语表（同一引用）+ 版本号", async () => {
    const harness = fakeEngine();
    await projectReviewDocument(harness.deps, projectionInput());

    expect(harness.calls.length).toBeGreaterThan(0);
    for (const call of harness.calls) {
      expect(call.context.targetLanguage).toBe("zh");
      expect(call.context.terminologyVersion).toBe(TERMINOLOGY_VERSION);
      // 单源直传：引擎拿到的就是 terminology.ts 的同一份表（不是拷贝再拼）
      expect(call.context.entries).toBe(TERMINOLOGY);
    }
  });

  it("自然语言字段已译，结构化字段翻译前后逐字节相等（===；evidence 代码摘录逐元素相等）", async () => {
    const harness = fakeEngine();
    const projected = await projectReviewDocument(harness.deps, projectionInput());

    expect(projected.findings).toHaveLength(E_FORM_FINDINGS.length);
    for (const [index, source] of E_FORM_FINDINGS.entries()) {
      const projectedFinding = projected.findings[index];
      if (projectedFinding === undefined || source === undefined) {
        throw new Error(`fixture mismatch at findings[${index}]`);
      }
      // 自然语言字段（唯一可翻译面）已译
      expect(projectedFinding.title).toBe(`【译】${source.title}`);
      expect(projectedFinding.description).toBe(`【译】${source.description}`);
      // 结构化字段绝不翻译：逐字节相等（===）
      expect(projectedFinding.id).toBe(source.id);
      expect(projectedFinding.severity).toBe(source.severity);
      expect(projectedFinding.category).toBe(source.category);
      expect(projectedFinding.file).toBe(source.file);
      expect(projectedFinding.line).toBe(source.line);
      expect(projectedFinding.rule).toBe(source.rule);
      expect(projectedFinding.confidence).toBe(source.confidence);
      // 证据代码摘录逐元素逐字节相等
      expect(projectedFinding.evidence).toHaveLength(source.evidence.length);
      for (const [evidenceIndex, excerpt] of source.evidence.entries()) {
        expect(projectedFinding.evidence[evidenceIndex]).toBe(excerpt);
      }
      // 投影侧 finding 仍契约同形——不新增字段（语言键不落 finding 面）
      expect(Object.keys(projectedFinding).sort()).toEqual(Object.keys(source).sort());
    }

    expect(projected.toolCallLog).toHaveLength(E_FORM_TOOL_CALL_LOG.length);
    for (const [index, source] of E_FORM_TOOL_CALL_LOG.entries()) {
      const projectedRecord = projected.toolCallLog[index];
      if (projectedRecord === undefined || source === undefined) {
        throw new Error(`fixture mismatch at toolCallLog[${index}]`);
      }
      expect(projectedRecord.resultSummary).toBe(`【译】${source.resultSummary}`);
      expect(projectedRecord.name).toBe(source.name);
      expect(projectedRecord.argumentsJson).toBe(source.argumentsJson);
    }
  });

  it("投影留痕：呈现语言 + 术语表版本 + 源 finding 关联（源 id = 投影 id，同长同序一一对应可回溯）", async () => {
    const harness = fakeEngine();
    const projected = await projectReviewDocument(harness.deps, projectionInput());

    expect(projected.provenance).toEqual({
      language: "zh",
      terminologyVersion: TERMINOLOGY_VERSION,
      findingLinks: E_FORM_FINDINGS.map((finding) => ({
        sourceFindingId: finding.id,
        projectedFindingId: finding.id,
      })),
    });
    // 零漂移：全量成功时降级键整键缺席（不是空数组占位）
    expect("degradedFields" in projected.provenance).toBe(false);
    expect("degradedReason" in projected.provenance).toBe(false);
    // 可回溯性：留痕关联与投影侧 findings 一一对应
    for (const [index, link] of projected.provenance.findingLinks.entries()) {
      expect(link.projectedFindingId).toBe(projected.findings[index]?.id);
      expect(link.sourceFindingId).toBe(E_FORM_FINDINGS[index]?.id);
    }
  });

  it("源文档不可变（投影零改动入参——不可变纪律）", async () => {
    const before = JSON.stringify({ findings: E_FORM_FINDINGS, toolCallLog: E_FORM_TOOL_CALL_LOG });
    const harness = fakeEngine();
    await projectReviewDocument(harness.deps, projectionInput());
    expect(JSON.stringify({ findings: E_FORM_FINDINGS, toolCallLog: E_FORM_TOOL_CALL_LOG })).toBe(before);
  });
});

describe("projectReviewDocument — en 恒等直通（零引擎调用）", () => {
  it("零引擎调用；呈现文档就是源文档本身（findings / toolCallLog 同引用直通）", async () => {
    const harness = fakeEngine();
    const projected = await projectReviewDocument(harness.deps, projectionInput({ language: "en" }));

    expect(harness.calls).toEqual([]);
    expect(projected.findings).toBe(E_FORM_FINDINGS);
    expect(projected.toolCallLog).toBe(E_FORM_TOOL_CALL_LOG);
  });

  it("en 档留痕同样完整（语言 en + 术语表版本 + 源 finding 关联）", async () => {
    const harness = fakeEngine();
    const projected = await projectReviewDocument(harness.deps, projectionInput({ language: "en" }));

    expect(projected.provenance.language).toBe("en");
    expect(projected.provenance.terminologyVersion).toBe(TERMINOLOGY_VERSION);
    expect(projected.provenance.findingLinks.map((link) => link.projectedFindingId)).toEqual(
      E_FORM_FINDINGS.map((finding) => finding.id),
    );
  });
});

describe("projectReviewDocument — 边界与失败路径", () => {
  it("空自然语言字段直通零调用（无事可译——不把空串喂引擎）", async () => {
    const harness = fakeEngine();
    const projected = await projectReviewDocument(harness.deps, {
      source: { findings: [ONE_FINDING_WITH_EMPTY_DESCRIPTION], toolCallLog: [] },
      language: "zh",
    });

    expect(harness.calls.map((call) => call.text)).toEqual([ONE_FINDING_WITH_EMPTY_DESCRIPTION.title]);
    expect(projected.findings[0]?.description).toBe("");
  });

  it("引擎对某个非空字段返回空串 → 该字段保留英文，其余字段照常翻译（部分降级）", async () => {
    let callIndex = 0;
    const harness = fakeEngine((text) => {
      callIndex += 1;
      // 第 2 次调用 = findings[0].description
      return callIndex === 2 ? "" : `【译】${text}`;
    });
    const projected = await projectReviewDocument(harness.deps, projectionInput());

    expect(projected.findings[0]?.title).toBe(`【译】${E_FORM_FINDINGS[0]?.title}`);
    expect(projected.findings[0]?.description).toBe(E_FORM_FINDINGS[0]?.description);
    // 后续字段不受影响（不是整次降级）
    expect(projected.findings[1]?.title).toBe(`【译】${E_FORM_FINDINGS[1]?.title}`);
    expect(projected.toolCallLog[0]?.resultSummary).toBe(
      `【译】${E_FORM_TOOL_CALL_LOG[0]?.resultSummary}`,
    );
    expect(projected.provenance.degradedFields).toEqual(["findings[0].description"]);
    expect(projected.provenance.degradedReason).toContain("empty translation");
  });

  it("引擎返回纯空白 → 与空译文同罪：该字段保留英文（部分降级）", async () => {
    let callIndex = 0;
    const harness = fakeEngine((text) => {
      callIndex += 1;
      return callIndex === 1 ? "   " : `【译】${text}`;
    });
    const projected = await projectReviewDocument(harness.deps, projectionInput());

    expect(projected.findings[0]?.title).toBe(E_FORM_FINDINGS[0]?.title);
    expect(projected.findings[0]?.description).toBe(`【译】${E_FORM_FINDINGS[0]?.description}`);
    expect(projected.provenance.degradedFields).toEqual(["findings[0].title"]);
  });

  it("工具摘要译文为空 → 只影响该条工具摘要，findings 段照常翻译", async () => {
    let callIndex = 0;
    const harness = fakeEngine((text) => {
      callIndex += 1;
      // 第 7 次调用 = toolCallLog[0].resultSummary（前 6 次 = 3 findings × title/description）
      return callIndex === 7 ? "" : `【译】${text}`;
    });
    const projected = await projectReviewDocument(harness.deps, projectionInput());

    expect(projected.findings.every((finding) => finding.title.startsWith("【译】"))).toBe(true);
    expect(projected.toolCallLog[0]?.resultSummary).toBe(E_FORM_TOOL_CALL_LOG[0]?.resultSummary);
    expect(projected.toolCallLog[1]?.resultSummary).toBe(
      `【译】${E_FORM_TOOL_CALL_LOG[1]?.resultSummary}`,
    );
    expect(projected.provenance.degradedFields).toEqual(["toolCallLog[0].resultSummary"]);
  });

  it("引擎连续抛错 → 探测第 2 个字段后短路，剩余字段全部保留英文（有界快速回退）", async () => {
    let calls = 0;
    const deps: ProjectionDeps = {
      engine: async () => {
        calls += 1;
        throw new Error("connect ECONNREFUSED");
      },
    };
    const projected = await projectReviewDocument(deps, projectionInput());

    // 单次抛错先按内容级失败隔离；连续第 2 次抛错才判定系统级并短路
    expect(calls).toBe(2);
    expect(projected.findings).toEqual(E_FORM_FINDINGS);
    expect(projected.toolCallLog).toEqual(E_FORM_TOOL_CALL_LOG);
    expect(projected.provenance.degradedFields).toHaveLength(8);
    expect(projected.provenance.degradedFields?.[0]).toBe("findings[0].title");
    expect(projected.provenance.degradedReason).toContain("connect ECONNREFUSED");
  });

  it("引擎单次抛错 → 只回退该字段，下一字段成功即继续翻译（内容级失败隔离）", async () => {
    let calls = 0;
    const deps: ProjectionDeps = {
      engine: async (text) => {
        calls += 1;
        // 第 1 次调用 = findings[0].title：单条 4xx，不应拖垮后续字段
        if (calls === 1) {
          throw new Error("HTTP 400 bad input");
        }
        return `【译】${text}`;
      },
    };
    const projected = await projectReviewDocument(deps, projectionInput());

    expect(calls).toBe(8);
    // 仅首个字段保留英文，其余全部译出
    expect(projected.findings[0]?.title).toBe(E_FORM_FINDINGS[0]?.title);
    expect(projected.findings[0]?.description).toBe(
      `【译】${E_FORM_FINDINGS[0]?.description}`,
    );
    expect(projected.findings[1]?.title).toBe(`【译】${E_FORM_FINDINGS[1]?.title}`);
    expect(projected.toolCallLog[0]?.resultSummary).toBe(
      `【译】${E_FORM_TOOL_CALL_LOG[0]?.resultSummary}`,
    );
    expect(projected.provenance.degradedFields).toEqual(["findings[0].title"]);
    expect(projected.provenance.degradedReason).toContain("HTTP 400 bad input");
  });

  it("连续 3 个字段空译文 → 判定系统性失败，剩余字段不再调用引擎", async () => {
    let calls = 0;
    const deps: ProjectionDeps = {
      engine: async () => {
        calls += 1;
        return "";
      },
    };
    const projected = await projectReviewDocument(deps, projectionInput());

    expect(calls).toBe(3);
    expect(projected.provenance.degradedFields).toHaveLength(8);
    expect(projected.provenance.degradedReason).toContain("empty translation");
  });

  it("自然语言字段非字符串（畸形源文档）→ 抛错指名字段路径", async () => {
    const malformed = { ...ONE_FINDING_WITH_EMPTY_DESCRIPTION, title: 42 as unknown as string };
    const harness = fakeEngine();
    await expect(
      projectReviewDocument(harness.deps, {
        source: { findings: [malformed], toolCallLog: [] },
        language: "zh",
      }),
    ).rejects.toThrow("findings[0].title");
  });

  it.each([
    ["language 非法", { language: "fr" }],
    ["source 缺席", { source: undefined }],
    ["findings 非数组", { source: { findings: "nope", toolCallLog: [] } }],
    ["toolCallLog 非数组", { source: { findings: [], toolCallLog: "nope" } }],
  ])("入参形状校验（装配面 fail fast）：%s → 抛装配错误且零引擎调用", async (_label, overrides) => {
    const harness = fakeEngine();
    await expect(
      projectReviewDocument(harness.deps, projectionInput(overrides as Partial<ProjectionInput>)),
    ).rejects.toThrow("translate projection");
    expect(harness.calls).toEqual([]);
  });
});

describe("presentationSourceOf — RunResult 呈现面圈定（端到端）", () => {
  it("从 RunResult 圈出呈现源（findings + audit.toolCallLog 引用直通），可直接进 zh 投影", async () => {
    const result = singleFormRunResult();
    const source = presentationSourceOf(result);
    expect(source.findings).toBe(result.findings);
    expect(source.toolCallLog).toBe(result.audit.toolCallLog);

    const harness = fakeEngine();
    const projected = await projectReviewDocument(harness.deps, { source, language: "zh" });
    expect(projected.provenance.language).toBe("zh");
    expect(projected.findings[0]?.title).toBe(`【译】${E_FORM_FINDINGS[0]?.title}`);
    expect(projected.findings[0]?.id).toBe("VUL4J-38-F1");
  });
});

describe("模块纪律（零 pi 内核运行时依赖——核外呈现层）", () => {
  it("src/presentation 模块的 import 面只有相对路径 / node: 内建 / 本仓 review-pi", async () => {
    // engine-zh.ts 是核外真引擎装配：翻译/建议走自持 `fetch`（不依赖任何
    // 共享 LLM 客户端包），ADR-0010 把「语言」定成核外呈现关注点。
    // ADR-0024：共享契约（Finding / RunResult / ToolCallRecord）以 review-pi
    // 为单源真值；ADR-0051：重试原语（shared/llm-retry）也由 review-pi 导出，
    // 呈现引擎逐请求复用同一份分类 / 退避逻辑。故 review-pi 允许 type-only
    // 与运行时 import；**pi 内核四包（@earendil-works/*）运行时仍禁止**。
    const moduleNames = ["translate-projection.ts", "terminology.ts", "engine-zh.ts"];
    for (const moduleName of moduleNames) {
      const modulePath = fileURLToPath(new URL(`../../src/presentation/${moduleName}`, import.meta.url));
      const source = await readFile(modulePath, "utf8");
      // 扫描器健全性：文件确实读到内容（纯数据模块可以零 import——纪律空集即成立）
      expect(source.length, `${moduleName} should be readable and non-empty`).toBeGreaterThan(0);
      const statements = [...source.matchAll(/import\s+(type\s+)?[^;]*?from\s+["']([^"']+)["']/g)];
      for (const statement of statements) {
        const specifier = statement[2] ?? "";
        // 只允许 root 内相对路径、node: 内建与本仓 review-pi；
        // @earendil-works（pi 四包）/ packages/ 转译路径全部禁止。
        const allowed =
          specifier.startsWith(".") ||
          specifier.startsWith("node:") ||
          specifier === "@baize/review-pi";
        expect(allowed, `${moduleName} imports "${specifier}"`).toBe(true);
        expect(specifier, `${moduleName} imports "${specifier}"`).not.toMatch(/@earendil-works|packages\//);
      }
    }
  });
});
