import type { MrFilteredPath, MrFilterReason, MrFilterRecord } from "../contracts/run.js";
import { isTestFilePath } from "../shared/test-file.js";

// 大 diff 第一期内核入口处理（预处理过滤 + 体积门）：
//
// 1. 预过滤：按 `diff --git` 文件块（无该头时退回 `--- ` / `+++ ` 文件头对）
//    识别 lockfile / 生成物 / minified / 二进制块，整块剔除。**绝不切 hunk**：
//    块即文件，hunk 行号与 evidence 链完整保留。
//    测试文件由 `limits.testFiles.skip`（缺省 true）单独控制：开启时整块剔除，
//    关闭时原样保留（reason = "test"，与其他噪声原因共用同一审计口径）。
// 2. 体积门：过滤后仍超过 `limits.boundary.maxDiffChars` 时直接抛人话错误，
//    不再把注定失败的请求发给模型（`null` = 关门）。
//
// 纪律：无命中时返回原串（逐字节不变）；命中时只删整行区间，其余字节原样
// 保留。过滤清单由调用方写入审计尾键 `mrFilter`，并可在 stderr 报一行。

/** 单个被剔除的文件块（顺序 = diff 中出现顺序） */
export interface DroppedDiffFile {
  readonly path: string;
  readonly reason: MrFilterReason;
}

export interface FilteredDiff {
  /** 过滤后的 diff；无命中时与输入逐字节相同 */
  readonly diff: string;
  readonly dropped: readonly DroppedDiffFile[];
  /** 被剔除的字符数（diff.length - filtered.length） */
  readonly droppedChars: number;
}

/** lockfile 文件名（大小写不敏感；`*.lock` 另行匹配） */
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "bun.lockb",
  "composer.lock",
  "gemfile.lock",
  "cargo.lock",
  "poetry.lock",
  "pipfile.lock",
  "uv.lock",
  "mix.lock",
  "pubspec.lock",
  "go.sum",
  "gradle.lockfile",
]);

/** 明确属于构建产物 / 第三方 / 生成代码的目录段 */
const GENERATED_DIR_SEGMENTS = new Set([
  "node_modules",
  "vendor",
  "dist",
  "target",
  "generated",
  "generated-sources",
  "__generated__",
  "coverage",
]);

/** 生成代码的固定文件名后缀（不含 `.min.`——那归 minified） */
const GENERATED_SUFFIXES = ["_pb2.py", ".pb.go", ".g.dart", ".designer.cs", ".generated.ts", ".generated.java", ".map"];

interface BlockRange {
  readonly start: number;
  /** 不含（下一个块起点 / 行数） */
  readonly end: number;
}

/**
 * 按文件块切分（返回行区间）。`diff --git` 是 git 统一 diff 的块头；没有它
 * 时，只把「`--- ` + 下一行 `+++ ` + 再下一行 `@@ `」认作文件头对——hunk
 * 体里恰好以 `--- ` 开头的删除行不会因此被误判。
 */
function blockRanges(lines: readonly string[]): readonly BlockRange[] {
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

/**
 * 按文件块切分（第二期分片复用第一期同一套块边界，不另造解析器）。
 *
 * - 返回顺序 = diff 中出现顺序；
 * - 第一个 `diff --git` 之前的内容（若有）作为 `path === ""` 的前置块返回，
 *   保证 `blocks.map(b => b.text).join("\n") === diff`；
 * - 空输入或无法识别任何块时返回空数组（调用方按「不可切」处理）。
 */
export function splitDiffIntoFileBlocks(diff: string): readonly DiffFileBlock[] {
  if (diff === "") {
    return [];
  }
  const lines = diff.split("\n");
  const ranges = blockRanges(lines);
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
    blocks.push(toDiffFileBlock(block, blockPath(block)));
  }
  return blocks;
}

/**
 * 过滤前 diff 里的**全部**变更文件（repo 相对 POSIX 路径，按 diff 出现顺序去重）。
 *
 * 用途（ADR-0068）：MCP 上报的「变更文件全集」。被预过滤剔除的文件（测试 /
 * lockfile / 生成物 / minified / binary）同样属于「变更过」，必须在
 * `saveReviewSummary` 之前拿到一条 `mrReviewResult(reviewTips: [])`，否则平台
 * 无法区分「检视过、没意见」与「从未检视」。
 *
 * 与 `splitDiffIntoFileBlocks` 共用同一套块边界，不另造解析器；无法识别路径的
 * 前置块（`path === ""`）不进入结果。
 */
export function listChangedFilePaths(diff: string): readonly string[] {
  const seen = new Set<string>();
  const paths: string[] = [];
  for (const block of splitDiffIntoFileBlocks(diff)) {
    if (block.path === "" || seen.has(block.path)) {
      continue;
    }
    seen.add(block.path);
    paths.push(block.path);
  }
  return paths;
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
function blockPath(block: readonly string[]): string {
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

function isLockfile(basename: string): boolean {
  return LOCKFILE_BASENAMES.has(basename) || basename.endsWith(".lock");
}

function isGenerated(posixPath: string, basename: string): boolean {
  const segments = posixPath.toLowerCase().split("/");
  // 最后一段是文件名，不按目录段判定
  if (segments.slice(0, -1).some((segment) => GENERATED_DIR_SEGMENTS.has(segment))) {
    return true;
  }
  return GENERATED_SUFFIXES.some((suffix) => basename.endsWith(suffix));
}

export interface FilterDiffOptions {
  /**
   * 是否整块剔除测试文件（`limits.testFiles.skip`，缺省 true）。
   * 关闭 = 原样保留；开启 = reason = "test"。
   */
  readonly skipTestFiles?: boolean;
}

/** 块级分类；第一个命中的原因生效（binary > lockfile > minified > generated > test） */
function classifyBlock(
  block: readonly string[],
  posixPath: string,
  skipTestFiles: boolean,
): MrFilterReason | undefined {
  if (
    block.some(
      (line) => line.startsWith("Binary files ") || line.startsWith("GIT binary patch"),
    )
  ) {
    return "binary";
  }
  const basename = (posixPath.split("/").at(-1) ?? "").toLowerCase();
  if (isLockfile(basename)) {
    return "lockfile";
  }
  if (basename.includes(".min.")) {
    return "minified";
  }
  if (isGenerated(posixPath, basename)) {
    return "generated";
  }
  if (skipTestFiles && isTestFilePath(posixPath)) {
    return "test";
  }
  return undefined;
}

/**
 * 预过滤：整块剔除噪声文件。无命中时返回**原串**（调用方可用 `===` 判定零介入）。
 */
export function filterDiffForReview(
  diff: string,
  options: FilterDiffOptions = {},
): FilteredDiff {
  const skipTestFiles = options.skipTestFiles ?? true;
  if (diff.trim() === "") {
    return { diff, dropped: [], droppedChars: 0 };
  }
  const lines = diff.split("\n");
  const ranges = blockRanges(lines);
  if (ranges.length === 0) {
    return { diff, dropped: [], droppedChars: 0 };
  }

  const dropped: DroppedDiffFile[] = [];
  const removed = new Set<number>();
  for (const range of ranges) {
    const block = lines.slice(range.start, range.end);
    const path = blockPath(block);
    if (path === "") {
      continue;
    }
    const reason = classifyBlock(block, path, skipTestFiles);
    if (reason === undefined) {
      continue;
    }
    dropped.push({ path, reason });
    for (let index = range.start; index < range.end; index += 1) {
      removed.add(index);
    }
  }
  if (dropped.length === 0) {
    return { diff, dropped: [], droppedChars: 0 };
  }
  const filtered = lines.filter((_, index) => !removed.has(index)).join("\n");
  return { diff: filtered, dropped, droppedChars: diff.length - filtered.length };
}

/**
 * 入口体积门：过滤后仍超过上限 → 人话错误（`maxChars = null` 关门）。
 * 超限不是「检视失败」，而是「这份输入不适合一次性检视」——错误信息要给
 * 出两条可执行出路：拆分 MR，或显式关闭门禁。
 */
export function assertDiffWithinCharLimit(diff: string, maxChars: number | null): void {
  if (maxChars === null || diff.length <= maxChars) {
    return;
  }
  throw new Error(
    `MR diff 过大：${String(diff.length)} 字符，超过上限 ${String(maxChars)} 字符（limits.boundary.maxDiffChars）。` +
      `请把 MR 拆成更小的批次分别检视；如确认要关闭该门禁，在配置里设 limits.boundary.maxDiffChars = null。`,
  );
}

/** 审计 / 摘要用的窄投影（无剔除 = undefined，缺席省键） */
export function toMrFilterRecord(filtered: FilteredDiff): MrFilterRecord | undefined {
  if (filtered.dropped.length === 0) {
    return undefined;
  }
  const reasons: Record<MrFilterReason, number> = {
    lockfile: 0,
    generated: 0,
    minified: 0,
    binary: 0,
    test: 0,
  };
  for (const entry of filtered.dropped) {
    reasons[entry.reason] += 1;
  }
  return {
    droppedFiles: filtered.dropped.length,
    droppedChars: filtered.droppedChars,
    reasons,
    paths: filtered.dropped.slice(0, 20) satisfies readonly MrFilteredPath[],
  };
}

/** stderr 一行（可 grep；明细永远在审计 `mrFilter.paths`） */
export function formatMrFilterNotice(record: MrFilterRecord): string {
  const parts = (Object.entries(record.reasons) as ReadonlyArray<[MrFilterReason, number]>)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${String(count)}`);
  return (
    `已过滤 ${String(record.droppedFiles)} 个文件 / ${String(record.droppedChars)} 字符` +
    `（${parts.join(", ")}），明细见审计 mrFilter`
  );
}
