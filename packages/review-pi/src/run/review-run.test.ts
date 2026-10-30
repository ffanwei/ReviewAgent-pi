import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test, vi } from "vitest";
import { PHASE_INSTRUCTIONS } from "../loop/phases.js";
import type { RuleSkill } from "../knowledge/rule-skill.js";
import { buildSkillCandidatesBrief } from "../knowledge/skill-pass-brief.js";
import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { GATEWAY_MAX_TOKENS } from "../provider/pi-client.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_ISSUE, VUL4J_1_SNAPSHOT, vul4j1Corpus } from "../testing/vul4j1-script.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import { runReview } from "./review-run.js";

// 单案全链 E2E（离线 fake 适配器形态；#3 P1a 起真源，#4 起真跑同缝）：
// 组装（Zone A/B/C + 预取）→ pi-ai 序列化 → fake 适配器 → findings 解析 →
// 候选拦截 → 审计投影（AuditFileContent + RunRecord）。
//
// 黄金真源：t-series 审计（DSH 线 VUL4J-1/B/rep-1）——
// 回复 1-5 原文、req0 wireBody、findings/rejections/phaseLog/prefetch 记账
// （脚本 fixture 见 ../testing/vul4j1-script.ts）。
//
// 全链只观测 RunRecord / 审计文件的外部行为（不窥探内核内部状态）。

const EXPECTED = JSON.parse(goldenFixture("expected-baseline-vul4j-1-b.json")) as {
  findings: unknown[];
  rejections: unknown[];
  phaseLog: unknown[];
  prefetch: unknown[];
};
const REQ0 = JSON.parse(goldenFixture("wire-req0-vul4j-1.json")) as {
  model: string;
  messages: { role: string; content: string }[];
  [extra: string]: unknown;
};

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-e2e-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test.skipIf(!existsSync(VUL4J_1_SNAPSHOT))(
  "全链离线：VUL4J-1 × config B 与 t-series 审计同构，零网络",
  async () => {
    // 零网络纪律：globalThis.fetch 换成抛错探针，全链仍可跑通
    const originalFetch = globalThis.fetch;
    const networkProbe = vi.fn(() => {
      throw new Error("network access is disabled in offline tests");
    });
    globalThis.fetch = networkProbe as unknown as typeof globalThis.fetch;

    const script = fakeFetch(vul4j1Corpus());
    const runsRoot = tempRunsRoot();
    let firstAudit: Record<string, unknown>;
    try {
      const { record, recordPath, auditPath } = await runReview({
        caseId: "VUL4J-1",
        repoPath: VUL4J_1_SNAPSHOT,
        diff: goldenFixture("vul4j-1.diff"),
        issueDescription: VUL4J_1_ISSUE,
        apiKey: "offline-test",
        configId: "B",
        fetch: script.fetch,
        runsRoot,
        experimentId: "phase2-smoke",
        rep: 1,
      });

      // fake 适配器恰好消耗六条脚本（六阶段各一请求，零工具）
      expect(script.requests).toHaveLength(6);

      // 落盘布局与 DSH 线一致
      expect(recordPath).toBe(
        path.join(runsRoot, "phase2-smoke", "runs", "vul4j", "VUL4J-1", "B", "rep-1.json"),
      );
      expect(path.dirname(auditPath)).toBe(
        path.join(runsRoot, "phase2-smoke", "audit", "vul4j", "VUL4J-1", "B", "rep-1", "audit"),
      );

      // RunRecord 与 t-series 记录同构（findings / 拦截 / phaseLog / 预取记账 / usage 聚合）
      expect(record.source).toBe("vul4j");
      expect(record.model).toBe("deepseek-v4-flash");
      expect(record.verifier).toBe("off");
      expect(Number.isNaN(Date.parse(record.completedAt))).toBe(false);
      expect(record.effective).toBeNull();
      expect(record.verifierPass).toBeNull();
      expect(record.baseline.findings).toEqual(EXPECTED.findings);
      expect(record.baseline.audit.rejections).toEqual(EXPECTED.rejections);
      expect(record.baseline.audit.phaseLog).toEqual(EXPECTED.phaseLog);
      expect(record.baseline.audit.prefetch).toEqual(EXPECTED.prefetch);
      expect(record.baseline.usage).toEqual({
        inputTokens: 9579,
        outputTokens: 14484,
        cacheReadTokens: 24064,
      });
      expect(record.baseline.rounds).toBe(1);
      expect(record.baseline.toolCalls).toBe(0);
      expect(record.baseline.audit.truncated).toBe(false);
      expect(record.baseline.audit.truncationReasons).toEqual([]);
      expect(record.baseline.auditPath).toBe(auditPath);

      // 审计文件：requests[].wireBody + 元数据
      firstAudit = JSON.parse(readFileSync(auditPath, "utf8")) as Record<string, unknown>;
      expect(firstAudit["rounds"]).toBe(1);
      expect(firstAudit["usage"]).toEqual({
        inputTokens: 9579,
        outputTokens: 14484,
        cacheReadTokens: 24064,
      });
      expect(firstAudit["truncated"]).toBe(false);
      expect(firstAudit["effort"]).toBe("default");
      const requests = firstAudit["requests"] as {
        wireBody: string;
        messages: { role: string; content: string; reasoning_content?: string }[];
      }[];
      expect(requests).toHaveLength(6);

      // req0 序列化语义面与 t-series 一致（Zone A/B/C 组装 + pi-ai 序列化同构）。
      // 内核身份差异（审计如实记录、P2 字节门再议）：DSH 非流式（stream: false）；
      // pi 内核 openai-completions 恒流式（stream: true + stream_options.include_usage）。
      const wire0 = JSON.parse(requests[0].wireBody) as Record<string, unknown>;
      expect(wire0["model"]).toBe(REQ0.model);
      expect(wire0["messages"]).toEqual(REQ0.messages);
      expect(wire0["thinking"]).toEqual(REQ0.thinking);
      expect(wire0["reasoning_effort"]).toBe(REQ0.reasoning_effort);
      expect(wire0["stream"]).toBe(true);
      expect(wire0["stream_options"]).toEqual({ include_usage: true });
      expect("max_tokens" in wire0).toBe(false);
      expect("tools" in wire0).toBe(false);

      // append-only（compaction 显式禁用）：每请求 = 上一请求 + assistant 回复 + 下一阶段指令
      expect(requests[0].messages).toHaveLength(7);
      const replies = [
        goldenFixture("reply-1-vul4j-1.txt"),
        goldenFixture("reply-2-vul4j-1.txt"),
        goldenFixture("reply-3-vul4j-1.txt"),
        goldenFixture("reply-4-vul4j-1.txt"),
        goldenFixture("reply-5-vul4j-1.txt"),
      ];
      for (let index = 1; index < requests.length; index++) {
        expect(requests[index].messages.slice(0, -2)).toEqual(requests[index - 1].messages);
        expect(requests[index].messages.at(-2)).toEqual({
          role: "assistant",
          content: replies[index - 1],
          reasoning_content: "",
        });
        expect(requests[index].messages.at(-1)).toEqual({
          role: "user",
          content: PHASE_INSTRUCTIONS[index],
        });
      }

      // Zone A：恒为首位 system，且与 t-series 逐字节一致
      for (const request of requests) {
        expect(request.messages[0]).toEqual(REQ0.messages[0]);
      }
      expect(REQ0.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    } finally {
      globalThis.fetch = originalFetch;
    }
    expect(networkProbe).not.toHaveBeenCalled();

    // Zone A 跨 MR 字节稳定：另一案（不同 caseId / 仓库 / diff / issue）全链重跑，
    // system 逐字节不变（systemPrompt 与 MR 无关；用样本小仓库控制耗时）
    const betaDiff = [
      "diff --git a/src/main/java/com/example/Beta.java b/src/main/java/com/example/Beta.java",
      "--- a/src/main/java/com/example/Beta.java",
      "+++ b/src/main/java/com/example/Beta.java",
      "@@ -5,4 +5,4 @@",
      " context",
      "+changed",
    ].join("\n");
    const secondScript = fakeFetch(vul4j1Corpus());
    const { auditPath: secondAuditPath } = await runReview({
      caseId: "SAMPLE-2",
      repoPath: repoFixturePath("sample"),
      diff: betaDiff,
      issueDescription: "Another MR under review.",
      apiKey: "offline-test",
      configId: "B",
      fetch: secondScript.fetch,
      runsRoot: tempRunsRoot(),
      experimentId: "phase2-smoke",
      rep: 1,
    });
    const secondAudit = JSON.parse(readFileSync(secondAuditPath, "utf8")) as {
      requests: { messages: { role: string; content: string }[] }[];
    };
    const firstRequests = firstAudit["requests"] as { messages: { role: string; content: string }[] }[];
    expect(secondAudit.requests[0].messages[0]).toEqual(firstRequests[0].messages[0]);
    expect(secondAudit.requests[0].messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  },
  480_000,
);

// ---- config 矩阵扩展(#5 P2 字节门):config A 驱动 + 预取注入缝 ----

test("config A:零预取组装——req0 = Zone A + MR + Phase-1 三条(与 DSH A 真源同构)", async () => {
  const script = fakeFetch(vul4j1Corpus());
  const runsRoot = tempRunsRoot();
  const { record, recordPath, auditPath, runId } = await runReview({
    caseId: "VUL4J-1",
    // config A 零预取零工具,不读仓库——路径不存在也必须跑通
    //(守护 A 路径不偷偷构建预取)
    repoPath: path.join(runsRoot, "no-such-repo"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "A",
  });

  // runId 透出（#7 CLI stdout 契约）：毫秒时间戳 + 配置 + 用例,与审计文件名同源
  expect(runId).toMatch(/^\d{8}T\d{6}\.\d{3}-A-VUL4J-1$/);
  expect(path.basename(auditPath)).toBe(`${runId}.json`);

  // 六阶段各一请求(零工具);落盘布局切到 A 段
  expect(script.requests).toHaveLength(6);
  expect(recordPath).toBe(
    path.join(runsRoot, "phase2-smoke", "runs", "vul4j", "VUL4J-1", "A", "rep-1.json"),
  );
  expect(record.configId).toBe("A");
  // config A 审计与记录不携带预取记账(DSH A 真源同构:键省略而非空数组)
  expect(record.baseline.audit.prefetch).toBeUndefined();

  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
    configId: string;
    requests: { wireBody: string }[];
  };
  expect(audit.configId).toBe("A");
  const req0 = JSON.parse(audit.requests[0].wireBody) as {
    messages: { role: string; content: string }[];
  };
  // 三条:Zone A(system)+ MR user + Phase-1 指令 user(独立成条,DSH A 真源形态)
  expect(req0.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
  expect(req0.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  expect(req0.messages[1].content).toContain("Merge request under review.");
  expect(req0.messages[1].content).toContain("Case ID: VUL4J-1");
  expect(req0.messages[1].content).toContain(goldenFixture("vul4j-1.diff"));
  expect(req0.messages[2]).toEqual({ role: "user", content: PHASE_INSTRUCTIONS[0] });

  // append-only 不变量在 A 下同样成立(每请求 = 上一请求 + 回复 + 下一阶段指令)
  const requests = audit.requests.map(
    (request) => JSON.parse(request.wireBody).messages as { role: string; content: string }[],
  );
  for (let index = 1; index < requests.length; index++) {
    expect(requests[index].slice(0, -2)).toEqual(requests[index - 1]);
    expect(requests[index].at(-1)).toEqual({ role: "user", content: PHASE_INSTRUCTIONS[index] });
  }
}, 120_000);

test("config B:注入预取(门缓存缝)——注入物直达 Zone B 位与审计记账", async () => {
  const sentinel = {
    zoneBMessage: { role: "user" as const, content: "SENTINEL-ZONE-B" },
    layerMessages: [
      { role: "user" as const, content: "SENTINEL-LAYER-1" },
      { role: "user" as const, content: "SENTINEL-LAYER-2" },
    ],
    records: [
      { layer: "zone-b" as const, budgetChars: 100, contentChars: 15, truncated: false, totalEntries: 1, shownEntries: 1 },
      { layer: "symbol" as const, budgetChars: 100, contentChars: 16, truncated: false, totalEntries: 1, shownEntries: 1 },
    ],
  };
  const script = fakeFetch(vul4j1Corpus());
  const runsRoot = tempRunsRoot();
  const { record, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: VUL4J_1_SNAPSHOT,
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "B",
    prefetch: sentinel,
  });

  // 注入物原样落位:req0 = system, ZoneB, MR, 层×2, Phase-1(不跑真预取管线)
  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
    requests: { wireBody: string }[];
  };
  const req0 = JSON.parse(audit.requests[0].wireBody) as {
    messages: { role: string; content: string }[];
  };
  expect(req0.messages.map((message) => message.role)).toEqual([
    "system",
    "user",
    "user",
    "user",
    "user",
    "user",
  ]);
  expect(req0.messages[1]).toEqual({ role: "user", content: "SENTINEL-ZONE-B" });
  expect(req0.messages[2].content).toContain("Merge request under review.");
  expect(req0.messages[3]).toEqual({ role: "user", content: "SENTINEL-LAYER-1" });
  expect(req0.messages[4]).toEqual({ role: "user", content: "SENTINEL-LAYER-2" });
  expect(req0.messages[5]).toEqual({ role: "user", content: PHASE_INSTRUCTIONS[0] });
  expect(record.baseline.audit.prefetch).toEqual(sentinel.records);
}, 120_000);

test("config 门面:A + 预取注入 → 抛;C/D/E + 预取注入 → 抛(矛盾输入)", async () => {
  const base = {
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: fakeFetch([]).fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
  };
  await expect(
    runReview({
      ...base,
      configId: "A",
      prefetch: {
        zoneBMessage: { role: "user", content: "x" },
        layerMessages: [],
        records: [],
      },
    }),
  ).rejects.toThrow(/config A .*prefetch/);
  for (const configId of ["C", "D", "E"] as const) {
    await expect(
      runReview({
        ...base,
        configId,
        prefetch: {
          zoneBMessage: { role: "user", content: "x" },
          layerMessages: [],
          records: [],
        },
      }),
    ).rejects.toThrow(/config [CDE] .*prefetch/);
  }
});

// ---- config C/D/E（#6 P3a）：工具驱动 agentLoop 集成（离线 fake 全链） ----

/** fake 脚本零 usage（usage 只进记账,零值即「脚本不带 usage 语义」） */
const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/** 一轮零工具回复脚本:六相位各一文本回复(phase-5 空候选 / phase-6 complete) */
function sixPhaseNoToolCorpus(): FakeReply[] {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ];
}

/** 审计文件请求投影(wireBody 解析 + requests[].tools 点分名) */
function readAudit(auditPath: string): {
  requests: { wireBody: string; tools?: { name: string }[] }[];
  [extra: string]: unknown;
} {
  return JSON.parse(readFileSync(auditPath, "utf8")) as {
    requests: { wireBody: string; tools?: { name: string }[] }[];
    [extra: string]: unknown;
  };
}

/** 七工具 wire 名序(REVIEW_TOOL_ORDER 下划线形态) */
const WIRE_TOOL_NAMES = [
  "review_get_diff",
  "review_get_symbol",
  "review_get_file",
  "review_find_references",
  "review_get_call_chain",
  "review_search_rule",
  "review_search_history",
];
/** 审计投影 tools 点分名序（fromWireToolName：仅首个下划线转点分） */
const DOTTED_TOOL_NAMES = [
  "review.get_diff",
  "review.get_symbol",
  "review.get_file",
  "review.find_references",
  "review.get_call_chain",
  "review.search_rule",
  "review.search_history",
];

test("config D:工具驱动全链——req0 = ZoneA+MR+Phase-1 + 七工具面,零工具调用 complete", async () => {
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot();
  const { record, recordPath, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "D",
  });

  // 六相位各一请求(零工具);落盘布局切到 D 段
  expect(script.requests).toHaveLength(6);
  expect(recordPath).toBe(
    path.join(runsRoot, "phase2-smoke", "runs", "vul4j", "VUL4J-1", "D", "rep-1.json"),
  );
  expect(record.configId).toBe("D");
  expect(record.baseline.rounds).toBe(1);
  expect(record.baseline.toolCalls).toBe(0);
  expect(record.baseline.audit.truncated).toBe(false);
  expect(record.baseline.audit.truncationReasons).toEqual([]);
  expect(record.baseline.usage).toEqual({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 0 });
  // D 无 fullRepo / ledger 记账(键省略,DSH D 真源同构)
  expect(record.baseline.audit.fullRepo).toBeUndefined();
  expect(record.baseline.audit.ledger).toBeUndefined();

  // req0:三条消息(同 A 形态) + 工具面(wire 下划线名;tool_choice 缺席为 pi 方言)
  const audit = readAudit(auditPath);
  const req0 = JSON.parse(audit.requests[0].wireBody) as {
    messages: { role: string; content: string }[];
    tools?: { function: { name: string } }[];
    [extra: string]: unknown;
  };
  expect(req0.messages.map((message) => message.role)).toEqual(["system", "user", "user"]);
  expect(req0.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  expect(req0.messages[1].content).toContain("Merge request under review.");
  expect(req0.messages[2]).toEqual({ role: "user", content: PHASE_INSTRUCTIONS[0] });
  expect(req0.tools?.map((tool) => tool.function.name)).toEqual(WIRE_TOOL_NAMES);
  expect("tool_choice" in req0).toBe(false);
  // 审计投影 tools = 点分名(DSH 审计口径)
  expect(audit.requests[0].tools?.map((tool) => tool.name)).toEqual(DOTTED_TOOL_NAMES);
  // append-only:每请求 = 上一请求 + assistant 回复 + 下一相位指令
  const requests = audit.requests.map(
    (request) => JSON.parse(request.wireBody).messages as { role: string; content: string }[],
  );
  for (let index = 1; index < requests.length; index++) {
    expect(requests[index].slice(0, -2)).toEqual(requests[index - 1]);
    expect(requests[index].at(-1)).toEqual({ role: "user", content: PHASE_INSTRUCTIONS[index] });
  }
}, 120_000);

test("config C:全仓注入——req0 四条(MR + fullRepo),fullRepo 记账进审计与 RunRecord", async () => {
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot();
  const { record, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "C",
  });

  // req0:四条 = system + MR + fullRepo + Phase-1(DSH C 真源消息序)
  const audit = readAudit(auditPath);
  const req0 = JSON.parse(audit.requests[0].wireBody) as {
    messages: { role: string; content: string }[];
    tools?: { function: { name: string } }[];
  };
  expect(req0.messages).toHaveLength(4);
  expect(req0.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  expect(req0.messages[1].content).toContain("Merge request under review.");
  expect(req0.messages[2].content).toContain("Full repository context (config C).");
  expect(req0.messages[2].content).toContain("## File: src/main/java/com/example/Alpha.java");
  expect(req0.messages[3]).toEqual({ role: "user", content: PHASE_INSTRUCTIONS[0] });
  expect(req0.tools?.map((tool) => tool.function.name)).toEqual(WIRE_TOOL_NAMES);

  // fullRepo 记账:审计文件与 RunRecord 同源(sample fixture 3 Java 文件不截断)
  const fullRepo = record.baseline.audit.fullRepo as unknown as Record<string, unknown>;
  expect(fullRepo).toEqual({
    budgetChars: 80_000,
    contentChars: fullRepo["contentChars"],
    truncated: false,
    totalFiles: 3,
    shownFiles: 3,
  });
  expect(audit.fullRepo).toEqual(fullRepo);
  // C 无 ledger 键
  expect(record.baseline.audit.ledger).toBeUndefined();
}, 120_000);

test("config E:ledger 审计键恒投影(零工具 → 空数组),RunRecord 与审计同源", async () => {
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot();
  const { record, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "E",
  });
  expect(record.configId).toBe("E");
  // E 恒投影 ledger 键(零工具调用 → 空数组;DSH E 真源恒有该键)
  expect(record.baseline.audit.ledger).toEqual([]);
  const audit = readAudit(auditPath);
  expect(audit.ledger).toEqual([]);
  // E 无 fullRepo 键
  expect(record.baseline.audit.fullRepo).toBeUndefined();
}, 120_000);

// ---- config F（ADR-0014）：Phase 5 之后追加独立 skill 检视会话 ----
//
// 请求序：主 Phase 1–5 → skill 会话（CLI 顺序，各一条独立 Agent）→ 主 Phase 6。
// Phase 1–5 与 E 逐字节相同（Phase 5 消息不再被修改）；Phase 6 的差异只有
// 尾部追加的 skill 候选清单；N=0 时全链与 E 逐字节相同。

const RULE_FILE = "src/main/java/com/example/Alpha.java";
const OK_REPLY: FakeReply = { text: "ok", usage: ZERO };

/** skill 候选（id 形态 = RULE-CHECK@<skill>@<file>:<line>；证据齐备可过拦截链） */
function skillCandidate(
  skill: string,
  line: number,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    id: `RULE-CHECK@${skill}@${RULE_FILE}:${line}`,
    severity: "P2",
    category: "BUG",
    file: RULE_FILE,
    line,
    title: "Missing null guard on a public method",
    description: "A public method dereferences its argument without a null guard, per the project rule.",
    evidence: [`${RULE_FILE}:${line} public int getBase() {`],
    rule: skill,
    confidence: 0.8,
    ...overrides,
  };
}

function candidatesReply(candidates: readonly unknown[]): FakeReply {
  return { text: JSON.stringify({ candidates }), usage: ZERO };
}

function allPassVerdicts(ids: readonly string[]): FakeReply {
  return {
    text: JSON.stringify({
      verdicts: ids.map((id) => ({ id, pass: true, reason: "evidence supports" })),
      complete: true,
    }),
    usage: ZERO,
  };
}

/** 假装载器产物：filePath 是宿主绝对路径（skill 会话按真实路径给 bash cwd） */
function skillPack(name: string, overrides: Partial<RuleSkill> = {}): RuleSkill {
  return {
    name,
    description: `Sample project rule skill ${name}`,
    content: `Check every public method for a null guard (${name}).`,
    filePath: `C:\\host\\cache\\deadbeef\\${name}\\SKILL.md`,
    digest: `digest-${name}`,
    source: { kind: "zip", path: `.review-rules/${name}.zip` },
    diagnostics: [],
    ...overrides,
  };
}

const SAMPLE_RULE_SKILL = skillPack("sample-rule", {
  digest: "deadbeef",
  source: { kind: "zip", path: ".review-rules/rules.zip" },
});

/** skill 会话转录（skillPassLog.transcriptFile → run 输出目录内 basename） */
function readSkillTranscript(run: { transcriptPath?: string }, file: string): Record<string, unknown> {
  const dir = path.dirname(run.transcriptPath ?? "");
  return JSON.parse(readFileSync(path.join(dir, file), "utf8")) as Record<string, unknown>;
}

test("config F:Phase 1–5 与 E 逐字节相同,Phase 6 追加 skill 候选清单,会话独立转录", async () => {
  const eScript = fakeFetch(sixPhaseNoToolCorpus());
  const eRun = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: eScript.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "E",
  });

  const candidate = skillCandidate("sample-rule", 11, {
    description:
      "A public method dereferences its argument without a null guard " +
      "(rule file: C:\\host\\cache\\deadbeef\\sample-rule\\rules\\01-null-dereference.md).",
  });
  // Phase 6 里应是净化后的同一条（skill 会话读真实路径，主会话请求不出现宿主绝对路径）
  const sanitizedCandidate = skillCandidate("sample-rule", 11, {
    description:
      "A public method dereferences its argument without a null guard " +
      "(rule file: <rule-skill>\\rules\\01-null-dereference.md).",
  });
  const fScript = fakeFetch([
    OK_REPLY,
    OK_REPLY,
    OK_REPLY,
    OK_REPLY,
    candidatesReply([]),
    // ↓ skill 会话（Phase 5 之后）
    candidatesReply([candidate]),
    // ↓ 主会话 Phase 6（一次裁定主候选 + skill 候选）
    allPassVerdicts([candidate.id as string]),
  ]);
  const fRun = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: fScript.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "F",
    ruleSkillLoader: async () => [SAMPLE_RULE_SKILL],
  });

  expect(eScript.requests).toHaveLength(6);
  // skill 会话是非测量档：其 wire 请求不进主审计 requests[]（独立转录是它的记录）
  expect(fScript.requests).toHaveLength(7);
  const eAudit = readAudit(eRun.auditPath);
  const fAudit = readAudit(fRun.auditPath);
  expect(fAudit.requests).toHaveLength(6);

  // Phase 1–5（下标 0–4）逐字节等于 E——Phase 5 消息不再被修改（ADR-0014 决策 2）
  for (const index of [0, 1, 2, 3, 4]) {
    expect(JSON.parse(fAudit.requests[index].wireBody), `request ${index}`).toEqual(
      JSON.parse(eAudit.requests[index].wireBody),
    );
  }

  const eReq6 = JSON.parse(eAudit.requests[5].wireBody) as { messages: { role: string; content: string }[] };
  const fReq6 = JSON.parse(fAudit.requests[5].wireBody) as { messages: { role: string; content: string }[] };

  // Phase 6：历史（含 Phase 5 回复）与 E 逐字节相同，只有尾部追加候选清单
  expect(fReq6.messages.slice(0, -1)).toEqual(eReq6.messages.slice(0, -1));
  const brief = buildSkillCandidatesBrief([
    { skill: "sample-rule", candidates: [sanitizedCandidate] },
  ]);
  const phase6 = fReq6.messages.at(-1) as { role: string; content: string };
  expect(phase6.content).toBe(`${PHASE_INSTRUCTIONS[5]}\n\n${brief}`);
  expect(phase6.content).toContain('<skill name="sample-rule">');
  expect(phase6.content).toContain(candidate.id as string);
  // 验收 6：skill 会话可以有真实 pack 路径，但主会话请求不能有——skill 候选
  // 里的 pack 根在并入候选流前已换成占位符（原始措辞留在 skill 转录里）
  expect(phase6.content).not.toContain("C:\\host");
  expect(phase6.content).toContain("<rule-skill>");
  expect(fAudit.requests[5].wireBody as string).not.toContain("C:\\host");

  // 装载留痕 = 数组（每 zip 一条）；执行留痕 = round × skill
  expect(fAudit.ruleSkill).toEqual([{ source: ".review-rules/rules.zip", digest: "deadbeef", name: "sample-rule" }]);
  expect(fRun.record.baseline.audit.ruleSkill).toEqual(fAudit.ruleSkill);
  expect(eAudit.ruleSkill).toBeUndefined();
  expect(eAudit.skillPassLog).toBeUndefined();

  const passLog = fAudit.skillPassLog as Record<string, unknown>[];
  expect(passLog).toHaveLength(1);
  expect(passLog[0]).toMatchObject({
    round: 1,
    skill: "sample-rule",
    status: "ok",
    requestCount: 1,
    toolCallCount: 0,
    candidateCount: 1,
    mergedCount: 0,
    ruleIds: ["sample-rule"],
  });

  // 独立转录：basename 引用 + 落盘文件存在 + 内容含 skill 首条 user 消息
  const transcriptFile = passLog[0]?.transcriptFile as string;
  expect(transcriptFile).toMatch(/-skill-sample-rule-r1\.json$/);
  const transcript = readSkillTranscript(fRun, transcriptFile);
  const info = transcript.info as { id: string; runId: string; configId: string };
  expect(info.id.endsWith("-skill-sample-rule-r1")).toBe(true);
  expect(info.runId).toBe(fRun.runId);
  expect(info.configId).toBe("F");
  const messages = transcript.messages as { role: string; content: unknown }[];
  expect(messages[0]?.role).toBe("system");
  // 倒数第二条 = skill 会话首条 user 消息（种子之后），最后一条 = 会话回复
  const invocationMessage = messages.at(-2) as {
    role: string;
    content: { type: string; text?: string }[];
  };
  expect(invocationMessage.role).toBe("user");
  const invocationText = invocationMessage.content.map((block) => block.text ?? "").join("");
  expect(invocationText).toContain('<skill name="sample-rule"');
  expect(invocationText).toContain("Rule-skill review pass");
  expect(messages.at(-1)?.role).toBe("assistant");

  // skill 候选走同一拦截链（rule = skill 名），E 无 findings
  expect(fRun.record.baseline.findings.map((finding) => finding.id)).toEqual([candidate.id]);
  expect(fRun.record.baseline.findings[0]?.rule).toBe("sample-rule");
  expect(eRun.record.baseline.findings).toEqual([]);
}, 120_000);

test("--rule-skill 目录形态：入参透传装载器，审计标 kind = dir（ADR-0018）", async () => {
  const dirSkill = skillPack("dir-rule", {
    digest: "dir-digest",
    source: { kind: "dir", path: "packs/general-code-review" },
  });
  const script = fakeFetch([
    OK_REPLY,
    OK_REPLY,
    OK_REPLY,
    OK_REPLY,
    candidatesReply([]),
    // ↓ skill 会话（Phase 5 之后，无候选）
    candidatesReply([]),
    // ↓ 主会话 Phase 6（无存活候选）
    allPassVerdicts([]),
  ]);
  const run = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "F",
    ruleSkillDirs: ["packs/general-code-review"],
    ruleSkillLoader: async (options) => {
      expect(options.ruleSkillDirs).toEqual(["packs/general-code-review"]);
      return [dirSkill];
    },
  });

  const audit = readAudit(run.auditPath);
  expect(audit.ruleSkill).toEqual([
    { source: "packs/general-code-review", kind: "dir", digest: "dir-digest", name: "dir-rule" },
  ]);
  expect(run.record.baseline.audit.ruleSkill).toEqual(audit.ruleSkill);
}, 120_000);

test("config F 多 skill：按 CLI 顺序执行，跨 skill 同 (file,line,category) 后者计入 mergedCount", async () => {
  const alpha = skillPack("alpha");
  const beta = skillPack("beta");
  const duplicate = skillCandidate("beta", 11);
  const extra = skillCandidate("beta", 20);
  const alphaCandidate = skillCandidate("alpha", 11);

  const script = fakeFetch([
    OK_REPLY,
    OK_REPLY,
    OK_REPLY,
    OK_REPLY,
    candidatesReply([]),
    // ↓ alpha 会话
    candidatesReply([alphaCandidate]),
    // ↓ beta 会话（第一条与 alpha 同 (file,line,category) —— 被合并）
    candidatesReply([duplicate, extra]),
    // ↓ 主 Phase 6
    allPassVerdicts([alphaCandidate.id as string, extra.id as string]),
  ]);
  const run = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "F",
    // CLI 顺序：zip 传入序就是执行序（不排序）
    ruleSkillZips: ["b-beta.zip", "a-alpha.zip"],
    ruleSkillLoader: async (options) => {
      expect(options.explicitZipPaths).toEqual(["b-beta.zip", "a-alpha.zip"]);
      return [alpha, beta];
    },
  });

  expect(script.requests).toHaveLength(8);
  const audit = readAudit(run.auditPath);
  // 主审计 requests[] 只含主会话（5 相位 + Phase 6）
  expect(audit.requests).toHaveLength(6);
  expect(audit.ruleSkill).toEqual([
    { source: ".review-rules/alpha.zip", digest: "digest-alpha", name: "alpha" },
    { source: ".review-rules/beta.zip", digest: "digest-beta", name: "beta" },
  ]);

  const passLog = audit.skillPassLog as Record<string, unknown>[];
  expect(passLog.map((record) => record.skill)).toEqual(["alpha", "beta"]);
  expect(passLog.map((record) => record.mergedCount)).toEqual([0, 1]);
  expect(passLog.map((record) => record.candidateCount)).toEqual([1, 2]);
  // 账目闭合：candidateCount − mergedCount = 实际并入数
  const merged = passLog.reduce(
    (sum, record) => sum + (record.candidateCount as number) - (record.mergedCount as number),
    0,
  );
  expect(merged).toBe(2);

  // Phase 6 清单只列存活候选：alpha 的 + beta 的 extra（重复项不出现在清单里）
  const req6 = JSON.parse(audit.requests[5].wireBody) as { messages: { content: string }[] };
  const phase6 = req6.messages.at(-1)?.content ?? "";
  expect(phase6).toContain(`<skill name="alpha">`);
  expect(phase6).toContain(`<skill name="beta">`);
  expect(phase6).toContain(extra.id as string);
  expect(phase6).not.toContain(duplicate.id as string);

  // 每个 skill 会话各一份独立转录
  expect(passLog.map((record) => String(record.transcriptFile))).toEqual([
    expect.stringMatching(/-skill-alpha-r1\.json$/),
    expect.stringMatching(/-skill-beta-r1\.json$/),
  ]);

  // findings = alpha 候选 + beta 的 extra（顺序 = CLI 顺序）
  expect(run.record.baseline.findings.map((finding) => finding.id)).toEqual([
    alphaCandidate.id,
    extra.id,
  ]);
}, 120_000);

test("config F skill 会话解析失败：status=failed/parse，Phase 6 无候选清单，主路径照常", async () => {
  const eScript = fakeFetch(sixPhaseNoToolCorpus());
  const eRun = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: eScript.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "E",
  });

  const fScript = fakeFetch([
    OK_REPLY,
    OK_REPLY,
    OK_REPLY,
    OK_REPLY,
    candidatesReply([]),
    { text: "not a JSON reply at all", usage: ZERO }, // skill 会话产出不可解析
    allPassVerdicts([]),
  ]);
  const fRun = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: fScript.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "F",
    ruleSkillLoader: async () => [SAMPLE_RULE_SKILL],
  });

  const eAudit = readAudit(eRun.auditPath);
  const fAudit = readAudit(fRun.auditPath);
  const passLog = fAudit.skillPassLog as Record<string, unknown>[];
  expect(passLog).toHaveLength(1);
  expect(passLog[0]).toMatchObject({
    round: 1,
    skill: "sample-rule",
    status: "failed",
    failureStage: "parse",
    candidateCount: 0,
    mergedCount: 0,
  });
  expect(String(passLog[0]?.degradedReason)).toContain("JSON");

  // 零候选 ⇒ Phase 6 消息逐字节 = E（不追加候选清单段）；主审计全 6 条同 E
  for (const index of [0, 1, 2, 3, 4, 5]) {
    expect(JSON.parse(fAudit.requests[index].wireBody), `request ${index}`).toEqual(
      JSON.parse(eAudit.requests[index].wireBody),
    );
  }
  expect(fRun.record.baseline.findings).toEqual([]);
}, 120_000);

test("config F N=0（无 zip）：全链请求与 E 逐字节相同；ruleSkill/skillPassLog 空数组", async () => {
  const eScript = fakeFetch(sixPhaseNoToolCorpus());
  const eRun = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: eScript.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "E",
  });
  const fScript = fakeFetch(sixPhaseNoToolCorpus());
  const fRun = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: fScript.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "F",
    ruleSkillLoader: async () => [],
  });

  expect(fScript.requests).toHaveLength(6);
  const eAudit = readAudit(eRun.auditPath);
  const fAudit = readAudit(fRun.auditPath);
  for (let index = 0; index < 6; index++) {
    expect(JSON.parse(fAudit.requests[index].wireBody), `request ${index}`).toEqual(
      JSON.parse(eAudit.requests[index].wireBody),
    );
  }
  expect(fAudit.ruleSkill).toEqual([]);
  expect(fAudit.skillPassLog).toEqual([]);
  expect(fRun.record.baseline.findings).toEqual(eRun.record.baseline.findings);
}, 120_000);

test("config F 降级:装载失败不跑会话，行为 = E（审计 ruleSkill[] 带 degradedReason）", async () => {
  const degradedSkill: RuleSkill = {
    name: "",
    description: "",
    content: "",
    filePath: "",
    digest: "",
    source: { kind: "zip", path: ".review-rules" },
    diagnostics: [],
    degradedReason: "no rule-skill archive found (.review-rules/ is missing)",
  };
  const eScript = fakeFetch(sixPhaseNoToolCorpus());
  const eRun = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: eScript.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "E",
  });
  const fScript = fakeFetch(sixPhaseNoToolCorpus());
  const fRun = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: fScript.fetch,
    runsRoot: tempRunsRoot(),
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "F",
    ruleSkillLoader: async () => [degradedSkill],
  });

  const eAudit = readAudit(eRun.auditPath);
  const fAudit = readAudit(fRun.auditPath);
  // 全六条请求逐字节 = E（降级包不跑会话 → 不产生任何字节差）
  for (let index = 0; index < 6; index++) {
    expect(JSON.parse(fAudit.requests[index].wireBody)).toEqual(JSON.parse(eAudit.requests[index].wireBody));
  }
  expect(fAudit.ruleSkill).toEqual([
    {
      source: ".review-rules",
      digest: "",
      name: "",
      degradedReason: "no rule-skill archive found (.review-rules/ is missing)",
    },
  ]);
  expect(fAudit.skillPassLog).toEqual([]);
}, 120_000);

test("persistRecord=false（#8 runner 执行缝）：记录不落盘、recordPath 空串；审计照常落盘", async () => {
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot();
  const { record, recordPath, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "D",
    persistRecord: false,
  });

  // 记录不落盘：runner 是记录唯一写者（执行缝纪律）；recordPath 空串 = 未持久化
  expect(recordPath).toBe("");
  expect(
    existsSync(path.join(runsRoot, "phase2-smoke", "runs", "vul4j", "VUL4J-1", "D", "rep-1.json")),
  ).toBe(false);

  // 审计照常落盘（重放字节是内核职责）；内存 record 完整返回（auditPath 同源）
  expect(existsSync(auditPath)).toBe(true);
  expect(record.configId).toBe("D");
  expect(record.baseline.auditPath).toBe(auditPath);
}, 120_000);

test("config D:工具轮——review.get_diff 执行记账 + recall 请求(工具结果进上下文)", async () => {
  const diff = goldenFixture("vul4j-1.diff");
  const script = fakeFetch([
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    {
      text: "Let me check the diff first.",
      toolCalls: [{ id: "call-diff-1", name: "review_get_diff", arguments: {} }],
      usage: ZERO,
    },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ]);
  const runsRoot = tempRunsRoot();
  const { record, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff,
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "D",
  });

  // 7 请求:六相位 + 1 次工具 recall;工具记账 1 条(真 toolkit 执行 get_diff)
  expect(script.requests).toHaveLength(7);
  expect(record.baseline.toolCalls).toBe(1);
  expect(record.baseline.audit.toolCallLog).toEqual([
    {
      name: "review.get_diff",
      argumentsJson: "{}",
      resultSummary: ["MR unified diff:", ...diff.split("\n")].join("\n"),
    },
  ]);

  // recall 请求 = 上一请求 + assistant(伴随文本 + tool_calls) + tool 应答
  const audit = readAudit(auditPath);
  const requests = audit.requests.map(
    (request) => JSON.parse(request.wireBody).messages as Record<string, unknown>[],
  );
  const toolTurn = requests[3];
  expect(toolTurn.slice(0, requests[2].length)).toEqual(requests[2]);
  const assistant = toolTurn[requests[2].length];
  expect(assistant).toMatchObject({
    role: "assistant",
    content: "Let me check the diff first.",
    tool_calls: [
      {
        id: "call-diff-1",
        type: "function",
        function: { name: "review_get_diff", arguments: "{}" },
      },
    ],
  });
  expect(toolTurn[requests[2].length + 1]).toMatchObject({
    role: "tool",
    tool_call_id: "call-diff-1",
    content: ["MR unified diff:", ...diff.split("\n")].join("\n"),
  });
}, 120_000);

test("截断路径:phase-6 恒 complete:false → MAX_ROUNDS 上界,正常返回(退出码 0)+ truncated 留痕", async () => {
  const replies: FakeReply[] = [];
  for (let round = 0; round < 5; round++) {
    replies.push(
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: '{"candidates":[]}', usage: ZERO },
      { text: '{"verdicts":[],"complete":false}', usage: ZERO },
    );
  }
  const script = fakeFetch(replies);
  const runsRoot = tempRunsRoot();
  const { record, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
    configId: "D",
  });

  // 5 轮 × 6 相位各一请求;runReview 正常返回(不抛——防御性路径退出码 0)
  expect(script.requests).toHaveLength(30);
  expect(record.baseline.rounds).toBe(5);
  expect(record.baseline.audit.truncated).toBe(true);
  expect(record.baseline.audit.truncationReasons).toEqual(["MAX_ROUNDS_REACHED"]);
  expect(record.baseline.toolCalls).toBe(0);
  const audit = readAudit(auditPath);
  expect(audit.truncated).toBe(true);
  expect(audit.truncationReasons).toEqual(["MAX_ROUNDS_REACHED"]);
  // phaseLog:5 轮 × 6 相位全留痕
  expect(record.baseline.audit.phaseLog).toHaveLength(30);
}, 180_000);

// ---- 网关注入透传（#4）：baseUrl/modelId 贯穿传输层与审计/RunRecord ----

test.skipIf(!existsSync(repoFixturePath("sample")))(
  "网关注入透传：baseUrl/modelId 贯穿请求 URL、wireBody 与审计/RunRecord model 字段",
  async () => {
    const GATEWAY_URL = "https://gw.example.com/v1";
    const script = fakeFetch(vul4j1Corpus());
    const { record, auditPath } = await runReview({
      caseId: "SAMPLE-GW",
      repoPath: repoFixturePath("sample"),
      diff: ["diff --git a/src/main/java/com/example/Beta.java b/src/main/java/com/example/Beta.java",
        "--- a/src/main/java/com/example/Beta.java",
        "+++ b/src/main/java/com/example/Beta.java",        "@@ -5,4 +5,4 @@",
        " context",
        "+changed",
      ].join("\n"),
      issueDescription: "Gateway passthrough MR under review.",
      apiKey: "sentinel-key",
      configId: "B",
      baseUrl: GATEWAY_URL,
      modelId: "custom-gateway-model",
      fetch: script.fetch,
      runsRoot: tempRunsRoot(),
      experimentId: "phase2-smoke",
      rep: 1,
    });

    // 传输层：六回合全部命中网关端点（${baseUrl}/chat/completions）
    expect(script.requests).toHaveLength(6);
    for (const request of script.requests) {
      expect(request.url).toBe(`${GATEWAY_URL}/chat/completions`);
    }

    // 审计与 RunRecord 只含 model（实际请求的 id），不含 baseUrl/key
    //（baseUrl 属冒烟 REPORT 口径，DSH-isomorphic 审计 20 键不含它）
    expect(record.model).toBe("custom-gateway-model");
    const audit = JSON.parse(readFileSync(auditPath, "utf8")) as {
      model: string;
      requests: { wireBody: string }[];
    };
    expect(audit.model).toBe("custom-gateway-model");
    for (const request of audit.requests) {
      const wire = JSON.parse(request.wireBody) as { model: string; max_tokens?: number };
      expect(wire.model).toBe("custom-gateway-model");
      // 网关档显式输出预算（官方直连不发 max_tokens，见 pi-client.maxTokensFor）
      expect(wire.max_tokens).toBe(GATEWAY_MAX_TOKENS);
    }
  },
  300_000,
);
