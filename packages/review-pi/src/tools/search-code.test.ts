import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { loadRepoContext } from "../analysis/repo-context.js";
import { DEFAULT_REVIEW_RUNTIME, type ReviewRuntime } from "../shared/review-runtime.js";
import { repoFixturePath } from "../testing/repos.js";
import { buildReviewToolkit } from "./toolkit.js";

// review.search_code（ADR-0098）：字面/正则、大小写、glob、上限、预算、Ledger、
// 失败语义与确定性。输出断言用 toContain（避免平台换行/空白差异）。

const SAMPLE = repoFixturePath("sample");

function toolkit(options?: {
  readonly repoPath?: string;
  readonly ledgerMode?: "enabled" | "inert";
  readonly resultBudgetChars?: number;
  readonly runtime?: ReviewRuntime;
  readonly repo?: Awaited<ReturnType<typeof loadRepoContext>>;
}) {
  return buildReviewToolkit({
    repoPath: options?.repoPath ?? SAMPLE,
    diff: "",
    ...(options?.ledgerMode !== undefined ? { ledgerMode: options.ledgerMode } : {}),
    ...(options?.resultBudgetChars !== undefined
      ? { resultBudgetChars: options.resultBudgetChars }
      : {}),
    ...(options?.runtime !== undefined ? { runtime: options.runtime } : {}),
    ...(options?.repo !== undefined ? { repo: options.repo } : {}),
  });
}

const tempDirs: string[] = [];

afterAll(() => {
  for (const dir of tempDirs) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("字面检索：默认不区分大小写，结果按文件与行号排序并带行号", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.search_code", { query: "getBase" });
  expect(result).toContain('Search "getBase" (literal, case-insensitive): 2 match(es) in 2 file(s)');
  expect(result).toContain("src/main/java/com/example/Alpha.java:11:");
  expect(result).toContain("src/main/java/com/example/Beta.java:6:");
  expect(result.indexOf("Alpha.java:11")).toBeLessThan(result.indexOf("Beta.java:6"));

  const upper = await tk.executeTool("review.search_code", { query: "GETBASE" });
  expect(upper).toContain("2 match(es) in 2 file(s)");
});

test("caseSensitive：区分大小写后零命中", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.search_code", {
    query: "GETBASE",
    caseSensitive: true,
  });
  expect(result).toBe('Search "GETBASE" (literal, case-sensitive): no matches.');
});

test("regex：按 ripgrep 默认引擎解释并收窄命中", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.search_code", {
    query: "getBase\\(\\)\\s*\\{",
    regex: true,
  });
  expect(result).toContain('Search "getBase\\(\\)\\s*\\{" (regex, case-insensitive): 1 match(es) in 1 file(s)');
  expect(result).toContain("Alpha.java:11:");
  expect(result).not.toContain("Beta.java");
});

test("glob：正向包含与 ! 负向排除；头部回显排序后的 glob", async () => {
  const tk = toolkit();
  const onlyAlpha = await tk.executeTool("review.search_code", {
    query: "getBase",
    glob: ["src/**/Alpha.java"],
  });
  expect(onlyAlpha).toContain("Alpha.java:11:");
  expect(onlyAlpha).not.toContain("Beta.java");

  const withoutBeta = await tk.executeTool("review.search_code", {
    query: "getBase",
    glob: ["**/*.java", "!**/Beta.java"],
  });
  expect(withoutBeta).toContain("Alpha.java:11:");
  // 头部会回显负向 glob 本身，所以只断言没有 Beta 的命中行
  expect(withoutBeta).not.toMatch(/Beta\.java:\d+:/);
  // 负向 glob 排序在前（"!" < "*"），头部按排序后的形态回显
  expect(withoutBeta).toContain('glob [!**/Beta.java, **/*.java]');
});

test("glob 校验：拒绝 .. 与绝对路径", async () => {
  const tk = toolkit();
  await expect(
    tk.executeTool("review.search_code", { query: "x", glob: ["src/../x"] }),
  ).rejects.toThrow(/must not contain "\.\."/);
  await expect(
    tk.executeTool("review.search_code", { query: "x", glob: ["/etc/**"] }),
  ).rejects.toThrow(/must be repository-relative/);
  await expect(
    tk.executeTool("review.search_code", { query: "x", glob: ["C:\\repo\\**"] }),
  ).rejects.toThrow(/must be repository-relative/);
});

test("零命中：固定文案", async () => {
  const tk = toolkit();
  await expect(
    tk.executeTool("review.search_code", { query: "no-such-token-xyz" }),
  ).resolves.toBe('Search "no-such-token-xyz" (literal, case-insensitive): no matches.');
});

test("limit：截断提示显式留痕", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.search_code", { query: "return", limit: 2 });
  expect(result).toContain("2 match(es) in 1 file(s)");
  expect(result).toContain("Match limit 2 reached; refine the query or add a glob.");
});

test("每文件上限：20 条封顶并报告被封顶文件数", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "search-code-cap-"));
  tempDirs.push(dir);
  writeFileSync(
    path.join(dir, "a.txt"),
    `${Array.from({ length: 25 }, (_, index) => `needle ${String(index)}`).join("\n")}\n`,
    "utf8",
  );
  writeFileSync(path.join(dir, "b.txt"), "needle once\n", "utf8");
  const tk = toolkit({ repoPath: dir });
  const result = await tk.executeTool("review.search_code", { query: "needle" });
  expect(result).toContain("21 match(es) in 2 file(s)");
  expect(result).toContain("Per-file limit 20 reached in 1 file(s); some matches omitted.");
});

test("结果预算：超预算截断并留痕", async () => {
  const tk = toolkit({ resultBudgetChars: 60 });
  const result = await tk.executeTool("review.search_code", { query: "return" });
  expect(result).toContain("Tool result truncated: showing");
  expect(result).toContain("chars exceeded");
});

test("Ledger：同一查询第二次返回引用，不同标志是不同条目", async () => {
  const tk = toolkit({ ledgerMode: "enabled" });
  await tk.executeTool("review.search_code", { query: "getBase" });
  await expect(tk.executeTool("review.search_code", { query: "getBase" })).resolves.toBe(
    'Already loaded: ctx#001 (review.search_code "getBase" [literal, case-insensitive])',
  );
  const withGlob = await tk.executeTool("review.search_code", {
    query: "getBase",
    glob: ["**/*.java"],
  });
  expect(withGlob).toContain("2 match(es)");
  expect(tk.ledger.snapshot()).toHaveLength(2);
});

test("入参校验：空 query / 非布尔 / 非整数 limit / 超上限", async () => {
  const tk = toolkit();
  await expect(tk.executeTool("review.search_code", { query: "   " })).rejects.toThrow(
    /must be a non-empty string/,
  );
  await expect(
    tk.executeTool("review.search_code", { query: "x", regex: "yes" }),
  ).rejects.toThrow(/must be a boolean/);
  await expect(
    tk.executeTool("review.search_code", { query: "x", limit: 1.5 }),
  ).rejects.toThrow(/positive integer/);
  await expect(
    tk.executeTool("review.search_code", { query: "x", limit: 201 }),
  ).rejects.toThrow(/must be <= 200/);
});

test("非法正则：有界错误文本（rg exit 2）", async () => {
  const tk = toolkit();
  await expect(
    tk.executeTool("review.search_code", { query: "(", regex: true }),
  ).rejects.toThrow(/^review\.search_code: /);
});

test("超时：固定文案并提示收窄查询", async () => {
  const repo = await loadRepoContext(SAMPLE);
  const runtime: ReviewRuntime = {
    ...DEFAULT_REVIEW_RUNTIME,
    limits: {
      ...DEFAULT_REVIEW_RUNTIME.limits,
      timeouts: { ...DEFAULT_REVIEW_RUNTIME.limits.timeouts, ripgrepMs: 1 },
    },
  };
  const tk = toolkit({ repo, runtime });
  await expect(tk.executeTool("review.search_code", { query: "getBase" })).rejects.toThrow(
    /search timed out after 1 ms; narrow the query or add a glob/,
  );
});

test("确定性：同一查询两次调用逐字节相同", async () => {
  const first = await toolkit().executeTool("review.search_code", { query: "return" });
  const second = await toolkit().executeTool("review.search_code", { query: "return" });
  expect(first).toBe(second);
});
