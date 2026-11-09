import type { LlmUsage } from "../contracts/llm.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import type { OneShotCallSample, OneShotPurpose } from "../shared/one-shot-llm.js";

/**
 * 一次性调用的进程级账本（只给 CLI 收尾日志用，不落盘、不进审计、不改退出码）。
 *
 * 采集面 = `shared/one-shot-llm.ts` 的 usage sink：每次「HTTP 2xx + 可读出
 * 文本」的一次性调用记一条样本。响应未带 usage 时仍计调用次数，token 记 0
 * 并单独记 `usageMissingCalls`（零静默）。
 *
 * 这里只做聚合，不做格式化；格式在 `cli/progress-render.ts` 的
 * `taskUsageLines` 单源维护。
 */

/** 用途分桶键：未标注用途的样本归入 `other`（正常路径不会出现） */
export type OneShotPurposeKey = OneShotPurpose | "other";

/** 单一模型维度的用量（成本必须按模型分桶算：presentation 模型可能不同价） */
export interface UsageAggregateModel {
  readonly calls: number;
  readonly usage: LlmUsage;
  readonly usageMissingCalls: number;
}

export interface UsageAggregate {
  readonly calls: number;
  readonly usage: LlmUsage;
  readonly usageMissingCalls: number;
  readonly byModel: ReadonlyMap<string, UsageAggregateModel>;
}

export interface OneShotUsageSnapshot {
  readonly total: UsageAggregate;
  readonly byPurpose: ReadonlyMap<OneShotPurposeKey, UsageAggregate>;
}

export interface OneShotUsageCollector {
  readonly sink: (sample: OneShotCallSample) => void;
  readonly snapshot: () => OneShotUsageSnapshot;
}

interface MutableModel {
  calls: number;
  usage: LlmUsage;
  usageMissingCalls: number;
}

interface MutableAggregate {
  calls: number;
  usage: LlmUsage;
  usageMissingCalls: number;
  readonly byModel: Map<string, MutableModel>;
}

function emptyAggregate(): MutableAggregate {
  return { calls: 0, usage: ZERO_USAGE, usageMissingCalls: 0, byModel: new Map() };
}

function addSample(aggregate: MutableAggregate, sample: OneShotCallSample): void {
  aggregate.calls += 1;
  if (sample.usage === undefined) {
    aggregate.usageMissingCalls += 1;
  } else {
    aggregate.usage = addUsage(aggregate.usage, sample.usage);
  }
  const model = aggregate.byModel.get(sample.modelId) ?? {
    calls: 0,
    usage: ZERO_USAGE,
    usageMissingCalls: 0,
  };
  model.calls += 1;
  if (sample.usage === undefined) {
    model.usageMissingCalls += 1;
  } else {
    model.usage = addUsage(model.usage, sample.usage);
  }
  aggregate.byModel.set(sample.modelId, model);
}

function freezeAggregate(aggregate: MutableAggregate): UsageAggregate {
  const byModel = new Map<string, UsageAggregateModel>();
  for (const [modelId, value] of aggregate.byModel) {
    byModel.set(modelId, {
      calls: value.calls,
      usage: value.usage,
      usageMissingCalls: value.usageMissingCalls,
    });
  }
  return {
    calls: aggregate.calls,
    usage: aggregate.usage,
    usageMissingCalls: aggregate.usageMissingCalls,
    byModel,
  };
}

/** 建一个 collector：`sink` 安装到 one-shot 层，`snapshot` 在收尾时取只读快照 */
export function createOneShotUsageCollector(): OneShotUsageCollector {
  const total = emptyAggregate();
  const byPurpose = new Map<OneShotPurposeKey, MutableAggregate>();
  return {
    sink: (sample) => {
      addSample(total, sample);
      const key: OneShotPurposeKey = sample.purpose ?? "other";
      const aggregate = byPurpose.get(key) ?? emptyAggregate();
      addSample(aggregate, sample);
      byPurpose.set(key, aggregate);
    },
    snapshot: () => {
      const purposes = new Map<OneShotPurposeKey, UsageAggregate>();
      for (const [key, value] of byPurpose) {
        purposes.set(key, freezeAggregate(value));
      }
      return { total: freezeAggregate(total), byPurpose: purposes };
    },
  };
}
