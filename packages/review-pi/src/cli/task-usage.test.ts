import { expect, test } from "vitest";

import { createOneShotUsageCollector } from "./task-usage.js";

// 整任务一次性调用账本（ADR-0066）：只做聚合，格式化在 progress-render。
// 纪律：无 usage 的调用仍计次数；成本按模型分桶需要的 byModel 必须保留。

test("按用途 / 模型累加；无 usage 的调用计次数、token 记 0", () => {
  const collector = createOneShotUsageCollector();
  collector.sink({
    modelId: "presentation-model",
    purpose: "tips",
    usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 },
  });
  collector.sink({
    modelId: "presentation-model",
    purpose: "tips",
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0 },
  });
  collector.sink({
    modelId: "review-model",
    purpose: "candidate-repair",
    usage: { inputTokens: 7, outputTokens: 3 },
  });
  collector.sink({ modelId: "review-model", purpose: "summary" });

  const snapshot = collector.snapshot();
  expect(snapshot.total.calls).toBe(4);
  expect(snapshot.total.usage).toEqual({
    inputTokens: 117,
    outputTokens: 28,
    cacheReadTokens: 30,
  });
  expect(snapshot.total.usageMissingCalls).toBe(1);
  expect([...snapshot.total.byModel.keys()].sort()).toEqual([
    "presentation-model",
    "review-model",
  ]);
  expect(snapshot.total.byModel.get("presentation-model")).toEqual({
    calls: 2,
    usage: { inputTokens: 110, outputTokens: 25, cacheReadTokens: 30 },
    usageMissingCalls: 0,
  });
  expect(snapshot.total.byModel.get("review-model")).toEqual({
    calls: 2,
    usage: { inputTokens: 7, outputTokens: 3 },
    usageMissingCalls: 1,
  });

  const tips = snapshot.byPurpose.get("tips");
  expect(tips?.calls).toBe(2);
  expect(tips?.usage.inputTokens).toBe(110);
  expect(snapshot.byPurpose.get("summary")?.usageMissingCalls).toBe(1);
  expect(snapshot.byPurpose.get("candidate-repair")?.usage.outputTokens).toBe(3);
});

test("未标用途的样本归入 other；快照与 collector 解耦", () => {
  const collector = createOneShotUsageCollector();
  collector.sink({ modelId: "m", usage: { inputTokens: 1, outputTokens: 2 } });
  const first = collector.snapshot();
  expect(first.byPurpose.get("other")?.calls).toBe(1);

  collector.sink({ modelId: "m", usage: { inputTokens: 3, outputTokens: 4 } });
  expect(first.total.calls).toBe(1);
  expect(collector.snapshot().total.calls).toBe(2);
});
