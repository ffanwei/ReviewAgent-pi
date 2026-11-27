import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import type { RepoSpikePlan, RepoSpikeResult } from "./types.js";

export async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

export async function writeJsonFile(filePath: string, value: unknown): Promise<void> {
  await ensureDir(path.dirname(filePath));
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

/** 组 key → 文件名/目录名安全 slug。 */
export function slugify(value: string): string {
  const slug = value
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "group";
}

export function groupSlug(index: number, key: string): string {
  return `g${String(index).padStart(3, "0")}-${slugify(key)}`;
}

export function formatPlanSummary(plan: RepoSpikePlan): string {
  return [
    `[repo-review] dry-run: discovered=${String(plan.files.discovered)} selected=${String(
      plan.files.selected,
    )} skipped=${String(plan.files.skipped)} groups=${String(plan.groups.length)}`,
    ...plan.groups.map(
      (group) =>
        `[repo-review]   ${String(group.index).padStart(3, "0")} ${group.key} files=${String(
          group.files.length,
        )} diffChars=${String(group.diffChars)}${group.soloLarge === true ? " solo=true" : ""}`,
    ),
  ].join("\n");
}

export function formatResultSummary(result: RepoSpikeResult): string {
  const reviewed = result.groups.filter((group) => group.status === "reviewed").length;
  const skipped = result.groups.filter((group) => group.status === "skipped").length;
  const failed = result.groups.filter((group) => group.status === "failed").length;
  return [
    `[repo-review] files: discovered=${String(result.files.discovered)} selected=${String(
      result.files.selected,
    )} skipped=${String(result.files.skipped)}`,
    `[repo-review] groups: reviewed=${String(reviewed)} skipped=${String(skipped)} failed=${String(
      failed,
    )}`,
    `[repo-review] findings=${String(result.findings.length)} usage=input ${String(
      result.usage.inputTokens,
    )} output ${String(result.usage.outputTokens)} cache ${String(
      result.usage.cacheReadTokens ?? 0,
    )} calls ${String(result.usageLedger?.calls ?? 0)}${
      (result.usageLedger?.missingUsageCalls ?? 0) > 0
        ? ` missing-usage ${String(result.usageLedger?.missingUsageCalls ?? 0)}`
        : ""
    }`,
    `[repo-review] coverage: selected=${String(result.coverage.summary.selected)} candidate=${String(
      result.coverage.summary.candidate,
    )} no-issue=${String(result.coverage.summary.noIssue)} not-reached=${String(
      result.coverage.summary.notReached,
    )}`,
    `[repo-review] result: ${path.join(result.outDir, "repo-review-result.json")}`,
  ].join("\n");
}

/** 毫秒 → 人读时长：`0s` / `42s` / `2m10s` / `1h05m`。 */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  if (totalSeconds < 60) {
    return `${String(totalSeconds)}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds === 0 ? `${String(minutes)}m` : `${String(minutes)}m${String(seconds)}s`;
  }
  const hours = Math.floor(minutes / 60);
  const restMinutes = minutes % 60;
  return restMinutes === 0
    ? `${String(hours)}h`
    : `${String(hours)}h${String(restMinutes).padStart(2, "0")}m`;
}

export interface ProgressSnapshot {
  readonly completed: number;
  readonly total: number;
  readonly active: number;
  readonly elapsedMs: number;
  readonly etaMs?: number | undefined;
  readonly spentTokens?: number | undefined;
  readonly maxTotalTokens?: number | undefined;
}

/** 定时/组间进度行：完成数、在飞数、已耗时、预估剩余、token 消耗。 */
export function formatProgressLine(snapshot: ProgressSnapshot): string {
  const eta =
    snapshot.etaMs === undefined ? "eta=calculating" : `eta=${formatDuration(snapshot.etaMs)}`;
  const tokens =
    snapshot.spentTokens === undefined
      ? ""
      : snapshot.maxTotalTokens !== undefined && snapshot.maxTotalTokens > 0
        ? ` tokens=${String(snapshot.spentTokens)}/${String(snapshot.maxTotalTokens)}`
        : ` tokens=${String(snapshot.spentTokens)}`;
  return `[repo-review] progress completed=${String(snapshot.completed)}/${String(
    snapshot.total,
  )} active=${String(snapshot.active)} elapsed=${formatDuration(snapshot.elapsedMs)} ${eta}${tokens}`;
}
