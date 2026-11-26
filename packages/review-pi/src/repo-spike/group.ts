import type { GroupPlan, RepoFile, RepoGroup, RepoSpikeGroupBy, SkippedFile } from "./types.js";

/** 每个文件在 unified diff 里的固定头/尾开销估算（路径 + hunk 头）。 */
const DIFF_OVERHEAD_PER_FILE = 256;

export interface GroupRepoFilesOptions {
  readonly groupBy: RepoSpikeGroupBy;
  readonly maxFilesPerGroup: number;
  readonly maxGroupChars: number;
}

/**
 * 确定性分组：只按路径 / 目录 / 扩展名分桶，再做文件数与字符双上限切片。
 *
 * - `directory`：取路径前两段（`src/a/x.ts` → `src/a`；`packages/x/...` → `packages/x`）；
 * - `files`：只按路径顺序切文件数桶；
 * - `language`：按扩展名；
 * - `none`：一个文件一组。
 *
 * 单文件估算超过 `maxGroupChars` 时**单独成组**（`soloLarge`），不再整文件跳过：
 * 多文件装箱上限不适用于已经不可再拆的单文件；单文件体积由枚举阶段的
 * `maxFileChars` 兜底。绝不把文件拆开。
 */
export function groupRepoFiles(
  files: readonly RepoFile[],
  options: GroupRepoFilesOptions,
): GroupPlan {
  const maxFiles = Math.max(1, Math.floor(options.maxFilesPerGroup));
  const maxChars = Math.max(1, Math.floor(options.maxGroupChars));
  const skipped: SkippedFile[] = [];

  if (files.length === 0) {
    return { groups: [], skipped };
  }

  const buckets = new Map<string, RepoFile[]>();
  for (const file of files) {
    const key = groupKey(file.path, options.groupBy);
    const bucket = buckets.get(key);
    if (bucket === undefined) {
      buckets.set(key, [file]);
    } else {
      bucket.push(file);
    }
  }

  const groups: RepoGroup[] = [];
  for (const key of [...buckets.keys()].sort(compareText)) {
    const bucket = [...(buckets.get(key) ?? [])].sort((left, right) =>
      compareText(left.path, right.path),
    );
    if (options.groupBy === "none") {
      for (const file of bucket) {
        groups.push(singleFileGroup(file, key, maxChars));
      }
      continue;
    }
    chunkBucket(bucket, key, maxFiles, maxChars, groups);
  }

  groups.sort((left, right) => {
    const byKey = compareText(left.key, right.key);
    if (byKey !== 0) {
      return byKey;
    }
    return compareText(left.files[0]?.path ?? "", right.files[0]?.path ?? "");
  });

  return {
    groups: groups.map((group, index) => ({ ...group, index: index + 1 })),
    skipped,
  };
}

function chunkBucket(
  bucket: readonly RepoFile[],
  key: string,
  maxFiles: number,
  maxChars: number,
  out: RepoGroup[],
): void {
  let current: RepoFile[] = [];
  let chars = 0;

  const flush = (): void => {
    if (current.length === 0) {
      return;
    }
    out.push({
      index: 0,
      key,
      files: current,
      estimatedChars: chars,
    });
    current = [];
    chars = 0;
  };

  for (const file of bucket) {
    const cost = estimateChars(file);
    if (cost > maxChars) {
      // 单文件已不可再拆：多文件装箱上限不适用，单独成组并留审计标记。
      flush();
      out.push(singleFileGroup(file, key, maxChars));
      continue;
    }
    if (current.length > 0 && (current.length >= maxFiles || chars + cost > maxChars)) {
      flush();
    }
    current.push(file);
    chars += cost;
  }
  flush();
}

function singleFileGroup(file: RepoFile, key: string, maxChars: number): RepoGroup {
  const cost = estimateChars(file);
  return {
    index: 0,
    key,
    files: [file],
    estimatedChars: cost,
    ...(cost > maxChars ? { soloLarge: true as const } : {}),
  };
}

function estimateChars(file: RepoFile): number {
  return file.size + DIFF_OVERHEAD_PER_FILE;
}

function groupKey(rel: string, mode: RepoSpikeGroupBy): string {
  if (mode === "none" || mode === "files") {
    return mode;
  }
  if (mode === "language") {
    const base = rel.split("/").at(-1) ?? rel;
    const dot = base.lastIndexOf(".");
    if (dot <= 0) {
      return "<no-ext>";
    }
    return base.slice(dot).toLowerCase();
  }
  const parts = rel.split("/");
  if (parts.length <= 1) {
    return "<root>";
  }
  const depth = Math.min(2, parts.length - 1);
  return parts.slice(0, depth).join("/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
