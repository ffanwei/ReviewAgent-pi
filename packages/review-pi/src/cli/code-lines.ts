import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

/**
 * 按 `--repo` + `file:line` 抽源码行（ADR-0017：`code` 的唯一真源）。
 * `Finding.line` = MR 应用后的行号，`--repo` 正是应用后的工作树——两者对齐，
 * 所以取的是原文而不是模型复述。取不到（文件不在仓 / 行号越界 / 读失败）
 * 一律缺席 ⇒ 落盘时为空串，**绝不编**。
 *
 * 主会话的片级上报（`reportShardFindings`）与收尾交付（`delivery`）共用同一实现。
 */
export async function readCodeLines(
  repoPath: string,
  findings: readonly { readonly id: string; readonly file: string; readonly line: number }[],
): Promise<Record<string, string>> {
  const cache = new Map<string, readonly string[] | undefined>();
  const codeByFinding: Record<string, string> = {};
  for (const finding of findings) {
    if (!cache.has(finding.file)) {
      cache.set(finding.file, await readLinesOf(resolve(repoPath, finding.file)));
    }
    const line = cache.get(finding.file)?.[finding.line - 1];
    if (line !== undefined) {
      codeByFinding[finding.id] = line.trim();
    }
  }
  return codeByFinding;
}

async function readLinesOf(filePath: string): Promise<readonly string[] | undefined> {
  try {
    return (await readFile(filePath, "utf8")).split(/\r?\n/);
  } catch {
    return undefined;
  }
}
