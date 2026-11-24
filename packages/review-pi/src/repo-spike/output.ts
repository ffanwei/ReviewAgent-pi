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
    `[repo-spike] dry-run: discovered=${String(plan.files.discovered)} selected=${String(
      plan.files.selected,
    )} skipped=${String(plan.files.skipped)} groups=${String(plan.groups.length)}`,
    ...plan.groups.map(
      (group) =>
        `[repo-spike]   ${String(group.index).padStart(3, "0")} ${group.key} files=${String(
          group.files.length,
        )} diffChars=${String(group.diffChars)}`,
    ),
  ].join("\n");
}

export function formatResultSummary(result: RepoSpikeResult): string {
  const reviewed = result.groups.filter((group) => group.status === "reviewed").length;
  const skipped = result.groups.filter((group) => group.status === "skipped").length;
  const failed = result.groups.filter((group) => group.status === "failed").length;
  return [
    `[repo-spike] files: discovered=${String(result.files.discovered)} selected=${String(
      result.files.selected,
    )} skipped=${String(result.files.skipped)}`,
    `[repo-spike] groups: reviewed=${String(reviewed)} skipped=${String(skipped)} failed=${String(
      failed,
    )}`,
    `[repo-spike] findings=${String(result.findings.length)} usage=input ${String(
      result.usage.inputTokens,
    )} output ${String(result.usage.outputTokens)}`,
    `[repo-spike] result: ${path.join(result.outDir, "repo-spike-result.json")}`,
  ].join("\n");
}
