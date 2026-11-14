import path from "node:path";

import { OPENCODE_DIR } from "./opencode-compat.js";

/**
 * run 产物布局的单一真源（ADR-0088）。
 *
 * 只做**确定性路径推导**：给定一个已存在的产物路径（原生转录 / 审计），
 * 回答「同一次 run 的另一个产物在哪」。读者优先使用 `RunRecord` 里记录的
 * 路径；本模块是 legacy 记录与写者组装时的唯一推导点。
 */

/** 从任意 run 产物路径反推 runs 目录（最后一个 `runs` 段） */
export function runsDirOf(artifactPath: string): string {
  const resolved = path.resolve(artifactPath);
  const segments = path.dirname(resolved).split(path.sep);
  const runsIndex = segments.lastIndexOf("runs");
  if (runsIndex < 0) {
    throw new Error(
      `run artifact path has no "runs" segment, cannot derive layout: ${resolved}`,
    );
  }
  return segments.slice(0, runsIndex + 1).join(path.sep);
}

/**
 * 原生转录路径 → 审计文件路径：
 * `runs/…/session-<runId>.json` → `audit/…/<runId>.json`。
 *
 * 缺 `runs` 段时**显式报错**——旧实现会静默返回同目录路径，随后在读取处
 * 变成 ENOENT，把「布局不对」伪装成「文件丢了」。
 */
export function auditPathOf(transcriptPath: string): string {
  const resolved = path.resolve(transcriptPath);
  const segments = path.dirname(resolved).split(path.sep);
  const runsIndex = segments.lastIndexOf("runs");
  if (runsIndex < 0) {
    throw new Error(
      `run artifact path has no "runs" segment, cannot derive audit path: ${resolved}`,
    );
  }
  segments[runsIndex] = "audit";
  const runId = path
    .basename(resolved)
    .replace(/^session-/, "")
    .replace(/\.json$/, "");
  return path.join(segments.join(path.sep), `${runId}.json`);
}

/** 原生转录 → OpenCode 兼容文件：`<runs 目录>/opencode/<原文件名>` */
export function compatFileOf(nativePath: string): string {
  const resolved = path.resolve(nativePath);
  return path.join(path.dirname(resolved), OPENCODE_DIR, path.basename(resolved));
}
