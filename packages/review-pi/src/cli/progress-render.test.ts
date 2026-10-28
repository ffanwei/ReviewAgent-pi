import { afterEach, expect, test, vi } from "vitest";
import type { RunProgressEvent } from "../contracts/progress.js";
import { createProgressRenderer, doneLine, type ProgressSummary } from "./progress-render.js";

// 呈现层验收（ADR-0016）：
// 1. 事件行永远追加、可 grep（非 TTY 下不出现 \r）；
// 2. 状态行只在 TTY 出现，且收尾/异常都不留残影；
// 3. 只消费事件里已截断的摘要——本层没有路径能拿到工具结果全文。

const SUMMARY: ProgressSummary = {
  requests: 17,
  reviewToolCalls: 18,
  bashToolCalls: 12,
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

  renderer.finish({
    durationMs: 358_228,
    usage: { inputTokens: 179_527, outputTokens: 20_854, cacheReadTokens: 165_888 },
    costUsd: 0.0312,
  });
  const text = out.text();
  const beforeDone = text.slice(0, text.indexOf("✓ done"));
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

  expect(out.text()).not.toContain("✓ done");
  const lastChunk = out.chunks.at(-1) ?? "";
  expect(lastChunk.startsWith("\r")).toBe(true);
  expect(lastChunk.endsWith("\r")).toBe(true);
});

test("收尾摘要：bash 只在跑过时单列，命中率与请求行同一分母", () => {
  // `tools` 只数 review 工具（与 record.baseline.toolCalls 同口径），bash 另列
  expect(doneLine(SUMMARY)).toBe(
    "✓ done · req 17 · tools 18 · bash 12 · 358.2s · cache 48.0% · $0.0312",
  );
  expect(doneLine({ ...SUMMARY, bashToolCalls: 0, reviewToolCalls: 18 })).toContain("tools 18 ·");
  // 分母含 cacheWrite：700 + 2048 + 100 ⇒ 2048/2848 = 71.9%
  const withWrite = doneLine({
    ...SUMMARY,
    usage: { inputTokens: 700, outputTokens: 0, cacheReadTokens: 2_048, cacheWriteTokens: 100 },
  });
  expect(withWrite).toContain("cache 71.9%");
});
