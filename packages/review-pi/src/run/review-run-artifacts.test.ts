import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
  buildView,
  type ViewAssistantMessage,
  type ViewToolPart,
  type ViewUserMessage,
} from "../export/transcript.js";
import { PHASE_INSTRUCTIONS } from "../loop/phases.js";
import { fakeFetch, type FakeReply } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_ISSUE } from "../testing/vul4j1-script.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import { runReview } from "./review-run.js";

// 落盘产物（ADR-0013）：检视转录 `session-*.json`（`{ info, messages, view }`）
// + 检视意见导出 `reviews_en.json`。断言面 = 磁盘文件与其形状（S1 = runReview
// 公共入口），不窥探内核内部状态。零网络（fake 适配器）。

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

/** 检视转录文档（info + messages + view）的宽松读取面 */
interface TranscriptDoc {
  readonly info: Record<string, unknown>;
  readonly messages: readonly Record<string, unknown>[];
  readonly view: {
    readonly messages: readonly Record<string, unknown>[];
  };
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

function runDir(runsRoot: string): string {
  return path.join(runsRoot, "runs", "mr", "VUL4J-1");
}

function sessionFiles(dir: string): string[] {
  return readdirSync(dir).filter((name) => name.startsWith("session-") && name.endsWith(".json"));
}

const INFO_KEYS = [
  "id",
  "runId",
  "agent",
  "model",
  "tokens",
  "cost",
  "outcome",
  "time",
  "title",
  "location",
];

test("检视转录：落点/命名/info 精确键表/messages 原生序列", async () => {
  const script = fakeFetch(sixPhaseNoToolCorpus());
  const runsRoot = tempRunsRoot();
  const repoPath = repoFixturePath("sample");
  const { record, auditPath, transcriptPath, reviewsPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath,
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    rep: 1,
    ruleSkillLoader: async () => [],
  });

  // 落点：与 rep-1.json 平铺（runs/vul4j/VUL4J-1/），名字含首次模型请求时刻
  const dir = runDir(runsRoot);
  expect(transcriptPath).toBeDefined();
  expect(path.dirname(transcriptPath ?? "")).toBe(dir);
  expect(existsSync(transcriptPath ?? "")).toBe(true);
  const baseName = path.basename(transcriptPath ?? "");
  expect(baseName).toMatch(/^session-\d{8}T\d{6}\.\d{3}-VUL4J-1\.json$/);
  // 每 run 独立留档：目录只有这一份 session
  expect(sessionFiles(dir)).toEqual([baseName]);

  const doc = readTranscript(transcriptPath ?? "");

  // 顶层恰好三键（原生真源 + 定形 view）；info 键集合精确（无 kind/version/projectID/durationMs）
  expect(Object.keys(doc).sort()).toEqual(["info", "messages", "view"]);
  expect(Object.keys(doc.info).sort()).toEqual([...INFO_KEYS].sort());

  // info 取值：id = 文件名 stem；runId = 审计 runId（配对键，与命名时间不同源）
  expect(doc.info["id"]).toBe(baseName.replace(/\.json$/, ""));
  expect(doc.info["runId"]).toBe(path.basename(auditPath, ".json"));
  expect(doc.info["agent"]).toBe("review");
  expect(doc.info["title"]).toBe("VUL4J-1");
  expect(doc.info["location"]).toEqual({ directory: repoPath });
  // ADR-0015：逐消息时间戳已可用，声明键退役（键表精确断言之外再显式否定一次）
  expect("perMessageTimestamps" in doc.info).toBe(false);
  expect(doc.info["outcome"]).toBe("succeeded");
  const model = doc.info["model"] as { id: unknown; baseUrl: unknown };
  expect(model.id).toBe("deepseek-v4-flash");
  expect(typeof model.baseUrl).toBe("string");

  // 命名时间 = 首次模型请求时刻（info.time 为 epoch 毫秒 {created, updated}；
  // 紧凑 ISO 形 = 文件名中段）。`completed` 退役后不得复活。
  const time = doc.info["time"] as { created: unknown; updated: unknown };
  expect(Object.keys(time).sort()).toEqual(["created", "updated"]);
  expect("completed" in time).toBe(false);
  expect(typeof time.created).toBe("number");
  expect(typeof time.updated).toBe("number");
  const created = new Date(time.created as number).toISOString();
  const nameSegment = baseName.replace(/^session-/, "").replace(/-VUL4J-1\.json$/, "");
  expect(created.replace(/[-:]/g, "").replace("Z", "")).toBe(nameSegment);
  expect(time.created as number).toBeLessThanOrEqual(time.updated as number);

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
  // 初始上下文与六相位指令逐字原样（合成 system 之外不改写）；timestamp 为真值（ADR-0015）
  const firstUser = doc.messages[1] as { timestamp: unknown };
  expect(typeof firstUser["timestamp"]).toBe("number");
  expect(firstUser["timestamp"] as number).toBeGreaterThan(0);
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

  // view：定形投影——messages[0] 为合成 system，其后镜像 user/assistant（无 toolResult 独立消息）
  expect(doc.view.messages[0]).toEqual({ type: "system", text: SYSTEM_PROMPT });
  expect(doc.view.messages.map((message) => message["type"])).toEqual([
    "system",
    "user",
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
    "user",
    "assistant",
  ]);
  const viewAssistant = doc.view.messages.filter((message) => message["type"] === "assistant");
  for (const message of viewAssistant) {
    // 有源就填（ADR-0015）：created ← assistant.timestamp；streamed/completed 无源仍 null
    expect(message["time"]).toEqual({
      created: expect.any(Number),
      streamed: null,
      completed: null,
    });
    expect((message["time"] as { created: number }).created).toBeGreaterThan(0);
    // 其余无源字段恒 null（定形纪律）：snapshot、model.variant
    expect(message["snapshot"]).toBeNull();
    // id：首个 assistant 取 provider `responseId`（fake 适配器恒回 "chatcmpl-fake"），
    // 之后重复出现 ⇒ 回退合成序号（ADR-0015 唯一性兜底）；唯一性由下方集合断言把守
    expect(typeof message["id"]).toBe("string");
    expect((message["id"] as string).length).toBeGreaterThan(0);
    expect((message["model"] as { variant: unknown }).variant).toBeNull();
    // 有源字段：model.id/providerID、finish、tokens/cost 皆在场
    const model = message["model"] as { id: unknown; providerID: unknown };
    expect(model.id).toBe("deepseek-v4-flash");
    expect(typeof model.providerID).toBe("string");
    expect(typeof message["finish"]).toBe("string");
    expect(typeof message["cost"]).toBe("number");
    expect(message["tokens"]).toMatchObject({ cache: { read: expect.any(Number), write: expect.any(Number) } });
    // assistant 的 text part 逐条镜像 messages 里的文本（无工具 → 无 tool part）
    expect((message["content"] as readonly { type: string }[]).every((part) => part.type === "text")).toBe(true);
  }
  // 首个 assistant 保留 provider 溯源 id（后续重复值回退合成序号）
  expect(viewAssistant[0]?.["id"]).toBe("chatcmpl-fake");
  // user 消息：text 原样、无源 files/agents 恒空数组、id 合成序号、time.created 为真值
  const viewUser = doc.view.messages.filter((message) => message["type"] === "user");
  expect(viewUser[0]).toEqual({
    type: "user",
    id: "msg_0001",
    time: { created: expect.any(Number) },
    text: expect.stringContaining("Merge request under review."),
    files: [],
    agents: [],
  });
  // 合成 id 在「user/assistant 子序列」内唯一且非空（system 不占号）
  const viewIds = doc.view.messages
    .filter((message) => message["type"] !== "system")
    .map((message) => message["id"]);
  expect(viewIds.every((id) => typeof id === "string" && id.length > 0)).toBe(true);
  expect(new Set(viewIds).size).toBe(viewIds.length);
  // id 只有两种形态：provider `responseId` 或合成 `msg_<≥4 位数字>`；
  // 合成序号在文档序上严格递增（首见 responseId 之后回退合成序号也不乱序）
  const syntheticSeq: number[] = [];
  for (const id of viewIds as string[]) {
    const match = /^msg_(\d{4,})$/.exec(id);
    if (match !== null) {
      syntheticSeq.push(Number(match[1]));
    } else {
      expect(id).toBe("chatcmpl-fake");
    }
  }
  expect(syntheticSeq).toEqual([...syntheticSeq].sort((left, right) => left - right));
  expect(new Set(syntheticSeq).size).toBe(syntheticSeq.length);

  // ADR-0015 决策 10：view 的时间 = 对应 native timestamp（纯投影，不另取时钟）
  const infoTime = doc.info["time"] as { created: number; updated: number };
  const nativeConvo = doc.messages
    .slice(1) // 跳过合成 system
    .filter((message) => message["role"] === "user" || message["role"] === "assistant");
  const viewConvo = doc.view.messages.slice(1);
  expect(viewConvo).toHaveLength(nativeConvo.length);
  viewConvo.forEach((viewMessage, index) => {
    const native = nativeConvo[index]!;
    expect((viewMessage["time"] as { created: number }).created).toBe(native["timestamp"]);
  });

  // 所有时间都 <= 收尾时刻；**首个 assistant 之后**的消息一律 >= 首次请求时刻。
  // 开跑前入列的 user（初始上下文 + Phase 0 指令）与首个 assistant（pi 在
  // `onPayload` 之前就给 partial 消息打点，openai-completions.ts:334）都早于
  // `info.time.created`——这是 ADR-0015 决策 8 明确接受的倒挂。真实时钟下只
  // 断言方向与区间，不断言严格先后或绝对毫秒。
  const firstAssistantIndex = doc.messages.findIndex((message) => message["role"] === "assistant");
  // 主会话固定形态：messages[1] 初始上下文、messages[2] Phase 0 指令、messages[3] 首个回复
  expect(firstAssistantIndex).toBe(3);
  for (const [index, message] of doc.messages.entries()) {
    if (index === 0) continue;
    expect(typeof message["timestamp"]).toBe("number");
    expect(message["timestamp"] as number).toBeLessThanOrEqual(infoTime.updated);
    if (index > firstAssistantIndex) {
      expect(message["timestamp"] as number).toBeGreaterThanOrEqual(infoTime.created);
    }
  }
  // 首次请求前缀（含首个 assistant）按代码顺序不会晚于 firstRequestAt。
  for (const message of doc.messages.slice(1, firstAssistantIndex + 1)) {
    expect(message["timestamp"] as number).toBeLessThanOrEqual(infoTime.created);
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
    ["generatedAt", "runId", "source", "caseId", "rep", "model", "findings"].sort(),
  );
  expect(envelope["runId"]).toBe(doc.info["runId"]);
  expect(envelope["source"]).toBe("mr");
  expect(envelope["caseId"]).toBe("VUL4J-1");
  expect(envelope["rep"]).toBe(1);
  expect(envelope["model"]).toBe("deepseek-v4-flash");
  expect(envelope["findings"]).toEqual(record.baseline.findings);

  // 形状零漂移：审计与运行记录不携带转录/导出键（路径只出现在返回结果里）
  const audit = JSON.parse(readFileSync(auditPath, "utf8")) as Record<string, unknown>;
  expect(Object.keys(record)).toEqual([
    "source",
    "caseId",
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
    fetch: script.fetch,
    runsRoot,
    rep: 1,
    ruleSkillLoader: async () => [],
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

  // view：toolResult 不另立消息——按 toolCall.id ↔ toolResult.toolCallId 合并进对应 assistant 的 tool part
  // （view 消息序列 = system + `messages` 里的 user/assistant，跳过 toolResult）
  const viewTypes = doc.view.messages.map((message) => message["type"]);
  const expectedViewTypes = [
    "system",
    ...messages
      .filter((message) => message["role"] !== "toolResult" && message["role"] !== "system")
      .map((message) => message["role"]),
  ];
  expect(viewTypes).toEqual(expectedViewTypes);
  expect(viewTypes).not.toContain("toolResult");
  const viewToolAssistant = doc.view.messages.filter(
    (message) =>
      message["type"] === "assistant" &&
      (message["content"] as readonly { type: string }[]).some((part) => part.type === "tool"),
  );
  expect(viewToolAssistant).toHaveLength(1);
  const parts = viewToolAssistant[0]?.["content"] as readonly Record<string, unknown>[];
  const toolPart = parts.find((part) => part["type"] === "tool");
  expect(toolPart?.["id"]).toBe(call?.id);
  expect(toolPart?.["name"]).toBe("review_get_diff");
  // ADR-0015：tool.time.completed ← toolResult.timestamp；created/ran 无源仍 null
  expect(toolPart?.["time"]).toEqual({ created: null, ran: null, completed: expect.any(Number) });
  // 有源字段与 native 一一对账，且落在会话区间内（不另取时钟）
  const infoTime = doc.info["time"] as { created: number; updated: number };
  expect((toolPart?.["time"] as { completed: number }).completed).toBe(result["timestamp"]);
  expect((toolPart?.["time"] as { completed: number }).completed).toBeLessThanOrEqual(infoTime.updated);
  expect((viewToolAssistant[0]?.["time"] as { created: number }).created).toBe(messages[callIndex]?.["timestamp"]);
  const state = toolPart?.["state"] as Record<string, unknown>;
  expect(state["status"]).toBe("completed");
  expect(state["metadata"]).toBeNull();
  expect(state["error"]).toBeUndefined();
  // content 原样 = toolResult.content（Step A 已断言 details {} 不投到这里）
  expect(state["content"]).toEqual(result["content"]);
}, 120_000);

test("共存：同 case 跑两次 → 两个不同 session 文件都在（每 run 独立留档）", async () => {
  const runsRoot = tempRunsRoot();
  const common = {
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: goldenFixture("vul4j-1.diff"),
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    runsRoot,
    rep: 1,
    ruleSkillLoader: async () => [],
  };
  const first = await runReview({ ...common, fetch: fakeFetch(sixPhaseNoToolCorpus()).fetch });
  // 首次模型请求时刻相差至少 1ms，保证文件名不同（并发毫秒碰撞是测试自身的 bug）
  await new Promise((resolve) => setTimeout(resolve, 2));
  const second = await runReview({ ...common, fetch: fakeFetch(sixPhaseNoToolCorpus()).fetch });

  expect(first.transcriptPath).not.toBe(second.transcriptPath);
  expect(existsSync(first.transcriptPath ?? "")).toBe(true);
  expect(existsSync(second.transcriptPath ?? "")).toBe(true);
  expect(sessionFiles(runDir(runsRoot))).toHaveLength(2);
  // reviews_* 按 rep 覆盖重写：同路径单份
  expect(first.reviewsPath).toBe(second.reviewsPath);
  expect(existsSync(first.reviewsPath ?? "")).toBe(true);
}, 120_000);

// ---- `view` 定形投影单元面（纯函数 `buildView`） ----
// runReview 路径不可达的两态在此直接覆盖：无匹配 toolResult 的 toolCall（截断/
// 中止 → `pending`）与 thinking 分块（→ `reasoning`）。另验证 isError 合并、
// 数组内容 user 消息、id 两遍分配（responseId 回退合成序号）、仍无源字段恒 null。

/** 造一条 assistant（宽松面：只填 view 投影读到的字段） */
function viewAssistant(content: readonly unknown[], extra: Record<string, unknown> = {}): AgentMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "deepseek",
    model: "deepseek-v4-flash",
    usage: {
      input: 5,
      output: 7,
      cacheRead: 2,
      cacheWrite: 1,
      reasoning: 3,
      totalTokens: 15,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 1.25 },
    },
    stopReason: "toolUse",
    timestamp: 0,
    ...extra,
  } as unknown as AgentMessage;
}

test("buildView：pending/reasoning/error 合并/数组内容 user（runReview 不可达态）", () => {
  const messages = [
    {
      role: "user",
      // 数组内容：只拼 text 块（图片块忽略）——无源分块不投
      content: [
        { type: "text", text: "part-a" },
        { type: "image", data: "aGk=", mimeType: "image/png" },
        { type: "text", text: "part-b" },
      ],
      timestamp: 1000,
    },
    viewAssistant(
      [
        { type: "thinking", thinking: "hmm", signature: "sig" },
        { type: "toolCall", id: "call-err", name: "review_bogus", arguments: { foo: "bar" } },
        { type: "toolCall", id: "call-pending", name: "review_get_diff", arguments: {} },
      ],
      { responseId: "resp-1", rawStopReason: "tool_calls", timestamp: 2000 },
    ),
    {
      role: "toolResult",
      toolCallId: "call-err",
      toolName: "review_bogus",
      content: [{ type: "text", text: "Tool review_bogus not found" }],
      details: {},
      isError: true,
      timestamp: 3000,
    },
    // 后续一轮：验证序号跨轮继续递增，且 assistant 无 responseId 时回退合成 id
    { role: "user", content: "next", timestamp: 4000 },
    viewAssistant([{ type: "text", text: "done" }], { timestamp: 5000 }),
    // responseId 与首条重复（fake 适配器恒回一个值）⇒ 后来者回退合成 id，保证唯一
    viewAssistant([{ type: "text", text: "again" }], { responseId: "resp-1", timestamp: 6000 }),
  ] as unknown as readonly AgentMessage[];

  const view = buildView("SYS", messages);

  // 不另立 toolResult 消息：system + 两轮 user/assistant + 重复 responseId 的一条
  expect(view.messages.map((message) => message.type)).toEqual([
    "system",
    "user",
    "assistant",
    "user",
    "assistant",
    "assistant",
  ]);
  expect(view.messages[0]).toEqual({ type: "system", text: "SYS" });

  const user = view.messages[1] as ViewUserMessage;
  expect(user.type).toBe("user");
  expect(user.text).toBe("part-a\npart-b");
  expect(user.files).toEqual([]);
  expect(user.agents).toEqual([]);
  // ADR-0015：user 一律合成序号；时间取 native timestamp
  expect(user.id).toBe("msg_0001");
  expect(user.time).toEqual({ created: 1000 });

  const assistant = view.messages[2] as ViewAssistantMessage;
  expect(assistant.type).toBe("assistant");
  expect(assistant.id).toBe("resp-1");
  expect(assistant.time).toEqual({ created: 2000, streamed: null, completed: null });
  expect(assistant.finish).toBe("toolUse");
  expect(assistant.rawFinish).toBe("tool_calls");
  expect(assistant.model).toEqual({ id: "deepseek-v4-flash", providerID: "deepseek", variant: null });
  expect(assistant.content[0]).toEqual({ type: "reasoning", text: "hmm", time: { created: null, completed: null } });
  expect(assistant.tokens).toEqual({ input: 5, output: 7, reasoning: 3, cache: { read: 2, write: 1 } });
  expect(assistant.cost).toBe(1.25);

  const toolParts = assistant.content.filter((part): part is ViewToolPart => part.type === "tool");
  expect(toolParts.map((part) => part.id)).toEqual(["call-err", "call-pending"]);
  for (const part of toolParts) {
    expect(part.state.metadata).toBeNull();
  }
  // isError → status error + error.message = 结果文本拼接
  const errPart = toolParts[0]!;
  expect(errPart.name).toBe("review_bogus");
  expect(errPart.state.status).toBe("error");
  expect(errPart.state.input).toEqual({ foo: "bar" });
  expect(errPart.state.error).toEqual({ message: "Tool review_bogus not found" });
  expect(errPart.state.content).toEqual([{ type: "text", text: "Tool review_bogus not found" }]);
  // 无匹配 toolResult → pending：content null、无 error 键、completed 无源仍 null
  const pendingPart = toolParts[1]!;
  expect(pendingPart.state.status).toBe("pending");
  expect(pendingPart.state.content).toBeNull();
  expect("error" in pendingPart.state).toBe(false);
  expect(pendingPart.time).toEqual({ created: null, ran: null, completed: null });
  // 有结果 → completed ← toolResult.timestamp（ADR-0015）；created/ran 无源
  expect(errPart.time).toEqual({ created: null, ran: null, completed: 3000 });

  // 第二轮：序号跨轮继续递增（跳过合成 system），assistant 无 responseId 回退合成 id
  const secondUser = view.messages[3] as ViewUserMessage;
  const secondAssistant = view.messages[4] as ViewAssistantMessage;
  expect(secondUser.id).toBe("msg_0003");
  expect(secondUser.time).toEqual({ created: 4000 });
  expect(secondAssistant.id).toBe("msg_0004");
  expect(secondAssistant.time).toEqual({ created: 5000, streamed: null, completed: null });

  // 重复 responseId ⇒ 后来者回退合成序号（seq=5），不产生重复 id
  const duplicateAssistant = view.messages[5] as ViewAssistantMessage;
  expect(duplicateAssistant.id).toBe("msg_0005");
  const ids = view.messages
    .filter((message) => message.type !== "system")
    .map((message) => message.id);
  expect(new Set(ids).size).toBe(ids.length);
});

test("buildView：responseId 与合成序号撞名或为空时回退（合成 id 不被抢占）", () => {
  const messages = [
    // 首个 assistant 的 responseId 恰是「下一条 user」的合成序号——不得抢占
    viewAssistant([{ type: "text", text: "a" }], { responseId: "msg_0002", timestamp: 1 }),
    { role: "user", content: "u", timestamp: 2 },
    // 空字符串 responseId 视为缺失
    viewAssistant([{ type: "text", text: "b" }], { responseId: "", timestamp: 3 }),
    // 与合成 id 同形但不在本次分配范围内的 provider id 也不得占用
    viewAssistant([{ type: "text", text: "c" }], { responseId: "msg_0100", timestamp: 4 }),
  ] as unknown as readonly AgentMessage[];

  const view = buildView("SYS", messages);
  // 合成序号先全部预分配；撞名/为空/同形的 assistant 只能保留自己的合成序号
  expect(
    view.messages.map((message) => (message.type === "system" ? null : message.id)),
  ).toEqual([null, "msg_0001", "msg_0002", "msg_0003", "msg_0004"]);
});
