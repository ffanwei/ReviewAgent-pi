// 非 diff 区域过滤（`limits.findingScope`）：把「检视意见是否落在本次 diff
// 真正改动过的位置」变成候选拦截链的一道确定性检查。
//
// 口径：
// - 判定单位是**新侧行号**（finding.line 的口径）：落在某个 hunk 的
//   `+start,count` 区间内，或距 hunk 边界不超过 `contextLines` 行，即视为范围内；
// - 文件不在本遍 diff 里 = 范围外（`file-not-in-diff`）；
// - 以下情况**fail-open**（整份 diff 解析不出任何文件 / 删除文件 / 只有
//   mode 变更而没有 hunk 的文件）：不因解析不到位置而丢弃意见；
// - 空 diff（直接调用 / 测试形态）同样 fail-open。
//
// 本模块是纯字符串解析，不读文件系统；不依赖 diff 之外的上下文。
import type { Finding } from "../contracts/finding.js";
import { parseUnifiedDiff } from "../diff/parse.js";

/** 单条 finding 的位置判定结果 */
export type ScopeDecision = "in-scope" | "file-not-in-diff" | "line-outside-hunks";

export interface DiffScope {
  /** 允许超出 hunk 边界的行数（已含在 ranges 里；仅用于拒绝原因文案） */
  readonly contextLines: number;
  /** 解析到的文件数（0 = fail-open，任何位置都算范围内） */
  readonly fileCount: number;
  /** 判定 `(file, line)` 是否落在本遍 diff 的变更范围（含上下文行）内 */
  readonly classify: (file: string, line: number) => ScopeDecision;
}

interface FileScope {
  /** 新侧行区间（闭区间，已按 contextLines 扩展） */
  readonly ranges: Array<readonly [number, number]>;
  /** 无法定位行（删除文件 / 无 hunk 的文件）⇒ 该文件任何行都算范围内 */
  readonly unbounded: boolean;
}

/**
 * 从统一 diff 构建位置范围。`contextLines` 非负整数（由配置层保证）；
 * 传 0 = 只保留 hunk 内。
 *
 * `wholeFilePaths`（可选）= 整文件放行的路径集合（skill 包的 manifest / 文档）。
 * 文件仍须在本次 diff 里；集合只放宽行区间，不扩大文件集合。
 */
export function buildDiffScope(
  diff: string,
  contextLines: number,
  wholeFilePaths?: readonly string[],
): DiffScope {
  const files = parseDiffFiles(diff, contextLines);
  const wholeFile = new Set((wholeFilePaths ?? []).map(normalizeFindingPath));
  return {
    contextLines,
    fileCount: files.size,
    classify: (file, line) => classifyIn(files, wholeFile, file, line),
  };
}

function classifyIn(
  files: ReadonlyMap<string, FileScope>,
  wholeFile: ReadonlySet<string>,
  file: string,
  line: number,
): ScopeDecision {
  // 解析不出任何文件 = 这份 diff 不可定位（空 diff / 非统一 diff）：不拦截。
  if (files.size === 0) {
    return "in-scope";
  }
  const normalized = normalizeFindingPath(file);
  const entry = files.get(normalized);
  if (entry === undefined) {
    return "file-not-in-diff";
  }
  // skill 包的 manifest / 文档：整文件放行（文件已在 diff 里，行号不再收窄）。
  if (entry.unbounded || wholeFile.has(normalized)) {
    return "in-scope";
  }
  return entry.ranges.some(([start, end]) => line >= start && line <= end) ? "in-scope" : "line-outside-hunks";
}

function parseDiffFiles(diff: string, contextLines: number): Map<string, FileScope> {
  const files = new Map<string, FileScope>();
  for (const change of parseUnifiedDiff(diff).files) {
    // 删除文件 / 无 hunk 的文件（二进制、仅权限、仅重命名）：文件在 diff 里，
    // 但没有可判定的行，按 fail-open 整文件放行。
    const unbounded = change.kind === "deleted" || change.hunks.length === 0;
    const ranges = change.hunks.map((hunk) =>
      expandRange(hunk.newStart, hunk.newCount, contextLines),
    );
    const existing = files.get(change.path);
    if (existing === undefined) {
      files.set(change.path, { ranges, unbounded });
      continue;
    }
    // 同一路径多次出现（手工拆分 / 多次 diff 块）：追加范围，不覆盖前段
    existing.ranges.push(...ranges);
    if (unbounded) {
      files.set(change.path, { ranges: existing.ranges, unbounded: true });
    }
  }
  return files;
}

/** hunk 新侧区间 + 前后 contextLines 行（下界夹到 1） */
function expandRange(newStart: number, newCount: number, contextLines: number): readonly [number, number] {
  const anchor = Math.max(1, newStart);
  const last = newCount <= 0 ? anchor : anchor + newCount - 1;
  return [Math.max(1, anchor - contextLines), last + contextLines];
}

/** finding.file 口径的归一（只做路径分隔符与前缀；不做大小写折叠） */
function normalizeFindingPath(file: string): string {
  return file.replace(/\\/g, "/").trim().replace(/^\.\//, "");
}

/** 拒绝原因文案（审计 / 测试共用；英文，与 finding 输出语言一致） */
export function describeScopeRejection(scope: DiffScope, finding: Pick<Finding, "file" | "line">): string {
  const decision = scope.classify(finding.file, finding.line);
  if (decision === "file-not-in-diff") {
    return `finding file is not part of the reviewed diff: ${finding.file}`;
  }
  return (
    `finding line ${String(finding.line)} is outside the changed hunks ` +
    `(±${String(scope.contextLines)} lines) of ${finding.file}`
  );
}
