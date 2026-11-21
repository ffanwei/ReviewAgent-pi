// 覆盖账本（F-01a）：从本遍 diff 确定性派生「文件 × hunk」目录，并支持
// finding 回填、显式 no-issue、未决收口与分片聚合。
//
// 纪律：
// - 分母只来自 diff；模型输出只能回填 / 声明，不能扩大分母；
// - 未回填的 hunk 在 close 时落成 `not-reached(cause)`，不允许静默成功；
// - 纯函数：同一输入 → 同一账本；不读文件系统，不发请求；
// - 文件按路径排序、hunk 按 index 排序，分片聚合与并行顺序无关。

import {
  NOT_REACHED_CAUSES,
  type BuildCoverageOptions,
  type CandidateSource,
  type CoverageCounts,
  type CoverageExclusionReason,
  type CoverageFindingRef,
  type CoverageHunkRef,
  type CoverageLedger,
  type CoverageLineRange,
  type CoverageSummary,
  type ExcludedFileCoverage,
  type FileCoverage,
  type HunkCoverage,
  type NoIssueClaim,
  type NotReachedCause,
  type TruncatedHunkRange,
} from "../contracts/coverage.js";
import type { ShardTruncationRecord } from "../contracts/run.js";
import { parseUnifiedDiff, type ParsedFileChange, type ParsedHunk } from "../diff/parse.js";

const ZERO_CAUSES: Record<NotReachedCause, number> = {
  "no-signal": 0,
  truncated: 0,
  budget: 0,
  "output-truncated": 0,
  "flow-error": 0,
  "round-cap": 0,
};

const EXCLUSION_PRIORITY: Record<CoverageExclusionReason, number> = {
  binary: 0,
  deleted: 1,
  "no-hunks": 2,
};

/** 空账本（无文件、无 hunk；counts 全零） */
export function emptyCoverageLedger(): CoverageLedger {
  return {
    files: [],
    excluded: [],
    unattributedHunks: 0,
    counts: {
      hunks: 0,
      candidate: 0,
      noIssue: 0,
      notReached: 0,
      outOfHunk: 0,
      byCause: { ...ZERO_CAUSES },
    },
  };
}

/**
 * 从 unified diff 建覆盖分母。
 *
 * - 删除 / binary / 无 hunk 的文件进 `excluded`，不进分母；
 * - `options.truncated`（ADR-0070）把被丢弃的 hunk 接回分母，标 `not-reached(truncated)`；
 * - 同一路径的多个 diff 块合并为一个文件，hunk 序号连续。
 */
export function buildCoverageLedger(
  diff: string,
  options: BuildCoverageOptions = {},
): CoverageLedger {
  const parsed = parseUnifiedDiff(diff);
  const truncated = groupTruncated(options.truncated ?? []);
  const builders = new Map<string, { readonly file: string; readonly hunks: HunkCoverage[] }>();
  const excluded = new Map<string, ExcludedFileCoverage>();

  // 先收 included 文件：同一路径可能因手工拆块出现多次，合并为一组。
  for (const change of parsed.files) {
    const key = normalizeFile(change.path);
    if (exclusionReason(change) !== undefined) {
      continue;
    }
    const existing = builders.get(key);
    const builder = existing ?? { file: change.path, hunks: [] };
    if (existing === undefined) {
      builders.set(key, builder);
    }
    for (const hunk of change.hunks) {
      builder.hunks.push(toHunkCoverage(hunk, builder.hunks.length + 1));
    }
  }

  // 再把被丢弃的 hunk 接回分母；未匹配到文件说明分片器的截取留痕与 diff 不一致。
  for (const [key, ranges] of truncated) {
    const builder = builders.get(key);
    if (builder === undefined) {
      throw new Error(`coverage: truncated hunk refers to unknown file: ${key}`);
    }
    for (const range of ranges) {
      if (builder.hunks.some((hunk) => hunk.index === range.index)) {
        throw new Error(`coverage: duplicate hunk index ${String(range.index)} in ${key}`);
      }
      builder.hunks.push({
        index: range.index,
        old: range.old,
        new: range.new,
        status: "not-reached",
        cause: "truncated",
      });
    }
  }

  const files = [...builders.values()]
    .map((builder) => ({
      file: builder.file,
      hunks: sortAndValidateHunks(builder.hunks, builder.file),
    }))
    .sort((left, right) => comparePaths(left.file, right.file));

  // excluded 只收没有进入分母的路径；同一路径多次出现时取优先级最高的原因。
  for (const change of parsed.files) {
    const key = normalizeFile(change.path);
    if (builders.has(key)) {
      continue;
    }
    const reason = exclusionReason(change);
    if (reason === undefined) {
      continue;
    }
    const current = excluded.get(key);
    if (
      current === undefined ||
      EXCLUSION_PRIORITY[reason] < EXCLUSION_PRIORITY[current.reason]
    ) {
      excluded.set(key, { path: change.path, reason });
    }
  }

  const excludedFiles = [...excluded.values()].sort((left, right) =>
    comparePaths(left.path, right.path),
  );

  return {
    files,
    excluded: excludedFiles,
    unattributedHunks: parsed.unattributedHunks,
    counts: computeCounts(files, 0),
  };
}

/**
 * stderr 一行摘要（可 grep）：三态计数 + 非零 cause + hunk 外候选。
 * 纯格式化，不改变账本。
 */
export function formatCoverageNotice(coverage: CoverageLedger): string {
  const { counts } = coverage;
  const causes = NOT_REACHED_CAUSES.filter((cause) => counts.byCause[cause] > 0)
    .map((cause) => `${cause}=${String(counts.byCause[cause])}`)
    .join(" ");
  const causeSuffix = causes === "" ? "" : `（${causes}）`;
  const outSuffix =
    counts.outOfHunk > 0 ? `，hunk 外候选 ${String(counts.outOfHunk)}` : "";
  return (
    `覆盖账本 candidate ${String(counts.candidate)} / no-issue ${String(counts.noIssue)} / ` +
    `not-reached ${String(counts.notReached)}${causeSuffix}${outSuffix}`
  );
}

/**
 * 把 `shardTruncation` 审计记录展开成账本需要的截取区间。
 * diff 前置块（path = ""）不是文件，跳过；其计数仍留在 `droppedHunks`。
 */
export function truncatedRangesFromShardRecords(
  records: readonly ShardTruncationRecord[],
): readonly TruncatedHunkRange[] {
  return records.flatMap((record) =>
    record.path === ""
      ? []
      : record.dropped.map((range) => ({
          file: record.path,
          index: range.index,
          old: range.old,
          new: range.new,
        })),
  );
}

/**
 * 按新侧行号把 findings 回填到 hunk。
 *
 * - 同一 hunk 的多条 finding：id / source 去重后追加；
 * - 文件不在账本或行号不落在任何 hunk：计入 `counts.outOfHunk`；
 * - 与 `no-issue` 冲突视为内部错误（候选优先，但两者不应同时出现）；
 * - 不修改输入账本。
 */
export function backfillCandidates(
  ledger: CoverageLedger,
  findings: readonly CoverageFindingRef[],
  source: CandidateSource,
): CoverageLedger {
  const drafts = copyForUpdate(ledger);
  let outOfHunk = ledger.counts.outOfHunk;

  for (const finding of findings) {
    const target = findHunk(drafts, finding.file, finding.line);
    if (target === undefined) {
      outOfHunk += 1;
      continue;
    }
    const file = drafts[target.fileIndex];
    if (file === undefined) {
      throw new Error("coverage: internal file index out of range");
    }
    const hunk = file.hunks[target.hunkIndex];
    if (hunk === undefined) {
      throw new Error("coverage: internal hunk index out of range");
    }
    if (hunk.status === "no-issue") {
      throw new Error(
        `coverage: finding ${finding.id} conflicts with no-issue hunk ` +
          `${String(hunk.index)} of ${file.file}`,
      );
    }
    const findingIds = appendUnique(hunk.findingIds ?? [], finding.id);
    const sources = appendUnique(hunk.sources ?? [], source);
    file.hunks[target.hunkIndex] = {
      index: hunk.index,
      old: hunk.old,
      new: hunk.new,
      status: "candidate",
      findingIds,
      sources,
    };
  }

  return {
    ...ledger,
    files: drafts,
    counts: computeCounts(drafts, outOfHunk),
  };
}

/**
 * 显式声明 hunk 已审视且无问题。
 * `reason` 必须非空；已为 candidate 的 hunk 不允许再标 no-issue；
 * 重复声明同一 hunk 时 reason 必须一致（幂等）。
 */
export function markNoIssue(
  ledger: CoverageLedger,
  claims: readonly NoIssueClaim[],
): CoverageLedger {
  const drafts = copyForUpdate(ledger);

  for (const claim of claims) {
    if (claim.reason.trim() === "") {
      throw new Error(
        `coverage: no-issue claim for ${claim.file}#${String(claim.hunkIndex)} requires a reason`,
      );
    }
    const file = drafts.find(
      (entry) => normalizeFile(entry.file) === normalizeFile(claim.file),
    );
    if (file === undefined) {
      throw new Error(`coverage: no-issue claim for unknown file: ${claim.file}`);
    }
    const hunkIndex = file.hunks.findIndex((hunk) => hunk.index === claim.hunkIndex);
    const hunk = hunkIndex < 0 ? undefined : file.hunks[hunkIndex];
    if (hunk === undefined || hunkIndex < 0) {
      throw new Error(
        `coverage: no-issue claim for unknown hunk ${String(claim.hunkIndex)} of ${file.file}`,
      );
    }
    if (hunk.status === "candidate") {
      throw new Error(
        `coverage: hunk ${String(hunk.index)} of ${file.file} already has candidates`,
      );
    }
    if (hunk.status === "no-issue") {
      if (hunk.reason !== claim.reason) {
        throw new Error(
          `coverage: hunk ${String(hunk.index)} of ${file.file} already no-issue ` +
            `with a different reason`,
        );
      }
      continue;
    }
    file.hunks[hunkIndex] = {
      index: hunk.index,
      old: hunk.old,
      new: hunk.new,
      status: "no-issue",
      reason: claim.reason,
    };
  }

  return {
    ...ledger,
    files: drafts,
    counts: computeCounts(drafts, ledger.counts.outOfHunk),
  };
}

/**
 * 把指定缺口 hunk 收口为具体原因（F-01b：补漏请求 / 字符上限用尽）。
 *
 * - 只改仍为 `not-reached` 且没有具体 cause 的 hunk；candidate / no-issue
 *   以及已有 `truncated` 等现场原因不被覆盖；
 * - 目标文件 / hunk 必须存在于账本，否则视为调用方错误；
 * - 不修改输入账本。
 */
export function markNotReached(
  ledger: CoverageLedger,
  targets: readonly CoverageHunkRef[],
  cause: NotReachedCause,
  reason?: string,
): CoverageLedger {
  const files = ledger.files.map((file) => ({
    file: file.file,
    hunks: [...file.hunks],
  }));

  for (const target of targets) {
    const file = files.find(
      (entry) => normalizeFile(entry.file) === normalizeFile(target.file),
    );
    if (file === undefined) {
      throw new Error(`coverage: not-reached target refers to unknown file: ${target.file}`);
    }
    const hunkIndex = file.hunks.findIndex((hunk) => hunk.index === target.hunkIndex);
    const hunk = hunkIndex < 0 ? undefined : file.hunks[hunkIndex];
    if (hunk === undefined || hunkIndex < 0) {
      throw new Error(
        `coverage: not-reached target refers to unknown hunk ` +
          `${String(target.hunkIndex)} of ${file.file}`,
      );
    }
    if (hunk.status !== "not-reached") {
      continue;
    }
    if (hunk.cause !== undefined && hunk.cause !== "no-signal") {
      continue;
    }
    file.hunks[hunkIndex] = {
      ...hunk,
      cause,
      ...(reason !== undefined && reason.trim() !== "" ? { reason } : {}),
    };
  }

  return {
    ...ledger,
    files,
    counts: computeCounts(files, ledger.counts.outOfHunk),
  };
}

/**
 * 收口：把所有仍为 `not-reached(no-signal)` 的 hunk 标成本次 run 的实际原因。
 *
 * - 正常结束传 `no-signal`（无变化）；
 * - 异常 / 预算 / 输出截断等由调用方按现场传入；
 * - 已有具体原因（如 `truncated`）不被覆盖（首个原因优先）；
 * - candidate / no-issue 不受影响。
 */
export function closeCoverage(
  ledger: CoverageLedger,
  cause: NotReachedCause = "no-signal",
): CoverageLedger {
  if (cause === "no-signal") {
    return ledger;
  }
  const files = ledger.files.map((file) => ({
    file: file.file,
    hunks: file.hunks.map((hunk) => {
      if (hunk.status !== "not-reached") {
        return hunk;
      }
      if (hunk.cause !== undefined && hunk.cause !== "no-signal") {
        return hunk;
      }
      return { ...hunk, cause };
    }),
  }));
  return {
    ...ledger,
    files,
    counts: computeCounts(files, ledger.counts.outOfHunk),
  };
}

/**
 * 合并分片账本。
 *
 * - 文件路径在多个片重复出现视为分片规划错误（抛错）；
 * - 输出按路径排序，因此串行 / 并行与片顺序不影响结果；
 * - `outOfHunk` 与 `unattributedHunks` 求和。
 */
export function mergeCoverageLedgers(
  ledgers: readonly CoverageLedger[],
): CoverageLedger {
  if (ledgers.length === 0) {
    return emptyCoverageLedger();
  }

  const files = new Map<string, FileCoverage>();
  const excluded = new Map<string, ExcludedFileCoverage>();
  let unattributedHunks = 0;
  let outOfHunk = 0;

  for (const ledger of ledgers) {
    unattributedHunks += ledger.unattributedHunks;
    outOfHunk += ledger.counts.outOfHunk;
    for (const file of ledger.files) {
      const key = normalizeFile(file.file);
      if (files.has(key)) {
        throw new Error(`coverage: duplicate file across shards: ${file.file}`);
      }
      files.set(key, file);
    }
    for (const entry of ledger.excluded) {
      const key = normalizeFile(entry.path);
      const current = excluded.get(key);
      if (current !== undefined && current.reason !== entry.reason) {
        throw new Error(`coverage: conflicting exclusion for ${entry.path}`);
      }
      if (current === undefined) {
        excluded.set(key, entry);
      }
    }
  }

  for (const key of files.keys()) {
    if (excluded.has(key)) {
      throw new Error(`coverage: file ${key} is both reviewed and excluded`);
    }
  }

  const mergedFiles = [...files.values()].sort((left, right) =>
    comparePaths(left.file, right.file),
  );
  const mergedExcluded = [...excluded.values()].sort((left, right) =>
    comparePaths(left.path, right.path),
  );

  return {
    files: mergedFiles,
    excluded: mergedExcluded,
    unattributedHunks,
    counts: computeCounts(mergedFiles, outOfHunk),
  };
}

/**
 * 严格校验账本不变量：
 * - 文件路径唯一且非空；每个文件至少一个 hunk；hunk 序号从 1 连续；
 * - 行区间合法；三态字段互相排斥；
 * - `counts` 与实际内容一致，`byCause` 合计等于 `notReached`；
 * - excluded 路径不与分母重叠。
 *
 * 内部不变量破坏以抛错暴露（与 `Finalize` 的硬校验同纪律）。
 */
export function assertCoverageInvariant(ledger: CoverageLedger): void {
  const files = new Set<string>();
  const excluded = new Set<string>();
  let hunks = 0;
  let candidate = 0;
  let noIssue = 0;
  let notReached = 0;
  const byCause: Record<NotReachedCause, number> = { ...ZERO_CAUSES };

  for (const file of ledger.files) {
    const key = normalizeFile(file.file);
    if (key === "") {
      throw new Error("coverage: file path is empty");
    }
    if (files.has(key)) {
      throw new Error(`coverage: duplicate file in ledger: ${file.file}`);
    }
    files.add(key);
    if (file.hunks.length === 0) {
      throw new Error(`coverage: file ${file.file} has no hunks`);
    }
    file.hunks.forEach((hunk, offset) => {
      if (hunk.index !== offset + 1) {
        throw new Error(
          `coverage: hunk indices for ${file.file} must be contiguous from 1 ` +
            `(got ${String(hunk.index)} at position ${String(offset + 1)})`,
        );
      }
      if (!validRange(hunk.old) || !validRange(hunk.new)) {
        throw new Error(
          `coverage: invalid line range for hunk ${String(hunk.index)} of ${file.file}`,
        );
      }
      hunks += 1;
      switch (hunk.status) {
        case "candidate":
          candidate += 1;
          if ((hunk.findingIds?.length ?? 0) === 0) {
            throw new Error(
              `coverage: candidate hunk ${String(hunk.index)} of ${file.file} has no findingIds`,
            );
          }
          if (hunk.cause !== undefined || hunk.reason !== undefined) {
            throw new Error(
              `coverage: candidate hunk ${String(hunk.index)} of ${file.file} carries no-issue fields`,
            );
          }
          break;
        case "no-issue":
          noIssue += 1;
          if (hunk.reason === undefined || hunk.reason.trim() === "") {
            throw new Error(
              `coverage: no-issue hunk ${String(hunk.index)} of ${file.file} has no reason`,
            );
          }
          if (hunk.cause !== undefined || (hunk.findingIds?.length ?? 0) > 0) {
            throw new Error(
              `coverage: no-issue hunk ${String(hunk.index)} of ${file.file} carries conflicting fields`,
            );
          }
          break;
        case "not-reached":
          notReached += 1;
          if (hunk.cause === undefined) {
            throw new Error(
              `coverage: not-reached hunk ${String(hunk.index)} of ${file.file} has no cause`,
            );
          }
          if ((hunk.findingIds?.length ?? 0) > 0) {
            throw new Error(
              `coverage: not-reached hunk ${String(hunk.index)} of ${file.file} carries findingIds`,
            );
          }
          byCause[hunk.cause] += 1;
          break;
        default:
          throw new Error(
            `coverage: unknown hunk status for ${String(hunk.index)} of ${file.file}`,
          );
      }
    });
  }

  for (const entry of ledger.excluded) {
    const key = normalizeFile(entry.path);
    if (key === "") {
      throw new Error("coverage: excluded path is empty");
    }
    if (!isExclusionReason(entry.reason)) {
      throw new Error(
        `coverage: invalid exclusion reason ${String(entry.reason)} for ${entry.path}`,
      );
    }
    if (excluded.has(key)) {
      throw new Error(`coverage: duplicate excluded file: ${entry.path}`);
    }
    if (files.has(key)) {
      throw new Error(`coverage: file ${entry.path} is both reviewed and excluded`);
    }
    excluded.add(key);
  }

  if (ledger.counts.hunks !== hunks) {
    throw new Error(
      `coverage: counts.hunks=${String(ledger.counts.hunks)} but ledger has ${String(hunks)}`,
    );
  }
  if (ledger.counts.candidate !== candidate) {
    throw new Error(
      `coverage: counts.candidate=${String(ledger.counts.candidate)} but ledger has ${String(candidate)}`,
    );
  }
  if (ledger.counts.noIssue !== noIssue) {
    throw new Error(
      `coverage: counts.noIssue=${String(ledger.counts.noIssue)} but ledger has ${String(noIssue)}`,
    );
  }
  if (ledger.counts.notReached !== notReached) {
    throw new Error(
      `coverage: counts.notReached=${String(ledger.counts.notReached)} but ledger has ${String(notReached)}`,
    );
  }
  if (candidate + noIssue + notReached !== hunks) {
    throw new Error("coverage: status partition does not add up to the hunk total");
  }
  if (!Number.isInteger(ledger.unattributedHunks) || ledger.unattributedHunks < 0) {
    throw new Error("coverage: unattributedHunks must be a non-negative integer");
  }
  if (!Number.isInteger(ledger.counts.outOfHunk) || ledger.counts.outOfHunk < 0) {
    throw new Error("coverage: counts.outOfHunk must be a non-negative integer");
  }
  let causeSum = 0;
  for (const cause of NOT_REACHED_CAUSES) {
    causeSum += byCause[cause];
    if (ledger.counts.byCause[cause] !== byCause[cause]) {
      throw new Error(
        `coverage: counts.byCause.${cause}=${String(ledger.counts.byCause[cause])} ` +
          `but ledger has ${String(byCause[cause])}`,
      );
    }
  }
  if (causeSum !== notReached) {
    throw new Error("coverage: byCause total does not equal notReached");
  }
}

interface MutableFile {
  readonly file: string;
  readonly hunks: HunkCoverage[];
}

function copyForUpdate(ledger: CoverageLedger): MutableFile[] {
  return ledger.files.map((file) => ({
    file: file.file,
    hunks: [...file.hunks],
  }));
}

function findHunk(
  files: readonly MutableFile[],
  rawFile: string,
  line: number,
): { readonly fileIndex: number; readonly hunkIndex: number } | undefined {
  const key = normalizeFile(rawFile);
  for (let fileIndex = 0; fileIndex < files.length; fileIndex += 1) {
    const file = files[fileIndex];
    if (file === undefined || normalizeFile(file.file) !== key) {
      continue;
    }
    for (let hunkIndex = 0; hunkIndex < file.hunks.length; hunkIndex += 1) {
      const hunk = file.hunks[hunkIndex];
      if (hunk !== undefined && lineInRange(line, hunk.new)) {
        return { fileIndex, hunkIndex };
      }
    }
  }
  return undefined;
}

function lineInRange(line: number, range: CoverageLineRange): boolean {
  if (!Number.isInteger(line) || line <= 0) {
    return false;
  }
  if (range.count <= 0) {
    return line === Math.max(1, range.start);
  }
  return line >= range.start && line <= range.start + range.count - 1;
}

/** 覆盖账本 → JSON 汇总（F-01c）：比例按 hunk 总数算；不复制逐 hunk 明细 */
export function summarizeCoverage(ledger: CoverageLedger): CoverageSummary {
  const counts = ledger.counts;
  const denominator = counts.hunks > 0 ? counts.hunks : 1;
  return {
    ...counts,
    candidateRatio: counts.hunks > 0 ? counts.candidate / denominator : 0,
    noIssueRatio: counts.hunks > 0 ? counts.noIssue / denominator : 0,
    notReachedRatio: counts.hunks > 0 ? counts.notReached / denominator : 0,
  };
}

function computeCounts(
  files: readonly FileCoverage[],
  outOfHunk: number,
): CoverageCounts {
  const byCause: Record<NotReachedCause, number> = { ...ZERO_CAUSES };
  let hunks = 0;
  let candidate = 0;
  let noIssue = 0;
  let notReached = 0;

  for (const file of files) {
    for (const hunk of file.hunks) {
      hunks += 1;
      if (hunk.status === "candidate") {
        candidate += 1;
      } else if (hunk.status === "no-issue") {
        noIssue += 1;
      } else {
        notReached += 1;
        byCause[hunk.cause ?? "no-signal"] += 1;
      }
    }
  }

  return { hunks, candidate, noIssue, notReached, outOfHunk, byCause };
}

function toHunkCoverage(hunk: ParsedHunk, index: number): HunkCoverage {
  return {
    index,
    old: { start: hunk.oldStart, count: hunk.oldCount },
    new: { start: hunk.newStart, count: hunk.newCount },
    status: "not-reached",
    cause: "no-signal",
  };
}

function exclusionReason(
  change: ParsedFileChange,
): CoverageExclusionReason | undefined {
  if (change.binary) {
    return "binary";
  }
  if (change.kind === "deleted") {
    return "deleted";
  }
  if (change.hunks.length === 0) {
    return "no-hunks";
  }
  return undefined;
}

function groupTruncated(
  ranges: readonly TruncatedHunkRange[],
): Map<string, readonly TruncatedHunkRange[]> {
  const grouped = new Map<string, TruncatedHunkRange[]>();
  for (const range of ranges) {
    if (!Number.isInteger(range.index) || range.index <= 0) {
      throw new Error(
        `coverage: truncated hunk index must be a positive integer: ${String(range.index)}`,
      );
    }
    if (!validRange(range.old) || !validRange(range.new)) {
      throw new Error(
        `coverage: invalid line range for truncated hunk ${String(range.index)} of ${range.file}`,
      );
    }
    const key = normalizeFile(range.file);
    const list = grouped.get(key);
    if (list === undefined) {
      grouped.set(key, [range]);
    } else {
      list.push(range);
    }
  }
  return grouped;
}

function sortAndValidateHunks(
  hunks: readonly HunkCoverage[],
  file: string,
): readonly HunkCoverage[] {
  const sorted = [...hunks].sort((left, right) => left.index - right.index);
  sorted.forEach((hunk, offset) => {
    if (hunk.index !== offset + 1) {
      throw new Error(
        `coverage: hunk indices for ${file} must be contiguous from 1 ` +
          `(got ${String(hunk.index)} at position ${String(offset + 1)})`,
      );
    }
  });
  return sorted;
}

function validRange(range: CoverageLineRange): boolean {
  if (!Number.isInteger(range.start) || !Number.isInteger(range.count)) {
    return false;
  }
  if (range.start < 0 || range.count < 0) {
    return false;
  }
  if (range.count > 0 && range.start < 1) {
    return false;
  }
  return true;
}

function isExclusionReason(value: CoverageExclusionReason): boolean {
  return value === "binary" || value === "deleted" || value === "no-hunks";
}

/** finding / 账本路径归一：反斜杠、首尾空白、前导 `./`（与 diff-scope 同口径） */
function normalizeFile(file: string): string {
  return file.replace(/\\/g, "/").trim().replace(/^\.\//, "");
}

function comparePaths(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function appendUnique<T>(values: readonly T[], value: T): readonly T[] {
  return values.includes(value) ? values : [...values, value];
}
