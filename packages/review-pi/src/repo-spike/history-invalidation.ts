// 历史意见失效检查的编排层（R-21）。
//
// 职责：装配输入（读盘注入给纯判定核心）、随组流水线化判定（不阻塞下一组
// 检视）、LLM 裁决队列（并发 2）、成功结果原子落盘（续跑按 tipsId 复用）、
// 收尾 end-sweep（file-removed / not-reached / 续跑组补判）与合并。
//
// 层次：本模块在 repo-spike 引擎层，**不知道 MCP**——输出是中性的
// `{ tipsId, reason }[]`，CLI 映射成 `InvalidatedTip`（保持 ADR-0117 的
// repo-spike / MCP 解耦）。
//
// 硬性不变量（R-21 票「故障语义」）：
// - 判定是收尾链里优先级最低的一环：任何失败最多「这批不判」，绝不影响
//   检视结果、产物落盘、退出码；`finalize` 出口只有列表或空列表，绝不抛出；
// - 每条 LLM 候选恰好一次裁决尝试（无预算截断）；调用失败 → 该批保守
//   保留，失败不落盘（续跑天然重试）；
// - 误失效代价高于漏失效：一切拿不准的路径落在保留。

import { readFile } from "node:fs/promises";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";
import type { StructuredLlm } from "../provider/structured-reply.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import { createDetachedUsageScope } from "../observability/usage-ledger.js";
import type { GenericReviewLimits, HistoryTipsLimits } from "../shared/config-limits.js";
import { filterGenericSuggestions } from "../shared/generic-review-policy.js";
import {
  evaluateMatrix,
  HISTORY_TIPS_RELATIVE_PATH,
  parseHistoryTipsDocument,
  reasonFromVerdict,
  type HistoryTipEntry,
} from "./history-tips.js";
import {
  judgeFileVerdicts,
  type VerdictBatchOutcome,
  type VerdictCandidate,
} from "./history-verdict.js";
import type { RepoReviewedBatch } from "./types.js";

/** 上报条目（中性形状；CLI 映射 InvalidatedTip） */
export interface InvalidationReportItem {
  readonly tipsId: number;
  readonly reason: string;
}

/** finalize 的出口：上报条目（CLI 映射 InvalidatedTip）+ 摘要（result 注入） */
export interface InvalidationFinalOutcome {
  readonly report: readonly InvalidationReportItem[];
  readonly summary: InvalidationSummary;
}

/** 逐条终态（result 摘要与 sidecar 的数据源） */
export interface InvalidationItem {
  readonly tipsId: number;
  readonly filePath: string;
  readonly outcome: "invalidate" | "keep";
  readonly reason?: string;
  readonly matchedFindingId?: string;
  readonly verdict?: string;
  readonly note?: string;
  readonly cause?: string;
}

/** 判定缓存与最终 sidecar 的公共条目形状 */
export type InvalidationDecisionRecord = InvalidationItem;

export interface InvalidationSummary {
  readonly total: number;
  readonly checked: number;
  readonly skippedInvalidated: number;
  readonly skippedStatus: number;
  readonly invalidEntries: number;
  readonly invalidated: number;
  readonly kept: number;
  readonly byReason: Readonly<Record<string, number>>;
  readonly byVerdict: Readonly<Record<string, number>>;
  readonly byStatus: Readonly<Record<string, number>>;
  readonly verdictCalls: number;
  readonly verdictFailed: number;
  readonly verdictUsage: LlmUsage;
}

/** 历史文件装载结果（stats 进 result 摘要） */
export interface HistoryTipsLoadResult {
  readonly entries: readonly HistoryTipEntry[];
  readonly total: number;
  readonly skippedInvalidated: number;
  readonly skippedStatus: number;
  readonly invalidEntries: number;
}

const CACHE_SCHEMA_VERSION = 1;

/** 判定缓存文件名（<out>/ 下；续跑按 tipsId 复用） */
export const VERDICT_CACHE_FILENAME = "history-tips-verdicts.json";
/** 最终 sidecar 文件名（<out>/ 下；含 summary + 逐条明细） */
export const INVALIDATION_SIDECAR_FILENAME = "history-tips-invalidation.json";

/** 判定 worker 并发：与检视组抢速率的幅度可控；drain 在收尾等待 */
const VERDICT_CONCURRENCY = 2;

export type ReadRepoText = (absolutePath: string) => Promise<string | null>;

/** 读历史意见文件；不存在 → null（功能不启用）。坏 JSON → null + 一行日志。 */
export async function loadHistoryTips(
  input: {
    readonly repoPath: string;
    readonly limits: HistoryTipsLimits;
    readonly readText?: ReadRepoText;
    readonly log: (line: string) => void;
  },
): Promise<HistoryTipsLoadResult | null> {
  const absolute = path.join(input.repoPath, ...HISTORY_TIPS_RELATIVE_PATH.split("/"));
  const raw = await (input.readText ?? defaultReadText)(absolute);
  if (raw === null) {
    return null;
  }
  const parsed = parseHistoryTipsDocument(raw, input.limits);
  if (parsed === undefined) {
    input.log(
      `review-pi: ${HISTORY_TIPS_RELATIVE_PATH} 不是合法 JSON 数组，跳过历史意见失效检查\n`,
    );
    return null;
  }
  input.log(
    `review-pi: 历史意见失效检查启用：${String(parsed.entries.length)}/${String(parsed.total)} 条待检查` +
      `（INVALIDATED ${String(parsed.skippedInvalidated)} / 状态过滤 ${String(parsed.skippedStatus)} / 非法 ${String(parsed.invalidEntries)}）\n`,
  );
  return {
    entries: parsed.entries,
    total: parsed.total,
    skippedInvalidated: parsed.skippedInvalidated,
    skippedStatus: parsed.skippedStatus,
    invalidEntries: parsed.invalidEntries,
  };
}

export interface CreateHistoryInvalidationInput {
  readonly repoPath: string;
  readonly outDir: string;
  readonly limits: HistoryTipsLimits;
  readonly load: HistoryTipsLoadResult;
  /**
   * 呈现层重建（续跑组补判的边缘路径）：从全量 findings 重建已上报集。
   * repo 批次上报无 confidence / severity 过滤，genericReview 是唯一差集。
   */
  readonly genericReview: GenericReviewLimits | undefined;
  readonly llm: StructuredLlm;
  readonly log: (line: string) => void;
  /** 注入读盘（缺省 node:fs；测试 fake） */
  readonly readText?: ReadRepoText;
}

export interface HistoryInvalidationRunner {
  /** 随组入队：矩阵同步判定（规则层即刻定案），LLM 候选进队列异步跑 */
  enqueueBatch(batch: RepoReviewedBatch): Promise<void>;
  /**
   * 收尾：drain 队列 → end-sweep（file-removed / not-reached / 续跑组复用或
   * 补判）→ 合并 → 落盘 sidecar → 返回上报条目 + 摘要。
   * 防御壳内：任何未预期异常 → 已累积的结果（可能为空），绝不抛出。
   */
  finalize(result: {
    readonly coverage: { readonly files: readonly { path: string; state: string }[] };
    readonly findings: readonly Finding[];
  }): Promise<InvalidationFinalOutcome>;
}

/** 有界并发任务池：固定 worker 数、任务自带防御壳、drain 等到全部排空 */
class BoundedTaskPool {
  private readonly pending: (() => Promise<void>)[] = [];
  private readonly active = new Set<Promise<void>>();
  private idleWaiters: Array<() => void> = [];

  constructor(private readonly concurrency: number) {}

  submit(task: () => Promise<void>): void {
    this.pending.push(task);
    this.pump();
  }

  private pump(): void {
    while (this.active.size < this.concurrency && this.pending.length > 0) {
      const task = this.pending.shift();
      if (task === undefined) {
        break;
      }
      const tracked = (async () => {
        try {
          await task();
        } catch {
          // 任务自带防御壳；这里只兜底，不让 worker 崩掉
        }
      })().then(() => {
        this.active.delete(tracked);
        this.pump();
        if (this.active.size === 0 && this.pending.length === 0) {
          for (const notify of this.idleWaiters.splice(0)) {
            notify();
          }
        }
      });
      this.active.add(tracked);
    }
  }

  async drain(): Promise<void> {
    while (this.active.size > 0 || this.pending.length > 0) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }
}

function emptySummary(): InvalidationSummary {
  return {
    total: 0,
    checked: 0,
    skippedInvalidated: 0,
    skippedStatus: 0,
    invalidEntries: 0,
    invalidated: 0,
    kept: 0,
    byReason: {},
    byVerdict: {},
    byStatus: {},
    verdictCalls: 0,
    verdictFailed: 0,
    verdictUsage: ZERO_USAGE,
  };
}

export function createHistoryInvalidationRunner(
  input: CreateHistoryInvalidationInput,
): HistoryInvalidationRunner {
  const { load } = input;
  const entriesByFile = new Map<string, HistoryTipEntry[]>();
  for (const entry of load.entries) {
    const list = entriesByFile.get(entry.filePath);
    if (list === undefined) {
      entriesByFile.set(entry.filePath, [entry]);
    } else {
      list.push(entry);
    }
  }
  const decided = new Map<number, InvalidationDecisionRecord>();
  const batchedFiles = new Set<string>();
  const readText = input.readText ?? defaultReadText;
  const usageScope = createDetachedUsageScope("history-verdict");
  let verdictUsage: LlmUsage = ZERO_USAGE;
  let verdictCalls = 0;
  let verdictFailed = 0;
  const verdictCounts: Record<string, number> = {};
  const pool = new BoundedTaskPool(VERDICT_CONCURRENCY);

  async function readRepoLines(filePath: string): Promise<readonly string[] | null> {
    const raw = await readText(path.join(input.repoPath, ...filePath.split("/")));
    return raw === null ? null : raw.split(/\r?\n/);
  }

  async function repoFileExists(filePath: string): Promise<boolean> {
    const absolute = path.join(input.repoPath, ...filePath.split("/"));
    if (input.readText !== undefined) {
      return (await input.readText(absolute)) !== null;
    }
    try {
      await readFile(absolute, "utf8");
      return true;
    } catch (error) {
      return (error as { code?: string }).code !== "ENOENT";
    }
  }

  function record(value: InvalidationDecisionRecord): void {
    decided.set(value.tipsId, value);
  }

  function bumpVerdict(verdict: string): void {
    verdictCounts[verdict] = (verdictCounts[verdict] ?? 0) + 1;
  }

  /** 裁决任务（池内跑；失败 → 该批保守保留 + 留痕，不落盘 → 续跑重试） */
  function enqueueVerdict(
    filePath: string,
    fileLines: readonly string[],
    candidates: readonly VerdictCandidate[],
    findings: readonly Finding[],
  ): void {
    pool.submit(async () => {
      try {
        const outcome: VerdictBatchOutcome = await judgeFileVerdicts({
          llm: { ...input.llm, usageScope },
          batch: {
            filePath,
            fileLines,
            candidates,
            findings: findings.map(toFindingForMatch),
          },
        });
        verdictCalls += outcome.attempts;
        if (outcome.usage !== undefined) {
          verdictUsage = addUsage(verdictUsage, outcome.usage);
        }
        if (outcome.failed) {
          verdictFailed += candidates.length;
          for (const candidate of candidates) {
            record({
              tipsId: candidate.entry.tipsId,
              filePath,
              outcome: "keep",
              cause: "verdict-failed",
            });
          }
          input.log(
            `review-pi: 历史意见裁决调用失败（${filePath}，${String(candidates.length)} 条保守保留）\n`,
          );
          return;
        }
        const byId = new Map(outcome.outcomes.map((item) => [item.tipsId, item]));
        for (const candidate of candidates) {
          const item = byId.get(candidate.entry.tipsId);
          if (item === undefined) {
            // 漏答 = unclear 保留（模型没给答案 = 不动它）
            bumpVerdict("unclear");
            record({
              tipsId: candidate.entry.tipsId,
              filePath,
              outcome: "keep",
              verdict: "unclear",
              cause: "verdict-missing",
            });
            continue;
          }
          bumpVerdict(item.verdict);
          const reason = reasonFromVerdict(item.verdict);
          if (reason !== undefined) {
            record({
              tipsId: candidate.entry.tipsId,
              filePath,
              outcome: "invalidate",
              reason,
              ...(item.matchedFindingId !== undefined
                ? { matchedFindingId: item.matchedFindingId }
                : {}),
              verdict: item.verdict,
              ...(item.note !== undefined && item.note !== "" ? { note: item.note } : {}),
            });
          } else {
            record({
              tipsId: candidate.entry.tipsId,
              filePath,
              outcome: "keep",
              verdict: item.verdict,
              ...(item.note !== undefined && item.note !== "" ? { note: item.note } : {}),
              ...(item.verdict === "persist" ? { cause: "recall-signal" } : {}),
            });
          }
        }
        await persistCache();
      } catch (error) {
        verdictFailed += candidates.length;
        const message = error instanceof Error ? error.message : String(error);
        for (const candidate of candidates) {
          record({
            tipsId: candidate.entry.tipsId,
            filePath,
            outcome: "keep",
            cause: "verdict-failed",
          });
        }
        input.log(`review-pi: 历史意见裁决异常（${filePath}：${message}，保守保留）\n`);
      }
    });
  }

  function toFindingForMatch(finding: Finding) {
    return {
      id: finding.id,
      line: finding.line,
      title: finding.title,
      ...(finding.tips?.review !== undefined ? { reviewText: finding.tips.review } : {}),
    };
  }

  /** 规则层 + LLM 候选分流（文件级） */
  async function judgeFile(
    filePath: string,
    findings: readonly Finding[],
    persist: boolean,
  ): Promise<void> {
    const fileEntries = entriesByFile.get(filePath);
    if (fileEntries === undefined) {
      return;
    }
    const fileLines = await readRepoLines(filePath);
    if (fileLines === null) {
      return;
    }
    const findingViews = findings.map(toFindingForMatch);
    const candidates: VerdictCandidate[] = [];
    for (const entry of fileEntries) {
      if (decided.has(entry.tipsId)) {
        continue;
      }
      const decision = evaluateMatrix(entry, fileLines, findingViews);
      if (decision.kind === "invalidate") {
        record({
          tipsId: entry.tipsId,
          filePath,
          outcome: "invalidate",
          reason: decision.reason,
          matchedFindingId: decision.matchedFindingId,
        });
      } else if (decision.kind === "keep") {
        record({ tipsId: entry.tipsId, filePath, outcome: "keep", cause: "no-signal" });
      } else {
        candidates.push({ entry, signal: decision.signal });
      }
    }
    if (candidates.length === 0) {
      if (persist) {
        await persistCache();
      }
      return;
    }
    if (!input.limits.semanticVerdict.enabled) {
      for (const candidate of candidates) {
        record({
          tipsId: candidate.entry.tipsId,
          filePath,
          outcome: "keep",
          cause: "semantic-off",
        });
      }
      if (persist) {
        await persistCache();
      }
      return;
    }
    enqueueVerdict(filePath, fileLines, candidates, findings);
  }

  // ---- 判定缓存（原子写；成功结果才落盘，失败不写 → 续跑重试） ----
  let persistChain: Promise<void> = Promise.resolve();
  function persistCache(): Promise<void> {
    const snapshot = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      decisions: [...decided.values()],
    };
    persistChain = persistChain
      .then(() => writeAtomic(path.join(input.outDir, VERDICT_CACHE_FILENAME), snapshot))
      .catch(() => undefined);
    return persistChain;
  }

  async function writeAtomic(target: string, value: unknown): Promise<void> {
    const dir = path.dirname(target);
    await mkdir(dir, { recursive: true });
    const tmp = path.join(
      dir,
      `.${path.basename(target)}.${process.pid}.${Date.now()}.tmp`,
    );
    await writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    try {
      await rename(tmp, target);
    } catch {
      await rm(target, { force: true });
      await rename(tmp, target);
    }
  }

  // ---- 随组入口（onGroupReviewed 缝；异常防御壳） ----
  async function enqueueBatchImpl(batch: RepoReviewedBatch): Promise<void> {
    try {
      for (const file of batch.files) {
        batchedFiles.add(file);
        const findings = batch.findings.filter((finding) => finding.file === file);
        await judgeFile(file, findings, false);
      }
      await persistCache();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      input.log(`review-pi: 历史意见判定异常（${message}，继续检视）\n`);
    }
  }

  // ---- 收尾 ----
  async function finalizeImpl(result: {
    readonly coverage: { readonly files: readonly { path: string; state: string }[] };
    readonly findings: readonly Finding[];
  }): Promise<InvalidationFinalOutcome> {
    const coverageFiles = result.coverage.files;
    await pool.drain();
    await persistChain;

    const cache = await loadCache();
    const coverageByFile = new Map(coverageFiles.map((file) => [file.path, file.state]));
    // 续跑组补判需要呈现集：从全量 findings 重建（filterGenericSuggestions 纯函数）。
    // repo 批次上报无 confidence / severity 过滤，genericReview 是唯一差集。
    const presentationFindings =
      input.genericReview === undefined
        ? result.findings
        : filterGenericSuggestions(result.findings, input.genericReview).kept;
    const findingsByFile = new Map<string, Finding[]>();
    for (const finding of presentationFindings) {
      const list = findingsByFile.get(finding.file);
      if (list === undefined) {
        findingsByFile.set(finding.file, [finding]);
      } else {
        list.push(finding);
      }
    }

    for (const [filePath, fileEntries] of entriesByFile) {
      const undecided = fileEntries.filter((entry) => !decided.has(entry.tipsId));
      if (undecided.length === 0) {
        continue;
      }
      // 文件层：磁盘状态 + 覆盖门
      const onDisk = await repoFileExists(filePath);
      const state = coverageByFile.get(filePath);
      const reviewed = state === "candidate" || state === "no-issue";
      for (const entry of undecided) {
        if (!onDisk) {
          record({
            tipsId: entry.tipsId,
            filePath,
            outcome: "invalidate",
            reason: "文件已删除",
          });
        } else if (!reviewed) {
          // not-reached / 未选中：本次无新信息，保留
          record({ tipsId: entry.tipsId, filePath, outcome: "keep", cause: "not-reached" });
        }
      }
      if (!onDisk || !reviewed) {
        continue;
      }
      // 已检视但本进程没批到（续跑 done 组）：先复用缓存，没有才补判
      if (!batchedFiles.has(filePath)) {
        for (const entry of undecided) {
          const cached = cache.get(entry.tipsId);
          if (cached !== undefined) {
            record(cached);
          }
        }
        if (undecided.some((entry) => !decided.has(entry.tipsId))) {
          await judgeFile(filePath, findingsByFile.get(filePath) ?? [], true);
        }
      }
    }
    // 补判可能又入了裁决池：再 drain 一次
    await pool.drain();
    await persistChain;

    // 防御收口：仍无终态的条目（读盘失败等边缘）一律保守保留——「每条都
    // 判断过」的最终兜底是「未判成 = 保留」，绝不悬空。
    for (const entry of load.entries) {
      if (!decided.has(entry.tipsId)) {
        record({
          tipsId: entry.tipsId,
          filePath: entry.filePath,
          outcome: "keep",
          cause: "unresolved",
        });
      }
    }

    const items: InvalidationItem[] = [...decided.values()];
    const invalidated = items.filter((item) => item.outcome === "invalidate");
    const byReason: Record<string, number> = {};
    for (const item of invalidated) {
      const key = item.reason ?? "(missing)";
      byReason[key] = (byReason[key] ?? 0) + 1;
    }
    const byStatus: Record<string, number> = {};
    for (const entry of load.entries) {
      byStatus[entry.status] = (byStatus[entry.status] ?? 0) + 1;
    }
    const summary: InvalidationSummary = {
      total: load.total,
      checked: load.entries.length,
      skippedInvalidated: load.skippedInvalidated,
      skippedStatus: load.skippedStatus,
      invalidEntries: load.invalidEntries,
      invalidated: invalidated.length,
      kept: items.length - invalidated.length,
      byReason,
      byVerdict: verdictCounts,
      byStatus,
      verdictCalls,
      verdictFailed,
      verdictUsage,
    };
    await writeAtomic(path.join(input.outDir, INVALIDATION_SIDECAR_FILENAME), {
      schemaVersion: CACHE_SCHEMA_VERSION,
      summary,
      items,
    }).catch(() => undefined);
    const reasonText =
      Object.entries(byReason)
        .map(([reason, count]) => `${reason} ${String(count)}`)
        .join("、") || "无失效";
    input.log(
      `review-pi: 历史意见失效检查完成：失效 ${String(invalidated.length)} / 保留 ${String(summary.kept)} 条` +
        `（${reasonText}；裁决调用 ${String(verdictCalls)} 次）\n`,
    );
    return {
      report: invalidated.map((item) => ({
        tipsId: item.tipsId,
        reason: item.reason ?? "(missing)",
      })),
      summary,
    };
  }

  async function loadCache(): Promise<Map<number, InvalidationDecisionRecord>> {
    const map = new Map<number, InvalidationDecisionRecord>();
    try {
      const raw = await readFile(path.join(input.outDir, VERDICT_CACHE_FILENAME), "utf8");
      const parsed = JSON.parse(raw) as { decisions?: InvalidationDecisionRecord[] };
      if (Array.isArray(parsed.decisions)) {
        for (const decision of parsed.decisions) {
          if (
            typeof decision?.tipsId === "number" &&
            (decision.outcome === "invalidate" || decision.outcome === "keep")
          ) {
            map.set(decision.tipsId, decision);
          }
        }
      }
    } catch {
      // 缓存缺失 / 损坏 = 无缓存（补判路径自然兜底）
    }
    return map;
  }

  return {
    enqueueBatch: enqueueBatchImpl,
    finalize: async (result) => {
      try {
        return await finalizeImpl(result);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        input.log(`review-pi: 历史意见失效检查失败（${message}），本次不上报失效\n`);
        return { report: [], summary: emptySummary() };
      }
    },
  };
}

async function defaultReadText(absolutePath: string): Promise<string | null> {
  try {
    return await readFile(absolutePath, "utf8");
  } catch {
    return null;
  }
}
