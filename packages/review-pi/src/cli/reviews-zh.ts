import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import type { ReviewsEnvelope } from "../export/reviews.js";
import type { PresentationProvenance } from "./presentation-projection.js";

/**
 * 检视意见中文导出（ADR-0013 Step B / CONTEXT.md「检视意见导出」）。
 *
 * 核外面（CLI 呈现缝）：`reviews_zh.json` 是**核外翻译投影**的落盘副本——与
 * stdout 呈现档复用**同一次**投影结果（绝不为了写文件再调一次网关）。内核只产
 * 英文字源 `reviews_en.json`（Step A）；本模块只在 CLI 侧编排 zh 的
 * 「写 / 清」生命周期，绝不触碰请求字节、审计或 `RunRecord`。
 *
 * 生命周期（ADR-0010 呈现降级纪律 + ADR-0013 失败语义）：
 * - 投影成功 ⇒ 写 `reviews_zh.json`（信封 = en 信封 + 投影留痕）；**写失败抛错**；
 * - 未配置引擎 / 投影降级 ⇒ **不产** + 主动删除**本次 run 的 `rep-<N>/`** 里的
 *   陈旧 zh（绝不跨 rep 越权删除），使磁盘与本次 run 一致。
 */

/** 中文导出的文件名（与内核 `reviews_en.json` 同目录、同 rep） */
export const REVIEWS_ZH_FILENAME = "reviews_zh.json";

/**
 * 中文导出信封 = `reviews_en.json` 信封 + 投影留痕三键（ADR-0010：
 * `language` / `terminologyVersion` / `findingLinks`；不出现 `degraded`——
 * 降级不产文件，故降级标注永不落盘）。
 */
export interface ReviewsZhEnvelope extends ReviewsEnvelope {
  readonly language: string;
  readonly terminologyVersion: number;
  readonly findingLinks: PresentationProvenance["findingLinks"];
}

/** 由英文信封 + 投影 provenance 组装中文信封（纯函数，键序：en 键在前，留痕在后） */
export function buildReviewsZhExport(args: {
  readonly envelope: ReviewsEnvelope;
  readonly provenance: PresentationProvenance;
}): ReviewsZhEnvelope {
  return {
    ...args.envelope,
    language: args.provenance.language,
    terminologyVersion: args.provenance.terminologyVersion,
    findingLinks: args.provenance.findingLinks,
  };
}

/**
 * 落盘 `reviews_zh.json`（`<dir>/reviews_zh.json`，覆盖重写；2 空格缩进 +
 * 尾换行）。**写失败抛错**——zh 产物即契约（与 en/session 同档）。
 */
export async function writeReviewsZh(dir: string, envelope: ReviewsZhEnvelope): Promise<string> {
  const resolved = path.resolve(dir);
  const filePath = path.join(resolved, REVIEWS_ZH_FILENAME);
  try {
    await mkdir(resolved, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to persist review export ${envelope.caseId}/${envelope.configId}/rep-${envelope.rep}/${REVIEWS_ZH_FILENAME}: ${message}`,
      { cause: error },
    );
  }
}

/**
 * 删除同目录陈旧 `reviews_zh.json`（本次 run 不产 zh 时使磁盘与本次 run 一致）。
 * 只动调用方给出的**本次 run 的 `rep-<N>/`** 目录——绝不跨 rep。返回被删路径；
 * 不存在则 `undefined`；其余删除失败抛错。
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
