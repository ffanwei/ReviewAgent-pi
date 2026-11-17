// 头扫描视图（单一真源）：只读 `diff --git` / `---` / `+++` / `@@` 结构行，
// **不消费 hunk 体**。
//
// 与 `parse.ts`（按计数游走体行）的分工：有些消费方只需要「文件 → hunk 头」
// 的骨架（符号求交），且必须容忍体行不完整 / 计数与内容不一致的历史 diff
// （数据集里的手工逆补丁）。体行走游对它们是负担而不是保护，因此单独提供
// 这个视图；路径与 hunk 语法仍与其它视图共用 `paths.ts` / `hunk.ts`。

import { parseHunkHeader } from "./hunk.js";
import { parseGitHeaderPaths, parseHeaderPath, stripTimestamp } from "./paths.js";

export interface HeaderHunk {
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

export interface HeaderFile {
  /** 新侧路径；删除文件退回旧侧 */
  readonly file: string;
  readonly hunks: readonly HeaderHunk[];
}

export interface HeaderScan {
  /** diff 出现顺序；同一路径只保留首个条目（后续 hunk 追加到该条目） */
  readonly files: readonly HeaderFile[];
  /** 出现在任何文件头之前的 hunk 数 */
  readonly orphanHunks: number;
}

/** 扫描 diff 头；永不抛错（结构缺失由消费方决定 fail fast 还是降级） */
export function scanDiffHeaders(diff: string): HeaderScan {
  const hunksByFile = new Map<string, HeaderHunk[]>();
  let currentFile: string | undefined;
  let orphanHunks = 0;

  for (const rawLine of diff.split("\n")) {
    const line = stripTimestamp(rawLine);
    if (line.startsWith("diff --git ")) {
      const paths = parseGitHeaderPaths(line);
      currentFile = paths.newPath ?? paths.oldPath;
      continue;
    }
    if (line.startsWith("--- ")) {
      // /dev/null（新增文件）不定文件，等 +++ 侧；否则同记旧侧
      currentFile = parseHeaderPath(line, "--- ").path ?? currentFile;
      continue;
    }
    if (line.startsWith("+++ ")) {
      // /dev/null（删除文件）保持旧侧
      currentFile = parseHeaderPath(line, "+++ ").path ?? currentFile;
      continue;
    }
    const hunk = parseHunkHeader(line);
    if (hunk === null) {
      continue;
    }
    if (currentFile === undefined) {
      orphanHunks += 1;
      continue;
    }
    const entry = hunksByFile.get(currentFile) ?? [];
    entry.push(hunk);
    hunksByFile.set(currentFile, entry);
  }

  return {
    files: [...hunksByFile.entries()].map(([file, hunks]) => ({ file, hunks })),
    orphanHunks,
  };
}
