import type { ShardTruncationRecord } from "../contracts/run.js";
import type { DiffFileBlock } from "./mr-input.js";
import { splitDiffIntoFileBlocks } from "./mr-input.js";

/**
 * 大 MR 第二期：按 `diff --git` 文件块贪心装箱（ADR-0039 决策 2 / 3）。
 *
 * 纪律：
 * - **只切文件块，绝不切 hunk**：行号与 evidence 链必须完整；
 * - 单块超预算**不报错**，改为**丢弃整 hunk** 截取检视（ADR-0070）：
 *   保留文件头 + 前缀若干个完整 hunk，尾部整 hunk 丢弃并留痕；
 * - 装箱是纯函数：同输入 + 同配置 → 同分片（可重放）；
 * - 每个块恰好出现一次，不跨片、不重复；
 * - 片数超上限仍是**预检期显式错误**（零模型请求），不静默丢片；
 * - 只有 1 片且无截取时调用方仍应走单遍老路径（本模块不决定是否分片）。
 */

export interface ShardLimits {
  /** 单片字符目标；单块超过它时按整 hunk 截取（不报错） */
  readonly maxShardChars: number;
  /** 片数上限（成本护栏） */
  readonly maxShards: number;
  /** 「其他文件变更摘要」的字符上限 */
  readonly contextSummaryChars: number;
}

export interface Shard {
  /** 1-based 片号（进入审计 / 进度标签 / 目录名 sNN） */
  readonly index: number;
  /** 本片 unified diff（块间以 `"\n"` 连接，字节可还原） */
  readonly diff: string;
  /** 本片包含的文件路径（diff 顺序；不含前置块） */
  readonly files: readonly string[];
  /** `diff.length` */
  readonly chars: number;
  /**
   * 其他片的文件变更摘要（`""` = 没有其他片）。只含路径与增删行数，
   * 不是证据源；用于让模型知道「还存在哪些改动」。
   */
  readonly otherFilesSummary: string;
  /** 本片内被截取的文件块（ADR-0070）；空数组 = 零截取 */
  readonly truncated: readonly ShardTruncationRecord[];
}

export interface ShardPlan {
  /** 分片结果（按 diff 顺序）；空 diff 时为空数组 */
  readonly shards: readonly Shard[];
  /** 参与装箱的文件块数 */
  readonly blockCount: number;
  /** 输入 diff 字符数 */
  readonly chars: number;
}

const SUMMARY_HEADER = "Other files changed in this MR (not shown in this shard):";

/**
 * 贪心装箱。调用方保证 `diff` 已通过第一期预过滤与体积门。
 *
 * 单块超过 `maxShardChars` 时按整 hunk 截取（ADR-0070），不抛错。
 *
 * @throws 片数超上限 / 配置非法（均为中文人话错误）
 */
export function planShards(diff: string, limits: ShardLimits): ShardPlan {
  assertLimits(limits);
  const blocks = splitDiffIntoFileBlocks(diff);
  if (blocks.length === 0) {
    return { shards: [], blockCount: 0, chars: diff.length };
  }

  // 逐块预检：超预算的块只保留文件头 + 前缀完整 hunk（从不切 hunk 体）
  const prepared = blocks.map((block) => prepareBlock(block, limits.maxShardChars));
  const packing = prepared.map((entry) => entry.block);

  // 片 = 连续块区间 [start, end)
  const ranges: Array<{ start: number; end: number }> = [];
  let start = 0;
  let chars = 0;
  let inShard = 0;
  for (let index = 0; index < packing.length; index += 1) {
    const block = packing[index] as DiffFileBlock;
    const withSeparator = inShard === 0 ? block.chars : chars + 1 + block.chars;
    if (inShard > 0 && withSeparator > limits.maxShardChars) {
      ranges.push({ start, end: index });
      start = index;
      chars = block.chars;
      inShard = 1;
      continue;
    }
    chars = withSeparator;
    inShard += 1;
  }
  ranges.push({ start, end: packing.length });

  if (ranges.length > limits.maxShards) {
    throw new Error(
      `这份 MR 需要 ${String(ranges.length)} 片，超过上限 limits.split.maxShards=` +
        `${String(limits.maxShards)}；请把 MR 拆成更小的批次分别检视，或调大该上限（成本会同步上升）。`,
    );
  }

  const shardOf = new Map<number, number>();
  ranges.forEach((range, shardIndex) => {
    for (let index = range.start; index < range.end; index += 1) {
      shardOf.set(index, shardIndex);
    }
  });

  const shards = ranges.map((range, shardIndex): Shard => {
    const slice = packing.slice(range.start, range.end);
    const shardDiff = slice.map((block) => block.text).join("\n");
    const truncated: ShardTruncationRecord[] = [];
    for (let index = range.start; index < range.end; index += 1) {
      const record = prepared[index]?.truncation;
      if (record !== undefined) {
        truncated.push(record);
      }
    }
    return {
      index: shardIndex + 1,
      diff: shardDiff,
      files: slice.map((block) => block.path).filter((path) => path !== ""),
      chars: shardDiff.length,
      otherFilesSummary: buildOtherFilesSummary(packing, shardOf, shardIndex, limits.contextSummaryChars),
      truncated,
    };
  });

  return { shards, blockCount: blocks.length, chars: diff.length };
}

interface PreparedBlock {
  readonly block: DiffFileBlock;
  readonly truncation?: ShardTruncationRecord;
}

/**
 * 单块超预算 → 按整 hunk 截取（ADR-0070）。
 *
 * 保留策略：文件头（`diff --git` / `index` / `---` / `+++` …）+ 前缀若干个
 * **完整** hunk，选择「不超预算的最大 hunk 数」。退化情形（文件头 + 首个 hunk
 * 本身就超预算）保留首个 hunk 并如实记录——宁可超目标，也不留一个只有文件头
 * 的空块（那会让模型完全看不到改动）。
 *
 * 没有 hunk 的块（二进制 / 纯头部）无法安全截取，原样保留、不产生留痕。
 */
function prepareBlock(block: DiffFileBlock, maxChars: number): PreparedBlock {
  if (block.chars <= maxChars) {
    return { block };
  }
  const lines = block.text.split("\n");
  const hunkStarts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("@@ ") === true) {
      hunkStarts.push(index);
    }
  }
  if (hunkStarts.length === 0) {
    return { block };
  }

  // cum[i] = lines[0..i) 用 "\n" 连接后的字符数
  const cum: number[] = [0];
  for (let index = 0; index < lines.length; index += 1) {
    cum.push((cum[index] ?? 0) + (index === 0 ? 0 : 1) + (lines[index]?.length ?? 0));
  }

  // 至少保留首个 hunk（退化情形允许超预算）
  let cut = hunkStarts[1] ?? lines.length;
  for (let kept = hunkStarts.length; kept >= 1; kept -= 1) {
    const candidate = hunkStarts[kept] ?? lines.length;
    if ((cum[candidate] ?? Number.POSITIVE_INFINITY) <= maxChars) {
      cut = candidate;
      break;
    }
  }

  const keptLines = lines.slice(0, cut);
  const droppedLines = lines.slice(cut);
  if (droppedLines.length === 0) {
    // 没有可丢弃的完整 hunk（单 hunk 块）：原样保留，不伪装成「已截取」
    return { block };
  }
  let droppedAdded = 0;
  let droppedRemoved = 0;
  for (const line of droppedLines) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      droppedAdded += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      droppedRemoved += 1;
    }
  }
  const keptHunks = hunkStarts.filter((lineIndex) => lineIndex < cut).length;
  const keptChars = cum[cut] ?? block.chars;

  return {
    block: {
      path: block.path,
      text: keptLines.join("\n"),
      chars: keptChars,
      added: block.added - droppedAdded,
      removed: block.removed - droppedRemoved,
    },
    truncation: {
      path: block.path,
      originalChars: block.chars,
      keptChars,
      hunks: hunkStarts.length,
      keptHunks,
      droppedHunks: hunkStarts.length - keptHunks,
      droppedAdded,
      droppedRemoved,
    },
  };
}

/** stderr 一行（可 grep；明细永远在审计 `shardTruncation`） */
export function formatShardTruncationNotice(records: readonly ShardTruncationRecord[]): string {
  const droppedHunks = records.reduce((total, record) => total + record.droppedHunks, 0);
  const keptChars = records.reduce((total, record) => total + record.keptChars, 0);
  return (
    `已截取检视 ${String(records.length)} 个超预算文件` +
    `（丢弃 ${String(droppedHunks)} 个完整 hunk，保留 ${String(keptChars)} 字符），` +
    `明细见审计 shardTruncation`
  );
}

/**
 * 拼出该片的初始 diff 输入：本片 diff + 其他文件摘要。
 * 摘要为空时**不追加任何字节**（单 shard 路径零漂移）。
 */
export function composeShardInput(shard: Shard): string {
  if (shard.otherFilesSummary === "") {
    return shard.diff;
  }
  return `${shard.diff}\n\n${shard.otherFilesSummary}`;
}

/** 摘要行（`- path (+12/-3)`）；前置块没有路径时给一个中性名字 */
export function formatShardSummaryLine(block: DiffFileBlock): string {
  return `- ${describePath(block.path)} (+${String(block.added)}/-${String(block.removed)})`;
}

function describePath(path: string): string {
  return path === "" ? "(diff 前置内容)" : path;
}

function buildOtherFilesSummary(
  blocks: readonly DiffFileBlock[],
  shardOf: ReadonlyMap<number, number>,
  shardIndex: number,
  maxChars: number,
): string {
  const others = blocks.filter((_, index) => shardOf.get(index) !== shardIndex);
  if (others.length === 0 || maxChars < SUMMARY_HEADER.length) {
    return "";
  }

  const lines: string[] = [];
  let used = SUMMARY_HEADER.length;
  for (const block of others) {
    const line = formatShardSummaryLine(block);
    if (used + 1 + line.length > maxChars) {
      break;
    }
    lines.push(line);
    used += 1 + line.length;
  }

  let rest = others.length - lines.length;
  if (rest > 0) {
    let footer = summaryFooter(rest);
    while (lines.length > 0 && used + 1 + footer.length > maxChars) {
      const dropped = lines.pop() as string;
      used -= 1 + dropped.length;
      rest += 1;
      footer = summaryFooter(rest);
    }
    if (used + 1 + footer.length <= maxChars) {
      lines.push(footer);
    }
  }

  return [SUMMARY_HEADER, ...lines].join("\n");
}

function summaryFooter(rest: number): string {
  return `- …(还有 ${String(rest)} 个文件未列出)`;
}

function assertLimits(limits: ShardLimits): void {
  if (!Number.isInteger(limits.maxShardChars) || limits.maxShardChars <= 0) {
    throw new Error(`limits.split.maxShardChars 必须是正整数，当前 ${String(limits.maxShardChars)}。`);
  }
  if (!Number.isInteger(limits.maxShards) || limits.maxShards <= 0) {
    throw new Error(`limits.split.maxShards 必须是正整数，当前 ${String(limits.maxShards)}。`);
  }
  if (!Number.isInteger(limits.contextSummaryChars) || limits.contextSummaryChars <= 0) {
    throw new Error(`limits.split.contextSummaryChars 必须是正整数，当前 ${String(limits.contextSummaryChars)}。`);
  }
}
