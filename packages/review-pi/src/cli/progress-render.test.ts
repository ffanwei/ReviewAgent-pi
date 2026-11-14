import { afterEach, expect, test, vi } from "vitest";
import type { RunProgressEvent } from "../contracts/progress.js";
import { createProgressRenderer, doneLine, stageBreakdownLines, taskUsageLines, type ProgressSummary } from "./progress-render.js";

// 呈现层验收（ADR-0016）：
// 1. 事件行永远追加、可 grep（非 TTY 下不出现 \r）；
// 2. 状态行只在 TTY 出现，且收尾/异常都不留残影；
// 3. 只消费事件里已截断的摘要——本层没有路径能拿到工具结果全文。

const SUMMARY: ProgressSummary = {
  modelCalls: 17,
  toolCalls: 30,
  mainToolCalls: 18,
  skillToolCalls: 12,
  skillBashCalls: 0,
  ledgerHits: 4,
  durationMs: 358_228,
  usage: { inputTokens: 179_527, outputTokens: 20_854, cacheReadTokens: 165_888 },
  costUsd: 0.0312,
};

const PHASE: RunProgressEvent = {
  kind: "phase",
  round: 1,
  phase: "Change Understanding",
  index: 1,
  total: 6,
};

const REQUEST_START: RunProgressEvent = { kind: "request", state: "start", requestId: 1 };

const REQUEST_END: RunProgressEvent = {
  kind: "request",
  state: "end",
  requestId: 1,
  durationMs: 8_100,
  usage: { inputTokens: 700, outputTokens: 678, cacheReadTokens: 2_048 },
};

const TOOL_END: RunProgressEvent = {
  kind: "tool",
  state: "end",
  name: "review.get_diff",
  argumentsSummary: "",
  durationMs: 3_100,
  ok: true,
  resultChars: 1_204,
  resultLines: 40,
};

function capture(): { readonly chunks: string[]; readonly text: () => string } {
  const chunks: string[] = [];
  return { chunks, text: () => chunks.join("") };
}

afterEach(() => {
  vi.useRealTimers();
});

test("非 TTY：事件行纯追加、从不出现回车", () => {
  const out = capture();
  const renderer = createProgressRenderer({ write: (text) => out.chunks.push(text), isTty: false });

  renderer.onEvent(PHASE);
  renderer.onEvent(REQUEST_START);
  renderer.onEvent(REQUEST_END);
  renderer.onEvent(TOOL_END);

  expect(out.text()).not.toContain("\r");
  expect(out.text()).toContain("▶ phase 1/6 Change Understanding (round 1)");
  // 命中率分母 = 未命中输入 + 缓读（本事件 cacheWrite 缺席）
  expect(out.text()).toContain("  req 1 8.1s · in 700 (cache 2,048, 74.5%) · out 678");
  expect(out.text()).toContain("  tool review.get_diff ok 3.1s · 1,204 chars / 40 lines");
});

test("TTY：状态行显示在飞请求，请求落地即撤下，收尾先擦行再写摘要", () => {
  vi.useFakeTimers();
  const out = capture();
  let clock = 1_000;
  const renderer = createProgressRenderer({
    write: (text) => out.chunks.push(text),
    isTty: true,
    now: () => clock,
    heartbeatMs: 1_000,
  });

  renderer.onEvent(PHASE);
  renderer.onEvent(REQUEST_START);
  renderer.start();

  clock += 45_000;
  vi.advanceTimersByTime(1_000);
  expect(out.text()).toContain("\r… req 1 45s · phase 1/6 · round 1");

  renderer.onEvent({ ...REQUEST_END, durationMs: 45_000 });
  // 请求结束后状态行重画时不再报这个请求（工具阶段不冒充「请求在飞」）
  const tailAfterEnd = out.text().slice(out.text().indexOf("  req 1 45.0s"));
  expect(tailAfterEnd).not.toContain("req 1 46s");
  expect(out.text()).toMatch(/\r… phase 1\/6 · round 1$/);

  renderer.finish(SUMMARY);
  const text = out.text();
  const beforeDone = text.slice(0, text.indexOf("✓ 完成"));
  // 状态行在 done 行之前被空格补白擦除（\r …空格… \r），不留残影
  expect(/\r +\r$/.test(beforeDone)).toBe(true);
  expect(text.trimEnd().endsWith("$0.0312")).toBe(true);
});

test("状态行心跳：仅 TTY 启动，按注入周期重画", () => {
  vi.useFakeTimers();
  const out = capture();
  let clock = 0;
  const renderer = createProgressRenderer({
    write: (text) => out.chunks.push(text),
    isTty: true,
    now: () => clock,
    heartbeatMs: 1_000,
  });
  renderer.onEvent(PHASE);
  renderer.onEvent(REQUEST_START);
  renderer.start();
  const before = out.chunks.length;

  clock = 3_000;
  vi.advanceTimersByTime(1_000);

  expect(out.chunks.length).toBeGreaterThan(before);
  expect(out.text()).toContain("\r… req 1 3s · phase 1/6 · round 1");
  renderer.dispose();
});

test("失败行带一行 detail，结果尺寸照报（含 0 行）", () => {
  const out = capture();
  const renderer = createProgressRenderer({ write: (text) => out.chunks.push(text), isTty: false });

  renderer.onEvent({
    kind: "tool",
    state: "end",
    name: "review.get_file",
    argumentsSummary: "path=cas-client-core/src/main/java/B.java",
    durationMs: 400,
    ok: false,
    detail: "review.get_file: file not found",
    resultChars: 0,
    resultLines: 0,
  });

  expect(out.text()).toContain(
    "  tool review.get_file FAIL 0.4s · path=cas-client-core/src/main/java/B.java · " +
      "0 chars / 0 lines · review.get_file: file not found",
  );
});

test("skill 作用域：会话内请求行/工具行带 [skill:<name>] 前缀，起止行直接点名", () => {
  const out = capture();
  const renderer = createProgressRenderer({ write: (text) => out.chunks.push(text), isTty: false });

  renderer.onEvent({ kind: "skill", state: "start", round: 1, skill: "general-code-review" });
  renderer.onEvent(REQUEST_START);
  renderer.onEvent(REQUEST_END);
  renderer.onEvent({ ...TOOL_END, name: "bash", argumentsSummary: "command=rg -n TODO" });
  renderer.onEvent({
    kind: "skill",
    state: "end",
    round: 1,
    skill: "general-code-review",
    durationMs: 28_400,
    status: "empty",
    requestCount: 5,
    toolCallCount: 12,
  });

  const text = out.text();
  expect(text).toContain("■ skill general-code-review (round 1)");
  expect(text).toContain("  [skill:general-code-review] req 1 8.1s");
  expect(text).toContain("  [skill:general-code-review] tool bash ok 3.1s · command=rg -n TODO");
  expect(text).toContain("■ skill general-code-review empty · 5 req · 12 tools · 28.4s");
});

test("异常清理：只擦状态行，不输出摘要", () => {
  const out = capture();
  const renderer = createProgressRenderer({ write: (text) => out.chunks.push(text), isTty: true });

  renderer.onEvent(PHASE);
  renderer.onEvent(REQUEST_START);
  renderer.dispose();

  expect(out.text()).not.toContain("✓ 完成");
  const lastChunk = out.chunks.at(-1) ?? "";
  expect(lastChunk.startsWith("\r")).toBe(true);
  expect(lastChunk.endsWith("\r")).toBe(true);
});

test("收尾摘要：一行报全账（耗时/token 三段/模型调用/工具分列/Ledger 命中），命中率与请求行同一分母", () => {
  expect(doneLine(SUMMARY)).toBe(
    "✓ 完成 · 耗时 358.2s · 模型调用 17 次 · " +
      "token 输入 179,527（未命中） · 输出 20,854 · 缓存命中 165,888（48.0%） · " +
      "工具 30 次（主会话 18 + 规则 Skill 12） · " +
      "Ledger 命中 4 次（未重复读取原文） · $0.0312",
  );
  // 分母含 cacheWrite：700 + 2048 + 100 ⇒ 2048/2848 = 71.9%
  const withWrite = doneLine({
    ...SUMMARY,
    usage: { inputTokens: 700, outputTokens: 0, cacheReadTokens: 2_048, cacheWriteTokens: 100 },
  });
  expect(withWrite).toContain("缓存命中 2,048（71.9%）");
  // skill 内 bash 真跑过才单列（指标 toolCalls 不含它，ADR-0014）
  expect(doneLine({ ...SUMMARY, skillBashCalls: 12 })).toContain(
    "规则 Skill 12） · skill bash 12 次 · Ledger 命中",
  );
});

test("阶段账本：主链路可相加、审计明细按审计占比、嵌套 Skill 标注不重复计入", () => {
  const lines = stageBreakdownLines({
    totalMs: 360_500,
    stages: [
      { label: "准备/建连", durationMs: 10_700 },
      { label: "六阶段审计", durationMs: 232_600 },
      { label: "报文生成+上报", durationMs: 74_100 },
      { label: "中文 tips 组装/落盘", durationMs: 0 },
      { label: "总结生成", durationMs: 32_900 },
      { label: "固定沉降", durationMs: 10_000 },
      { label: "其他/收尾", durationMs: 200 },
    ],
    phases: [
      { label: "P1", durationMs: 6_500 },
      { label: "P2", durationMs: 3_200 },
      { label: "P5", durationMs: 72_400 },
      { label: "P6", durationMs: 45_900 },
    ],
    nested: [{ label: "general-code-review", durationMs: 82_100 }],
  });
  expect(lines[0]).toBe("[time] 阶段耗时 | 总墙钟 360.5s（含总结 / 沉降 / 收尾）");
  expect(lines).toContain("[time] 阶段 | 六阶段审计 232.6s (64.5%)");
  // 0 值阶段也保留：投影关闭时能看到「确实没花时间」
  expect(lines).toContain("[time] 阶段 | 中文 tips 组装/落盘 0.0s (0.0%)");
  // 审计明细的分母 = 明细之和，不是总墙钟
  expect(lines.join("\n")).toMatch(/\[time\] 审计明细 \| P1 6\.5s \(5\.1%\)/);
  expect(lines.join("\n")).toContain("（含于审计，不重复计入）");
});

test("阶段账本：总墙钟为 0 时不输出（避免除零与空块）", () => {
  expect(stageBreakdownLines({ totalMs: 0, stages: [], phases: [], nested: [] })).toEqual([]);
});

test("整任务账本：Agent + 一次性合并，分项按用途拆行并标出无 usage 调用", () => {
  const lines = taskUsageLines({
    agentCalls: 17,
    agentUsage: {
      inputTokens: 179_527,
      outputTokens: 20_854,
      cacheReadTokens: 165_888,
    },
    oneShotCalls: 3,
    oneShotUsage: { inputTokens: 2_400, outputTokens: 900, cacheReadTokens: 1_200 },
    oneShotMissingUsageCalls: 1,
    costUsd: 0.0412,
    purposes: [
      { label: "中文 tips", calls: 1, usage: { inputTokens: 1_200, outputTokens: 600, cacheReadTokens: 0 }, usageMissingCalls: 0 },
      { label: "收尾总结", calls: 1, usage: { inputTokens: 1_200, outputTokens: 300, cacheReadTokens: 1_200 }, usageMissingCalls: 0 },
      { label: "候选修复", calls: 1, usage: { inputTokens: 0, outputTokens: 0 }, usageMissingCalls: 1 },
    ],
  });
  expect(lines[0]).toBe(
    "[usage] 任务总计 | 模型调用 20 次（Agent 17 + 一次性 3） | token 输入 181,927（未命中） | " +
      "输出 21,754 | 缓存命中 167,088（47.9%） | 未带 usage 1 次 | $0.0412",
  );
  expect(lines[1]).toBe(
    "[usage] 一次性明细 | 中文 tips 1 次（输入 1,200 / 输出 600 / 缓存 0） | " +
      "收尾总结 1 次（输入 1,200 / 输出 300 / 缓存 1,200） | " +
      "候选修复 1 次（输入 0 / 输出 0 / 缓存 0，1 次无 usage）",
  );
});

test("整任务账本：零调用不输出；无一次性调用时只有总计行", () => {
  expect(
    taskUsageLines({
      agentCalls: 0,
      agentUsage: { inputTokens: 0, outputTokens: 0 },
      oneShotCalls: 0,
      oneShotUsage: { inputTokens: 0, outputTokens: 0 },
      oneShotMissingUsageCalls: 0,
      purposes: [],
      costUsd: 0,
    }),
  ).toEqual([]);

  const lines = taskUsageLines({
    agentCalls: 6,
    agentUsage: { inputTokens: 1_000, outputTokens: 100, cacheReadTokens: 0 },
    oneShotCalls: 0,
    oneShotUsage: { inputTokens: 0, outputTokens: 0 },
    oneShotMissingUsageCalls: 0,
    purposes: [],
    costUsd: 0.01,
  });
  expect(lines).toHaveLength(1);
  expect(lines[0]).toContain("[usage] 任务总计 | 模型调用 6 次（Agent 6 + 一次性 0）");
});
