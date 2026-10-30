import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReviewTipsDocumentLike } from "./presentation-projection.js";

/**
 * 分组式检视意见中文导出（ADR-0017）。
 *
 * 核外面（CLI 呈现缝）：`reviews_tips_zh.json` 是核外投影的**第二份落盘副本**
 * ——与 `reviews_zh.json` 同目录、同 rep、同生命周期，内容严格 `{ files }`
 * （无信封：出处由同目录 zh 与路径承担）。本模块只编排「写 / 清」，绝不触碰
 * 请求字节、审计、`RunRecord` 或 Finding 契约。
 *
 * 生命周期（与 zh 同口径）：
 * - 投影成功且 tips 形状合法 ⇒ 写 `reviews_tips_zh.json`；**写失败抛错**
 *   （产物即契约，与 en/zh 同档）；
 * - 未配置引擎 / 投影降级 / tips 形状非法 ⇒ **不产** + 主动删除**本次 run 的
 *   `rep-<N>/`** 里的陈旧文件（绝不跨 rep 越权删除）。
 */

/** 分组意见导出的文件名（与 `reviews_zh.json` 同目录、同 rep） */
export const REVIEWS_TIPS_ZH_FILENAME = "reviews_tips_zh.json";

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
