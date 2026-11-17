// 宽松统一 diff 解析（单一真源）：文件 → hunk（行号、增删计数、旧/新侧内容行）。
//
// 这是「读内容」的视图，供三处消费：
// - `run/repo-side.ts`：按 oldStart/newStart 在磁盘文件里比对两侧块；
// - `gate/diff-scope.ts`：取新侧 hunk 区间做 finding 位置判定；
// - `analysis/diff-analysis.ts`：取旧侧区间做符号求交。
//
// 纪律：
// - 只认 `diff --git` / `--- ` / `+++ ` / `@@ ` 与 hunk 体；hunk 体按头部声明
//   的计数游走，消解 `--- x` / `+++ x` 类前缀歧义；
// - 手写 diff 的空上下文行（空串）按上下文处理（git 会写成单个空格）；
// - 永不抛错：结构不完整时退化为能解析出的部分（严格「可度量」判定是
//   `diff/measure.ts` 的职责，宽松视图不替它审判）。

import { parseHunkHeader, type HunkHeader } from "./hunk.js";
import { parseGitHeaderPaths, parseHeaderPath } from "./paths.js";

export type FileChangeKind = "added" | "deleted" | "modified";

export interface ParsedHunk extends HunkHeader {
  /** 本 hunk 新增行数（`+` 体行） */
  readonly added: number;
  /** 本 hunk 删除行数（`-` 体行） */
  readonly removed: number;
  /** 旧侧块：context + `-` 行（原样，无前缀） */
  readonly oldLines: readonly string[];
  /** 新侧块：context + `+` 行（原样，无前缀） */
  readonly newLines: readonly string[];
}

export interface ParsedFileChange {
  /** 新侧路径；删除文件退回旧侧（仓库相对 POSIX 路径） */
  readonly path: string;
  readonly oldPath?: string;
  readonly newPath?: string;
  readonly kind: FileChangeKind;
  readonly hunks: readonly ParsedHunk[];
  readonly added: number;
  readonly removed: number;
  /** `Binary files …` / `GIT binary patch` 标记 */
  readonly binary: boolean;
}

export interface ParsedDiff {
  readonly files: readonly ParsedFileChange[];
  /** 出现在任何文件头之前的 hunk 数（宽松视图保留；严格消费方可据此报错） */
  readonly unattributedHunks: number;
}

interface FileBuilder {
  readonly gitOld?: string;
  readonly gitNew?: string;
  oldPath?: string;
  newPath?: string;
  sawOldHeader: boolean;
  oldIsNull: boolean;
  sawNewHeader: boolean;
  newIsNull: boolean;
  hunks: ParsedHunk[];
  binary: boolean;
}

interface HunkBuilder {
  readonly header: HunkHeader;
  oldLeft: number;
  newLeft: number;
  added: number;
  removed: number;
  readonly oldLines: string[];
  readonly newLines: string[];
}

/** 解析 unified diff；宽松视图，永不抛错 */
export function parseUnifiedDiff(diff: string): ParsedDiff {
  const lines = diff.split("\n");
  const files: ParsedFileChange[] = [];
  let unattributedHunks = 0;
  let current: FileBuilder | undefined;
  let hunk: HunkBuilder | undefined;

  const finishHunk = (): void => {
    if (hunk === undefined) {
      return;
    }
    if (current !== undefined) {
      current.hunks.push({
        ...hunk.header,
        added: hunk.added,
        removed: hunk.removed,
        oldLines: hunk.oldLines,
        newLines: hunk.newLines,
      });
    } else {
      unattributedHunks += 1;
    }
    hunk = undefined;
  };

  const finishFile = (): void => {
    finishHunk();
    if (current === undefined) {
      return;
    }
    const builder = current;
    current = undefined;
    const path = builder.newPath ?? builder.oldPath ?? builder.gitNew ?? builder.gitOld;
    if (path === undefined) {
      // 没有任何可用路径：hunk 计入「无归属」，与 repo-side 的既有行为一致
      unattributedHunks += builder.hunks.length;
      return;
    }
    const added = builder.hunks.reduce((sum, entry) => sum + entry.added, 0);
    const removed = builder.hunks.reduce((sum, entry) => sum + entry.removed, 0);
    const kind: FileChangeKind =
      builder.sawOldHeader && builder.oldIsNull
        ? "added"
        : builder.sawNewHeader && builder.newIsNull
          ? "deleted"
          : "modified";
    files.push({
      path,
      ...(builder.oldPath !== undefined ? { oldPath: builder.oldPath } : {}),
      ...(builder.newPath !== undefined ? { newPath: builder.newPath } : {}),
      kind,
      hunks: builder.hunks,
      added,
      removed,
      binary: builder.binary,
    });
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";

    if (line.startsWith("diff --git ")) {
      finishFile();
      const header = parseGitHeaderPaths(line);
      current = {
        ...(header.oldPath !== undefined ? { gitOld: header.oldPath } : {}),
        ...(header.newPath !== undefined ? { gitNew: header.newPath } : {}),
        sawOldHeader: false,
        oldIsNull: false,
        sawNewHeader: false,
        newIsNull: false,
        hunks: [],
        binary: false,
      };
      continue;
    }

    // 没有 `diff --git` 的文件头对（手工 diff / 逆补丁）：新开一个文件节。
    // 已在同一节里见过 `+++` 或 hunk 时，这一对属于下一个文件。
    if (hunk === undefined && line.startsWith("--- ") && (lines[index + 1] ?? "").startsWith("+++ ")) {
      if (current !== undefined && (current.sawNewHeader || current.hunks.length > 0)) {
        finishFile();
      }
      if (current === undefined) {
        current = {
          sawOldHeader: false,
          oldIsNull: false,
          sawNewHeader: false,
          newIsNull: false,
          hunks: [],
          binary: false,
        };
      }
    }

    if (current !== undefined && (line.startsWith("Binary files ") || line.startsWith("GIT binary patch"))) {
      current.binary = true;
    }

    if (hunk === undefined && line.startsWith("--- ")) {
      if (current !== undefined) {
        const parsed = parseHeaderPath(line, "--- ");
        current.sawOldHeader = true;
        current.oldIsNull = parsed.deleted;
        if (parsed.path !== null) {
          current.oldPath = parsed.path;
        } else {
          delete current.oldPath;
        }
      }
      continue;
    }
    if (hunk === undefined && line.startsWith("+++ ")) {
      if (current !== undefined) {
        const parsed = parseHeaderPath(line, "+++ ");
        current.sawNewHeader = true;
        current.newIsNull = parsed.deleted;
        if (parsed.path !== null) {
          current.newPath = parsed.path;
        } else {
          delete current.newPath;
        }
      }
      continue;
    }

    if (hunk === undefined) {
      const header = parseHunkHeader(line);
      if (header === null) {
        continue;
      }
      hunk = {
        header,
        oldLeft: header.oldCount,
        newLeft: header.newCount,
        added: 0,
        removed: 0,
        oldLines: [],
        newLines: [],
      };
      if (hunk.oldLeft <= 0 && hunk.newLeft <= 0) {
        finishHunk();
      }
      continue;
    }

    if (hunk.oldLeft <= 0 && hunk.newLeft <= 0) {
      finishHunk();
      index -= 1; // 重新按文件头 / hunk 头处理当前行
      continue;
    }
    if (line.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    }
    if (line === "") {
      hunk.oldLines.push("");
      hunk.newLines.push("");
      hunk.oldLeft -= 1;
      hunk.newLeft -= 1;
      continue;
    }
    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === " ") {
      hunk.oldLines.push(content);
      hunk.newLines.push(content);
      hunk.oldLeft -= 1;
      hunk.newLeft -= 1;
      continue;
    }
    if (prefix === "-") {
      hunk.oldLines.push(content);
      hunk.oldLeft -= 1;
      hunk.removed += 1;
      continue;
    }
    if (prefix === "+") {
      hunk.newLines.push(content);
      hunk.newLeft -= 1;
      hunk.added += 1;
      continue;
    }
    // 结构行出现在体行位置（截断 / 非法 diff）：结束本 hunk，按头部重解析
    finishHunk();
    index -= 1;
  }
  finishFile();
  return { files, unattributedHunks };
}

/** 便捷：把解析结果按路径排序（符号分析等要求确定性输出） */
export function sortParsedFiles(files: readonly ParsedFileChange[]): readonly ParsedFileChange[] {
  return [...files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}
