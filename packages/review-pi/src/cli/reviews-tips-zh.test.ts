import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
 * 执行目录副本单测（ADR-0017 决策 14）：同一份分组意见另存到进程 cwd，
 * 同时用原名 `reviews_tips_zh.json` 与下游约定名 `review-result.json`。
 *
 * 锁定面：
 * - 双写且内容逐字节相同（2 空格缩进 + 尾换行）；
 * - **永不抛错**：单份写失败只进 problems（另一份照写）；
 * - 清理删两份、不存在不算问题（零噪声），删除失败进 problems；
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

test("双写：原名 + review-result.json，内容逐字节相同且带尾换行", async () => {
  const dir = makeTempDir("review-tips-copies-");
  const outcome = await writeExecDirTipsCopies(DOCUMENT, dir);

  expect(outcome.problems).toEqual([]);
  expect(outcome.touched).toEqual([
    path.join(dir, REVIEWS_TIPS_ZH_FILENAME),
    path.join(dir, REVIEW_RESULT_FILENAME),
  ]);
  const original = readFileSync(path.join(dir, REVIEWS_TIPS_ZH_FILENAME), "utf8");
  const alias = readFileSync(path.join(dir, REVIEW_RESULT_FILENAME), "utf8");
  expect(alias).toBe(original);
  expect(original.endsWith("\n")).toBe(true);
  expect(JSON.parse(original)).toEqual(DOCUMENT);
});

test("文件名族就是这两个（下游按 review-result.json 读，改名即破坏契约）", () => {
  expect(EXEC_DIR_TIPS_FILENAMES).toEqual(["reviews_tips_zh.json", "review-result.json"]);
});

test("单份写失败不抛错：另一份照写，失败进 problems", async () => {
  const dir = makeTempDir("review-tips-copies-partial-");
  // 把第一个目标名预占成目录 ⇒ writeFile 失败（EISDIR / EPERM）
  const blocked = path.join(dir, REVIEWS_TIPS_ZH_FILENAME);
  await mkdir(blocked, { recursive: true });

  const outcome = await writeExecDirTipsCopies(DOCUMENT, dir);

  expect(outcome.touched).toEqual([path.join(dir, REVIEW_RESULT_FILENAME)]);
  expect(outcome.problems).toHaveLength(1);
  expect(outcome.problems[0]).toContain(REVIEWS_TIPS_ZH_FILENAME);
  // 约定名仍然可用（下游读得到）
  expect(JSON.parse(readFileSync(path.join(dir, REVIEW_RESULT_FILENAME), "utf8"))).toEqual(DOCUMENT);
});

test("目标目录不存在 ⇒ 不抛错、不进 touched（绝不凭空建目录）", async () => {
  const missing = path.join(makeTempDir("review-tips-copies-missing-"), "nope", "deeper");
  const outcome = await writeExecDirTipsCopies(DOCUMENT, missing);
  expect(outcome.touched).toEqual([]);
  expect(outcome.problems).toHaveLength(2);
});

test("清理：两份都在 ⇒ 都删并返回路径", async () => {
  const dir = makeTempDir("review-tips-clean-");
  await writeExecDirTipsCopies(DOCUMENT, dir);

  const outcome = await removeExecDirTipsCopies(dir);

  expect(outcome.problems).toEqual([]);
  expect(outcome.touched).toEqual([
    path.join(dir, REVIEWS_TIPS_ZH_FILENAME),
    path.join(dir, REVIEW_RESULT_FILENAME),
  ]);
});

test("清理：不存在不算问题（零噪声），也不进 touched", async () => {
  const dir = makeTempDir("review-tips-clean-empty-");
  writeFileSync(path.join(dir, "unrelated.txt"), "keep me\n", "utf8");

  const outcome = await removeExecDirTipsCopies(dir);

  expect(outcome).toEqual({ touched: [], problems: [] });
  // 只动这两个名字，绝不扫别的文件
  expect(readFileSync(path.join(dir, "unrelated.txt"), "utf8")).toBe("keep me\n");
});
