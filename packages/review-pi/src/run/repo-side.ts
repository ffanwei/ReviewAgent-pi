import { stat } from "node:fs/promises";
import path from "node:path";
import { readUtf8Tolerant } from "../codeintel/fs-utils.js";
import { normalizeDiffPathForRegex } from "./mr-input.js";

/**
 * 仓库快照侧别判定（`--repo` 相对本次 diff 停在哪一侧）。
 *
 * 为什么需要：`review.get_file` / 符号类工具读的是 `--repo` 工作树的当前内容，
 * 不对 diff 做叠加。快照停在 base 侧时，改动过的文件会被读到改前内容、diff 里
 * 的新增文件会直接读不到——而工具 schema 只写「仓库快照」，模型无从知道。
 *
 * 判定口径（确定性，零网络、零 git）：
 * - 只看 diff 里带文本 hunk 的文件；逐 hunk 取旧侧块（context + `-`）与新侧块
 *   （context + `+`），在磁盘文件里按 oldStart / newStart 精确比对；
 * - 旧侧块命中 = base 票；新侧块命中 = head 票；两侧都命中或都不命中 = 无票；
 * - 新增文件在树中存在且命中新侧块 = head 票；不存在 = base 票（弱证据）；
 *   删除文件存在且命中旧侧块 = base 票；不存在 = head 票（弱证据）；
 * - 二进制 / 仅权限 / 仅重命名（无 hunk）不产生证据；读不到的文件只计数。
 *
 * 边界纪律：本模块**永不抛错**——任何解析或读取失败都退化为 `unknown`；
 * 读取量与文件数都有硬上限（判定是旁路观测，不能拖慢检视）；同一输入永远
 * 同一结果（文件按 diff 出现顺序、无并发）。
 */

/** 单标：head = diff 改后侧；base = 改前侧；mixed = 两侧都有证据；unknown = 无可用证据 */
export type RepoSnapshotSide = "head" | "base" | "mixed" | "unknown";

export interface RepoSnapshotSideRecord {
  readonly side: RepoSnapshotSide;
  /** 命中 diff 新侧（改后）的证据票数（hunk 或新增/删除文件级） */
  readonly headVotes: number;
  /** 命中 diff 旧侧（改前）的证据票数 */
  readonly baseVotes: number;
  /** 实际读到并参与比对的文本文件数 */
  readonly filesChecked: number;
  /** 因缺失（新增/删除的文件级判定已计入票数）/ 过大 / 二进制 / 越界而跳过的文件数 */
  readonly filesSkipped: number;
  /** diff 里存在但没有文本 hunk 的文件数（二进制 / 仅权限 / 仅重命名） */
  readonly filesWithoutHunks: number;
}

export interface DetectRepoSnapshotSideInput {
  readonly repoPath: string;
  readonly diff: string;
}

/** 判定上限：旁路观测，规模随 diff 而非仓库增长，且有绝对上界 */
const MAX_FILES = 100;
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * 1024 * 1024;

/**
 * 判定 `--repo` 相对 diff 的侧别。永不抛错：解析失败 / 仓库不可读 → `unknown`。
 */
export async function detectRepoSnapshotSide(
  input: DetectRepoSnapshotSideInput,
): Promise<RepoSnapshotSideRecord> {
  try {
    return await detect(input);
  } catch {
    return emptyRecord();
  }
}

async function detect(input: DetectRepoSnapshotSideInput): Promise<RepoSnapshotSideRecord> {
  const changes = parseTextFileChanges(input.diff).slice(0, MAX_FILES);
  let headVotes = 0;
  let baseVotes = 0;
  let filesChecked = 0;
  let filesSkipped = 0;
  let filesWithoutHunks = 0;
  let bytesRead = 0;

  for (const change of changes) {
    if (change.hunks.length === 0) {
      filesWithoutHunks += 1;
      continue;
    }
    const remaining = MAX_TOTAL_BYTES - bytesRead;
    if (remaining <= 0) {
      filesSkipped += 1;
      continue;
    }
    const read = await readRepoFile(input.repoPath, change.path, remaining);
    if (read.kind === "missing") {
      filesSkipped += 1;
      // 弱证据：base 侧本该没有新增文件；head 侧本该没有删除文件。
      // 部分检出 / 子模块 / 过滤都可能造成"缺失"，故只在确实 ENOENT 时计一票。
      if (change.kind === "added") {
        baseVotes += 1;
      } else if (change.kind === "deleted") {
        headVotes += 1;
      }
      continue;
    }
    if (read.kind === "skipped") {
      filesSkipped += 1;
      continue;
    }
    bytesRead += read.bytes;
    filesChecked += 1;
    for (const hunk of change.hunks) {
      const oldHit = hunk.oldLines.length > 0 && matchesAt(read.lines, hunk.oldStart, hunk.oldLines);
      const newHit = hunk.newLines.length > 0 && matchesAt(read.lines, hunk.newStart, hunk.newLines);
      if (oldHit && !newHit) {
        baseVotes += 1;
      } else if (newHit && !oldHit) {
        headVotes += 1;
      }
    }
  }

  return {
    side: decideSide(headVotes, baseVotes),
    headVotes,
    baseVotes,
    filesChecked,
    filesSkipped,
    filesWithoutHunks,
  };
}

function emptyRecord(): RepoSnapshotSideRecord {
  return {
    side: "unknown",
    headVotes: 0,
    baseVotes: 0,
    filesChecked: 0,
    filesSkipped: 0,
    filesWithoutHunks: 0,
  };
}

function decideSide(headVotes: number, baseVotes: number): RepoSnapshotSide {
  if (headVotes > 0 && baseVotes === 0) {
    return "head";
  }
  if (baseVotes > 0 && headVotes === 0) {
    return "base";
  }
  if (headVotes > 0 && baseVotes > 0) {
    return "mixed";
  }
  return "unknown";
}

/**
 * stderr 提醒文案。head 侧不打扰，unknown 无可用证据也不报
 * （二次误报比漏报更伤）；只有 base / mixed 说明工具读到的内容与 diff 不同侧。
 */
export function formatRepoSnapshotSideNotice(
  record: RepoSnapshotSideRecord,
): string | undefined {
  const evidence = `${record.headVotes} head / ${record.baseVotes} base 票，${record.filesChecked} 文件`;
  if (record.side === "base") {
    return (
      `仓库快照停在 diff 的改前（base）侧：get_file 读到的是改前内容，改后内容以 diff 为准（${evidence}）`
    );
  }
  if (record.side === "mixed") {
    return `仓库快照侧别混杂：部分文件可能读到与 diff 不同侧的内容，请确认检出的提交（${evidence}）`;
  }
  return undefined;
}

/** 精确行比对：`block` 必须与文件 start1（1 基）起的连续行完全一致 */
function matchesAt(
  lines: readonly string[],
  start1: number,
  block: readonly string[],
): boolean {
  const start = start1 - 1;
  if (start < 0 || start + block.length > lines.length) {
    return false;
  }
  for (let index = 0; index < block.length; index += 1) {
    if (lines[start + index] !== block[index]) {
      return false;
    }
  }
  return true;
}

type FileRead =
  | { readonly kind: "ok"; readonly lines: readonly string[]; readonly bytes: number }
  | { readonly kind: "missing" }
  | { readonly kind: "skipped" };

async function readRepoFile(
  repoPath: string,
  relativePath: string,
  remainingBytes: number,
): Promise<FileRead> {
  const segments = relativePath.split("/");
  if (segments.some((segment) => segment === ".." || segment === "")) {
    return { kind: "skipped" };
  }
  const root = path.resolve(repoPath);
  const absolute = path.resolve(root, ...segments);
  // 词法 jail（与 review.get_file 同口径；判定是旁路，不做 realpath）
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    return { kind: "skipped" };
  }
  let info;
  try {
    info = await stat(absolute);
  } catch (error) {
    return isMissingError(error) ? { kind: "missing" } : { kind: "skipped" };
  }
  if (!info.isFile()) {
    return { kind: "skipped" };
  }
  if (info.size > MAX_FILE_BYTES || info.size > remainingBytes) {
    return { kind: "skipped" };
  }
  let source: string;
  try {
    source = await readUtf8Tolerant(absolute);
  } catch {
    return { kind: "skipped" };
  }
  // 与 get_file 的读取口径一致：BOM 剥离、NUL 视为二进制
  const text = source.startsWith("\uFEFF") ? source.slice(1) : source;
  if (text.includes("\u0000")) {
    return { kind: "skipped" };
  }
  return { kind: "ok", lines: splitLines(text), bytes: info.size };
}

function isMissingError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** 行拆分（文件尾换行不产生伪行；空文件为 0 行）——与 get_file 同口径 */
function splitLines(source: string): readonly string[] {
  if (source.length === 0) {
    return [];
  }
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body.split("\n");
}

type FileKind = "added" | "deleted" | "modified";

interface ParsedHunk {
  readonly oldStart: number;
  readonly newStart: number;
  /** 旧侧块：context + `-` 行（原样，无前缀） */
  readonly oldLines: string[];
  /** 新侧块：context + `+` 行（原样，无前缀） */
  readonly newLines: string[];
}

interface ParsedChange {
  readonly path: string;
  readonly kind: FileKind;
  readonly hunks: ParsedHunk[];
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

/**
 * 把统一 diff 解析为「文件 → 文本 hunk」。只认 `--- `/`+++ `/`@@ ` 与 hunk
 * 体（按头部声明计数游走，消解 `--- x` 类前缀歧义）；二进制 / 仅权限 / 仅
 * 重命名没有 hunk，保留为 hunks 为空的条目（调用方计入 filesWithoutHunks）。
 */
function parseTextFileChanges(diff: string): ParsedChange[] {
  const changes: ParsedChange[] = [];
  const lines = diff.split("\n");
  let oldPath: string | undefined;
  let newPath: string | undefined;
  let gitHeaderPath: string | undefined;
  let hunks: ParsedHunk[] = [];
  let hunk: ParsedHunk | undefined;
  let oldLeft = 0;
  let newLeft = 0;

  const finishHunk = (): void => {
    hunk = undefined;
    oldLeft = 0;
    newLeft = 0;
  };

  const finishSection = (): void => {
    finishHunk();
    const filePath = newPath ?? oldPath ?? gitHeaderPath;
    if (filePath !== undefined) {
      changes.push({ path: filePath, kind: fileKind(oldPath, newPath), hunks });
    }
    oldPath = undefined;
    newPath = undefined;
    gitHeaderPath = undefined;
    hunks = [];
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.startsWith("diff --git ")) {
      finishSection();
      gitHeaderPath = gitHeaderNewPath(line);
      continue;
    }
    if (hunk === undefined && line.startsWith("--- ")) {
      oldPath = headerPath(line.slice(4));
      continue;
    }
    if (hunk === undefined && line.startsWith("+++ ")) {
      newPath = headerPath(line.slice(4));
      continue;
    }
    if (hunk === undefined) {
      const header = HUNK_HEADER.exec(line);
      if (header === null) {
        continue;
      }
      hunk = {
        oldStart: Number(header[1]),
        newStart: Number(header[3]),
        oldLines: [],
        newLines: [],
      };
      oldLeft = header[2] === undefined ? 1 : Number(header[2]);
      newLeft = header[4] === undefined ? 1 : Number(header[4]);
      hunks.push(hunk);
      continue;
    }

    if (oldLeft <= 0 && newLeft <= 0) {
      finishHunk();
      index -= 1; // 重新按文件头 / hunk 头处理当前行
      continue;
    }
    if (line.startsWith("\\")) {
      continue; // "\ No newline at end of file"
    }
    if (line === "") {
      // 手写 diff 的空上下文行（git 会写成单个空格）
      hunk.oldLines.push("");
      hunk.newLines.push("");
      oldLeft -= 1;
      newLeft -= 1;
      continue;
    }
    const prefix = line[0];
    const content = line.slice(1);
    if (prefix === " ") {
      hunk.oldLines.push(content);
      hunk.newLines.push(content);
      oldLeft -= 1;
      newLeft -= 1;
      continue;
    }
    if (prefix === "-") {
      hunk.oldLines.push(content);
      oldLeft -= 1;
      continue;
    }
    if (prefix === "+") {
      hunk.newLines.push(content);
      newLeft -= 1;
      continue;
    }
    // 结构行出现在体行位置（截断 / 非法 diff）：结束本 hunk，按头部重解析
    finishHunk();
    index -= 1;
  }
  finishSection();
  return changes;
}

function fileKind(oldPath: string | undefined, newPath: string | undefined): FileKind {
  // 只有 diff --git 头、没有 ---/+++ 的文件块（二进制 / 仅权限）按"修改"处理
  if (oldPath === undefined && newPath === undefined) {
    return "modified";
  }
  if (oldPath === undefined) {
    return "added";
  }
  if (newPath === undefined) {
    return "deleted";
  }
  return "modified";
}

/** `diff --git a/x b/x` 的新侧路径（带引号路径按成对引号提取；否则按最后一个 " b/" 切） */
function gitHeaderNewPath(line: string): string | undefined {
  const rest = line.slice("diff --git ".length);
  const quoted = rest.match(/"((?:[^"\\]|\\.)*)"/g);
  const candidate =
    quoted !== null && quoted.length >= 2
      ? quoted[quoted.length - 1]
      : rest.slice(rest.lastIndexOf(" b/") + 1);
  if (candidate === undefined || candidate === "") {
    return undefined;
  }
  const normalized = normalizeDiffPathForRegex(candidate);
  return normalized === "" ? undefined : normalized;
}

/** 文件头路径：剥时间戳、解 git 引号（含八进制）、去 a/ b/ 前缀；/dev/null → undefined */
function headerPath(raw: string): string | undefined {
  const tab = raw.indexOf("\t");
  const text = (tab >= 0 ? raw.slice(0, tab) : raw).trim();
  if (text === "" || text === "/dev/null") {
    return undefined;
  }
  const normalized = normalizeDiffPathForRegex(text);
  return normalized === "" ? undefined : normalized;
}
