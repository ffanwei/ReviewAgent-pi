import type {
  MrFilteredPath,
  MrFilterPatternSet,
  MrFilterReason,
  MrFilterRecord,
} from "../contracts/run.js";
import { isTestFilePath } from "../shared/test-file.js";

// 大 diff 第一期内核入口处理（预处理过滤 + 体积门）：
//
// 1. 预过滤：按 `diff --git` 文件块（无该头时退回 `--- ` / `+++ ` 文件头对）
//    识别 lockfile / 生成物 / minified / 二进制块，整块剔除。**绝不切 hunk**：
//    块即文件，hunk 行号与 evidence 链完整保留。
//    测试文件由 `limits.testFiles.skip`（缺省 true）单独控制：开启时整块剔除，
//    关闭时原样保留（reason = "test"，与其他噪声原因共用同一审计口径）。
//    另有 `limits.mrFilter.excludeGlobs`（ADR-0069）：命中 glob 的块整块剔除
//    （reason = "exclude"），排在全部内置原因之后。
//    检视范围正则（ADR-0078）：`--include` / `--exclude`（CLI）或
//    `limits.mrFilter.includeRegex` / `excludeRegex`（配置）先按白名单选，
//    再按黑名单剔；命中白名单的块越过启发式过滤，`binary` 恒剔。
//    正则匹配对象先做一次 git 引号/八进制归一化（只给正则层用）。
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
  /**
   * 本次生效的范围规则（ADR-0078）：未配置 include/exclude 时省键。
   * 即使一条都没剔除也保留——审计要靠它复原「这次按什么范围筛的」。
   */
  readonly filters?: {
    readonly include?: MrFilterPatternSet;
    readonly exclude?: MrFilterPatternSet;
  };
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
  /**
   * 配置驱动的 glob 跳过（`limits.mrFilter.excludeGlobs`，ADR-0069）。
   * 命中 = reason = "exclude"；空数组 / 缺省 = 不排除。
   */
  readonly excludeGlobs?: readonly string[];
  /**
   * 检视范围白名单（ADR-0078）：模式原文 + 来源。命中任意一条 = 入选；
   * 入选块越过 test / lockfile / minified / generated / excludeGlobs 启发式。
   */
  readonly includeFilter?: MrFilterPatternSet;
  /**
   * 检视范围黑名单（ADR-0078）：命中任意一条 = 剔除（`regex-exclude`），
   * 优先于 include。
   */
  readonly excludeFilter?: MrFilterPatternSet;
}

/** 预编译的排除 glob（只编译一次，逐块匹配） */
interface CompiledExcludeGlob {
  /** 不含 `/` 的 glob 只比文件名（`*.md` 与 `**\/*.md` 等价） */
  readonly basenameOnly: boolean;
  readonly regex: RegExp;
}

/** glob → 正则：`**` 跨目录、`*` / `?` 不跨 `/`，大小写不敏感 */
function globToRegExp(glob: string): RegExp {
  let source = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const char = glob[index] ?? "";
    if (char === "*") {
      if (glob[index + 1] === "*") {
        // `**/` = 零或多级目录；裸 `**` = 任意字符
        if (glob[index + 2] === "/") {
          source += "(?:.*/)?";
          index += 2;
        } else {
          source += ".*";
          index += 1;
        }
      } else {
        source += "[^/]*";
      }
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`${source}$`, "i");
}

function compileExcludeGlobs(globs: readonly string[]): readonly CompiledExcludeGlob[] {
  const compiled: CompiledExcludeGlob[] = [];
  for (const raw of globs) {
    const glob = raw.trim().replace(/\\/g, "/");
    if (glob === "") {
      continue;
    }
    compiled.push({ basenameOnly: !glob.includes("/"), regex: globToRegExp(glob) });
  }
  return compiled;
}

function matchesExcludeGlob(posixPath: string, globs: readonly CompiledExcludeGlob[]): boolean {
  if (globs.length === 0) {
    return false;
  }
  const normalized = posixPath.replace(/\\/g, "/").trim();
  if (normalized === "") {
    return false;
  }
  const basename = normalized.split("/").at(-1) ?? "";
  return globs.some((glob) => glob.regex.test(glob.basenameOnly ? basename : normalized));
}

/**
 * 检视范围正则的匹配对象归一化（ADR-0078）：
 * `--mr-diff` 里非 ASCII / 特殊字符路径会被 git 写成 C 风格引号 + 八进制
 * （`+++ "b/\344\270\255\346\226\207.md"`），而 `--mr-json` 是原样路径。
 * 只给正则层归一化——现有 glob 层（ADR-0069）行为不动。
 */
export function normalizeDiffPathForRegex(raw: string): string {
  let normalized = raw.trim();
  if (normalized.length >= 2 && normalized.startsWith('"') && normalized.endsWith('"')) {
    normalized = decodeGitQuotedPath(normalized.slice(1, -1));
  }
  normalized = normalized.replace(/\\/g, "/");
  return normalized.replace(/^[ab]\//, "");
}

/** git C 风格引号内的转义解码（八进制按 UTF-8 字节还原） */
function decodeGitQuotedPath(value: string): string {
  const bytes: number[] = [];
  const simple: Readonly<Record<string, number>> = {
    t: 0x09,
    n: 0x0a,
    r: 0x0d,
    f: 0x0c,
    v: 0x0b,
    a: 0x07,
    b: 0x08,
    '"': 0x22,
    "\\": 0x5c,
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }
    const octal = /^[0-7]{1,3}/.exec(value.slice(index + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += octal[0].length;
      continue;
    }
    bytes.push(simple[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

interface CompiledPatternSet {
  readonly set: MrFilterPatternSet;
  readonly regexes: readonly RegExp[];
}

/** 编译一条范围名单；空名单 = 该维度不生效（调用方已把「清空」归一成 undefined） */
function compilePatternSet(set: MrFilterPatternSet | undefined): CompiledPatternSet | undefined {
  if (set === undefined || set.patterns.length === 0) {
    return undefined;
  }
  const regexes: RegExp[] = [];
  for (const pattern of set.patterns) {
    try {
      regexes.push(new RegExp(pattern));
    } catch (error) {
      throw new Error(
        `无效的检视范围正则 ${JSON.stringify(pattern)}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return { set, regexes };
}

function matchesAnyRegex(regexes: readonly RegExp[], path: string): boolean {
  return regexes.some((regex) => regex.test(path));
}

/**
 * 块级分类（ADR-0078 之后的优先级）：
 * binary > not-included > regex-exclude > 原有 lockfile > minified > generated >
 * test > exclude。
 *
 * include 命中即「保留」：显式白名单越过全部启发式（默认的 md 排除与
 * `testFiles.skip` 否则会让白名单失效）；`binary` 例外（没有可检视正文）。
 */
function classifyBlock(
  block: readonly string[],
  posixPath: string,
  skipTestFiles: boolean,
  excludeGlobs: readonly CompiledExcludeGlob[],
  includeRegexes: readonly RegExp[],
  excludeRegexes: readonly RegExp[],
): MrFilterReason | undefined {
  if (
    block.some(
      (line) => line.startsWith("Binary files ") || line.startsWith("GIT binary patch"),
    )
  ) {
    return "binary";
  }
  const regexPath =
    includeRegexes.length > 0 || excludeRegexes.length > 0
      ? normalizeDiffPathForRegex(posixPath)
      : "";
  if (includeRegexes.length > 0) {
    if (!matchesAnyRegex(includeRegexes, regexPath)) {
      return "not-included";
    }
    if (excludeRegexes.length > 0 && matchesAnyRegex(excludeRegexes, regexPath)) {
      return "regex-exclude";
    }
    return undefined;
  }
  if (excludeRegexes.length > 0 && matchesAnyRegex(excludeRegexes, regexPath)) {
    return "regex-exclude";
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
  if (matchesExcludeGlob(posixPath, excludeGlobs)) {
    return "exclude";
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
  const excludeGlobs = compileExcludeGlobs(options.excludeGlobs ?? []);
  const include = compilePatternSet(options.includeFilter);
  const exclude = compilePatternSet(options.excludeFilter);
  const filters =
    include !== undefined || exclude !== undefined
      ? {
          ...(include !== undefined ? { include: include.set } : {}),
          ...(exclude !== undefined ? { exclude: exclude.set } : {}),
        }
      : undefined;
  const untouched: FilteredDiff = {
    diff,
    dropped: [],
    droppedChars: 0,
    ...(filters !== undefined ? { filters } : {}),
  };
  if (diff.trim() === "") {
    return untouched;
  }
  const lines = diff.split("\n");
  const ranges = blockRanges(lines);
  if (ranges.length === 0) {
    return untouched;
  }

  const dropped: DroppedDiffFile[] = [];
  const removed = new Set<number>();
  for (const range of ranges) {
    const block = lines.slice(range.start, range.end);
    const path = blockPath(block);
    if (path === "") {
      continue;
    }
    const reason = classifyBlock(
      block,
      path,
      skipTestFiles,
      excludeGlobs,
      include?.regexes ?? [],
      exclude?.regexes ?? [],
    );
    if (reason === undefined) {
      continue;
    }
    dropped.push({ path, reason });
    for (let index = range.start; index < range.end; index += 1) {
      removed.add(index);
    }
  }
  if (dropped.length === 0) {
    return untouched;
  }
  const filtered = lines.filter((_, index) => !removed.has(index)).join("\n");
  return {
    diff: filtered,
    dropped,
    droppedChars: diff.length - filtered.length,
    ...(filters !== undefined ? { filters } : {}),
  };
}

/**
 * 入口体积门：过滤后仍超过上限 → 人话错误（`maxChars = null` 关门）。
 * 超限不是「检视失败」，而是「这份输入不适合一次性检视」——错误信息要给
 * 出两条可执行出路：拆分 MR，或显式关闭门禁。
 */
/**
 * MR 过滤后 diff 超 `limits.boundary.maxDiffChars` 的结构化错误（ADR-0075）：
 * CLI 据此走「跳过检视、上报空意见 + 固定总结」，而不是整条命令失败。
 */
export class MrDiffTooLargeError extends Error {
  readonly kind = "diff-too-large";
  readonly diffLength: number;
  readonly maxChars: number;

  constructor(diffLength: number, maxChars: number) {
    super(
      `MR diff 过大：${String(diffLength)} 字符，超过上限 ${String(maxChars)} 字符（limits.boundary.maxDiffChars）。` +
        `请把 MR 拆成更小的批次分别检视；如确认要关闭该门禁，在配置里设 limits.boundary.maxDiffChars = null。`,
    );
    this.name = "MrDiffTooLargeError";
    this.diffLength = diffLength;
    this.maxChars = maxChars;
  }
}

/** 体积门判定（单一真源）：超限返回错误对象，未超限返回 undefined */
export function diffTooLargeError(
  diff: string,
  maxChars: number | null,
): MrDiffTooLargeError | undefined {
  if (maxChars === null || diff.length <= maxChars) {
    return undefined;
  }
  return new MrDiffTooLargeError(diff.length, maxChars);
}

export function assertDiffWithinCharLimit(diff: string, maxChars: number | null): void {
  const error = diffTooLargeError(diff, maxChars);
  if (error !== undefined) {
    throw error;
  }
}

/**
 * 过滤后没有任何可检视文件块（ADR-0078）：输入 diff 本来有文件块，但被
 * include/exclude 或预过滤规则全部剔除。CLI 据此走「跳过检视 + 上报空意见 +
 * 固定总结」（与 ADR-0075 同形），不再拿空 diff 去调模型。
 *
 * 注意：输入本身就解析不出文件块（空 diff / malformed）不走本异常，仍由
 * 边界护栏按 `boundary-unmeasurable` 降级处理（ADR-0012 的既有契约）。
 */
export class NoReviewableFilesError extends Error {
  readonly kind = "no-reviewable-files";
  readonly droppedFiles: number;
  readonly droppedChars: number;

  constructor(droppedFiles: number, droppedChars: number) {
    super(
      `过滤后没有可检视的文件：${String(droppedFiles)} 个变更文件被全部剔除` +
        `（--include/--exclude 或预过滤规则，共 ${String(droppedChars)} 字符）`,
    );
    this.name = "NoReviewableFilesError";
    this.droppedFiles = droppedFiles;
    this.droppedChars = droppedChars;
  }
}

/** 审计 / 摘要用的窄投影（无剔除且未配置范围规则 = undefined，缺席省键） */
export function toMrFilterRecord(filtered: FilteredDiff): MrFilterRecord | undefined {
  if (filtered.dropped.length === 0 && filtered.filters === undefined) {
    return undefined;
  }
  const reasons: Record<MrFilterReason, number> = {
    lockfile: 0,
    generated: 0,
    minified: 0,
    binary: 0,
    test: 0,
    exclude: 0,
    "not-included": 0,
    "regex-exclude": 0,
  };
  for (const entry of filtered.dropped) {
    reasons[entry.reason] += 1;
  }
  return {
    droppedFiles: filtered.dropped.length,
    droppedChars: filtered.droppedChars,
    reasons,
    paths: filtered.dropped.slice(0, 20) satisfies readonly MrFilteredPath[],
    ...(filtered.filters !== undefined ? { filters: filtered.filters } : {}),
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
