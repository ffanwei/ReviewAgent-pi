import { stat } from "node:fs/promises";
import path from "node:path";
import { readUtf8Tolerant } from "../codeintel/fs-utils.js";
import { parseUnifiedDiff } from "../diff/parse.js";

/**
 * 仓库快照侧别判定（`--repo` 相对本次 diff 停在哪一侧）。
 *
 * 为什么需要：`review.get_file` / 符号类工具读的是 `--repo` 工作树的当前内容，
 * 不对 diff 做叠加。快照停在 base 侧时，改动过的文件会被读到改前内容、diff 里
 * 的新增文件会直接读不到——而工具 schema 只写「仓库快照」，模型无从知道。
 * 因此 base / mixed 侧会额外把可执行提示注入初始 user 消息（ADR-0109）；
 * head（大多数情况）/ unknown 不注入，保持请求字节不变。
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
  const changes = parseUnifiedDiff(input.diff).files.slice(0, MAX_FILES);
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

/**
 * 注入模型的侧别提示（ADR-0109）：只在 `base` / `mixed` 返回文本。
 *
 * 与 stderr 提醒分开：stderr 给人看（带票数），本函数给模型看（可执行规则）。
 * `head`（大多数情况）与 `unknown` 返回 undefined —— 初始 user 消息逐字节
 * 保持原样，正常路径的请求字节不受影响。
 */
export function formatRepoSnapshotModelNote(
  record: RepoSnapshotSideRecord | undefined,
): string | undefined {
  if (record === undefined) {
    return undefined;
  }
  const side =
    record.side === "base"
      ? "停在本次 diff 的改前（base）侧"
      : record.side === "mixed"
        ? "与本次 diff 的侧别混杂（部分文件可能是改前内容）"
        : undefined;
  if (side === undefined) {
    return undefined;
  }
  return [
    `注意：本会话的 --repo 工作树${side}。`,
    "diff 中新增的文件可能不存在，修改文件读到的是改前内容；变更行以 diff 为准。",
    "review.get_file / review.search_code 无结果不代表文件或符号不存在；不要仅因仓库读取失败而放弃候选。",
  ].join("\n");
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

