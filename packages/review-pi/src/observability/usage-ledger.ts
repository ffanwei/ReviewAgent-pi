// LLM 用量账本（ADR-0066 口径收敛）：**唯一写入点**是 LLM 调用边界
// （Agent 每轮结束 / `completeOneShot` 成功回包），所有汇总（审计 `usage`、
// `coverageRepair.usage`、CLI `[usage]` 总账、repo 组账）都只做只读投影。
//
// 纪律：
// - 一条记录 = 一次 HTTP 成功回包；`usage` 缺席表示响应未带 usage（调用次数
//   仍计，token 记 0，单列 `missingUsage`），绝不静默丢调用；
// - `scope` 把并发片 / 组隔开：同一进程可以同时有多个 pass，汇总按 scope 过滤；
// - `source` 是唯一归属维度：调用方只声明用途，不自行 `addUsage`。
import type { LlmUsage } from "../contracts/llm.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";

/** 用量来源：Agent 会话 / Skill 会话 / 各类一次性调用 */
export type UsageSource =
  | "agent"
  | "skill"
  | "reply-repair"
  | "candidate-repair"
  | "coverage-repair"
  | "finding-verification"
  | "tips"
  | "summary"
  | "other";

/** 账本条目：一次成功 LLM 回包的用量与归属 */
export interface UsageEntry {
  /** pass / group / task 作用域；同一进程内唯一 */
  readonly scope: string;
  readonly source: UsageSource;
  readonly modelId: string;
  /** 响应未带 usage 时缺席（调用次数仍计） */
  readonly usage?: LlmUsage;
  /** 本条记录代表的 HTTP 尝试数（正常 = 1；截断重发 / 重试可 > 1） */
  readonly attempts: number;
  readonly phase?: string;
  readonly round?: number;
  /** 回放 / fake 传输的录制值：汇总时默认排除 */
  readonly replay?: boolean;
}

/** 只读过滤条件 */
export interface UsageFilter {
  readonly scope?: string;
  readonly sources?: readonly UsageSource[];
  /** 默认 false：回放条目不进真实花费 */
  readonly includeReplay?: boolean;
}

/** 一个作用域的聚合结果 */
export interface UsageAggregate {
  readonly usage: LlmUsage;
  /** 逻辑调用数（条目数） */
  readonly calls: number;
  /** HTTP 尝试数（attempts 之和） */
  readonly attempts: number;
  /** 响应未带 usage 的调用数 */
  readonly missingUsageCalls: number;
  /** 按来源分桶（同一 source 的聚合） */
  readonly bySource: ReadonlyMap<UsageSource, UsageAggregate>;
  /** 按模型分桶（成本必须按模型算） */
  readonly byModel: ReadonlyMap<string, UsageAggregate>;
}

/** JSON 友好的账本摘要（落审计 / run.json / repo 结果用） */
export interface UsageLedgerSummary {
  readonly calls: number;
  readonly attempts: number;
  readonly missingUsageCalls: number;
  readonly usage: LlmUsage;
  readonly bySource: Readonly<Partial<Record<UsageSource, UsageBucketSummary>>>;
  readonly byModel: Readonly<Record<string, UsageBucketSummary>>;
}

export interface UsageBucketSummary {
  readonly calls: number;
  readonly usage: LlmUsage;
  readonly missingUsageCalls: number;
}

/** 单一作用域句柄：ledger + scope id */
export interface UsageScope {
  readonly ledger: UsageLedger;
  readonly id: string;
}

/** Agent 本体来源：主会话 + 规则 Skill（口径单一，汇总不再各写一份） */
export const AGENT_USAGE_SOURCES: readonly UsageSource[] = ["agent", "skill"];

/** 一次性调用来源：除 Agent 本体外的全部用途 */
export const ONE_SHOT_USAGE_SOURCES: readonly UsageSource[] = [
  "reply-repair",
  "candidate-repair",
  "coverage-repair",
  "finding-verification",
  "tips",
  "summary",
  "other",
];

/**
 * 任务账本的标准切分：Agent 桶 + 一次性桶 = 全量，互斥且完备。
 *
 * CLI `[usage]` 行必须用这个切分：reply-repair 只落在一次性桶，Agent 桶
 * 不含它，因此不会再出现「audit.usage 已含 reply + one-shot 又加一次」。
 */
export function partitionUsage(
  ledger: UsageLedger,
  filter: UsageFilter = {},
): { readonly agent: UsageAggregate; readonly oneShot: UsageAggregate; readonly total: UsageAggregate } {
  return {
    agent: ledger.aggregate({ ...filter, sources: AGENT_USAGE_SOURCES }),
    oneShot: ledger.aggregate({ ...filter, sources: ONE_SHOT_USAGE_SOURCES }),
    total: ledger.aggregate(filter),
  };
}

/**
 * 进程内用量账本。只追加、不修改；聚合是纯只读投影。
 *
 * 并发纪律：`scope` 由调用方（pass / group）生成，互不重叠；汇总按 scope
 * 过滤，因此分片并行 / 全仓分组并行时不会互相污染。
 */
export class UsageLedger {
  private readonly items: UsageEntry[] = [];

  record(entry: UsageEntry): void {
    this.items.push(entry);
  }

  entries(filter: UsageFilter = {}): readonly UsageEntry[] {
    return this.items.filter((entry) => matches(entry, filter));
  }

  aggregate(filter: UsageFilter = {}): UsageAggregate {
    return aggregateEntries(this.entries(filter));
  }

  /** 快照（测试 / 诊断用；不可变副本） */
  snapshot(): readonly UsageEntry[] {
    return [...this.items];
  }
}

/** 新建独立账本（直调内核 / 测试的缺省） */
export function createUsageLedger(): UsageLedger {
  return new UsageLedger();
}

let scopeSequence = 0;

/** 在给定账本上建一个唯一作用域 */
export function createUsageScope(ledger: UsageLedger, prefix: string): UsageScope {
  scopeSequence += 1;
  return { ledger, id: `${prefix}#${String(scopeSequence)}` };
}

/** 建独立作用域（自己带一个账本；只在没有上层账本时使用） */
export function createDetachedUsageScope(prefix: string): UsageScope {
  return createUsageScope(createUsageLedger(), prefix);
}

/** 纯聚合：把条目列表压成一个账 */
export function aggregateEntries(entries: readonly UsageEntry[]): UsageAggregate {
  let usage: LlmUsage = ZERO_USAGE;
  let calls = 0;
  let attempts = 0;
  let missingUsageCalls = 0;
  const bySource = new Map<UsageSource, { usage: LlmUsage; calls: number; attempts: number; missingUsageCalls: number }>();
  const byModel = new Map<string, { usage: LlmUsage; calls: number; attempts: number; missingUsageCalls: number }>();
  for (const entry of entries) {
    calls += 1;
    attempts += entry.attempts;
    if (entry.usage === undefined) {
      missingUsageCalls += 1;
    } else {
      usage = addUsage(usage, entry.usage);
    }
    addToBucket(bySource, entry.source, entry);
    addToBucket(byModel, entry.modelId, entry);
  }
  return {
    usage,
    calls,
    attempts,
    missingUsageCalls,
    bySource: freezeBuckets(bySource),
    byModel: freezeBuckets(byModel),
  };
}

/** 账本 → JSON 摘要（审计 / run.json / repo 结果落盘用） */
export function summarizeUsage(
  ledger: UsageLedger,
  filter: UsageFilter = {},
): UsageLedgerSummary {
  const aggregate = ledger.aggregate(filter);
  const bySource: Partial<Record<UsageSource, UsageBucketSummary>> = {};
  for (const [source, bucket] of aggregate.bySource) {
    bySource[source] = bucketSummary(bucket);
  }
  const byModel: Record<string, UsageBucketSummary> = {};
  for (const [model, bucket] of aggregate.byModel) {
    byModel[model] = bucketSummary(bucket);
  }
  return {
    calls: aggregate.calls,
    attempts: aggregate.attempts,
    missingUsageCalls: aggregate.missingUsageCalls,
    usage: aggregate.usage,
    bySource,
    byModel,
  };
}

/** 合并两份摘要（多组 / 多片汇总） */
export function mergeUsageSummaries(
  left: UsageLedgerSummary | undefined,
  right: UsageLedgerSummary | undefined,
): UsageLedgerSummary {
  const a = left ?? EMPTY_SUMMARY;
  const b = right ?? EMPTY_SUMMARY;
  const bySource: Partial<Record<UsageSource, UsageBucketSummary>> = { ...a.bySource };
  for (const [source, bucket] of Object.entries(b.bySource)) {
    const key = source as UsageSource;
    bySource[key] = mergeBucket(bySource[key], bucket);
  }
  const byModel: Record<string, UsageBucketSummary> = { ...a.byModel };
  for (const [model, bucket] of Object.entries(b.byModel)) {
    byModel[model] = mergeBucket(byModel[model], bucket);
  }
  return {
    calls: a.calls + b.calls,
    attempts: a.attempts + b.attempts,
    missingUsageCalls: a.missingUsageCalls + b.missingUsageCalls,
    usage: addUsage(a.usage, b.usage),
    bySource,
    byModel,
  };
}

const EMPTY_SUMMARY: UsageLedgerSummary = {
  calls: 0,
  attempts: 0,
  missingUsageCalls: 0,
  usage: ZERO_USAGE,
  bySource: {},
  byModel: {},
};

function bucketSummary(bucket: UsageAggregate): UsageBucketSummary {
  return {
    calls: bucket.calls,
    usage: bucket.usage,
    missingUsageCalls: bucket.missingUsageCalls,
  };
}

function mergeBucket(
  left: UsageBucketSummary | undefined,
  right: UsageBucketSummary,
): UsageBucketSummary {
  if (left === undefined) {
    return right;
  }
  return {
    calls: left.calls + right.calls,
    usage: addUsage(left.usage, right.usage),
    missingUsageCalls: left.missingUsageCalls + right.missingUsageCalls,
  };
}

function addToBucket<K>(
  buckets: Map<K, { usage: LlmUsage; calls: number; attempts: number; missingUsageCalls: number }>,
  key: K,
  entry: UsageEntry,
): void {
  const bucket = buckets.get(key) ?? {
    usage: ZERO_USAGE,
    calls: 0,
    attempts: 0,
    missingUsageCalls: 0,
  };
  bucket.calls += 1;
  bucket.attempts += entry.attempts;
  if (entry.usage === undefined) {
    bucket.missingUsageCalls += 1;
  } else {
    bucket.usage = addUsage(bucket.usage, entry.usage);
  }
  buckets.set(key, bucket);
}

function freezeBuckets<K>(buckets: Map<K, { usage: LlmUsage; calls: number; attempts: number; missingUsageCalls: number }>): ReadonlyMap<K, UsageAggregate> {
  const frozen = new Map<K, UsageAggregate>();
  for (const [key, value] of buckets) {
    frozen.set(key, {
      usage: value.usage,
      calls: value.calls,
      attempts: value.attempts,
      missingUsageCalls: value.missingUsageCalls,
      bySource: new Map(),
      byModel: new Map(),
    });
  }
  return frozen;
}

function matches(entry: UsageEntry, filter: UsageFilter): boolean {
  if (filter.scope !== undefined && entry.scope !== filter.scope) {
    return false;
  }
  if (filter.sources !== undefined && !filter.sources.includes(entry.source)) {
    return false;
  }
  if (filter.includeReplay !== true && entry.replay === true) {
    return false;
  }
  return true;
}
