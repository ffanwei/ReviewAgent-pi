import path from "node:path";
import type { RepoContext } from "../analysis/repo-context.js";
import { readUtf8Tolerant } from "../codeintel/fs-utils.js";
import { normalizeRepoPath, optionalPositiveIntArg, requireStringArg } from "./args.js";
import { readThroughLedger } from "./ledger.js";
import { applyLineBudget } from "./result-budget.js";
import type { ReviewToolHandler, ToolRunContext } from "./toolkit-types.js";

/**
 * review.get_file（#6 P3a）：读取仓库快照中的文件（支持行区间读取）。
 *
 * - 路径为仓库相对 POSIX 路径；反斜杠归一化，拒绝绝对路径与 ".." 越界（防路径逃逸）；
 * - 读取经 RepoContext（确定性）；文件缺失/不可读为显式有界错误，
 *   错误信息不泄漏仓库绝对路径（请求字节可跨环境复现）；
 * - **规则 Skill 会话**：toolkit 注入 `skillPackRoot` 后，仓库读取失败时回退到
 *   本 skill 包根；`skill://<包内相对路径>` 前缀强制读包。主会话无 packRoot，
 *   行为与既有完全一致；包内读取同样只输出相对路径、不泄漏宿主绝对路径；
 * - 行区间：start 超出文件尾为显式错误；end 超出文件尾截断到文件尾并留痕；
 * - 输出行带行号（证据引用需要行号）；超预算在行边界截断并留痕；
 * - Context Ledger：整读登记为 file、区间读取登记为 range（规范化请求标识 =
 *   路径 + 请求区间，未给的边界显式化为 start=1 / end=end）；重复的同一规范化
 *   请求返回 "Already loaded: ctx#NNN" 引用；读取失败不登记。
 */

/** 规则 Skill 会话里强制读包的路径前缀（`skill://rules/x.md`） */
export const SKILL_FILE_PREFIX = "skill://";

export const getFileTool: ReviewToolHandler = async (args, context): Promise<string> => {
  const rawPath = requireStringArg("review.get_file", args, "path");
  const startLine = optionalPositiveIntArg("review.get_file", args, "startLine");
  const endLine = optionalPositiveIntArg("review.get_file", args, "endLine");
  if (startLine !== undefined && endLine !== undefined && startLine > endLine) {
    throw new Error(
      `review.get_file: argument "startLine" (${startLine}) must not exceed "endLine" (${endLine})`,
    );
  }

  const forcedSkill = rawPath.startsWith(SKILL_FILE_PREFIX);
  const pathText = forcedSkill ? rawPath.slice(SKILL_FILE_PREFIX.length) : rawPath;
  const posixPath = normalizeRepoPath("review.get_file", pathText);
  if (forcedSkill && context.skillPackRoot === undefined) {
    throw new Error(
      'review.get_file: "skill://" paths are only available in a rule-skill session',
    );
  }
  const ledgerDescription = forcedSkill
    ? `review.get_file ${SKILL_FILE_PREFIX}${posixPath}`
    : fileReadLedgerDescription(posixPath, startLine, endLine);
  return readThroughLedger(
    context.ledger,
    fileReadLedgerKind(startLine, endLine),
    ledgerDescription,
    async () => {
      const target = await resolveSource(context, posixPath, forcedSkill);
      const lines = splitFileLines(target.source);
      return renderFileSlice(
        posixPath,
        lines,
        { startLine, endLine },
        context.resultBudgetChars,
        target.kind,
      );
    },
  );
};

/** Ledger 登记种类：指定任一边界即区间读取（range），否则整读（file） */
function fileReadLedgerKind(
  startLine: number | undefined,
  endLine: number | undefined,
): "range" | "file" {
  return startLine !== undefined || endLine !== undefined ? "range" : "file";
}

/** 规范化请求标识：路径 + 请求区间（缺省边界显式化；键取请求而非实际返回内容） */
function fileReadLedgerDescription(
  posixPath: string,
  startLine: number | undefined,
  endLine: number | undefined,
): string {
  if (startLine === undefined && endLine === undefined) {
    return `review.get_file ${posixPath}`;
  }
  const start = startLine ?? 1;
  const end = endLine ?? "end";
  return `review.get_file ${posixPath}:${start}-${end}`;
}

/** 读取来源：仓库快照 / 规则 Skill 包根 */
interface SourceText {
  readonly kind: "repo" | "skill";
  readonly source: string;
}

/**
 * 按请求决定读哪里：
 * - `skill://` 强制读包；
 * - 普通路径先读仓库；仓库缺失且存在 skillPackRoot 时回退包根（主会话无 packRoot，
 *   错误文本与既有逐字节一致）。
 */
async function resolveSource(
  context: ToolRunContext,
  posixPath: string,
  forcedSkill: boolean,
): Promise<SourceText> {
  const packRoot = context.skillPackRoot;
  if (forcedSkill) {
    return { kind: "skill", source: await readSkillSourceSafe(packRoot!, posixPath) };
  }
  try {
    const repo = await context.repo();
    return { kind: "repo", source: await readSourceSafe(repo, posixPath) };
  } catch (error) {
    if (packRoot === undefined) {
      throw error;
    }
    try {
      return { kind: "skill", source: await readSkillSourceSafe(packRoot, posixPath) };
    } catch {
      throw new Error(
        `review.get_file: file "${posixPath}" cannot be read from the repository snapshot or skill pack (not found or unreadable)`,
      );
    }
  }
}

/** 读取 + 边界守卫：仓库根外或缺失/不可读一律归为有界错误（不泄漏绝对路径） */
async function readSourceSafe(repo: RepoContext, posixPath: string): Promise<string> {
  const absolute = path.resolve(repo.repoPath, ...posixPath.split("/"));
  const root = path.resolve(repo.repoPath);
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`review.get_file: path "${posixPath}" must stay inside the repository snapshot`);
  }
  try {
    return await repo.readSource(posixPath);
  } catch {
    throw new Error(
      `review.get_file: file "${posixPath}" cannot be read from the repository snapshot (not found or unreadable)`,
    );
  }
}

/** 读取 skill 包内文件：路径 jail 在 pack 根；错误不泄漏宿主绝对路径 */
async function readSkillSourceSafe(packRoot: string, posixPath: string): Promise<string> {
  const root = path.resolve(packRoot);
  const absolute = path.resolve(root, ...posixPath.split("/"));
  if (absolute !== root && !absolute.startsWith(`${root}${path.sep}`)) {
    throw new Error(`review.get_file: path "${posixPath}" must stay inside the skill pack`);
  }
  try {
    return await readUtf8Tolerant(absolute);
  } catch {
    throw new Error(
      `review.get_file: skill file "${posixPath}" cannot be read from the skill pack (not found or unreadable)`,
    );
  }
}

/** 行拆分（文件尾换行不产生伪行；空文件为 0 行） */
function splitFileLines(source: string): readonly string[] {
  if (source.length === 0) {
    return [];
  }
  const body = source.endsWith("\n") ? source.slice(0, -1) : source;
  return body.split("\n");
}

interface FileSlice {
  readonly startLine: number | undefined;
  readonly endLine: number | undefined;
}

function renderFileSlice(
  posixPath: string,
  lines: readonly string[],
  slice: FileSlice,
  budgetChars: number,
  kind: "repo" | "skill",
): string {
  const label = kind === "skill" ? "Skill file" : "File";
  const totalLines = lines.length;
  if (totalLines === 0) {
    return [`${label}: ${posixPath}`, "Lines 0-0 of 0 (empty file)"].join("\n");
  }
  const requestedStart = slice.startLine ?? 1;
  if (requestedStart > totalLines) {
    throw new Error(
      `review.get_file: requested start line ${requestedStart} is beyond end of file "${posixPath}" (${totalLines} lines)`,
    );
  }
  const clampedEnd =
    slice.endLine !== undefined && slice.endLine > totalLines ? totalLines : (slice.endLine ?? totalLines);
  const clampedNote =
    slice.endLine !== undefined && slice.endLine > totalLines
      ? ` (requested end line ${slice.endLine} clamped to end of file)`
      : "";

  const selected = lines.slice(requestedStart - 1, clampedEnd);
  const header = [
    `${label}: ${posixPath}`,
    `Lines ${requestedStart}-${clampedEnd} of ${totalLines}${clampedNote}`,
  ];
  const numbered = numberLines(selected, requestedStart);
  const budget = applyLineBudget(
    [...header, ...numbered],
    budgetChars,
    (shown, total) =>
      `Tool result truncated: showing ${shown} of ${total} result lines (tool result budget ${budgetChars} chars exceeded); request a narrower range with startLine/endLine.`,
  );
  return budget.lines.join("\n");
}

/** 行号右对齐前缀（宽度按展示区间内最大行号） */
function numberLines(lines: readonly string[], firstLineNumber: number): readonly string[] {
  const width = String(firstLineNumber + lines.length - 1).length;
  return lines.map((line, index) => {
    const lineNumber = String(firstLineNumber + index).padStart(width, " ");
    return `${lineNumber} | ${line}`;
  });
}
