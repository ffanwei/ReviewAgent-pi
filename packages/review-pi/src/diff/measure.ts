// 严格「可度量」视图：只有结构可完整游走的 unified diff 才给出计数。
//
// 与宽松解析（`parse.ts`）的分工：
// - 宽松视图服务于内容读取（宁可部分解析，也不拖垮检视）；
// - 本视图服务于边界护栏与收尾总结——不能证明界内 = 显式降级
//   （boundary-unmeasurable），所以任何结构疑点都返回 null。
//
// 口径：files = 文件数（含新增 / 删除）；changedLines = 新增行 + 删除行
// （不含 context / 文件头 / hunk 头）。hunk 体按头部声明的 old/new 计数游走，
// 从根上区分「`+++ `/`--- ` 文件头」与「`+`/`-` 前缀的增删行」。

import { parseHunkHeaderStrict } from "./hunk.js";

export interface DiffBoundaryMetrics {
  readonly files: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly changedLines: number;
}

/** 变更规模（收尾总结用：与边界度量共用同一解析器，额外报 hunk 数） */
export interface DiffScaleMetrics {
  readonly files: number;
  readonly hunks: number;
  readonly changedLines: number;
}

/** 严格度量 MR 边界指标；不可度量返回 null */
export function measureDiffBoundary(diff: string): DiffBoundaryMetrics | null {
  if (typeof diff !== "string" || diff.trim() === "") {
    return null;
  }
  const lines = splitDiffLines(diff);
  let files = 0;
  let added = 0;
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      return null;
    }
    if (isGitHeaderNoise(line)) {
      i += 1;
      continue;
    }
    if (isUnsupportedMarker(line) || !line.startsWith("--- ")) {
      // 顶层只允许 git 头噪音行与 `--- ` 文件头（root 同则：其他行 = 期望文件头失败）
      return null;
    }
    const block = measureFileBlock(lines, i);
    if (block === null) {
      return null;
    }
    files += 1;
    added += block.added;
    removed += block.removed;
    i = block.next;
  }
  if (files === 0) {
    return null;
  }
  return { files, addedLines: added, removedLines: removed, changedLines: added + removed };
}

/** 严格度量变更规模（文件数 / hunk 数 / 变更行数）；不可度量返回 null */
export function measureDiffScale(diff: string): DiffScaleMetrics | null {
  if (typeof diff !== "string" || diff.trim() === "") {
    return null;
  }
  const lines = splitDiffLines(diff);
  let files = 0;
  let hunks = 0;
  let changedLines = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      return null;
    }
    if (isGitHeaderNoise(line)) {
      i += 1;
      continue;
    }
    if (isUnsupportedMarker(line) || !line.startsWith("--- ")) {
      return null;
    }
    const block = measureFileBlock(lines, i);
    if (block === null) {
      return null;
    }
    files += 1;
    hunks += block.hunks;
    changedLines += block.added + block.removed;
    i = block.next;
  }
  if (files === 0) {
    return null;
  }
  return { files, hunks, changedLines };
}

function splitDiffLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** git 头噪音行（root skipGitHeader 同集：diff --git / Index: / index / mode / similarity） */
function isGitHeaderNoise(line: string): boolean {
  return (
    line.startsWith("diff --git") ||
    line.startsWith("Index:") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity index")
  );
}

/** root 全量解析器显式报错的标记（二进制 / 纯重命名）——同向不可度量 */
function isUnsupportedMarker(line: string): boolean {
  return (
    line.startsWith("rename from") ||
    line.startsWith("rename to") ||
    line.startsWith("Binary files") ||
    line.startsWith("GIT binary patch")
  );
}

/** 度量一个 `--- `/`+++ ` 文件块（含其全部 hunk）；结构不可游走返回 null */
function measureFileBlock(
  lines: readonly string[],
  start: number,
): { readonly next: number; readonly added: number; readonly removed: number; readonly hunks: number } | null {
  const plusLine = lines[start + 1];
  if (plusLine === undefined || !plusLine.startsWith("+++ ")) {
    return null;
  }
  let i = start + 2;
  let added = 0;
  let removed = 0;
  let hunks = 0;
  while (i < lines.length && lines[i]?.startsWith("@@ ") === true) {
    const hunk = measureHunk(lines, i);
    if (hunk === null) {
      return null;
    }
    added += hunk.added;
    removed += hunk.removed;
    i = hunk.next;
    hunks += 1;
  }
  if (hunks === 0) {
    // root 同则：文件块不含任何 hunk = 解析失败
    return null;
  }
  return { next: i, added, removed, hunks };
}

const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** 度量一个 hunk：按头部声明的 old/new 计数游走体行（歧义前缀由此消解） */
function measureHunk(
  lines: readonly string[],
  start: number,
): { readonly next: number; readonly added: number; readonly removed: number } | null {
  const header = parseHunkHeaderStrict(lines[start] ?? "");
  if (header === null) {
    return null;
  }
  let oldNeed = header.oldCount;
  let newNeed = header.newCount;
  let added = 0;
  let removed = 0;
  let i = start + 1;
  while (oldNeed > 0 || newNeed > 0) {
    const line = lines[i];
    if (line === undefined) {
      // 截断的 hunk：体行数不足头部声明
      return null;
    }
    if (line === NO_NEWLINE_MARKER) {
      i += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      oldNeed -= 1;
      newNeed -= 1;
    } else if (line.startsWith("-")) {
      oldNeed -= 1;
      removed += 1;
    } else if (line.startsWith("+")) {
      newNeed -= 1;
      added += 1;
    } else {
      // 计数耗尽前出现结构行（@@ / --- / diff --git）或不可识别行
      return null;
    }
    if (oldNeed < 0 || newNeed < 0) {
      // 体行数超出头部声明
      return null;
    }
    i += 1;
  }
  while (i < lines.length && lines[i] === NO_NEWLINE_MARKER) {
    i += 1;
  }
  return { next: i, added, removed };
}
