import { afterEach, describe, expect, test } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { FetchFunction } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import type { RetryPolicy } from "../shared/llm-retry.js";
import {
  createHistoryInvalidationRunner,
  INVALIDATION_SIDECAR_FILENAME,
  loadHistoryTips,
  VERDICT_CACHE_FILENAME,
  type InvalidationFinalOutcome,
  type ReadRepoText,
} from "./history-invalidation.js";
import type { RepoReviewedBatch } from "./types.js";

const NO_WAIT: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxRetryAfterMs: 0,
};

const LIMITS = { statuses: ["PENDING"], semanticVerdict: { enabled: true } } as const;

const dirs: string[] = [];
function tempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}
afterEach(() => {
  for (const dir of dirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeRepoFile(root: string, rel: string, content: string): void {
  const full = path.join(root, ...rel.split("/"));
  mkdirSync(path.dirname(full), { recursive: true });
  writeFileSync(full, content, "utf8");
}

function historyFile(entries: unknown[]): string {
  return JSON.stringify(entries);
}

function tip(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "1",
    status: "PENDING",
    filePath: "src/a.ts",
    lineNum: 3,
    patchLine: "+ const sql = \"SELECT * FROM users WHERE id = \" + userId;",
    reviewMsg: "SQL 语句使用字符串拼接，存在注入风险",
    ...overrides,
  };
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    id: "F001",
    severity: "P2",
    category: "安全",
    file: "src/a.ts",
    line: 3,
    title: "SQL 语句拼接存在注入风险",
    description: "拼接导致注入",
    evidence: ["src/a.ts:3"],
    rule: "SEC-001",
    confidence: 0.8,
    tips: {
      review: "[缺陷类型] 注入。影响评估：高危。",
      suggestion: "[重构思路] 参数化。代码示例：use ?",
      subcategory: "注入",
    },
    ...overrides,
  };
}

async function buildRunner(input: {
  readonly repoRoot: string;
  readonly outDir: string;
  readonly history: string;
  readonly files: Readonly<Record<string, string>>;
  readonly fetch?: FetchFunction;
  readonly semanticEnabled?: boolean;
  readonly logs?: string[];
}) {
  const repoFileRoot = path.join(input.repoRoot, "repo");
  const readText: ReadRepoText = async (absolutePath) => {
    const rel = path.relative(process.cwd(), absolutePath);
    void rel;
    for (const [rel2, content] of Object.entries(input.files)) {
      if (path.join(repoFileRoot, ...rel2.split("/")) === absolutePath) {
        return content;
      }
    }
    if (absolutePath === path.join(repoFileRoot, ".aireview", "history_review_tips.json")) {
      return input.history;
    }
    return null;
  };
  const logs = input.logs ?? [];
  const load = await loadHistoryTips({
    repoPath: repoFileRoot,
    limits: { ...LIMITS, semanticVerdict: { enabled: input.semanticEnabled ?? true } },
    readText,
    log: (line) => logs.push(line),
  });
  if (load === null) {
    throw new Error("history load failed");
  }
  const runner = createHistoryInvalidationRunner({
    repoPath: repoFileRoot,
    outDir: input.outDir,
    limits: { ...LIMITS, semanticVerdict: { enabled: input.semanticEnabled ?? true } },
    load,
    genericReview: undefined,
    llm: {
      baseUrl: "https://gw.example.com/v1",
      apiKey: "sk-runner-sentinel",
      modelId: "deepseek-v4-flash",
      timeoutMs: 5_000,
      retry: NO_WAIT,
      ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
    },
    log: (line) => logs.push(line),
    readText,
  });
  return { runner, load, readText, repoFileRoot };
}

function verdictFetch(verdicts: readonly unknown[]): FetchFunction {
  return async () =>
    new Response(
      JSON.stringify({
        choices: [
          { message: { role: "assistant", content: JSON.stringify({ verdicts }) } },
        ],
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
}

function batchOf(files: readonly string[], findings: readonly Finding[]): RepoReviewedBatch {
  return { index: 1, key: "g001", files, findings };
}

describe("runner：随组判定与收尾", () => {
  test("硬档重复在批次内直接定案（零模型）；sidecar 与 result 摘要落盘", async () => {
    const out = tempDir("hist-inv-out-");
    const root = tempDir("hist-inv-root-");
    const files = {
      "src/a.ts": 'import httpx\nconst port = 1\nconst sql = "SELECT * FROM users WHERE id = " + userId;\n',
    };
    const logs: string[] = [];
    const { runner } = await buildRunner({
      repoRoot: root,
      outDir: out,
      history: historyFile([tip()]),
      files,
      fetch: verdictFetch([]),
      logs,
    });
    await runner.enqueueBatch(batchOf(["src/a.ts"], [finding()]));

    const outcome: InvalidationFinalOutcome = await runner.finalize({
      coverage: { files: [{ path: "src/a.ts", state: "candidate" }] },
      findings: [finding()],
    });
    // 硬档：位置命中 + 文本过线 → 重复
    expect(outcome.report).toEqual([{ tipsId: 1, reason: "重复" }]);
    expect(outcome.summary.invalidated).toBe(1);
    expect(outcome.summary.byReason).toEqual({ 重复: 1 });
    // sidecar 存在且逐条可读
    const sidecar = JSON.parse(
      readFileSync(path.join(out, INVALIDATION_SIDECAR_FILENAME), "utf8"),
    ) as { items: { tipsId: number; outcome: string }[] };
    expect(sidecar.items).toHaveLength(1);
    expect(existsSync(path.join(out, VERDICT_CACHE_FILENAME))).toBe(true);
    expect(logs.some((line) => line.includes("失效 1 / 保留 0"))).toBe(true);
  });

  test("LLM 候选：fixed → 失效「已修复」；persist → 保留 + 召回信号", async () => {
    const out = tempDir("hist-inv-out-");
    const root = tempDir("hist-inv-root-");
    // 行被改（edited）：patchLine 不再精确存在于文件
    const files = { "src/a.ts": 'const sql = query("users", userId);\n' };
    const { runner } = await buildRunner({
      repoRoot: root,
      outDir: out,
      history: historyFile([
        tip({ id: "1" }),
        tip({ id: "2", reviewMsg: "另一个完全不同的意见内容" }),
      ]),
      files,
      fetch: verdictFetch([
        { tipsId: 1, verdict: "fixed", matchedFindingId: null, note: "已参数化" },
        { tipsId: 2, verdict: "persist", matchedFindingId: null, note: "仍在" },
      ]),
    });
    await runner.enqueueBatch(batchOf(["src/a.ts"], [finding()]));
    const outcome = await runner.finalize({
      coverage: { files: [{ path: "src/a.ts", state: "candidate" }] },
      findings: [finding()],
    });
    expect(outcome.report).toEqual([{ tipsId: 1, reason: "已修复" }]);
    expect(outcome.summary.byVerdict).toEqual({ fixed: 1, persist: 1 });
    const sidecar = JSON.parse(
      readFileSync(path.join(out, INVALIDATION_SIDECAR_FILENAME), "utf8"),
    ) as { items: { tipsId: number; cause?: string }[] };
    expect(sidecar.items.find((item) => item.tipsId === 2)?.cause).toBe("recall-signal");
  });

  test("裁决调用失败 → fail-open：该批保守保留、不碰其他结果", async () => {
    const out = tempDir("hist-inv-out-");
    const root = tempDir("hist-inv-root-");
    const files = { "src/a.ts": 'const sql = query("users", userId);\n' };
    const fetch: FetchFunction = async () =>
      new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content: "bad" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    const { runner } = await buildRunner({
      repoRoot: root,
      outDir: out,
      history: historyFile([tip()]),
      files,
      fetch,
    });
    await runner.enqueueBatch(batchOf(["src/a.ts", "src/keep.ts"], [finding()]));
    const outcome = await runner.finalize({
      coverage: { files: [{ path: "src/a.ts", state: "candidate" }] },
      findings: [finding()],
    });
    expect(outcome.report).toEqual([]);
    expect(outcome.summary.verdictFailed).toBe(1);
  });

  test("开关关闭：LLM 候选保守保留（semantic-off），不烧裁决调用", async () => {
    const out = tempDir("hist-inv-out-");
    const root = tempDir("hist-inv-root-");
    let calls = 0;
    const verdicts = verdictFetch([]);
    const fetch: FetchFunction = async (url, init) => {
      calls += 1;
      return verdicts(url, init);
    };
    const files = { "src/a.ts": 'const sql = query("users", userId);\n' };
    const { runner } = await buildRunner({
      repoRoot: root,
      outDir: out,
      history: historyFile([tip()]),
      files,
      fetch,
      semanticEnabled: false,
    });
    await runner.enqueueBatch(batchOf(["src/a.ts"], [finding()]));
    const outcome = await runner.finalize({
      coverage: { files: [{ path: "src/a.ts", state: "candidate" }] },
      findings: [finding()],
    });
    expect(outcome.report).toEqual([]);
    expect(outcome.summary.verdictCalls).toBe(0);
    expect(calls).toBe(0);
    const sidecar = JSON.parse(
      readFileSync(path.join(out, INVALIDATION_SIDECAR_FILENAME), "utf8"),
    ) as { items: { cause?: string }[] };
    expect(sidecar.items[0]?.cause).toBe("semantic-off");
  });

  test("end-sweep：文件已删除 → 「文件已删除」；not-reached → 保留", async () => {
    const out = tempDir("hist-inv-out-");
    const root = tempDir("hist-inv-root-");
    const files = { "src/exists.ts": "const a = 1;\n" };
    const { runner } = await buildRunner({
      repoRoot: root,
      outDir: out,
      history: historyFile([
        tip({ id: "1", filePath: "src/gone.ts" }),
        tip({ id: "2", filePath: "src/exists.ts" }),
      ]),
      files,
      fetch: verdictFetch([]),
    });
    const outcome = await runner.finalize({
      coverage: { files: [{ path: "src/exists.ts", state: "not-reached" }] },
      findings: [],
    });
    expect(outcome.report).toEqual([{ tipsId: 1, reason: "文件已删除" }]);
    expect(outcome.summary.byReason).toEqual({ 文件已删除: 1 });
    const sidecar = JSON.parse(
      readFileSync(path.join(out, INVALIDATION_SIDECAR_FILENAME), "utf8"),
    ) as { items: { tipsId: number; cause?: string }[] };
    expect(sidecar.items.find((item) => item.tipsId === 2)?.cause).toBe("not-reached");
  });

  test("续跑复用：缓存里的终态被直接采用（不重付 LLM）", async () => {
    const out = tempDir("hist-inv-out-");
    const root = tempDir("hist-inv-root-");
    const files = { "src/a.ts": 'const sql = query("users", userId);\n' };
    let calls = 0;
    const verdicts = verdictFetch([]);
    const fetch: FetchFunction = async (url, init) => {
      calls += 1;
      return verdicts(url, init);
    };
    // 预置缓存：tipsId 1 已判 fixed
    mkdirSync(out, { recursive: true });
    writeFileSync(
      path.join(out, VERDICT_CACHE_FILENAME),
      JSON.stringify({
        schemaVersion: 1,
        decisions: [
          { tipsId: 1, filePath: "src/a.ts", outcome: "invalidate", reason: "已修复" },
        ],
      }),
      "utf8",
    );
    const { runner } = await buildRunner({
      repoRoot: root,
      outDir: out,
      history: historyFile([tip()]),
      files,
      fetch,
    });
    // 不 enqueueBatch（模拟续跑：done 组不触发上报缝）
    const outcome = await runner.finalize({
      coverage: { files: [{ path: "src/a.ts", state: "candidate" }] },
      findings: [finding()],
    });
    expect(outcome.report).toEqual([{ tipsId: 1, reason: "已修复" }]);
    expect(calls).toBe(0);
  });

  test("续跑无缓存 → 补判（LLM 仍会被调用）", async () => {
    const out = tempDir("hist-inv-out-");
    const root = tempDir("hist-inv-root-");
    const files = { "src/a.ts": 'const sql = query("users", userId);\n' };
    const { runner } = await buildRunner({
      repoRoot: root,
      outDir: out,
      history: historyFile([tip()]),
      files,
      fetch: verdictFetch([
        { tipsId: 1, verdict: "persist", matchedFindingId: null, note: "" },
      ]),
    });
    const outcome = await runner.finalize({
      coverage: { files: [{ path: "src/a.ts", state: "candidate" }] },
      findings: [finding()],
    });
    expect(outcome.report).toEqual([]);
    expect(outcome.summary.verdictCalls).toBeGreaterThan(0);
    expect(outcome.summary.byVerdict).toEqual({ persist: 1 });
  });

  test("防御收口：finalize 异常 → 空结果且不抛（绝不影响收尾链）", async () => {
    const out = tempDir("hist-inv-out-");
    const root = tempDir("hist-inv-root-");
    const files = { "src/a.ts": "const a = 1;\n" };
    const { runner } = await buildRunner({
      repoRoot: root,
      outDir: out,
      history: historyFile([tip()]),
      files,
      fetch: verdictFetch([]),
    });
    // coverage.files 抛错模拟实现 bug：runner 必须吞掉
    const outcome = await runner.finalize({
      coverage: {
        get files(): never {
          throw new Error("boom");
        },
      },
      findings: [],
    });
    expect(outcome.report).toEqual([]);
  });
});

describe("loadHistoryTips", () => {
  test("文件不存在 → null；坏 JSON → null + 一行日志", async () => {
    const logs: string[] = [];
    const readText: ReadRepoText = async (absolutePath) =>
      absolutePath.endsWith("history_review_tips.json") ? "{" : null;
    const missing = await loadHistoryTips({
      repoPath: "D:/nope",
      limits: LIMITS,
      readText: async () => null,
      log: (line) => logs.push(line),
    });
    expect(missing).toBeNull();
    const broken = await loadHistoryTips({
      repoPath: "D:/nope",
      limits: LIMITS,
      readText,
      log: (line) => logs.push(line),
    });
    expect(broken).toBeNull();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toContain("不是合法 JSON");
  });
});
