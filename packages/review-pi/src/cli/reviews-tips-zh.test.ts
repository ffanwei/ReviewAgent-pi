import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import {
  EXEC_DIR_TIPS_FILENAMES,
  REVIEW_RESULT_FILENAME,
  REVIEWS_TIPS_ZH_FILENAME,
  removeExecDirTipsCopies,
  writeExecDirTipsCopies,
} from "./reviews-tips-zh.js";

/**
 * 执行目录副本单测（ADR-0017 决策 14 / ADR-0027）：同一份分组意见另存到
 * 进程 cwd，**只用**下游约定名 `review-result.json`（真源永远是 run 目录里的
 * `rep-<N>/reviews_tips_zh.json`）。
 *
 * 锁定面：
 * - 只写一个名字（cwd 里两个同内容文件只会让人猜哪个权威）；
 * - 内容与 run 目录那份逐字节相同（2 空格缩进 + 尾换行）；
 * - **永不抛错**：写失败只进 problems；
 * - 清理带走本次名字 + 旧版本写过的原名副本；不存在不算问题（零噪声）；
 * - 不改 cwd、不建目录（execDir 由调用方给出）。
 */

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

const DOCUMENT = {
  files: [
    {
      filePath: "src/Main.java",
      reviewTips: [
        {
          code: "int x = y;",
          review: "此处可能为空。",
          suggestion: "改为先判空。",
          category: "CORRECTNESS",
          subcategory: "",
          severity: "Minor" as const,
          ruleId: "",
          lineNum: 42,
          source: "common-reviewer" as const,
          confidence: "Medium" as const,
        },
      ],
    },
  ],
};

test("只写 review-result.json：内容带尾换行，不再写原名副本", async () => {
  const dir = makeTempDir("review-tips-copies-");
  const outcome = await writeExecDirTipsCopies(DOCUMENT, dir);

  expect(outcome.problems).toEqual([]);
  expect(outcome.touched).toEqual([path.join(dir, REVIEW_RESULT_FILENAME)]);
  const text = readFileSync(path.join(dir, REVIEW_RESULT_FILENAME), "utf8");
  expect(text.endsWith("\n")).toBe(true);
  expect(JSON.parse(text)).toEqual(DOCUMENT);
  expect(existsSync(path.join(dir, REVIEWS_TIPS_ZH_FILENAME))).toBe(false);
});

test("文件名族就是这一个（ADR-0027：cwd 只保留 review-result.json）", () => {
  expect(EXEC_DIR_TIPS_FILENAMES).toEqual(["review-result.json"]);
});

test("写失败不抛错：失败进 problems", async () => {
  const dir = makeTempDir("review-tips-copies-blocked-");
  // 目标名预占成目录 ⇒ writeFile 失败（EISDIR / EPERM）
  await mkdir(path.join(dir, REVIEW_RESULT_FILENAME), { recursive: true });

  const outcome = await writeExecDirTipsCopies(DOCUMENT, dir);

  expect(outcome.touched).toEqual([]);
  expect(outcome.problems).toHaveLength(1);
  expect(outcome.problems[0]).toContain(REVIEW_RESULT_FILENAME);
});

test("目标目录不存在 ⇒ 不抛错、不进 touched（绝不凭空建目录）", async () => {
  const missing = path.join(makeTempDir("review-tips-copies-missing-"), "nope", "deeper");
  const outcome = await writeExecDirTipsCopies(DOCUMENT, missing);
  expect(outcome.touched).toEqual([]);
  expect(outcome.problems).toHaveLength(1);
});

test("清理：本次名字与旧版本原名副本都删（不留会冒充本次的陈旧文件）", async () => {
  const dir = makeTempDir("review-tips-clean-");
  await writeExecDirTipsCopies(DOCUMENT, dir);
  writeFileSync(path.join(dir, REVIEWS_TIPS_ZH_FILENAME), "{}\n", "utf8");

  const outcome = await removeExecDirTipsCopies(dir);

  expect(outcome.problems).toEqual([]);
  expect(outcome.touched).toEqual([
    path.join(dir, REVIEWS_TIPS_ZH_FILENAME),
    path.join(dir, REVIEW_RESULT_FILENAME),
  ]);
  expect(existsSync(path.join(dir, REVIEW_RESULT_FILENAME))).toBe(false);
  expect(existsSync(path.join(dir, REVIEWS_TIPS_ZH_FILENAME))).toBe(false);
});

test("清理：不存在不算问题（零噪声），也不进 touched", async () => {
  const dir = makeTempDir("review-tips-clean-empty-");
  writeFileSync(path.join(dir, "unrelated.txt"), "keep me\n", "utf8");

  const outcome = await removeExecDirTipsCopies(dir);

  expect(outcome).toEqual({ touched: [], problems: [] });
  // 只动这两个名字，绝不扫别的文件
  expect(readFileSync(path.join(dir, "unrelated.txt"), "utf8")).toBe("keep me\n");
});
