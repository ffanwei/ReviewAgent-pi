import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { PHASE_INSTRUCTIONS } from "../loop/phases.js";
import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_ISSUE, vul4j1Corpus } from "../testing/vul4j1-script.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import { runReview } from "./review-run.js";

// Step A 落盘产物（ADR-0013）：检视转录 `session-*.json` + 检视意见导出
// `reviews_en.json`。断言面 = 磁盘文件与其形状（S1 = runReview 公共入口），
// 不窥探内核内部状态。零网络（fake 适配器）。

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-artifacts-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/** config B 的注入预取哨兵（免真跑预取管线；与 review-run.test.ts 同形） */
const SENTINEL_PREFETCH = {
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

/** 一轮零工具回复脚本：六相位各一文本回复（phase-5 空候选 / phase-6 complete） */
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

/** 检视转录文档（info + messages）的宽松读取面 */
interface TranscriptDoc {
  readonly info: Record<string, unknown>;
  readonly messages: readonly Record<string, unknown>[];
  readonly [extra: string]: unknown;
}

/** 逐条 assistant `usage` 的测试读取面（断言求和口径） */
interface AssistantUsage {
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly reasoning?: number;
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
}

/** 转录 `info.tokens` / `info.cost` 的求和累加器形状 */
interface UsageTotals {
  readonly tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: { read: number; write: number };
  };
  readonly cost: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    total: number;
  };
}

function readTranscript(filePath: string): TranscriptDoc {
  return JSON.parse(readFileSync(filePath, "utf8")) as TranscriptDoc;
}

function textOf(message: Record<string, unknown> | undefined): string {
  const content = message?.["content"];
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block): block is { type: string; text: string } => {
      const candidate = block as { type?: unknown };
      return candidate.type === "text";
    })
    .map((block) => block.text)
    .join("\n");
}

function runDir(runsRoot: string, configId: string): string {
  return path.join(runsRoot, "phase2-smoke", "runs", "vul4j", "VUL4J-1", configId);
}

function sessionFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("session-") && name.endsWith(".json"));
}

const INFO_KEYS = [
  "id",
  "runId",
  "agent",
  "configId",
  "model",
  "tokens",
  "cost",
  "outcome",
  "time",
  "title",
  "location",
  "perMessageTimestamps",
];

test("检视转录（config D）：落点/命名/info 精确键表/messages 原生序列", async () => {
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot();
  const repoPath = repoFixturePath("sample");
  const { record, auditPath, transcriptPath, reviewsPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath,
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    configId: "D",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
  });

  // 落点：与 rep-1.json 平铺（runs/vul4j/VUL4J-1/D/），名字含首次模型请求时刻
  const dir = runDir(runsRoot, "D");
  expect(transcriptPath).toBeDefined();
  expect(path.dirname(transcriptPath ?? "")).toBe(dir);
  expect(existsSync(transcriptPath ?? "")).toBe(true);
  const baseName = path.basename(transcriptPath ?? "");
  expect(baseName).toMatch(/^session-\d{8}T\d{6}\.\d{3}-D-VUL4J-1\.json$/);
  // 每 run 独立留档：D 目录只有这一份 session
  expect(sessionFiles(dir)).toEqual([baseName]);

  const doc = readTranscript(transcriptPath ?? "");

  // 顶层恰好两键（Step A 无 view）；info 键集合精确（无 kind/version/projectID/durationMs）
  expect(Object.keys(doc).sort()).toEqual(["info", "messages"]);
  expect(Object.keys(doc.info).sort()).toEqual([...INFO_KEYS].sort());

  // info 取值：id = 文件名 stem；runId = 审计 runId（配对键，与命名时间不同源）
  expect(doc.info["id"]).toBe(baseName.replace(/\.json$/, ""));
  expect(doc.info["runId"]).toBe(path.basename(auditPath, ".json"));
  expect(doc.info["agent"]).toBe("review");
  expect(doc.info["configId"]).toBe("D");
  expect(doc.info["title"]).toBe("VUL4J-1");
  expect(doc.info["location"]).toEqual({ directory: repoPath });
  expect(doc.info["perMessageTimestamps"]).toBe("unavailable");
  expect(doc.info["outcome"]).toBe("succeeded");
  const model = doc.info["model"] as { id: unknown; baseUrl: unknown };
  expect(model.id).toBe("deepseek-v4-flash");
  expect(typeof model.baseUrl).toBe("string");

  // 命名时间 = 首次模型请求时刻（info.time.created 的紧凑形 = 文件名中段）
  const time = doc.info["time"] as { created: unknown; completed: unknown };
  const created = String(time.created);
  const completed = String(time.completed);
  const nameSegment = baseName.replace(/^session-/, "").replace(/-D-VUL4J-1\.json$/, "");
  expect(created.replace(/[-:]/g, "").replace("Z", "")).toBe(nameSegment);
  expect(Date.parse(created)).toBeLessThanOrEqual(Date.parse(completed));

  // messages：合成 system（Zone A 系统提示词）+ pi 原生序列原样
  expect(doc.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
  expect(doc.messages.map((message) => message["role"])).toEqual([
    "system",
    "user", // MR
    "user", // phase-1 指令
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
    "user",
    "assistant",
  ]);
  // 初始上下文与六相位指令逐字原样（合成 system 之外不改写）
  expect(doc.messages[1]?.["timestamp"]).toBe(0);
  expect(String(doc.messages[1]?.["content"])).toContain("Merge request under review.");
  for (let phase = 0; phase < 6; phase += 1) {
    expect(doc.messages[2 + phase * 2]?.["content"]).toBe(PHASE_INSTRUCTIONS[phase]);
  }
  // assistant 回复文本（脚本原文）+ 时间戳/usage 原样在场
  expect([0, 1, 2, 3, 4, 5].map((phase) => textOf(doc.messages[3 + phase * 2]))).toEqual([
    "ok",
    "ok",
    "ok",
    "ok",
    '{"candidates":[]}',
    '{"verdicts":[],"complete":true}',
  ]);
  for (const message of doc.messages.filter((entry) => entry["role"] === "assistant")) {
    expect(typeof message["timestamp"]).toBe("number");
    expect(typeof message["usage"]).toBe("object");
  }

  // info.tokens/cost = 逐条 assistant usage 求和（pi-ai 口径；与审计 LlmUsage 不同层）
  const summed = doc.messages
    .filter((message) => message["role"] === "assistant")
    .reduce<UsageTotals>(
      (acc, message) => {
        const usage = message["usage"] as AssistantUsage;
        acc.tokens.input += usage.input;
        acc.tokens.output += usage.output;
        acc.tokens.reasoning += usage.reasoning ?? 0;
        acc.tokens.cache.read += usage.cacheRead;
        acc.tokens.cache.write += usage.cacheWrite;
        acc.cost.input += usage.cost.input;
        acc.cost.output += usage.cost.output;
        acc.cost.cacheRead += usage.cost.cacheRead;
        acc.cost.cacheWrite += usage.cost.cacheWrite;
        acc.cost.total += usage.cost.total;
        return acc;
      },
      {
        tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    );
  expect(doc.info["tokens"]).toEqual(summed.tokens);
  expect(doc.info["cost"]).toEqual(summed.cost);

  // 检视意见导出：与转录同 run 树、rep-1/ 目录、保序等于 record.baseline.findings
  expect(reviewsPath).toBe(path.join(dir, "rep-1", "reviews_en.json"));
  const envelope = JSON.parse(readFileSync(reviewsPath ?? "", "utf8")) as Record<string, unknown>;
  expect(Object.keys(envelope).sort()).toEqual(
    ["generatedAt", "runId", "source", "caseId", "configId", "rep", "model", "findings"].sort(),
  );
  expect(envelope["runId"]).toBe(doc.info["runId"]);
  expect(envelope["source"]).toBe("vul4j");
  expect(envelope["caseId"]).toBe("VUL4J-1");
  expect(envelope["configId"]).toBe("D");
  expect(envelope["rep"]).toBe(1);
  expect(envelope["model"]).toBe("deepseek-v4-flash");
  expect(envelope["findings"]).toEqual(record.baseline.findings);

  // 形状零漂移：审计与运行记录不携带转录/导出键（路径只出现在返回结果里）
  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as Record<string, unknown>;
  expect(Object.keys(record)).toEqual([
    "source",
    "caseId",
    "configId",
    "rep",
    "model",
    "verifier",
    "completedAt",
    "baseline",
    "effective",
    "verifierPass",
  ]);
  expect(Object.keys(record.baseline)).toEqual([
    "findings",
    "usage",
    "rounds",
    "toolCalls",
    "audit",
    "auditPath",
  ]);
  for (const key of ["transcript", "transcriptPath", "session", "reviews", "reviewsPath"]) {
    expect(key in audit).toBe(false);
    expect(key in record.baseline).toBe(false);
  }
}, 120_000);

test("检视转录：assistant toolCall 与 toolResult 原样保留（链接键 + details 空对象）", async () => {
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
  const { transcriptPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff,
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    configId: "D",
    fetch: script.fetch,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
  });

  const doc = readTranscript(transcriptPath ?? "");
  const messages = doc.messages as readonly Record<string, unknown>[];
  const callIndex = messages.findIndex((message) => {
    const content = message["content"];
    return (
      message["role"] === "assistant" &&
      Array.isArray(content) &&
      content.some((block) => (block as { type?: unknown }).type === "toolCall")
    );
  });
  expect(callIndex).toBeGreaterThan(0);
  const callBlocks = messages[callIndex]?.["content"] as readonly {
    type: string;
    id: string;
    name: string;
  }[];
  const call = callBlocks.find((block) => block.type === "toolCall");
  expect(call?.name).toBe("review_get_diff");

  const result = messages[callIndex + 1] as Record<string, unknown>;
  expect(result["role"]).toBe("toolResult");
  expect(result["toolCallId"]).toBe(call?.id);
  expect(result["isError"]).toBe(false);
  // 本仓工具结果 details 恒为 {}（空内容，非"无源"——Step B 的 view 原样记）
  expect(result["details"]).toEqual({});
  const resultText = (result["content"] as readonly { type: string; text: string }[])[0]?.text ?? "";
  expect(resultText).toContain("MR unified diff:");
}, 120_000);

test("共存：同 case/config 跑两次 → 两个不同 session 文件都在（每 run 独立留档）", async () => {
  const runsRoot = tempRunsRoot();
  const common = {
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    configId: "D" as const,
    runsRoot,
    experimentId: "phase2-smoke",
    rep: 1,
  };
  const first = await runReview({ ...common, fetch: fakeFetch(sixPhaseNoToolCorpus()).fetch });
  // 首次模型请求时刻相差至少 1ms，保证文件名不同（并发毫秒碰撞是测试自身的 bug）
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await runReview({ ...common, fetch: fakeFetch(sixPhaseNoToolCorpus()).fetch });

  expect(first.transcriptPath).not.toBe(second.transcriptPath);
  expect(existsSync(first.transcriptPath ?? "")).toBe(true);
  expect(existsSync(second.transcriptPath ?? "")).toBe(true);
  expect(sessionFiles(runDir(runsRoot, "D"))).toHaveLength(2);
  // reviews_* 按 rep 覆盖重写：同路径单份
  expect(first.reviewsPath).toBe(second.reviewsPath);
  expect(existsSync(first.reviewsPath ?? "")).toBe(true);
}, 120_000);

// C/E/F：Agent 路径的其余配置（D 已在上面详测）——C 全仓注入、E Ledger、
// F 规则 Skill（样本仓库无 .review-rules ⇒ 降级不注入简报）。三者与 D 同缝，
// 断言产物落点/键表/配对键一致。
for (const configId of ["C", "E", "F"] as const) {
  test(`检视转录（config ${configId}）：与 D 同缝产出 session + reviews_en.json`, async () => {
    const script = fakeFetch(sixPhaseNoToolCorpus());
    const runsRoot = tempRunsRoot();
    const { record, transcriptPath, reviewsPath } = await runReview({
      caseId: "VUL4J-1",
      repoPath: repoFixturePath("sample"),
      diff: goldenFixture("vul4j-1.diff"),
      issueDescription: VUL4J_1_ISSUE,
      apiKey: "offline-test",
      configId,
      fetch: script.fetch,
      runsRoot,
      experimentId: "phase2-smoke",
      rep: 1,
    });

    const dir = runDir(runsRoot, configId);
    expect(transcriptPath).toBeDefined();
    expect(path.dirname(transcriptPath ?? "")).toBe(dir);
    expect(sessionFiles(dir)).toHaveLength(1);
    const doc = readTranscript(transcriptPath ?? "");
    expect(Object.keys(doc).sort()).toEqual(["info", "messages"]);
    expect(Object.keys(doc.info).sort()).toEqual([...INFO_KEYS].sort());
    expect(doc.info["configId"]).toBe(configId);
    expect(doc.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });

    expect(reviewsPath).toBe(path.join(dir, "rep-1", "reviews_en.json"));
    const envelope = JSON.parse(readFileSync(reviewsPath ?? "", "utf8")) as {
      runId: unknown;
      configId: string;
      findings: unknown;
    };
    expect(envelope.configId).toBe(configId);
    expect(envelope.runId).toBe(doc.info["runId"]);
    expect(envelope.findings).toEqual(record.baseline.findings);
  }, 120_000);
}

// A/B（非 Agent 路径）：产 reviews_en.json、无 session 文件——其等价物是
// 既有 `requests[].messages`，本能力不另造转录。A 零预取、B 注入哨兵预取。
for (const configId of ["A", "B"] as const) {
  test(`config ${configId}（非 Agent 路径）：产 reviews_en.json、无 session 文件`, async () => {
    const script = fakeFetch(vul4j1Corpus());
    const runsRoot = tempRunsRoot();
    const { record, transcriptPath, reviewsPath } = await runReview({
      caseId: "VUL4J-1",
      // A 零预取零工具、不读仓库——路径不存在也必须跑通
      repoPath: configId === "A" ? path.join(runsRoot, "no-such-repo") : repoFixturePath("sample"),
      diff: goldenFixture("vul4j-1.diff"),
      issueDescription: VUL4J_1_ISSUE,
      apiKey: "offline-test",
      configId,
      fetch: script.fetch,
      runsRoot,
      experimentId: "phase2-smoke",
      rep: 1,
      ...(configId === "B" ? { prefetch: SENTINEL_PREFETCH } : {}),
    });

    expect(transcriptPath).toBeUndefined();
    const dir = runDir(runsRoot, configId);
    expect(sessionFiles(dir)).toEqual([]);
    expect(reviewsPath).toBe(path.join(dir, "rep-1", "reviews_en.json"));
    const envelope = JSON.parse(readFileSync(reviewsPath ?? "", "utf8")) as {
      findings: unknown;
      configId: string;
    };
    expect(envelope.configId).toBe(configId);
    expect(envelope.findings).toEqual(record.baseline.findings);
  }, 120_000);
}
