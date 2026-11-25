import { readFile } from "node:fs/promises";
import path from "node:path";

import type { RepoSnapshotFile } from "../loop/messages.js";
import type { RepoGroup, SkippedFile, SyntheticGroup } from "./types.js";

export interface SynthesizeGroupOptions {
  readonly repoPath: string;
}

/**
 * 把一个分组的文件合成为「全部新增」的 unified diff。
 *
 * 这是 spike 的核心取巧：现有 MR 流水线只需要一份合法 unified diff；
 * 把每个文件写成 `--- /dev/null` / `+++ b/<path>`、所有行加 `+` 前缀，
 * 就能复用分片、六阶段、证据门、候选门与输出。
 *
 * 语义债（必须在报告里写清）：模型会把仓库里既有的问题也当成「本次新增」；
 * 行号仍然对得上（所有行都是 `+` 行），但「引入/加重」的归因不再成立。
 */
export async function synthesizeGroupDiff(
  group: RepoGroup,
  options: SynthesizeGroupOptions,
): Promise<SyntheticGroup> {
  const parts: string[] = [];
  const files: string[] = [];
  const snapshot: RepoSnapshotFile[] = [];
  const skipped: SkippedFile[] = [];

  for (const file of group.files) {
    const full = path.join(options.repoPath, ...file.path.split("/"));
    const raw = await readFile(full, "utf8").catch(() => undefined);
    if (raw === undefined) {
      skipped.push({ path: file.path, reason: "read-failed" });
      continue;
    }
    const normalized = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n");
    const hasTrailingNewline = normalized.endsWith("\n");
    const body = hasTrailingNewline ? normalized.slice(0, -1) : normalized;
    if (body.length === 0) {
      skipped.push({ path: file.path, reason: "empty" });
      continue;
    }
    const lines = body.split("\n");
    const header = [
      `diff --git a/${file.path} b/${file.path}`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ b/${file.path}`,
      `@@ -0,0 +1,${String(lines.length)} @@`,
    ];
    const bodyLines = lines.map((line) => `+${line}`);
    if (!hasTrailingNewline) {
      bodyLines.push("\\ No newline at end of file");
    }
    parts.push([...header, ...bodyLines].join("\n"));
    files.push(file.path);
    // repo 模式给模型的原貌：不含 `new file mode` / `@@` / `+` 前缀。
    snapshot.push({ path: file.path, content: body });
  }

  const diff = parts.length === 0 ? "" : `${parts.join("\n")}\n`;
  return {
    group,
    diff,
    files,
    snapshot,
    chars: diff.length,
    skipped,
  };
}
