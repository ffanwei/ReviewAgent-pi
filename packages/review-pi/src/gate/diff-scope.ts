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
 */
export function buildDiffScope(diff: string, contextLines: number): DiffScope {
  const files = parseDiffFiles(diff, contextLines);
  return {
    contextLines,
    fileCount: files.size,
    classify: (file, line) => classifyIn(files, file, line),
  };
}

function classifyIn(files: ReadonlyMap<string, FileScope>, file: string, line: number): ScopeDecision {
  // 解析不出任何文件 = 这份 diff 不可定位（空 diff / 非统一 diff）：不拦截。
  if (files.size === 0) {
    return "in-scope";
  }
  const entry = files.get(normalizeFindingPath(file));
  if (entry === undefined) {
    return "file-not-in-diff";
  }
  if (entry.unbounded) {
    return "in-scope";
  }
  return entry.ranges.some(([start, end]) => line >= start && line <= end) ? "in-scope" : "line-outside-hunks";
}

function parseDiffFiles(diff: string, contextLines: number): Map<string, FileScope> {
  const files = new Map<string, FileScope>();
  if (diff.trim() === "") {
    return files;
  }
  const lines = diff.split("\n");
  let current: FileScope | null = null;
  let inHunk = false;
  let oldLeft = 0;
  let newLeft = 0;
  let blockPaths: readonly string[] = [];
  let registeredInBlock = false;

  const flushBlock = (): void => {
    // 只有 `diff --git` 头、没有 `---`/`+++` 对的块（mode 变更 / 二进制）：
    // 文件本身在 diff 里，但没有可判定的行，按 fail-open 整文件放行。
    if (!registeredInBlock) {
      for (const filePath of blockPaths) {
        if (!files.has(filePath)) {
          files.set(filePath, { ranges: [], unbounded: true });
        }
      }
    }
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("diff --git ")) {
      flushBlock();
      current = null;
      registeredInBlock = false;
      blockPaths = parseGitHeaderPaths(line);
      inHunk = false;
      continue;
    }
    if (inHunk) {
      consumeHunkLine(line);
      continue;
    }
    if (line.startsWith("@@ ")) {
      const hunk = parseHunkHeader(line);
      if (hunk !== null) {
        if (current !== null) {
          current.ranges.push(expandRange(hunk.newStart, hunk.newCount, contextLines));
        }
        oldLeft = hunk.oldCount;
        newLeft = hunk.newCount;
        inHunk = true;
      }
      continue;
    }
    if (line.startsWith("--- ") && (lines[index + 1] ?? "").startsWith("+++ ")) {
      const minus = parseHeaderPath(line.slice(4));
      const plus = parseHeaderPath((lines[index + 1] ?? "").slice(4));
      const filePath = plus.path ?? minus.path;
      if (filePath === null) {
        current = null;
      } else {
        // 同一个文件理论上只出现一个 `diff --git` 块；但兼容手工拆分 / 多次
        // 出现的形态——命中已有条目就继续追加 hunk，而不是覆盖前面的范围。
        const existing = files.get(filePath);
        if (existing !== undefined) {
          current = existing;
        } else {
          current = { ranges: [], unbounded: plus.deleted };
          files.set(filePath, current);
        }
        registeredInBlock = true;
      }
      index += 1;
    }
  }
  flushBlock();
  return files;

  function consumeHunkLine(line: string): void {
    if (line.startsWith("\\")) {
      return;
    }
    if (line.startsWith("+")) {
      newLeft -= 1;
    } else if (line.startsWith("-")) {
      oldLeft -= 1;
    } else {
      oldLeft -= 1;
      newLeft -= 1;
    }
    if (oldLeft <= 0 && newLeft <= 0) {
      inHunk = false;
    }
  }
}

function parseHunkHeader(line: string): { oldCount: number; newStart: number; newCount: number } | null {
  const matched = /^@@ -\d+(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
  if (matched === null) {
    return null;
  }
  const oldCount = matched[1] === undefined ? 1 : Number(matched[1]);
  const newStart = Number(matched[2]);
  const newCount = matched[3] === undefined ? 1 : Number(matched[3]);
  return { oldCount, newStart, newCount };
}

/** hunk 新侧区间 + 前后 contextLines 行（下界夹到 1） */
function expandRange(newStart: number, newCount: number, contextLines: number): readonly [number, number] {
  const anchor = Math.max(1, newStart);
  const last = newCount <= 0 ? anchor : anchor + newCount - 1;
  return [Math.max(1, anchor - contextLines), last + contextLines];
}

interface HeaderPath {
  readonly path: string | null;
  readonly deleted: boolean;
}

/** `--- a/x` / `+++ b/x` / `+++ /dev/null` / 带引号或时间戳的行 */
function parseHeaderPath(raw: string): HeaderPath {
  const text = stripTimestamp(unquote(raw.trim()));
  if (text === "/dev/null") {
    return { path: null, deleted: true };
  }
  return { path: normalizeDiffPath(text), deleted: false };
}

function stripTimestamp(text: string): string {
  const tab = text.indexOf("\t");
  return tab >= 0 ? text.slice(0, tab) : text;
}

function unquote(text: string): string {
  if (!text.startsWith('"') || !text.endsWith('"') || text.length < 2) {
    return text;
  }
  return text.slice(1, -1).replace(/\\(["\\])/g, "$1");
}

/** diff 侧路径 → 仓库相对 POSIX 路径（去 a/ b/ 前缀、反斜杠归一） */
function normalizeDiffPath(text: string): string {
  const posix = text.replace(/\\/g, "/").trim();
  if (posix.startsWith("a/") || posix.startsWith("b/")) {
    return posix.slice(2);
  }
  return posix.replace(/^\.\//, "");
}

/** finding.file 口径的归一（只做路径分隔符与前缀；不做大小写折叠） */
function normalizeFindingPath(file: string): string {
  return file.replace(/\\/g, "/").trim().replace(/^\.\//, "");
}

/**
 * `diff --git a/x b/x` 的两个路径。带空格的路径会被 git 加引号，先按引号
 * 成对提取；否则用最后一个 ` b/` 分隔（左侧剥 `a/`）。
 */
function parseGitHeaderPaths(line: string): readonly string[] {
  const rest = line.slice("diff --git ".length);
  const quoted = rest.match(/"((?:[^"\\]|\\.)*)"/g);
  if (quoted !== null && quoted.length >= 2) {
    return quoted
      .slice(0, 2)
      .map((entry) => normalizeDiffPath(unquote(entry)))
      .filter((entry) => entry !== "");
  }
  const separator = rest.lastIndexOf(" b/");
  if (separator > 0) {
    return [normalizeDiffPath(rest.slice(0, separator)), normalizeDiffPath(rest.slice(separator + 1))];
  }
  return [];
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
