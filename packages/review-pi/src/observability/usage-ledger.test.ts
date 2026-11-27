import { expect, test } from "vitest";

import {
  aggregateEntries,
  createDetachedUsageScope,
  createUsageLedger,
  createUsageScope,
  mergeUsageSummaries,
  partitionUsage,
  summarizeUsage,
  type UsageEntry,
} from "./usage-ledger.js";

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    scope: "s1",
    source: "agent",
    modelId: "deepseek-v4.1-flash",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 100 },
    attempts: 1,
    ...overrides,
  };
}

test("按 scope 与 source 过滤；同一条记录只被加一次", () => {
  const ledger = createUsageLedger();
  ledger.record(entry({ scope: "s1", source: "agent" }));
  ledger.record(entry({ scope: "s1", source: "reply-repair", usage: { inputTokens: 2, outputTokens: 3 } }));
  ledger.record(entry({ scope: "s2", source: "coverage-repair", usage: { inputTokens: 7, outputTokens: 1 } }));

  const pass = ledger.aggregate({ scope: "s1", sources: ["agent", "reply-repair"] });
  expect(pass.calls).toBe(2);
  expect(pass.usage).toEqual({ inputTokens: 12, outputTokens: 8, cacheReadTokens: 100 });

  const all = ledger.aggregate();
  expect(all.calls).toBe(3);
  expect(all.usage).toEqual({ inputTokens: 19, outputTokens: 9, cacheReadTokens: 100 });
  expect(all.bySource.get("reply-repair")?.calls).toBe(1);
});

test("partitionUsage：Agent 桶 + 一次性桶 = 全量，reply-repair 只进一次性桶", () => {
  const ledger = createUsageLedger();
  ledger.record(entry({ source: "agent", usage: { inputTokens: 10, outputTokens: 5 } }));
  ledger.record(entry({ source: "skill", usage: { inputTokens: 1, outputTokens: 1 } }));
  ledger.record(entry({ source: "reply-repair", usage: { inputTokens: 2, outputTokens: 3 } }));
  ledger.record(entry({ source: "coverage-repair", usage: { inputTokens: 7, outputTokens: 1 } }));

  const { agent, oneShot, total } = partitionUsage(ledger);
  expect(agent.calls).toBe(2);
  expect(agent.usage).toEqual({ inputTokens: 11, outputTokens: 6 });
  expect(oneShot.calls).toBe(2);
  expect(oneShot.usage).toEqual({ inputTokens: 9, outputTokens: 4 });
  expect(total.calls).toBe(4);
  // 关键：全量 = Agent + 一次性，reply-repair 不被两边各加一次
  expect(total.usage).toEqual({
    inputTokens: agent.usage.inputTokens + oneShot.usage.inputTokens,
    outputTokens: agent.usage.outputTokens + oneShot.usage.outputTokens,
  });
});

test("usage 缺席 = 计入调用次数与 missingUsage，token 不加", () => {
  const ledger = createUsageLedger();
  ledger.record(entry({ usage: undefined }));
  const agg = ledger.aggregate();
  expect(agg.calls).toBe(1);
  expect(agg.missingUsageCalls).toBe(1);
  expect(agg.usage).toEqual({ inputTokens: 0, outputTokens: 0 });
});

test("回放条目默认排除；显式 includeReplay 才计入", () => {
  const ledger = createUsageLedger();
  ledger.record(entry({ replay: true, usage: { inputTokens: 99, outputTokens: 1 } }));
  expect(ledger.aggregate().calls).toBe(0);
  expect(ledger.aggregate({ includeReplay: true }).calls).toBe(1);
});

test("byModel 按模型分桶（成本口径）", () => {
  const ledger = createUsageLedger();
  ledger.record(entry({ modelId: "m-a", usage: { inputTokens: 1, outputTokens: 1 } }));
  ledger.record(entry({ modelId: "m-b", usage: { inputTokens: 2, outputTokens: 2 } }));
  const agg = ledger.aggregate();
  expect(agg.byModel.get("m-a")?.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  expect(agg.byModel.get("m-b")?.usage).toEqual({ inputTokens: 2, outputTokens: 2 });
});

test("aggregateEntries 是纯函数：不改写入参数组", () => {
  const entries = [entry(), entry({ usage: undefined })];
  const before = structuredClone(entries);
  const agg = aggregateEntries(entries);
  expect(agg.calls).toBe(2);
  expect(entries).toEqual(before);
});

test("summarizeUsage：JSON 摘要按 source / model 聚合；merge 等价于逐条相加", () => {
  const a = createUsageLedger();
  a.record(entry({ scope: "s1", source: "agent", usage: { inputTokens: 10, outputTokens: 5 } }));
  a.record(entry({ scope: "s1", source: "coverage-repair", usage: { inputTokens: 3, outputTokens: 4 } }));
  const b = createUsageLedger();
  b.record(entry({ scope: "s2", source: "agent", usage: { inputTokens: 1, outputTokens: 2 } }));

  const sa = summarizeUsage(a, { scope: "s1" });
  expect(sa.calls).toBe(2);
  expect(sa.bySource.agent?.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
  expect(sa.bySource["coverage-repair"]?.usage).toEqual({ inputTokens: 3, outputTokens: 4 });
  expect(sa.byModel["deepseek-v4.1-flash"]?.calls).toBe(2);

  const merged = mergeUsageSummaries(sa, summarizeUsage(b));
  expect(merged.calls).toBe(3);
  expect(merged.usage).toEqual({ inputTokens: 14, outputTokens: 11 });
  expect(merged.bySource.agent?.calls).toBe(2);
  expect(merged.bySource.agent?.usage).toEqual({ inputTokens: 11, outputTokens: 7 });
});

test("scope 序号单调递增，互不重叠", () => {
  const ledger = createUsageLedger();
  const a = createUsageScope(ledger, "pass");
  const b = createUsageScope(ledger, "pass");
  expect(a.id).not.toBe(b.id);
  expect(a.ledger).toBe(ledger);
  const detached = createDetachedUsageScope("loop");
  expect(detached.ledger).not.toBe(ledger);
});
