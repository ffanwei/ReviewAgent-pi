import { createHash } from "node:crypto";

import type { FetchFunction } from "@earendil-works/pi-ai";

import type { LlmUsage } from "../contracts/llm.js";
import type { GroupingLimits } from "../shared/config.js";
import { extractModelJson } from "../shared/model-json.js";
import { completeOneShot } from "../shared/one-shot-llm.js";
import { splitDiffIntoFileBlocks, type DiffFileBlock } from "./mr-input.js";
import { planShards, type Shard, type ShardPlan } from "./shard-planner.js";

/**
 * 语义分组（ADR-0094）：把变更文件按相关性分成 Review Group。
 *
 * - 只喂文件元数据（路径 / 变更量 / 字符数 / 类别），不喂 diff 内容；
 * - 严格 JSON：每个文件恰好出现一次、每组 1..maxFilesPerShard；
 * - 失败重试一次，仍失败 fallback 到确定性顶层目录分组；
 * - 组内超字符/文件预算时复用 `planShards`（整文件块切分，不切 hunk）；
 * - 结果按 diff digest 缓存，group 顺序按组内最小文件 index 排序。
 */

export interface GroupingLlm {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly fetch: FetchFunction;
  readonly timeoutMs: number;
  readonly maxTokens?: number;
}

export interface GroupedShardPlan {
  readonly shards: readonly Shard[];
  readonly source: "llm" | "path" | "fallback";
  readonly error?: string;
  readonly usage?: LlmUsage;
}

/** 是否触发语义分组：小 PR 直接跳过，其余按文件数/diff 字符数 OR 触发。 */
export function shouldGroupReview(
  fileCount: number,
  diffLength: number,
  limits: GroupingLimits,
): boolean {
  const smallPr = fileCount <= limits.smallPrMaxFiles && diffLength <= limits.smallPrMaxChars;
  return !smallPr && (fileCount > limits.minFiles || diffLength >= limits.minDiffChars);
}

interface FileMeta {
  readonly index: number;
  readonly path: string;
  readonly changed: number;
  readonly chars: number;
  readonly kind: string;
}

interface ParsedGroup {
  readonly label: string;
  readonly files: readonly number[];
}

const GROUPING_HEADER = "Other files changed in this MR (not shown in this shard):";
const CACHE_LIMIT = 32;
const planCache = new Map<string, GroupedShardPlan>();

export async function planGroupedShards(
  diff: string,
  limits: GroupingLimits,
  contextSummaryChars: number,
  llm: GroupingLlm | null,
): Promise<GroupedShardPlan> {
  const blocks = splitDiffIntoFileBlocks(diff);
  if (blocks.length === 0) {
    return { shards: [], source: "path" };
  }

  const prefixIndex = blocks.findIndex((block) => block.path === "");
  const prefix = prefixIndex >= 0 ? blocks[prefixIndex] : undefined;
  const realBlocks = blocks.filter((_, index) => index !== prefixIndex);
  const meta = realBlocks.map((block, index): FileMeta => ({
    index,
    path: block.path,
    changed: block.added + block.removed,
    chars: block.chars,
    kind: classifyFile(block.path),
  }));

  const cacheKey = sha256(`${diff}\u0000${JSON.stringify(limits)}\u0000${llm?.modelId ?? ""}`);
  const cached = planCache.get(cacheKey);
  if (cached !== undefined) {
    return cached;
  }

  let groups: readonly ParsedGroup[] | undefined;
  let attemptedLlm = false;
  let source: GroupedShardPlan["source"] = "path";
  let error: string | undefined;
  let usage: LlmUsage | undefined;

  if (llm !== null && meta.length > 0) {
    attemptedLlm = true;
    const first = await callGrouping(llm, meta, limits);
    usage = first.usage;
    if (first.groups !== undefined) {
      groups = first.groups;
      source = "llm";
    } else {
      error = first.error ?? "invalid grouping response";
      const retry = await callGrouping(llm, meta, limits, `上一次输出不合法：${error}。请严格按 JSON schema 重新输出。`);
      usage = retry.usage ?? usage;
      if (retry.groups !== undefined) {
        groups = retry.groups;
        source = "llm";
        error = undefined;
      }
    }
  }
  if (groups === undefined) {
    groups = pathGroups(meta, limits);
    source = attemptedLlm ? "fallback" : "path";
  }

  const mergedGroups = mergeTinyGroups(groups, limits.minFilesPerGroup, limits.maxFilesPerShard);
  const shards = buildShards(blocks, prefix, realBlocks, mergedGroups, limits, contextSummaryChars);
  const capped = capShards(shards, limits.maxShards);
  const withSummary = recomputeOtherFilesSummary(capped, blocks, contextSummaryChars);
  const result: GroupedShardPlan = {
    shards: withSummary,
    source,
    ...(error !== undefined ? { error } : {}),
    ...(usage !== undefined ? { usage } : {}),
  };
  remember(cacheKey, result);
  return result;
}

function classifyFile(path: string): string {
  const lower = path.toLowerCase();
  if (/(^|\/)(test|tests|spec|specs|__tests__)\//.test(lower) || /\.(test|spec)\./.test(lower)) {
    return "test";
  }
  if (/\.(md|json|ya?ml|lock|snap)$/.test(lower)) {
    return "config/data";
  }
  return "code";
}

async function callGrouping(
  llm: GroupingLlm,
  meta: readonly FileMeta[],
  limits: GroupingLimits,
  retryNote?: string,
): Promise<{ groups?: readonly ParsedGroup[]; usage?: LlmUsage; error?: string }> {
  const system = [
    "你是一名代码评审分组器。你的唯一任务是把列出的变更文件分成若干语义相关的检视组。",
    "只输出 JSON，不要输出解释或 Markdown。",
    '输出格式：{"groups":[{"label":"简短中文标签","files":[文件编号...]}]}',
    `硬约束：每个文件编号必须恰好出现一次；每组 1..${String(limits.maxFilesPerShard)} 个文件；不能遗漏、不能重复。`,
    "分组原则：同一模块/目录、实现与头文件、同模块测试与资源尽量放在一组；不要把无关文件硬凑在一起。",
  ].join("\n");
  const fileLines = meta
    .map((entry) => `${String(entry.index)}. ${entry.path} | ${entry.kind} | ±${String(entry.changed)} changed lines | ${String(entry.chars)} chars`)
    .join("\n");
  const user = [
    `共 ${String(meta.length)} 个文件：`,
    fileLines,
    ...(retryNote !== undefined ? ["", retryNote] : []),
  ].join("\n");

  const result = await completeOneShot({
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    modelId: llm.modelId,
    system,
    user,
    timeoutMs: llm.timeoutMs,
    ...(llm.maxTokens !== undefined ? { maxTokens: llm.maxTokens } : {}),
    responseFormat: "json_object",
    purpose: "grouping",
    fetch: llm.fetch,
  });
  if (!result.ok) {
    return { error: result.reason };
  }
  const extracted = extractModelJson(result.text, { preferKey: "groups" });
  if (extracted.value === undefined || extracted.failure !== undefined) {
    return { error: extracted.failure ?? "missing groups", ...(result.usage !== undefined ? { usage: result.usage } : {}) };
  }
  const groups = parseGroups(extracted.value, meta.length, limits.maxFilesPerShard);
  if (groups === undefined) {
    return { error: "groups schema invalid", ...(result.usage !== undefined ? { usage: result.usage } : {}) };
  }
  return { groups, ...(result.usage !== undefined ? { usage: result.usage } : {}) };
}

function parseGroups(
  value: unknown,
  count: number,
  maxFilesPerGroup: number,
): readonly ParsedGroup[] | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const rawGroups = (value as { groups?: unknown }).groups;
  if (!Array.isArray(rawGroups) || rawGroups.length === 0) {
    return undefined;
  }
  const seen = new Set<number>();
  const groups: ParsedGroup[] = [];
  for (const raw of rawGroups) {
    if (typeof raw !== "object" || raw === null) {
      return undefined;
    }
    const files = (raw as { files?: unknown }).files;
    if (!Array.isArray(files) || files.length === 0 || files.length > maxFilesPerGroup) {
      return undefined;
    }
    const labelRaw = (raw as { label?: unknown }).label;
    const label = typeof labelRaw === "string" && labelRaw.trim() !== "" ? labelRaw.trim() : "group";
    const indices: number[] = [];
    for (const entry of files) {
      if (!Number.isInteger(entry) || (entry as number) < 0 || (entry as number) >= count) {
        return undefined;
      }
      const index = entry as number;
      if (seen.has(index)) {
        return undefined;
      }
      seen.add(index);
      indices.push(index);
    }
    groups.push({ label, files: indices });
  }
  if (seen.size !== count) {
    return undefined;
  }
  groups.sort((a, b) => Math.min(...a.files) - Math.min(...b.files));
  return groups;
}

/** 确定性顶层目录分组；超文件数按顺序切块；组数超限交给 capShards。 */
function pathGroups(meta: readonly FileMeta[], limits: GroupingLimits): readonly ParsedGroup[] {
  if (meta.length === 0) {
    return [];
  }
  const byTop = new Map<string, FileMeta[]>();
  for (const entry of meta) {
    const top = entry.path.includes("/") ? (entry.path.split("/")[0] ?? "") : "";
    const list = byTop.get(top);
    if (list === undefined) {
      byTop.set(top, [entry]);
    } else {
      list.push(entry);
    }
  }
  const groups: ParsedGroup[] = [];
  for (const [top, entries] of byTop) {
    for (let start = 0; start < entries.length; start += limits.maxFilesPerShard) {
      groups.push({
        label: top === "" ? "root" : top,
        files: entries.slice(start, start + limits.maxFilesPerShard).map((entry) => entry.index),
      });
    }
  }
  groups.sort((a, b) => Math.min(...a.files) - Math.min(...b.files));
  return groups;
}

/**
 * 碎组合并：小于 minFiles 的组并入相邻组（优先并入合并后仍不超 maxFiles 的邻居）。
 * 只有一组时保持不动；合并后允许暂时超 maxFiles，后续 buildShards 仍按字符切。
 */
function mergeTinyGroups(
  groups: readonly ParsedGroup[],
  minFiles: number,
  maxFiles: number,
): readonly ParsedGroup[] {
  if (groups.length <= 1 || minFiles <= 1) {
    return groups;
  }
  let list: ParsedGroup[] = groups.map((group) => ({ label: group.label, files: [...group.files] }));
  while (list.length > 1) {
    const index = list.findIndex((group) => group.files.length < minFiles);
    if (index < 0) {
      break;
    }
    const tiny = list[index]!;
    const neighbors = [index - 1, index + 1].filter((entry) => entry >= 0 && entry < list.length);
    if (neighbors.length === 0) {
      break;
    }
    const fits = neighbors.filter(
      (entry) => list[entry]!.files.length + tiny.files.length <= maxFiles,
    );
    const pool = fits.length > 0 ? fits : neighbors;
    pool.sort((left, right) => list[left]!.files.length - list[right]!.files.length);
    const target = pool[0]!;
    const merged: ParsedGroup = {
      label: list[target]!.label,
      files: [...list[target]!.files, ...tiny.files],
    };
    const insertAt = Math.min(index, target);
    list = list.filter((_, entry) => entry !== index && entry !== target);
    list.splice(insertAt, 0, merged);
  }
  return list;
}

function buildShards(  blocks: readonly DiffFileBlock[],
  prefix: DiffFileBlock | undefined,
  realBlocks: readonly DiffFileBlock[],
  groups: readonly ParsedGroup[],
  limits: GroupingLimits,
  contextSummaryChars: number,
): Shard[] {
  const shards: Shard[] = [];
  const effectiveGroups = groups.length > 0 ? groups : [{ label: "all", files: realBlocks.map((_, index) => index) }];
  effectiveGroups.forEach((group, groupIndex) => {
    const selected: DiffFileBlock[] = [];
    if (groupIndex === 0 && prefix !== undefined) {
      selected.push(prefix);
    }
    for (const index of group.files) {
      const block = realBlocks[index];
      if (block !== undefined) {
        selected.push(block);
      }
    }
    if (selected.length === 0) {
      return;
    }
    const groupDiff = selected.map((block) => block.text).join("\n");
    let plan: ShardPlan;
    try {
      plan = planShards(groupDiff, {
        maxShardChars: limits.maxCharsPerShard,
        maxShards: limits.maxShards,
        contextSummaryChars,
      });
    } catch {
      plan = { shards: [], blockCount: selected.length, chars: groupDiff.length };
    }
    if (plan.shards.length === 0) {
      shards.push({
        index: 0,
        diff: groupDiff,
        files: selected.map((block) => block.path).filter((path) => path !== ""),
        chars: groupDiff.length,
        otherFilesSummary: "",
        truncated: [],
      });
      return;
    }
    for (const shard of plan.shards) {
      shards.push(shard);
    }
  });
  return shards.map((shard, index) => ({ ...shard, index: index + 1 }));
}

/** 组数超上限时合并相邻最小片（优先保持文件不丢；合并后允许超字符目标）。 */
function capShards(shards: readonly Shard[], maxShards: number): Shard[] {
  const result = [...shards];
  while (result.length > maxShards) {
    let bestIndex = 0;
    let bestChars = Number.POSITIVE_INFINITY;
    for (let index = 0; index < result.length - 1; index += 1) {
      const combined = result[index]!.chars + 1 + result[index + 1]!.chars;
      if (combined < bestChars) {
        bestChars = combined;
        bestIndex = index;
      }
    }
    const left = result[bestIndex]!;
    const right = result[bestIndex + 1]!;
    result.splice(bestIndex, 2, {
      index: 0,
      diff: `${left.diff}\n${right.diff}`,
      files: [...left.files, ...right.files],
      chars: left.chars + 1 + right.chars,
      otherFilesSummary: "",
      truncated: [...left.truncated, ...right.truncated],
    });
  }
  return result.map((shard, index) => ({ ...shard, index: index + 1 }));
}

function recomputeOtherFilesSummary(
  shards: readonly Shard[],
  blocks: readonly DiffFileBlock[],
  maxChars: number,
): Shard[] {
  const allPaths = [...new Set(blocks.map((block) => block.path).filter((path) => path !== ""))];
  return shards.map((shard) => {
    const own = new Set(shard.files);
    const others = allPaths.filter((path) => !own.has(path));
    return { ...shard, otherFilesSummary: summarize(others, maxChars) };
  });
}

function summarize(paths: readonly string[], maxChars: number): string {
  if (paths.length === 0 || maxChars < GROUPING_HEADER.length) {
    return "";
  }
  const lines: string[] = [];
  let used = GROUPING_HEADER.length;
  for (const path of paths) {
    const line = `- ${path}`;
    if (used + 1 + line.length > maxChars) {
      break;
    }
    lines.push(line);
    used += 1 + line.length;
  }
  const rest = paths.length - lines.length;
  if (rest > 0) {
    lines.push(`- …(还有 ${String(rest)} 个文件未列出)`);
  }
  return [GROUPING_HEADER, ...lines].join("\n");
}

function remember(key: string, plan: GroupedShardPlan): void {
  if (planCache.size >= CACHE_LIMIT) {
    const first = planCache.keys().next().value;
    if (first !== undefined) {
      planCache.delete(first);
    }
  }
  planCache.set(key, plan);
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}
