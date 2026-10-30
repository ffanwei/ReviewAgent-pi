import { rm } from "node:fs/promises";
import path from "node:path";

/**
 * 中文导出的**残留清理**（ADR-0022：`reviews_zh.json` 已不再是交付物）。
 *
 * 历史：ADR-0013 Step B 曾在核外（CLI 呈现缝）把投影结果落盘成 `reviews_zh.json`
 * ——与 `reviews_en.json` 同目录、同 rep，带投影留痕三键。ADR-0022 判定「中文
 * 交付物 = `reviews_tips_zh.json` 一份即可」，于是**不再写**这个文件。
 *
 * 保留本模块的唯一职责：**清掉旧版本留下的 `reviews_zh.json`**，使「磁盘上的
 * 中文产物 = 本次 run」成立。只动调用方给出的**本次 run 的 `rep-<N>/`** 目录
 * ——绝不跨 rep；文件不存在即无操作（零噪声）。投影本身照旧服务 stdout 与
 * `reviews_tips_zh.json`（同一次投影，不额外调网关）。
 */

/** 已停产的中文导出文件名（只用于陈旧清理） */
export const REVIEWS_ZH_FILENAME = "reviews_zh.json";

/**
 * 删除同目录陈旧的 `reviews_zh.json`。返回被删路径；不存在则 `undefined`；
 * 其余删除失败抛错（与其它产物同档：IO 失败是运行失败）。
 */
export async function removeStaleReviewsZh(dir: string): Promise<string | undefined> {
  const resolved = path.resolve(dir);
  const filePath = path.join(resolved, REVIEWS_ZH_FILENAME);
  try {
    await rm(filePath);
    return filePath;
  } catch (error) {
    if (isNotFound(error)) {
      return undefined;
    }
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`failed to remove stale review export ${filePath}: ${message}`, {
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
