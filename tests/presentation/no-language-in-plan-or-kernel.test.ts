import { describe, expect, expectTypeOf, it } from "vitest";
import type { ReviewRunInput, RunResult } from "review-pi";

/**
 * 检视面语言回归断言（#13 AC3 / ADR-0010，ADR-0024 后对齐唯一形态）：语言不进
 * 检视执行缝。检视产物恒英文由「无语言参数化缝」结构性保证——语言是呈现配置
 * （核外翻译投影，src/presentation/translate-projection.ts），不是检视行为。
 *
 * 双形态断言（形态互补，各执法一面）：
 * - 类型级守卫（expectTypeOf + pnpm typecheck 执法）：ReviewRunInput / RunResult
 *   键面无 "language" / "lang"——有人往契约开语言缝时 typecheck 红；
 * - 实例级深键扫描（运行时执法）：真实可校验的执行缝入参（含规则 Skill 输入面）
 *   与运行结果（含嵌套 audit）JSON 化后递归收集全部键，/lang(uage)?/i 零命中——
 *   防类型面之外的原始 JSON 旁路。
 *
 * 「锁 en」的实现即「无语言键」：不存在能把检视切到其他语言的开关。
 */

/** 深键收集（数组穿透、对象递归；只判键不判值——语言参数化的形态是键） */
function collectKeysDeep(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const item of value) {
      collectKeysDeep(item, into);
    }
    return into;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      into.add(key);
      collectKeysDeep(child, into);
    }
  }
  return into;
}

/** 语言参数化键判定（大小写不敏感；lang / language 两形） */
function languageKeys(keys: ReadonlySet<string>): string[] {
  return [...keys].filter((key) => /^lang(uage)?$/i.test(key));
}

/** 传输层桩（键扫描不看值；只为让入参满足 ReviewRunInput 的非可选面） */
const fetchStub: ReviewRunInput["fetch"] = () => Promise.resolve(new Response("{}"));

/** 全键面执行缝入参（可选键全部在场——语言缝若藏在可选键里也会被扫到） */
const REVIEW_RUN_INPUT: ReviewRunInput = {
  caseId: "VUL4J-38",
  repoPath: "D:/fixtures/vul4j-repos/VUL4J-38",
  diff: "--- a/x.java\n+++ b/x.java\n@@ -1 +1 @@\n-old\n+new\n",
  issueDescription: "Vulnerability CVE-2014-4172 (CWE-74) in jasig/cas-client.",
  apiKey: "offline-test",
  baseUrl: "https://gw.example.com/v1",
  modelId: "deepseek-v4-flash",
  fetch: fetchStub,
  runsRoot: "D:/fixtures/runs/lang-regression",
  experimentId: "review-pi-cli",
  rep: 1,
  persistRecord: true,
  startedAt: new Date(0),
  ruleSkillZip: "packs/rules.zip",
  ruleSkillZips: ["packs/rules.zip"],
  ruleSkillDirs: ["packs/general-code-review"],
  ruleSkillName: "general-code-review",
  strictRuleSkill: false,
};

/** 运行结果样本（含嵌套 audit：契约键面全量覆盖） */
const RUN_RESULT: RunResult = {
  caseId: "VUL4J-38",
  model: "deepseek-v4-flash",
  findings: [],
  usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 },
  rounds: 1,
  toolCalls: 0,
  audit: {
    requests: [],
    toolCallLog: [],
    phaseLog: [],
    rejections: [],
    cacheBreaks: [],
    truncated: false,
    truncationReasons: [],
    ledger: [],
    ruleSkill: [],
    skillPassLog: [],
  },
  auditPath: "D:/fixtures/runs/lang-regression/audit.json",
};

describe("检视执行缝无语言键（不存在切语言的开关）", () => {
  it("类型级守卫：ReviewRunInput 键面无 language / lang", () => {
    expectTypeOf<Extract<keyof ReviewRunInput, "language" | "lang">>().toBeNever();
  });

  it("实例级深键扫描：全键面入参 JSON 化产物无语言键", () => {
    const keys = collectKeysDeep(JSON.parse(JSON.stringify(REVIEW_RUN_INPUT)));
    // 扫描器健全性：确实收集到了顶层与可选键，空集绿不算数
    expect(keys.has("caseId")).toBe(true);
    expect(keys.has("ruleSkillDirs")).toBe(true);
    expect(languageKeys(keys)).toEqual([]);
  });
});

describe("运行结果契约无语言键（审计投影不带语言）", () => {
  it("类型级守卫：RunResult 键面无 language / lang", () => {
    expectTypeOf<Extract<keyof RunResult, "language" | "lang">>().toBeNever();
  });

  it("实例级深键扫描：嵌套 audit 的 JSON 化产物无语言键", () => {
    const keys = collectKeysDeep(JSON.parse(JSON.stringify(RUN_RESULT)));
    // 扫描器健全性：嵌套对象确实被收集（audit / usage）
    expect(keys.has("audit")).toBe(true);
    expect(keys.has("ruleSkill")).toBe(true);
    expect(languageKeys(keys)).toEqual([]);
  });
});
