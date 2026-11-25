import { createHash } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";

import type { LlmUsage } from "../contracts/llm.js";
import type { Finding } from "../contracts/finding.js";
import { ZERO_USAGE } from "../provider/usage-map.js";
import { groupSlug } from "./output.js";
import type {
  RepoSpikeGroupOutcome,
  SyntheticGroup,
} from "./types.js";

export type RepoJobGroupStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface RepoJobGroup {
  readonly index: number;
  readonly key: string;
  readonly files: readonly string[];
  readonly diffChars: number;
  status: RepoJobGroupStatus;
  attempts: number;
  startedAt?: string | undefined;
  finishedAt?: string | undefined;
  runId?: string | undefined;
  findingsCount?: number | undefined;
  usage?: LlmUsage | undefined;
  error?: string | undefined;
  skipReason?: string | undefined;
}

export interface RepoJobManifest {
  readonly schemaVersion: 1;
  readonly mode: "repo-review-job";
  readonly jobId: string;
  readonly createdAt: string;
  updatedAt: string;
  status: "running" | "completed" | "partial" | "failed";
  readonly repoPath: string;
  readonly outDir: string;
  readonly snapshotHash: string;
  readonly configHash: string;
  readonly planHash: string;
  readonly modelId?: string;
  readonly maxTotalTokens: number;
  spentTokens: number;
  readonly groups: RepoJobGroup[];
}

export interface ExpectedJobHashes {
  readonly snapshotHash: string;
  readonly configHash: string;
  readonly planHash: string;
}

export function jobPath(outDir: string): string {
  return path.join(outDir, "job.json");
}

/** 内容级快照指纹：覆盖所有实际送入模型的文件内容（按路径 + 内容）。 */
export function fingerprintGroups(groups: readonly SyntheticGroup[]): string {
  const hash = createHash("sha256");
  for (const group of groups) {
    for (const file of group.snapshot) {
      hash.update(file.path);
      hash.update("\u0000");
      hash.update(file.content);
      hash.update("\u0000");
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

/** 计划指纹：分组键、文件集、字符量；不覆盖文件内容（由 snapshotHash 覆盖）。 */
export function fingerprintPlan(groups: readonly SyntheticGroup[]): string {
  return hashJson(
    groups.map((group) => ({
      index: group.group.index,
      key: group.group.key,
      files: group.files,
      diffChars: group.chars,
    })),
  );
}

export function fingerprintConfig(input: {
  readonly modelId?: string;
  readonly baseUrl?: string;
  readonly maxRounds: number;
  readonly includeTests: boolean;
  readonly groupBy: string;
  readonly ruleSkillsHash: string;
  readonly strictRuleSkill: boolean;
}): string {
  return hashJson({
    modelId: input.modelId ?? null,
    baseUrl: input.baseUrl ?? null,
    maxRounds: input.maxRounds,
    includeTests: input.includeTests,
    groupBy: input.groupBy,
    ruleSkillsHash: input.ruleSkillsHash,
    strictRuleSkill: input.strictRuleSkill,
  });
}

/** 规则包内容指纹：zip 读字节；目录递归读相对路径 + 内容。 */
export async function fingerprintRuleSkills(
  zips: readonly string[] | undefined,
  dirs: readonly string[] | undefined,
): Promise<string> {
  const hash = createHash("sha256");
  for (const zip of zips ?? []) {
    hash.update(`zip:${zip}\u0000`);
    try {
      hash.update(await readFile(zip));
    } catch {
      hash.update("read-failed");
    }
    hash.update("\u0000");
  }
  for (const dir of dirs ?? []) {
    hash.update(`dir:${dir}\u0000`);
    await hashDirectory(hash, dir, dir);
    hash.update("\u0000");
  }
  return `sha256:${hash.digest("hex")}`;
}

async function hashDirectory(
  hash: ReturnType<typeof createHash>,
  root: string,
  current: string,
): Promise<void> {
  const { readdir } = await import("node:fs/promises");
  const entries = await readdir(current, { withFileTypes: true }).catch(() => []);
  for (const entry of entries.sort((left, right) => (left.name < right.name ? -1 : 1))) {
    const full = path.join(current, entry.name);
    const rel = path.relative(root, full).split(path.sep).join("/");
    if (entry.isDirectory()) {
      hash.update(`d:${rel}\u0000`);
      await hashDirectory(hash, root, full);
    } else if (entry.isFile()) {
      hash.update(`f:${rel}\u0000`);
      try {
        hash.update(await readFile(full));
      } catch {
        hash.update("read-failed");
      }
      hash.update("\u0000");
    }
  }
}

export function createJob(input: {
  readonly outDir: string;
  readonly repoPath: string;
  readonly now: Date;
  readonly modelId?: string;
  readonly maxTotalTokens: number;
  readonly hashes: ExpectedJobHashes;
  readonly groups: readonly SyntheticGroup[];
}): RepoJobManifest {
  const jobId = `repo-review-${input.now.toISOString().replaceAll(/[:.]/g, "-")}`;
  return {
    schemaVersion: 1,
    mode: "repo-review-job",
    jobId,
    createdAt: input.now.toISOString(),
    updatedAt: input.now.toISOString(),
    status: "running",
    repoPath: input.repoPath,
    outDir: input.outDir,
    snapshotHash: input.hashes.snapshotHash,
    configHash: input.hashes.configHash,
    planHash: input.hashes.planHash,
    ...(input.modelId !== undefined ? { modelId: input.modelId } : {}),
    maxTotalTokens: input.maxTotalTokens,
    spentTokens: 0,
    groups: input.groups.map((group) => ({
      index: group.group.index,
      key: group.group.key,
      files: group.files,
      diffChars: group.chars,
      status: "pending",
      attempts: 0,
    })),
  };
}

export async function loadJob(outDir: string): Promise<RepoJobManifest | undefined> {
  try {
    const raw = await readFile(jobPath(outDir), "utf8");
    return JSON.parse(raw) as RepoJobManifest;
  } catch {
    return undefined;
  }
}

export function validateJob(job: RepoJobManifest, expected: ExpectedJobHashes): void {
  const mismatches: string[] = [];
  if (job.snapshotHash !== expected.snapshotHash) {
    mismatches.push("snapshot");
  }
  if (job.configHash !== expected.configHash) {
    mismatches.push("config/model/rule skills");
  }
  if (job.planHash !== expected.planHash) {
    mismatches.push("plan/grouping");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `repo-review: cannot resume: ${mismatches.join(", ")} changed since the job was recorded; start a new --out directory or remove ${jobPath(job.outDir)}`,
    );
  }
}

/** 原子写 job.json：临时文件 + rename；Windows 上 rename 覆盖失败时先删再 rename。 */
export async function writeJob(job: RepoJobManifest): Promise<void> {
  const target = jobPath(job.outDir);
  const dir = path.dirname(target);
  await mkdir(dir, { recursive: true });
  const tmp = path.join(dir, `.job.${process.pid}.${Date.now()}.tmp`);
  await writeFile(tmp, `${JSON.stringify(job, null, 2)}\n`, "utf8");
  try {
    await rename(tmp, target);
  } catch {
    await rm(target, { force: true });
    await rename(tmp, target);
  }
}

/** 从已完成的 run.json 重建组结果（resume 用）；缺失或损坏返回 undefined。 */
export async function readDoneGroup(
  outDir: string,
  group: RepoJobGroup,
): Promise<RepoSpikeGroupOutcome | undefined> {
  const slug = groupSlug(group.index, group.key);
  const recordPath = path.join(outDir, "runs", slug, "runs", "run.json");
  try {
    const record = JSON.parse(await readFile(recordPath, "utf8")) as {
      baseline?: { findings?: Finding[]; usage?: LlmUsage; auditPath?: string; transcriptPath?: string };
    };
    const findings = record.baseline?.findings;
    if (!Array.isArray(findings)) {
      return undefined;
    }
    return {
      index: group.index,
      key: group.key,
      files: group.files,
      diffChars: group.diffChars,
      status: "reviewed",
      findingsCount: findings.length,
      findings,
      usage: record.baseline?.usage ?? ZERO_USAGE,
      ...(record.baseline?.auditPath !== undefined ? { auditPath: record.baseline.auditPath } : {}),
      ...(record.baseline?.transcriptPath !== undefined
        ? { transcriptPath: record.baseline.transcriptPath }
        : {}),
      recordPath,
      reviewsPath: path.join(outDir, "runs", slug, "runs", "reviews_all.json"),
    };
  } catch {
    return undefined;
  }
}

export function usageTotal(usage: LlmUsage | undefined): number {
  if (usage === undefined) {
    return 0;
  }
  return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0);
}

/** 429 / 5xx / 超时 / 网络类错误可重试；4xx / 配置 / 鉴权不重试。 */
export function isTransientError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (/401|403|400|404|invalid|unauthorized|forbidden|api key|config/i.test(message)) {
    return false;
  }
  return /429|5\d\d|timeout|timed out|ECONNRESET|ETIMEDOUT|EAI_AGAIN|connection|fetch failed|socket|network/i.test(
    message,
  );
}

function hashJson(value: unknown): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

/** 文件是否存在且非空（测试与 resume 自检用）。 */
export async function isNonEmptyFile(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}
