// 文件块切分（单一真源）：`diff --git` 是 git 统一 diff 的文件块头；没有它时，
// 只把「`--- ` + 下一行 `+++ ` + 再下一行 `@@ `」认作文件头对——hunk 体里恰好
// 以 `--- ` 开头的删除行不会因此被误判。
//
// 本视图是**字节保真**的：块边界之间用 `"\n"` 连接即逐字节还原输入，供预过滤
// （整块剔除）与分片（整块装箱）使用，绝不切 hunk。

/** 行号区间（`end` 不含） */
export interface BlockRange {
  readonly start: number;
  /** 不含（下一个块起点 / 行数） */
  readonly end: number;
}

/**
 * 单个文件块（第二期分片的装箱单位）。`text` 只含该块的行；相邻块之间用
 * `"\n"` 连接即逐字节还原输入——分片不得改动任何 hunk 字节。
 */
export interface DiffFileBlock {
  /** 块内新侧路径（删除文件退回旧侧；无法识别 / 文件头前置内容时为空串） */
  readonly path: string;
  readonly text: string;
  readonly chars: number;
  /** 新增行数（`+` 开头且不是 `+++` 文件头） */
  readonly added: number;
  /** 删除行数（`-` 开头且不是 `---` 文件头） */
  readonly removed: number;
}

/** 按文件块切分（返回行区间） */
export function fileBlockRanges(lines: readonly string[]): readonly BlockRange[] {
  const gitStarts: number[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (lines[index]?.startsWith("diff --git ") === true) {
      gitStarts.push(index);
    }
  }
  const starts = gitStarts.length > 0 ? gitStarts : headerPairStarts(lines);
  return starts.map((start, index) => ({ start, end: starts[index + 1] ?? lines.length }));
}

function headerPairStarts(lines: readonly string[]): readonly number[] {
  const starts: number[] = [];
  for (let index = 0; index + 2 < lines.length; index += 1) {
    if (
      lines[index]?.startsWith("--- ") === true &&
      lines[index + 1]?.startsWith("+++ ") === true &&
      lines[index + 2]?.startsWith("@@ ") === true
    ) {
      starts.push(index);
    }
  }
  return starts;
}

/**
 * 按文件块切分。
 *
 * - 返回顺序 = diff 中出现顺序；
 * - 第一个 `diff --git` 之前的内容（若有）作为 `path === ""` 的前置块返回，
 *   保证 `blocks.map(b => b.text).join("\n") === diff`；
 * - 空输入或无法识别任何块时返回空数组（调用方按「不可切」处理）。
 */
export function splitFileBlocks(diff: string): readonly DiffFileBlock[] {
  if (diff === "") {
    return [];
  }
  const lines = diff.split("\n");
  const ranges = fileBlockRanges(lines);
  if (ranges.length === 0) {
    return [];
  }
  const blocks: DiffFileBlock[] = [];
  const first = ranges[0];
  if (first !== undefined && first.start > 0) {
    blocks.push(toDiffFileBlock(lines.slice(0, first.start), ""));
  }
  for (const range of ranges) {
    const block = lines.slice(range.start, range.end);
    blocks.push(toDiffFileBlock(block, blockPathOf(block)));
  }
  return blocks;
}

function toDiffFileBlock(block: readonly string[], path: string): DiffFileBlock {
  let added = 0;
  let removed = 0;
  for (const line of block) {
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added += 1;
    } else if (line.startsWith("-") && !line.startsWith("---")) {
      removed += 1;
    }
  }
  const text = block.join("\n");
  return { path, text, chars: text.length, added, removed };
}

/** 块内新侧路径（删除文件退回旧侧；都没有时退回块头） */
export function blockPathOf(block: readonly string[]): string {
  for (const line of block) {
    if (line.startsWith("+++ ")) {
      const path = line.slice(4).replace(/^b\//, "").trim();
      if (path !== "" && path !== "/dev/null") {
        return path;
      }
    }
  }
  for (const line of block) {
    if (line.startsWith("--- ")) {
      const path = line.slice(4).replace(/^a\//, "").trim();
      if (path !== "" && path !== "/dev/null") {
        return path;
      }
    }
  }
  const header = block[0] ?? "";
  const matched = /^diff --git a\/(.+) b\/(.+)$/.exec(header);
  return matched?.[2]?.trim() ?? "";
}
