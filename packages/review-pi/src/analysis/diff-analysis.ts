import { scanDiffHeaders } from "../diff/scan.js";
import type { LineSpan } from "./symbols.js";

// Diff 层分析（测量常量面：Diff → Symbol → Reference → Call Chain 管线第一层 Diff）。
//
// 从 unified diff 提取：
// - 变更文件清单（b 侧路径；删除文件回退 a 侧），POSIX 相对路径、排序去重；
// - 每个 hunk 的旧侧行区间（仓库快照是 MR 前版本 = base，符号求交以旧侧行号为准）。
//
// 解析实现在 `diff/scan.ts`（头扫描视图）：只认结构行、不消费 hunk 体——
// 数据集里的手工逆补丁常有体行与计数不一致，本层不需要体行。
//
// 确定性：仅字符串解析，无环境依赖；同一 diff 永远同一结果。

export interface DiffHunk {
  /** 旧侧（base 版本）起始行，1-based */
  readonly oldStart: number;
  readonly oldCount: number;
  /** 新侧起始行，1-based */
  readonly newStart: number;
  readonly newCount: number;
}

export interface FileDiff {
  readonly file: string;
  readonly hunks: readonly DiffHunk[];
}

export interface DiffAnalysis {
  /** 按路径排序的变更文件及其 hunk 列表 */
  readonly files: readonly FileDiff[];
}

/** 解析 unified diff；无任何可识别文件头时显式抛错（fail fast，不静默空结果） */
export function analyzeDiff(diff: string): DiffAnalysis {
  const scan = scanDiffHeaders(diff);
  if (scan.orphanHunks > 0) {
    throw new Error("diff hunk appeared before any file header");
  }
  if (scan.files.length === 0) {
    throw new Error(
      'diff contains no parsable file headers (expected "diff --git" or "+++ b/<path>" lines)',
    );
  }
  const files = [...scan.files]
    .map(({ file, hunks }) => ({ file, hunks }))
    .sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  return { files };
}

/** 变更文件的旧侧（base）行区间列表；纯新增（oldCount=0）以单行近似 */
export function oldSpansOf(fileDiff: FileDiff): readonly LineSpan[] {
  return fileDiff.hunks.map((hunk) => {
    const endLine = hunk.oldStart + Math.max(hunk.oldCount, 1) - 1;
    return { startLine: hunk.oldStart, endLine };
  });
}
