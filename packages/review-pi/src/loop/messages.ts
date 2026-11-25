// MR 初始 user 消息构造。消息骨架与空白语义由 src/loop/messages.test.ts 把守；
// 不再与 DSH 历史审计记录逐字节对照（ADR-0038）。
export function buildInitialUserMessage(
  caseId: string,
  issueDescription: string,
  diff: string,
  extraSection?: string,
): string {
  // DSH 线语义：判空看 trim，注入看原文（前后空白保留）。
  const description = issueDescription.trim().length > 0 ? issueDescription : "(none)";
  const message = [
    "Merge request under review.",
    "",
    `Case ID: ${caseId}`,
    "Issue description:",
    description,
    "",
    "Unified diff:",
    "```diff",
    diff,
    "```",
  ].join("\n");
  // 额外检视清单（skill 包等）：缺席 / 纯空白时逐字节保持原消息。
  return extraSection === undefined || extraSection.trim().length === 0
    ? message
    : `${message}\n\n${extraSection}`;
}

/** repo 模式送给模型的一个文件快照（已归一化为 LF，无 diff 头）。 */
export interface RepoSnapshotFile {
  /** 仓库相对 POSIX 路径 */
  readonly path: string;
  readonly content: string;
}

/**
 * 全仓扫描（repo 模式）初始 user 消息。
 *
 * 刻意不出现 “Merge request” / “Unified diff” / `new file mode`：扫描对象是
 * 既有仓库，不是本次变更。文件内容用 `=== <path> ===` 分隔，行号仍是真实
 * 文件行号，模型据此定位 finding。
 */
export function buildRepoInitialUserMessage(
  caseId: string,
  issueDescription: string,
  files: readonly RepoSnapshotFile[],
  extraSection?: string,
): string {
  const description = issueDescription.trim().length > 0 ? issueDescription : "(none)";
  const body =
    files.length === 0
      ? "(none)"
      : files.map((file) => `=== ${file.path} ===\n${file.content}`).join("\n\n");
  const message = [
    "Repository snapshot under review.",
    "",
    `Case ID: ${caseId}`,
    "Issue description:",
    description,
    "",
    `Files (${String(files.length)}):`,
    "",
    body,
  ].join("\n");
  return extraSection === undefined || extraSection.trim().length === 0
    ? message
    : `${message}\n\n${extraSection}`;
}
