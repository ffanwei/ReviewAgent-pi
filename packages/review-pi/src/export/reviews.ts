import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { Finding } from "../contracts/finding.js";

// 检视意见导出（ADR-0013 / ADR-0090）：把 Finding 清单落成明确给下游读的
// 产物——`reviews_all.json` 是全部意见的真源口径（中文自然语言 + 结构化
// 英文字段），恒产。中文交付物另有分组意见 `reviews_tips_zh.json`。
//
// 纪律：
// - 信封（非裸数组）：`{ generatedAt, runId, source, caseId, rep, model,
//   findings }`——provenance 显式，不靠路径推断；
// - `findings` = 完整 `Finding` 对象，**保序**（与 `record.baseline.findings`
//   同序深相等）；
// - 按 `rep` **覆盖重写**（与转录"每 run 独立留档"相反）；
// - JSON 纪律同既有产物：2 空格缩进 + 尾换行；失败显式抛错。

export const REVIEWS_ALL_FILENAME = "reviews_all.json";
/** @deprecated 历史名（ADR-0090 前的英文真源口径）；保留 re-export 供迁移 */
export const REVIEWS_EN_FILENAME = REVIEWS_ALL_FILENAME;

export interface ReviewsEnvelope {
  readonly generatedAt: string;
  readonly runId: string;
  readonly source: string;
  readonly caseId: string;
  readonly rep: number;
  readonly model: string;
  readonly findings: readonly Finding[];
}

export interface BuildReviewsInput {
  readonly runId: string;
  readonly source: string;
  readonly caseId: string;
  readonly rep: number;
  readonly model: string;
  readonly findings: readonly Finding[];
  readonly generatedAt: Date;
}

export function buildReviewsExport(input: BuildReviewsInput): ReviewsEnvelope {
  return {
    generatedAt: input.generatedAt.toISOString(),
    runId: input.runId,
    source: input.source,
    caseId: input.caseId,
    rep: input.rep,
    model: input.model,
    findings: input.findings,
  };
}

/** 落盘 `reviews_all.json`（`<dir>/reviews_all.json`，覆盖重写）；失败显式抛错 */
export async function writeReviewsAll(dir: string, envelope: ReviewsEnvelope): Promise<string> {
  return writeReviewsFile(dir, REVIEWS_ALL_FILENAME, envelope);
}

/** @deprecated 历史名（ADR-0090）；转发到 writeReviewsAll */
export async function writeReviewsEn(dir: string, envelope: ReviewsEnvelope): Promise<string> {
  return writeReviewsAll(dir, envelope);
}

async function writeReviewsFile(
  dir: string,
  fileName: string,
  envelope: ReviewsEnvelope,
): Promise<string> {
  const resolved = path.resolve(dir);
  const filePath = path.join(resolved, fileName);
  try {
    await mkdir(resolved, { recursive: true });
    await writeFile(filePath, `${JSON.stringify(envelope, null, 2)}\n`, "utf8");
    return filePath;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(
      `failed to persist review export ${envelope.caseId}/rep-${envelope.rep}/${fileName}: ${message}`,
      { cause: error },
    );
  }
}
