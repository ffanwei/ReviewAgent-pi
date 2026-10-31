import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { buildInitialUserMessage } from "../loop/messages.js";
import { PHASE_INSTRUCTIONS } from "../loop/phases.js";
import { fakeFetch } from "../provider/fake-fetch.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";
import { VUL4J_1_ISSUE, vul4j1Corpus } from "../testing/vul4j1-script.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import {
  DOMAIN_WARNING_OUT_OF_BOUNDARY,
  DOMAIN_WARNING_UNMEASURABLE,
  domainWarningFor,
  guardMrBoundary,
  measureMrBoundary,
  type MrBoundaryMetrics,
} from "./mr-boundary-guard.js";
import { runReview } from "./review-run.js";

// MR 边界护栏（#12 生产化四必做之一）双接缝测试：
// - 纯函数接缝（measureMrBoundary / guardMrBoundary）：以锁定数值断言度量口径
//   （不 import root，内核包不反向依赖；root 侧数据集门已随 ADR-0024 删除）；边界值
//   （10 文件 / 2000 行）含在界内，malformed 家族一律「不可度量」降级。
// - runReview 行为接缝（离线 fakeFetch 全链）：超界 / malformed 走显式降级
//   （domainWarning + 审计 mrBoundary 留痕 + 照常出结果，零静默）；边界内
//   零漂移（护栏键全缺席 + 请求字节面不受护栏影响）。
// 零网络纪律：全部离线 fakeFetch，不触任何真实网关。

// ---- 纯函数接缝：fixture 与期望值 ----

/** 单文件小 diff（diff -u 风格，无 git 头）：1 文件，+1 / -1 */
const SINGLE_FILE_DIFF = [
  "--- src/A.java",
  "+++ src/A.java",
  "@@ -10,3 +10,3 @@",
  " context",
  "-old line",
  "+new line",
  " tail context",
].join("\n");

/** git 风格双文件（新增 + 删除文件头，index / mode 噪音行齐全） */
const GIT_STYLE_TWO_FILE_DIFF = [
  "diff --git a/src/New.java b/src/New.java",
  "new file mode 100644",
  "index 0000000..1111111",
  "--- /dev/null",
  "+++ b/src/New.java",
  "@@ -0,0 +1,2 @@",
  "+brand",
  "+new file",
  "diff --git a/src/Old.java b/src/Old.java",
  "deleted file mode 100644",
  "index 2222222..0000000",
  "--- a/src/Old.java",
  "+++ /dev/null",
  "@@ -1,2 +0,0 @@",
  "-gone",
  "-deleted file",
].join("\n");

/**
 * hunk 体内 `--- x` / `+++ x` 前缀行是增删行而非文件头（计数歧义锁定：
 * 文件头判定只在文件块顶层，体行游走由 hunk 头声明的 old/new 计数驱动）。
 */
const AMBIGUOUS_PREFIX_DIFF = [
  "--- src/A.java",
  "+++ src/A.java",
  "@@ -1,3 +1,3 @@",
  " ctx",
  "--- this body line's text starts with --",
  "+++ this body line's text starts with ++",
  "-plain remove",
  "+plain add",
].join("\n");

/** no-newline 标记行：不计数、不致结构失败 */
const NO_NEWLINE_MARKER_DIFF = [
  "--- src/A.java",
  "+++ src/A.java",
  "@@ -1,1 +1,1 @@",
  "-old",
  "\\ No newline at end of file",
  "+new",
].join("\n");

/** hunk 头省略计数（`@@ -1 +1 @@`）：两侧计数默认 1（与 root 同则） */
const ELIDED_COUNT_DIFF = ["--- src/A.java", "+++ src/A.java", "@@ -1 +1 @@", "-old", "+new"].join("\n");

/** n 文件合法 diff，每文件 1 上下文行 + 1 删 + 1 增（changed = 2n） */
function multiFileDiff(fileCount: number): string {
  const lines: string[] = [];
  for (let index = 0; index < fileCount; index += 1) {
    lines.push(
      `--- src/F${index}.java`,
      `+++ src/F${index}.java`,
      "@@ -1,2 +1,2 @@",
      " context",
      `-removed-${index}`,
      `+added-${index}`,
    );
  }
  return lines.join("\n");
}

/** 单文件 diff，变更行数精确为 changedLines（全部新增行 + 1 上下文锚） */
function singleFileDiffOfChangedLines(changedLines: number): string {
  const lines = ["--- src/Big.java", "+++ src/Big.java", `@@ -1,1 +1,${changedLines + 1} @@`, " keep"];
  for (let index = 0; index < changedLines; index += 1) {
    lines.push(`+big-${index}`);
  }
  return lines.join("\n");
}

function expectMetrics(diff: string, expected: MrBoundaryMetrics): void {
  const metrics = measureMrBoundary(diff);
  expect(metrics).toEqual(expected);
}

test("度量：单文件小 diff（diff -u 风格）——1 文件 +1/-1，context 不计", () => {
  expectMetrics(SINGLE_FILE_DIFF, {
    files: 1,
    addedLines: 1,
    removedLines: 1,
    changedLines: 2,
  });
});

test("度量：golden vul4j-1.diff（真实数据集 diff）——与 root 数据集门口径数值对齐", () => {
  expectMetrics(goldenFixture("vul4j-1.diff"), {
    files: 1,
    addedLines: 1,
    removedLines: 1,
    changedLines: 2,
  });
});

test("度量：git 风格双文件（新增/删除文件 + /dev/null + mode/index 噪音行）——文件与增删各计 2", () => {
  expectMetrics(GIT_STYLE_TWO_FILE_DIFF, {
    files: 2,
    addedLines: 2,
    removedLines: 2,
    changedLines: 4,
  });
});

test("度量：hunk 体内 `--- x`/`+++ x` 前缀行计为增删行，不是文件头（前缀歧义锁定）", () => {
  expectMetrics(AMBIGUOUS_PREFIX_DIFF, {
    files: 1,
    addedLines: 2,
    removedLines: 2,
    changedLines: 4,
  });
});

test("度量：no-newline 标记行不计数不致败；hunk 头省略计数默认 1/1", () => {
  expectMetrics(NO_NEWLINE_MARKER_DIFF, { files: 1, addedLines: 1, removedLines: 1, changedLines: 2 });
  expectMetrics(ELIDED_COUNT_DIFF, { files: 1, addedLines: 1, removedLines: 1, changedLines: 2 });
});

test("判界：恰好压线（10 文件 / 2000 行）含在界内——降级键全缺席", () => {
  for (const boundaryDiff of [multiFileDiff(10), singleFileDiffOfChangedLines(2000)]) {
    const decision = guardMrBoundary(boundaryDiff);
    expect(decision.degraded).toBe(false);
    expect(Object.keys(decision)).toEqual(["degraded"]);
  }
});

test("判界：超文件数（11 文件）——domainWarning（§3.1 原文案）+ mrBoundary 留痕", () => {
  const decision = guardMrBoundary(multiFileDiff(11));
  expect(decision.degraded).toBe(true);
  if (!decision.degraded) {
    throw new Error("unreachable");
  }
  expect(decision.domainWarning).toBe(DOMAIN_WARNING_OUT_OF_BOUNDARY);
  expect(decision.mrBoundary).toEqual({
    files: 11,
    changedLines: 22,
    degraded: true,
    reason: "too-many-files",
  });
});

test("判界：超行数（2001 行）——reason 逐 diff-too-large，度量值留痕", () => {
  const decision = guardMrBoundary(singleFileDiffOfChangedLines(2001));
  expect(decision.degraded).toBe(true);
  if (!decision.degraded) {
    throw new Error("unreachable");
  }
  expect(decision.domainWarning).toBe(DOMAIN_WARNING_OUT_OF_BOUNDARY);
  expect(decision.mrBoundary).toEqual({
    files: 1,
    changedLines: 2001,
    degraded: true,
    reason: "diff-too-large",
  });
});

test("判界：malformed 家族（保守口径）——不可度量 = 显式降级，不拒检", () => {
  const malformedDiffs = [
    "",
    "   \n   ",
    "this is not a unified diff",
    // 截断的 hunk：头声明 5+5 行，体只有 2 行
    ["--- src/A.java", "+++ src/A.java", "@@ -1,5 +1,5 @@", " ctx", "-only two body lines"].join("\n"),
    // 文件头 --- 之后缺 +++
    ["--- src/A.java", "not a plus header"].join("\n"),
    // 文件块不含任何 hunk
    ["--- src/A.java", "+++ src/A.java"].join("\n"),
    // hunk 体行数超出头部声明（声明 1+1，体有 3 行）
    ["--- src/A.java", "+++ src/A.java", "@@ -1,1 +1,1 @@", " ctx", "-extra", "+extra"].join("\n"),
    // hunk 体在计数耗尽前遇到新结构行
    ["--- src/A.java", "+++ src/A.java", "@@ -1,2 +1,2 @@", " ctx", "@@ -1,1 +1,1 @@", "-x", "+y"].join(
      "\n",
    ),
    // 二进制 / 纯重命名标记（root 全量解析器显式报错，同向不可度量）
    ["diff --git a/x.bin b/x.bin", "Binary files differ"].join("\n"),
    ["diff --git a/x.java b/y.java", "rename from x.java", "rename to y.java"].join("\n"),
  ];
  for (const diff of malformedDiffs) {
    expect(measureMrBoundary(diff)).toBeNull();
    const decision = guardMrBoundary(diff);
    expect(decision.degraded, JSON.stringify(diff)).toBe(true);
    if (!decision.degraded) {
      throw new Error("unreachable");
    }
    expect(decision.domainWarning).toBe(DOMAIN_WARNING_UNMEASURABLE);
    expect(decision.mrBoundary).toEqual({
      files: null,
      changedLines: null,
      degraded: true,
      reason: "boundary-unmeasurable",
    });
  }
});

test("文案面：域外警示为生产化方案 §3.1 原文；不可度量为 boundary-unmeasurable 语义", () => {
  expect(DOMAIN_WARNING_OUT_OF_BOUNDARY).toBe("out-of-validated-domain (files>10 or diff>2K)");
  expect(DOMAIN_WARNING_UNMEASURABLE).toMatch(/boundary-unmeasurable/);
});

test("文案派生（ADR-0025）：界值改了文案跟着改；整千用 K，否则原样数字", () => {
  expect(domainWarningFor({ maxFiles: 10, maxDiffLines: 2000 })).toBe(DOMAIN_WARNING_OUT_OF_BOUNDARY);
  expect(domainWarningFor({ maxFiles: 5, maxDiffLines: 500 })).toBe(
    "out-of-validated-domain (files>5 or diff>500)",
  );
  expect(domainWarningFor({ maxFiles: null, maxDiffLines: 2000 })).toBe(
    "out-of-validated-domain (diff>2K)",
  );
  expect(domainWarningFor({ maxFiles: 10, maxDiffLines: null })).toBe(
    "out-of-validated-domain (files>10)",
  );
});

test("自定义界（ADR-0025）：更小的界按新界判、文案同步；更宽的界不误报", () => {
  const custom = { maxFiles: 2, maxDiffLines: 10 } as const;
  const decision = guardMrBoundary(multiFileDiff(3), custom);
  expect(decision.degraded).toBe(true);
  if (!decision.degraded) {
    throw new Error("unreachable");
  }
  expect(decision.domainWarning).toBe("out-of-validated-domain (files>2 or diff>10)");
  expect(decision.mrBoundary.reason).toBe("too-many-files");

  // 更宽的界：11 文件 / 22 行在 20 文件 / 100 行内 = 介内零介入
  const wide = guardMrBoundary(multiFileDiff(11), { maxFiles: 20, maxDiffLines: 100 });
  expect(wide.degraded).toBe(false);
  expect(Object.keys(wide)).toEqual(["degraded"]);
});

test("双维皆 null（ADR-0025）：护栏整体停用——不度量、不告警，连 malformed 也不降级", () => {
  const disabled = { maxFiles: null, maxDiffLines: null } as const;
  for (const diff of [multiFileDiff(11), singleFileDiffOfChangedLines(2001), "not a diff at all"]) {
    const decision = guardMrBoundary(diff, disabled);
    expect(decision.degraded).toBe(false);
    expect(Object.keys(decision)).toEqual(["degraded"]);
  }
});

// ---- runReview 行为接缝（离线 fakeFetch 全链） ----

const tempDirs: string[] = [];

function tempRunsRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-boundary-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

interface AuditFile {
  readonly requests: { readonly wireBody: string }[];
  readonly mrBoundary?: unknown;
}

function readAudit(auditPath: string): AuditFile {
  return JSON.parse(readFileSync(auditPath, "utf8")) as AuditFile;
}

/** 护栏不触碰请求字节面：任何请求的 wireBody 都不得出现护栏键（两路径通用断言） */
function expectWireBodiesGuardFree(audit: AuditFile): void {
  expect(audit.requests.length).toBeGreaterThan(0);
  for (const request of audit.requests) {
    expect(request.wireBody).not.toContain("domainWarning");
    expect(request.wireBody).not.toContain("mrBoundary");
    expect(request.wireBody).not.toContain("out-of-validated-domain");
  }
}

test("全链超界（11 文件）：照常出 findings + domainWarning + 审计 mrBoundary 留痕 + 记录落盘", async () => {
  const script = fakeFetch(vul4j1Corpus());
  const runsRoot = tempRunsRoot();
  const overBoundaryDiff = multiFileDiff(11);
  const { record, recordPath, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: overBoundaryDiff,
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    rep: 1,
    ruleSkillLoader: async () => [],
  });

  // 照常执行（v1 显式降级：不拒检）：六阶段六请求全跑完，findings 照常产出
  expect(script.requests).toHaveLength(6);
  expect(record.baseline.findings.length).toBeGreaterThan(0);

  // 显式降级：RunResult 顶层 domainWarning（§3.1 原文案）
  expect(record.baseline.domainWarning).toBe(DOMAIN_WARNING_OUT_OF_BOUNDARY);

  // 审计留痕：mrBoundary 记录度量值与降级决策（键序在 AuditFileContent 尾部）
  const audit = readAudit(auditPath);
  expect(audit.mrBoundary).toEqual({
    files: 11,
    changedLines: 22,
    degraded: true,
    reason: "too-many-files",
  });
  const auditKeys = Object.keys(audit);
  expect(auditKeys.indexOf("mrBoundary")).toBeGreaterThan(auditKeys.indexOf("toolCallLog"));

  // 记录落盘：domainWarning 经 toRunSnapshot 透传进 rep-1.json
  const onDisk = JSON.parse(readFileSync(recordPath, "utf8")) as {
    baseline: { domainWarning?: string };
  };
  expect(onDisk.baseline.domainWarning).toBe(DOMAIN_WARNING_OUT_OF_BOUNDARY);

  // 护栏不触碰请求字节面
  expectWireBodiesGuardFree(audit);
}, 120_000);

test("全链 malformed diff：boundary-unmeasurable 降级标注 + 照常执行", async () => {
  const script = fakeFetch(vul4j1Corpus());
  const runsRoot = tempRunsRoot();
  const { record, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: "this is not a unified diff",
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    rep: 1,
    ruleSkillLoader: async () => [],
  });

  // 照常执行：六请求、findings 照常产出（不拒检——零静默 + 不误伤怪格式）
  expect(script.requests).toHaveLength(6);
  expect(record.baseline.findings.length).toBeGreaterThan(0);

  // 显式降级（保守口径：不能证明界内 = 降级）
  expect(record.baseline.domainWarning).toBe(DOMAIN_WARNING_UNMEASURABLE);
  const audit = readAudit(auditPath);
  expect(audit.mrBoundary).toEqual({
    files: null,
    changedLines: null,
    degraded: true,
    reason: "boundary-unmeasurable",
  });
  expectWireBodiesGuardFree(audit);
}, 120_000);

test("全链边界内零漂移：护栏键全缺席 + req0 消息面逐字节断言", async () => {
  const script = fakeFetch(vul4j1Corpus());
  const runsRoot = tempRunsRoot();
  const inBoundaryDiff = SINGLE_FILE_DIFF;
  const { record, recordPath, auditPath } = await runReview({
    caseId: "VUL4J-1",
    repoPath: repoFixturePath("sample"),
    diff: inBoundaryDiff,
    issueDescription: VUL4J_1_ISSUE,
    apiKey: "offline-test",
    fetch: script.fetch,
    runsRoot,
    rep: 1,
    ruleSkillLoader: async () => [],
  });

  // 护栏零介入：domainWarning / mrBoundary 缺席省键（不是 undefined 值，是键不在）
  expect("domainWarning" in record.baseline).toBe(false);
  const onDisk = JSON.parse(readFileSync(recordPath, "utf8")) as Record<string, unknown>;
  expect("domainWarning" in (onDisk["baseline"] as Record<string, unknown>)).toBe(false);
  const audit = readAudit(auditPath);
  expect("mrBoundary" in audit).toBe(false);

  // 请求字节面：req0 = Zone A + MR + Phase-1 三条（E 无全仓注入），七工具面在场
  const req0 = JSON.parse(audit.requests[0].wireBody) as {
    messages: { role: string; content: string }[];
    tools?: { function: { name: string } }[];
  };
  expect(req0.messages).toEqual([
    { role: "system", content: SYSTEM_PROMPT },
    { role: "user", content: buildInitialUserMessage("VUL4J-1", VUL4J_1_ISSUE, inBoundaryDiff) },
    { role: "user", content: PHASE_INSTRUCTIONS[0] },
  ]);
  expect(req0.messages[1]?.content).toContain(inBoundaryDiff);
  expect(req0.tools?.map((tool) => tool.function.name)).toEqual([
    "review_get_diff",
    "review_get_symbol",
    "review_get_file",
    "review_find_references",
    "review_get_call_chain",
    "review_search_rule",
    "review_search_history",
  ]);
  // E 恒投影 ledger 键（零工具 → 空数组）
  expect(record.baseline.audit.ledger).toEqual([]);
  expectWireBodiesGuardFree(audit);
}, 120_000);
