import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReviewTipsDocumentLike } from "./presentation-projection.js";

/**
 * 分组式检视意见中文导出（ADR-0017）。
 *
 * 核外面（CLI 呈现缝）：`reviews_tips_zh.json` 是核外投影的**第二份落盘副本**
 * ——与 `reviews_zh.json` 同目录、同 rep、同生命周期，内容严格 `{ files }`
 * （无信封：出处由同目录 zh 与路径承担）。本模块只编排「写 / 清 / 拷」，绝不
 * 触碰请求字节、审计、`RunRecord` 或 Finding 契约。
 *
 * 生命周期（与 zh 同口径）：
 * - 投影成功且 tips 形状合法 ⇒ 写 `reviews_tips_zh.json`；**写失败抛错**
 *   （产物即契约，与 en/zh 同档）；
 * - 未配置引擎 / 投影降级 / tips 形状非法 ⇒ **不产** + 主动删除**本次 run 的
 *   `rep-<N>/`** 里的陈旧文件（绝不跨 rep 越权删除）。
 *
 * 执行目录副本（ADR-0017 决策 14）：除 run 产物目录外，同一份内容再落到**进程
 * cwd**——两份同名族文件（`reviews_tips_zh.json` 原名 + `review-result.json`
 * 下游约定名）。cwd 属用户目录（可能只读、可能本身是 git 仓库根），故这一路
 * **永不抛错**：失败只进 stderr 警告，检视本身照常成功（exit 0）；本次不产时
 * 两份陈旧副本一并清除。
 */

/** 分组意见导出的文件名（与 `reviews_zh.json` 同目录、同 rep） */
export const REVIEWS_TIPS_ZH_FILENAME = "reviews_tips_zh.json";

/** 执行目录副本的下游约定名（内容与上面的原名副本逐字节相同） */
export const REVIEW_RESULT_FILENAME = "review-result.json";

/** 执行目录副本的两个文件名（同内容双写：原名 + 下游约定名） */
export const EXEC_DIR_TIPS_FILENAMES = [
  REVIEWS_TIPS_ZH_FILENAME,
  REVIEW_RESULT_FILENAME,
] as const;

/** 执行目录副本的写/清结果（失败不抛，收敛成可打印的问题清单） */
export interface ExecDirTipsOutcome {
  /** 已写出/已删除的绝对路径 */
  readonly touched: readonly string[];
  /** 失败项（`<path>: <reason>`；调用方决定是否打到 stderr） */
  readonly problems: readonly string[];
}

/**
 * 落盘 `reviews_tips_zh.json`（`<dir>/reviews_tips_zh.json`，覆盖重写；
 * 2 空格缩进 + 尾换行）。**写失败抛错**——产物即契约。
 */
export async function writeReviewsTipsZh(
  dir: string,
  document: ReviewTipsDocumentLike,
): Promise<string> {
  const resolved = path.resolve(dir);
  const filePath = path.join(resolved, REVIEWS_TIPS_ZH_FILENAME);
  try {
    await mkdir(resolved, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to persist grouped review export ${filePath}: ${message}`,
      { cause: error },
    );
  }
}

/**
 * 删除同目录陈旧 `reviews_tips_zh.json`（本次 run 不产时使磁盘与本次 run 一致）。
 * 只动调用方给出的**本次 run 的 `rep-<N>/`** 目录——绝不跨 rep。返回被删路径；
 * 不存在则 `undefined`；其余删除失败抛错。
 */
export async function removeStaleReviewsTipsZh(dir: string): Promise<string | undefined> {
  const resolved = path.resolve(dir);
  const filePath = path.join(resolved, REVIEWS_TIPS_ZH_FILENAME);
  try {
    await rm(filePath);
    return filePath;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to remove stale grouped review export ${filePath}: ${message}`, {
      cause: error,
    });
  }
}

function isNotFound(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "ENOENT"
  );
}

/**
 * 把分组意见另存到**执行目录**（进程 cwd，ADR-0017 决策 14）：同名双写
 * `reviews_tips_zh.json` + `review-result.json`，内容与 run 产物目录里的那份
 * 逐字节相同（2 空格缩进 + 尾换行）。
 *
 * **永不抛错**：cwd 属用户目录，可能只读、可能落在系统目录；失败项收敛进
 * `problems` 由调用方打 stderr，检视本身照常成功（exit 0）。不 `mkdir`——
 * cwd 必然存在，凭空造目录反而越权。
 */
export async function writeExecDirTipsCopies(
  document: ReviewTipsDocumentLike,
  execDir: string,
): Promise<ExecDirTipsOutcome> {
  const text = `${JSON.stringify(document, null, 2)}\n`;
  const touched: string[] = [];
  const problems: string[] = [];
  for (const name of EXEC_DIR_TIPS_FILENAMES) {
    const filePath = path.resolve(execDir, name);
    try {
      await writeFile(filePath, text, "utf8");
      touched.push(filePath);
    } catch (error) {
      problems.push(`${filePath}: ${errorMessageOf(error)}`);
    }
  }
  return { touched, problems };
}

/**
 * 删除执行目录里的陈旧副本（本次不产 tips 时使「有就是本次的」成立）。
 * 与写入同档：**永不抛错**，删除失败进 `problems`；不存在不算问题、不入
 * `touched`（零噪声）。
 */
export async function removeExecDirTipsCopies(execDir: string): Promise<ExecDirTipsOutcome> {
  const touched: string[] = [];
  const problems: string[] = [];
  for (const name of EXEC_DIR_TIPS_FILENAMES) {
    const filePath = path.resolve(execDir, name);
    try {
      await rm(filePath);
      touched.push(filePath);
    } catch (error) {
      if (!isNotFound(error)) {
        problems.push(`${filePath}: ${errorMessageOf(error)}`);
      }
    }
  }
  return { touched, problems };
}

function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
