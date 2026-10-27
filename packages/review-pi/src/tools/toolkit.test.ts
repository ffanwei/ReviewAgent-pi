import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { expect, test } from "vitest";
import { createContextLedger, createInertContextLedger } from "./ledger.js";
import { DEFAULT_TOOL_RESULT_BUDGET_CHARS } from "./result-budget.js";
import { buildReviewToolkit } from "./toolkit.js";
import { repoFixturePath } from "../testing/repos.js";

// 七工具执行器行为测试（#6 P3a）：sample 合成仓库上验证输出形态、入参校验、
// 预算截断、Ledger 去重与只读纪律。VUL4J-1 真源字节对齐另见
// toolkit-vul4j1.test.ts（skipIf 快照守卫）。

const SAMPLE = repoFixturePath("sample");
const SAMPLE_DIFF = [
  "diff --git a/src/main/java/com/example/Beta.java b/src/main/java/com/example/Beta.java",
  "--- a/src/main/java/com/example/Beta.java",
  "+++ b/src/main/java/com/example/Beta.java",
  "@@ -5,4 +5,4 @@",
  " context",
  "+changed",
].join("\n");

function toolkit(overrides?: { ledgerMode?: "enabled" | "inert"; diff?: string; resultBudgetChars?: number }) {
  return buildReviewToolkit({
    repoPath: SAMPLE,
    diff: overrides?.diff ?? SAMPLE_DIFF,
    ...(overrides?.resultBudgetChars !== undefined
      ? { resultBudgetChars: overrides.resultBudgetChars }
      : {}),
    ...(overrides?.ledgerMode !== undefined ? { ledgerMode: overrides.ledgerMode } : {}),
  });
}

test("get_diff：diff 原文带 header 行返回", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.get_diff", {});
  expect(result).toBe(["MR unified diff:", ...SAMPLE_DIFF.split("\n")].join("\n"));
});

test("get_file：整读带行号前缀；区间读取带 Lines 头", async () => {
  const tk = toolkit();
  const whole = await tk.executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
  });
  const lines = whole.split("\n");
  expect(lines[0]).toBe("File: src/main/java/com/example/Alpha.java");
  expect(lines[1]).toBe("Lines 1-18 of 18");
  expect(lines[2]).toBe(" 1 | package com.example;");
  expect(lines.at(-1)).toMatch(/^18 | \}$/);

  const slice = await tk.executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
    startLine: 11,
    endLine: 13,
  });
  expect(slice.split("\n")).toEqual([
    "File: src/main/java/com/example/Alpha.java",
    "Lines 11-13 of 18",
    "11 |     public int getBase() {",
    "12 |         return base;",
    "13 |     }",
  ]);
});

test("get_file：end 超文件尾 clamp 留痕；start 超尾为显式错误", async () => {
  const tk = toolkit();
  const clamped = await tk.executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
    startLine: 15,
    endLine: 99,
  });
  expect(clamped.split("\n")[1]).toBe(
    "Lines 15-18 of 18 (requested end line 99 clamped to end of file)",
  );
  await expect(
    tk.executeTool("review.get_file", {
      path: "src/main/java/com/example/Alpha.java",
      startLine: 99,
    }),
  ).rejects.toThrow(/requested start line 99 is beyond end of file .*18 lines/);
});

test("get_file：路径逃逸与缺失文件为有界错误（不泄漏绝对路径）", async () => {
  const tk = toolkit();
  await expect(tk.executeTool("review.get_file", { path: "C:/Windows/system32/config" })).rejects.toThrow(
    /must be repository-relative/,
  );
  await expect(tk.executeTool("review.get_file", { path: "/etc/passwd" })).rejects.toThrow(
    /must be repository-relative/,
  );
  await expect(tk.executeTool("review.get_file", { path: "../outside.txt" })).rejects.toThrow(
    /must stay inside the repository snapshot/,
  );
  // 错误消息有界：缺失文件归为统一消息且不含宿主机绝对路径
  const message = await tk
    .executeTool("review.get_file", { path: "no/such/file.java" })
    .then(
      () => "tool unexpectedly succeeded",
      (error: unknown) => (error instanceof Error ? error.message : String(error)),
    );
  expect(message).toBe(
    'review.get_file: file "no/such/file.java" cannot be read from the repository snapshot (not found or unreadable)',
  );
  expect(message).not.toContain(SAMPLE);
  expect(message).not.toMatch(/[A-Za-z]:[\\/]/);
});

test("get_file：startLine > endLine 与非法入参为显式错误", async () => {
  const tk = toolkit();
  await expect(
    tk.executeTool("review.get_file", { path: "a.java", startLine: 5, endLine: 2 }),
  ).rejects.toThrow(/must not exceed/);
  await expect(tk.executeTool("review.get_file", { path: "" })).rejects.toThrow(
    /argument "path" must be a non-empty string/,
  );
  await expect(
    tk.executeTool("review.get_file", { path: "a.java", startLine: 1.5 }),
  ).rejects.toThrow(/argument "startLine" must be a positive integer/);
});

test("get_symbol：sample 仓库命中形态与零命中留痕", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.get_symbol", { symbol: "Alpha" });
  const lines = result.split("\n");
  // 类声明 + 同名构造器各计一次（名字级匹配，不区分种类）
  expect(lines[0]).toBe('Symbol "Alpha": 2 match(es) across 3 Java file(s)');
  expect(lines[1]).toBe("src/main/java/com/example/Alpha.java (package com.example)");
  expect(lines[2]).toBe("  L3 public class Alpha");
  // 成员签名随类型命中附带
  expect(result).toContain("L11 public int getBase()");
  expect(result).toContain("L7 public Alpha(int base)");

  const zero = await tk.executeTool("review.get_symbol", { symbol: "NoSuchSymbol" });
  expect(zero).toBe('Symbol "NoSuchSymbol": 0 match(es) across 3 Java file(s)');
});

test("find_references：声明/使用点形态（与 zoneb 原语同结果）", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.find_references", { symbol: "getBase" });
  expect(result.split("\n")).toEqual([
    'References to "getBase" (name-level whole-word match, no type resolution): 2 match(es) across 2 file(s)',
    "  src/main/java/com/example/Alpha.java:11 [declaration] Alpha.getBase",
    "      public int getBase() {",
    "  src/main/java/com/example/Beta.java:6 [usage] Beta.combine",
    "      int value = alpha.getBase();",
  ]);
});

test("get_call_chain：sample 方法链形态与零命中", async () => {
  const tk = toolkit();
  const result = await tk.executeTool("review.get_call_chain", { symbol: "getBase" });
  expect(result).toContain('Call chain for "getBase" (name-level, up to 2 hops, no type resolution): 1 method declaration(s) matched');
  expect(result).toContain("Alpha.getBase - method at src/main/java/com/example/Alpha.java:11");
  expect(result).toContain("Callers (hop 1):");
  expect(result).toContain("Callees (hop 1):");

  const zero = await tk.executeTool("review.get_call_chain", { symbol: "noSuchMethod" });
  expect(zero).toBe(
    'Call chain for "noSuchMethod" (name-level, up to 2 hops, no type resolution): no method or constructor named "noSuchMethod" found across 3 Java file(s)',
  );
});

test("search_rule/search_history：空语料与命中形态", async () => {
  const tk = toolkit();
  // 空语料（t-series 真源形态：0 entries configured for this run）
  await expect(tk.executeTool("review.search_rule", { query: "autoType" })).resolves.toBe(
    'Rule search "autoType" (case-insensitive substring): rule corpus is empty (0 entries configured for this run)',
  );
  await expect(tk.executeTool("review.search_history", { query: "CVE-2017-18349" })).resolves.toBe(
    'History search "CVE-2017-18349" (case-insensitive substring): history corpus is empty (0 entries configured for this run)',
  );

  // 注入语料后：命中计数 + 条目渲染 + 大小写不敏感
  const withCorpus = buildReviewToolkit({
    repoPath: SAMPLE,
    diff: SAMPLE_DIFF,
    knowledge: {
      rules: [{ id: "R-1", title: "Null handling", text: "Check for null before dereference." }],
      history: [
        { id: "H-1", title: "NPE in Beta", text: "Historical NPE defect in Beta.combine." },
        { id: "H-2", title: "Unrelated", text: "Nothing to see." },
      ],
    },
  });
  await expect(withCorpus.executeTool("review.search_rule", { query: "null" })).resolves.toBe(
    [
      'Rule search "null" (case-insensitive substring): 1 of 1 rule(s) matched',
      "  [R-1] Null handling",
      "    Check for null before dereference.",
    ].join("\n"),
  );
  await expect(withCorpus.executeTool("review.search_history", { query: "npe" })).resolves.toContain(
    'History search "npe" (case-insensitive substring): 1 of 2 history record(s) matched',
  );
});

test("预算：默认 8000 字符；超预算行边界截断并留痕", async () => {
  expect(DEFAULT_TOOL_RESULT_BUDGET_CHARS).toBe(8_000);
  const tk = toolkit({ resultBudgetChars: 100 });
  const result = await tk.executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
  });
  const lines = result.split("\n");
  const notice = lines.at(-1) as string;
  expect(notice).toMatch(
    /^Tool result truncated: showing \d+ of 20 result lines \(tool result budget 100 chars exceeded\); request a narrower range with startLine\/endLine\.$/,
  );
  // 截断只发生在行边界：无 notice 的行都来自原文行集
  const original = (await toolkit().executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
  })).split("\n");
  expect(lines.slice(0, -1).every((line) => original.includes(line))).toBe(true);
});

test("Ledger 功能态：精确重复命中引用、不同请求不命中、失败不登记", async () => {
  const tk = toolkit({ ledgerMode: "enabled" });
  const args = { path: "src/main/java/com/example/Alpha.java", startLine: 11, endLine: 13 };
  const first = await tk.executeTool("review.get_file", args);
  expect(first).toContain("Lines 11-13 of 18");
  // 精确重复（规范化请求标识相同）→ 引用而非原文
  await expect(tk.executeTool("review.get_file", args)).resolves.toBe(
    "Already loaded: ctx#001 (review.get_file src/main/java/com/example/Alpha.java:11-13)",
  );
  // 不同区间（即使内容重叠）不命中——新登记
  const second = await tk.executeTool("review.get_file", {
    path: "src/main/java/com/example/Alpha.java",
    startLine: 11,
    endLine: 14,
  });
  expect(second).toContain("Lines 11-14 of 18");
  await expect(
    tk.executeTool("review.get_file", {
      path: "src/main/java/com/example/Alpha.java",
      startLine: 11,
      endLine: 14,
    }),
  ).resolves.toBe("Already loaded: ctx#002 (review.get_file src/main/java/com/example/Alpha.java:11-14)");
  // 读取失败不登记（重试仍走真实读取路径，错误形态不变）
  await expect(tk.executeTool("review.get_file", { path: "no/such/file.java" })).rejects.toThrow(
    /cannot be read/,
  );
  await expect(tk.executeTool("review.get_file", { path: "no/such/file.java" })).rejects.toThrow(
    /cannot be read/,
  );
  // 快照形态（审计留痕口径）
  expect(tk.ledger.snapshot()).toEqual([
    {
      id: "ctx#001",
      kind: "range",
      description: "review.get_file src/main/java/com/example/Alpha.java:11-13",
    },
    {
      id: "ctx#002",
      kind: "range",
      description: "review.get_file src/main/java/com/example/Alpha.java:11-14",
    },
  ]);
});

test("Ledger 功能态：整读（file）与区间读（range）分属不同登记；get_diff 登记为 evidence", async () => {
  const tk = toolkit({ ledgerMode: "enabled" });
  await tk.executeTool("review.get_file", { path: "src/main/java/com/example/Alpha.java" });
  await tk.executeTool("review.get_diff", {});
  await expect(tk.executeTool("review.get_diff", {})).resolves.toBe(
    "Already loaded: ctx#002 (review.get_diff)",
  );
  expect(tk.ledger.snapshot().map((entry) => entry.kind)).toEqual(["file", "evidence"]);
});

test("Ledger 惰性态：永不命中、快照恒空（C/D 行为零变化）", async () => {
  const tk = toolkit({ ledgerMode: "inert" });
  const args = { path: "src/main/java/com/example/Alpha.java" };
  const first = await tk.executeTool("review.get_file", args);
  const second = await tk.executeTool("review.get_file", args);
  expect(second).toBe(first);
  expect(tk.ledger.snapshot()).toEqual([]);
  // 独立账本原语同口径
  const inert = createInertContextLedger();
  expect(inert.referenceIfLoaded("file", "x")).toBeUndefined();
  const functional = createContextLedger();
  functional.register("file", "x");
  expect(functional.referenceIfLoaded("file", "x")).toBe("Already loaded: ctx#001 (x)");
});

test("Ledger 分叉态（ADR-0014）：沿用种子 id 与顺序，新登记接最大序号之后", () => {
  const seed = [
    { id: "ctx#001", kind: "file" as const, description: "review.get_file a.java" },
    { id: "ctx#002", kind: "evidence" as const, description: "review.get_diff" },
  ];
  const forked = createContextLedger(seed);
  // 种子可命中（skill 会话看到主会话已加载过的引用）
  expect(forked.referenceIfLoaded("file", "review.get_file a.java")).toBe(
    "Already loaded: ctx#001 (review.get_file a.java)",
  );
  forked.register("file", "review.get_file b.java");
  expect(forked.snapshot().map((entry) => entry.id)).toEqual(["ctx#001", "ctx#002", "ctx#003"]);
  // 分叉与种子互不影响（skill 之间互不可见）
  expect(seed.map((entry) => entry.id)).toEqual(["ctx#001", "ctx#002"]);
  expect(createContextLedger(seed).snapshot()).toEqual(seed);
  // 非连续种子按最大序号续发（防新旧 id 碰撞）
  const sparse = createContextLedger([
    { id: "ctx#007", kind: "file", description: "review.get_file c.java" },
  ]);
  sparse.register("file", "review.get_file d.java");
  expect(sparse.snapshot().map((entry) => entry.id)).toEqual(["ctx#007", "ctx#008"]);
});

test("executeTool：未知名为有界错误；schema 面固定七工具", async () => {
  const tk = toolkit();
  await expect(tk.executeTool("review.nope", {})).rejects.toThrow(
    /unknown tool "review.nope" \(available: review.get_diff, /,
  );
  expect(tk.schemas.map((schema) => schema.name)).toEqual([
    "review.get_diff",
    "review.get_symbol",
    "review.get_file",
    "review.find_references",
    "review.get_call_chain",
    "review.search_rule",
    "review.search_history",
  ]);
});

test("只读纪律：七工具全调用后仓库内容哈希不变", async () => {
  function snapshotDirHash(root: string): string {
    const hash = createHash("sha256");
    const visit = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        const full = path.join(dir, entry.name);
        hash.update(entry.name);
        if (entry.isDirectory()) {
          hash.update("dir\n");
          visit(full);
        } else if (entry.isFile()) {
          hash.update(`file ${statSync(full).size}\n`);
          hash.update(readFileSync(full));
        }
      }
    };
    visit(root);
    return hash.digest("hex");
  }

  const before = snapshotDirHash(SAMPLE);
  const tk = toolkit({ ledgerMode: "enabled" });
  // 每个工具真实执行一轮（含搜索类与 diff）
  await tk.executeTool("review.get_diff", {});
  await tk.executeTool("review.get_symbol", { symbol: "Alpha" });
  await tk.executeTool("review.get_file", { path: "src/main/java/com/example/Beta.java" });
  await tk.executeTool("review.find_references", { symbol: "getBase" });
  await tk.executeTool("review.get_call_chain", { symbol: "getBase" });
  await tk.executeTool("review.search_rule", { query: "null" });
  await tk.executeTool("review.search_history", { query: "npe" });
  expect(snapshotDirHash(SAMPLE)).toBe(before);
});
