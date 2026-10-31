import type { MrBoundaryRecord, MrBoundaryReason } from "../contracts/run.js";

// MR 边界护栏（#12 生产化四必做之一，P4/P5 窗口并行票）：验证域边界
// ≤10 文件 / diff ≤2K 变更行（《基于 Pi 内核的 Review Agent 总体架构
// 设计方案》§7.7；曾与 root 数据集门同口径，该门已随 ADR-0024 删除）。
//
// 定位（《Config B 生产化方案》§3.1 钦定 v1：护栏 + 显式标注，v2 切分另立项）：
// - 位置无关配置：在内核入口处统一生效，不绑任何配置维度（ADR-0024 后只有
//   唯一形态，本护栏即在 runReview 最前）；
// - 不触碰请求字节面：纯度量 + 结果尾键标注，边界内 MR 与无护栏时逐字节
//   一致（domainWarning / mrBoundary 全部「缺席省键」）；
// - 超界不拒检：照常执行（截断纪律兜底）+ 零静默——RunResult 顶层
//   domainWarning 与审计文件尾部 mrBoundary（度量值 + 降级决策）留痕。
//
// 度量口径（自含单源；曾与 root 数据集门 measureDiffBoundary / checkBoundary
// 同构，该门已随 ADR-0024 删除）：
// - files = diff 触碰的文件数（含新增 / 删除文件）；
// - changedLines = 新增行 + 删除行（不含 context 行与文件头 / hunk 头）。
// 内核包不反向依赖 root——此处自含轻量行级状态机：以 hunk 头声明的
// old / new 计数驱动体行游走（同 root parseHunkBody 语义），从根上区分
// 「`+++ `/`--- ` 文件头」与「`+`/`-` 前缀的增删行」（hunk 体内 `--- x` /
// `+++ x` 是增删行而非文件头——前缀歧义由计数游走消解）。口径对齐由
// mr-boundary-guard.test.ts 以锁定数值断言（golden diff / 边界值 / 歧义
// 前缀 / malformed 家族）。
//
// malformed 取舍（保守口径）：不能证明界内 = 显式降级。轻量计数器只接受
// 结构可完整游走的 unified diff；结构不可游走（空串 / 乱码 / 截断 hunk /
// 体行数超出声明 / hunk 体内出现结构行 / 纯重命名 / 二进制标记 / 文件块
// 无 hunk）一律「不可度量」→ boundary-unmeasurable 降级 + 照常执行，
// 不拒检——零静默，同时不误伤格式怪异但内容有效的 diff（真正 malformed
// 的过滤是 root 数据集门（mr-boundary-filter）的职责，内核只兜底降级
// 标注、不重复审判）。已知与 root 全量解析器的有意分歧：不校验路径
// 非空 / hunk 重叠 / no-newline 标记位置（不影响计数的语义面）——此类
// diff 若真进数据集会被 root 门拒收，护栏侧的宽松只影响「是否多打一条
// 降级标注」，不影响任何执行行为。

/** 验证域边界（§7.7 / 生产化方案 §3.1 钉死的产品常量，不参数化） */
export const MR_BOUNDARY_LIMITS = Object.freeze({ maxFiles: 10, maxDiffLines: 2000 });

/** 域外警示文案（生产化方案 §3.1 原文——消费端据此降级呈现） */
export const DOMAIN_WARNING_OUT_OF_BOUNDARY = "out-of-validated-domain (files>10 or diff>2K)";

/** 不可度量警示文案（保守口径：不能证明界内 = 按降级口径检视） */
export const DOMAIN_WARNING_UNMEASURABLE =
  "out-of-validated-domain (boundary-unmeasurable: diff is not a countable unified diff)";

/** MR 边界度量值（口径同构 root BoundaryMetrics 的判界面——totalDiffLines 非判界项不冗余） */
export interface MrBoundaryMetrics {
  readonly files: number;
  readonly addedLines: number;
  readonly removedLines: number;
  readonly changedLines: number;
}

/**
 * 护栏判定：界内 = degraded:false（护栏零介入，无任何附加键）；
 * 降级 = degraded:true + domainWarning（进 RunResult 顶层）+
 * mrBoundary（进审计文件尾键）。布尔字面量判别式，缺席省键纪律下
 * 调用方以条件展开落键。
 */
export type MrBoundaryDecision =
  | { readonly degraded: false }
  | {
      readonly degraded: true;
      readonly domainWarning: string;
      readonly mrBoundary: MrBoundaryRecord;
    };

/**
 * 度量 MR 边界指标（纯函数，零 IO）。不可度量返回 null（保守口径：
 * 结构不可完整游走即不可证明界内，由 guardMrBoundary 转为显式降级）。
 */
export function measureMrBoundary(diff: string): MrBoundaryMetrics | null {
  if (typeof diff !== "string" || diff.trim() === "") {
    return null;
  }
  const lines = splitDiffLines(diff);
  let files = 0;
  let added = 0;
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line === undefined) {
      return null;
    }
    if (isGitHeaderNoise(line)) {
      i += 1;
      continue;
    }
    if (isUnsupportedMarker(line) || !line.startsWith("--- ")) {
      // 顶层只允许 git 头噪音行与 `--- ` 文件头（root 同则：其他行 = 期望文件头失败）
      return null;
    }
    const block = measureFileBlock(lines, i);
    if (block === null) {
      return null;
    }
    files += 1;
    added += block.added;
    removed += block.removed;
    i = block.next;
  }
  if (files === 0) {
    return null;
  }
  return { files, addedLines: added, removedLines: removed, changedLines: added + removed };
}

/** 入口护栏判定：界内零介入；超界 / 不可度量 → 显式降级（照常执行由调用方保证） */
export function guardMrBoundary(diff: string): MrBoundaryDecision {
  const metrics = measureMrBoundary(diff);
  if (metrics === null) {
    return {
      degraded: true,
      domainWarning: DOMAIN_WARNING_UNMEASURABLE,
      mrBoundary: {
        files: null,
        changedLines: null,
        degraded: true,
        reason: "boundary-unmeasurable",
      },
    };
  }
  const reason = boundaryReason(metrics);
  if (reason === null) {
    return { degraded: false };
  }
  return {
    degraded: true,
    domainWarning: DOMAIN_WARNING_OUT_OF_BOUNDARY,
    mrBoundary: {
      files: metrics.files,
      changedLines: metrics.changedLines,
      degraded: true,
      reason,
    },
  };
}

/** 判界（顺序同 root checkBoundary：先文件数后行数）；界内返回 null */
function boundaryReason(metrics: MrBoundaryMetrics): MrBoundaryReason | null {
  if (metrics.files > MR_BOUNDARY_LIMITS.maxFiles) {
    return "too-many-files";
  }
  if (metrics.changedLines > MR_BOUNDARY_LIMITS.maxDiffLines) {
    return "diff-too-large";
  }
  return null;
}

function splitDiffLines(text: string): string[] {
  const lines = text.split(/\r?\n/);
  if (lines.at(-1) === "") {
    lines.pop();
  }
  return lines;
}

/** git 头噪音行（root skipGitHeader 同集：diff --git / Index: / index / mode / similarity） */
function isGitHeaderNoise(line: string): boolean {
  return (
    line.startsWith("diff --git") ||
    line.startsWith("Index:") ||
    line.startsWith("index ") ||
    line.startsWith("new file mode") ||
    line.startsWith("deleted file mode") ||
    line.startsWith("old mode") ||
    line.startsWith("new mode") ||
    line.startsWith("similarity index")
  );
}

/** root 全量解析器显式报错的标记（二进制 / 纯重命名）——同向不可度量 */
function isUnsupportedMarker(line: string): boolean {
  return (
    line.startsWith("rename from") ||
    line.startsWith("rename to") ||
    line.startsWith("Binary files") ||
    line.startsWith("GIT binary patch")
  );
}

/** 度量一个 `--- `/`+++ ` 文件块（含其全部 hunk）；结构不可游走返回 null */
function measureFileBlock(
  lines: readonly string[],
  start: number,
): { readonly next: number; readonly added: number; readonly removed: number } | null {
  const plusLine = lines[start + 1];
  if (plusLine === undefined || !plusLine.startsWith("+++ ")) {
    return null;
  }
  let i = start + 2;
  let added = 0;
  let removed = 0;
  let hunks = 0;
  while (i < lines.length && lines[i]?.startsWith("@@ ") === true) {
    const hunk = measureHunk(lines, i);
    if (hunk === null) {
      return null;
    }
    added += hunk.added;
    removed += hunk.removed;
    i = hunk.next;
    hunks += 1;
  }
  if (hunks === 0) {
    // root 同则：文件块不含任何 hunk = 解析失败
    return null;
  }
  return { next: i, added, removed };
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const NO_NEWLINE_MARKER = "\\ No newline at end of file";

/** 度量一个 hunk：按头部声明的 old/new 计数游走体行（歧义前缀由此消解） */
function measureHunk(
  lines: readonly string[],
  start: number,
): { readonly next: number; readonly added: number; readonly removed: number } | null {
  const header = parseHunkHeader(lines[start] ?? "");
  if (header === null) {
    return null;
  }
  let oldNeed = header.oldCount;
  let newNeed = header.newCount;
  let added = 0;
  let removed = 0;
  let i = start + 1;
  while (oldNeed > 0 || newNeed > 0) {
    const line = lines[i];
    if (line === undefined) {
      // 截断的 hunk：体行数不足头部声明
      return null;
    }
    if (line === NO_NEWLINE_MARKER) {
      i += 1;
      continue;
    }
    if (line.startsWith(" ")) {
      oldNeed -= 1;
      newNeed -= 1;
    } else if (line.startsWith("-")) {
      oldNeed -= 1;
      removed += 1;
    } else if (line.startsWith("+")) {
      newNeed -= 1;
      added += 1;
    } else {
      // 计数耗尽前出现结构行（@@ / --- / diff --git）或不可识别行
      return null;
    }
    if (oldNeed < 0 || newNeed < 0) {
      // 体行数超出头部声明
      return null;
    }
    i += 1;
  }
  while (i < lines.length && lines[i] === NO_NEWLINE_MARKER) {
    i += 1;
  }
  return { next: i, added, removed };
}

/** hunk 头解析（root 同则：省略计数默认 1；count>0 时 start≥1） */
function parseHunkHeader(line: string): { readonly oldCount: number; readonly newCount: number } | null {
  const match = HUNK_HEADER_RE.exec(line);
  if (match === null) {
    return null;
  }
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if ((oldCount > 0 && oldStart < 1) || (newCount > 0 && newStart < 1)) {
    return null;
  }
  return { oldCount, newCount };
}
