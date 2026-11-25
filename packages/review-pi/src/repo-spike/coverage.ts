import type {
  RepoCoverage,
  RepoCoverageFile,
  RepoCoverageReason,
  RepoCoverageState,
  RepoFile,
  RepoSpikeGroupOutcome,
  SkippedFile,
  SyntheticGroup,
} from "./types.js";

export interface BuildRepoCoverageInput {
  /** 枚举后选中的文件（已完成全局 maxFiles 截断） */
  readonly selected: readonly RepoFile[];
  /** 分组阶段跳过的文件（如 group-too-large） */
  readonly groupedSkipped: readonly SkippedFile[];
  /** 合成 diff 阶段的实际分组（含每组 read-failed / empty 跳过） */
  readonly groups: readonly SyntheticGroup[];
  /** 每组执行结果（reviewed / skipped / failed） */
  readonly outcomes: readonly RepoSpikeGroupOutcome[];
}

/**
 * 构建文件级三态覆盖账本。
 *
 * 纪律：
 * - 输出按 `selected` 的枚举顺序（路径字典序）排列，每个文件恰好一条；
 * - 已检视（reviewed）覆盖任何跳过原因：candidate（有 finding）或 no-issue；
 * - 失败组 / 跳过组 / 分组或合成阶段跳过的文件统一记 not-reached + 原因；
 * - 纯确定性，不触模型。
 */
export function buildRepoCoverage(input: BuildRepoCoverageInput): RepoCoverage {
  const selected = dedupeByPath(input.selected);
  const state = new Map<string, RepoCoverageFile>();
  for (const file of selected) {
    state.set(file.path, { path: file.path, state: "not-reached", reason: "unknown" });
  }

  // 先铺跳过原因（不覆盖已更具体的原因；同一路径以后写为准没有语义差异）。
  for (const skipped of [...input.groupedSkipped, ...input.groups.flatMap((group) => group.skipped)]) {
    if (!state.has(skipped.path)) {
      continue;
    }
    state.set(skipped.path, {
      path: skipped.path,
      state: "not-reached",
      reason: normalizeReason(skipped.reason),
    });
  }

  for (const outcome of input.outcomes) {
    if (outcome.status === "failed") {
      for (const file of outcome.files) {
        setNotReached(state, file, "failed-group");
      }
      continue;
    }
    if (outcome.status === "skipped") {
      const reason = normalizeReason(outcome.skipReason ?? "no-reviewable-files");
      for (const file of outcome.files) {
        setNotReached(state, file, reason);
      }
      continue;
    }

    const findingIdsByFile = new Map<string, string[]>();
    for (const finding of outcome.findings ?? []) {
      const ids = findingIdsByFile.get(finding.file);
      if (ids === undefined) {
        findingIdsByFile.set(finding.file, [finding.id]);
      } else {
        ids.push(finding.id);
      }
    }
    for (const file of outcome.files) {
      const findingIds = findingIdsByFile.get(file);
      state.set(
        file,
        findingIds !== undefined && findingIds.length > 0
          ? { path: file, state: "candidate", findingIds }
          : { path: file, state: "no-issue" },
      );
    }
  }

  const files = selected.map((file) => {
    const fallback: RepoCoverageFile = { path: file.path, state: "not-reached", reason: "unknown" };
    return state.get(file.path) ?? fallback;
  });
  return { summary: summarize(files), files };
}

/** 枚举阶段本应去重；这里再兜一层，保证「每个路径恰好一条」。 */
function dedupeByPath(files: readonly RepoFile[]): readonly RepoFile[] {
  const seen = new Set<string>();
  return files.filter((file) => {
    if (seen.has(file.path)) {
      return false;
    }
    seen.add(file.path);
    return true;
  });
}

function setNotReached(
  state: Map<string, RepoCoverageFile>,
  path: string,
  reason: RepoCoverageReason,
): void {
  if (!state.has(path)) {
    return;
  }
  state.set(path, { path, state: "not-reached", reason });
}

function summarize(files: readonly RepoCoverageFile[]): RepoCoverage["summary"] {
  let candidate = 0;
  let noIssue = 0;
  let notReached = 0;
  for (const file of files) {
    if (file.state === "candidate") {
      candidate += 1;
    } else if (file.state === "no-issue") {
      noIssue += 1;
    } else {
      notReached += 1;
    }
  }
  return { selected: files.length, candidate, noIssue, notReached };
}

/** 枚举 / 分组 / 执行的 reason 字符串 → 稳定枚举值。 */
export function normalizeReason(reason: string): RepoCoverageReason {
  if (reason.startsWith("too-large(")) {
    return "too-large";
  }
  switch (reason) {
    case "failed-group":
    case "group-too-large":
    case "too-large":
    case "binary":
    case "unsupported-extension":
    case "excluded-path":
    case "not-a-regular-file":
    case "empty":
    case "read-failed":
    case "no-reviewable-files":
    case "budget-exhausted":
    case "over-max-files":
      return reason;
    default:
      return "unknown";
  }
}

/** 三态计数是否与 selected 一致（测试与运行期自检用）。 */
export function coverageIsConsistent(coverage: RepoCoverage): boolean {
  const { summary } = coverage;
  return (
    summary.selected === coverage.files.length &&
    summary.selected === summary.candidate + summary.noIssue + summary.notReached
  );
}

/** 某个状态的文件数（CLI 摘要用）。 */
export function countState(coverage: RepoCoverage, state: RepoCoverageState): number {
  return coverage.files.filter((file) => file.state === state).length;
}
