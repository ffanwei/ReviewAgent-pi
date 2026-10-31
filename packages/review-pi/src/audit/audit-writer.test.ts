import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { RunAudit } from "../contracts/run.js";
import { buildAuditFileContent, buildRunId, writeAuditFile, type AuditFileContent } from "./audit-writer.js";

// 审计投影（测量常量面）：AuditFileContent 字段集与键序在本仓内单源定义，
// requests[] = onPayload 序列化点捕获（model/effort/messages/tools/wireBody）。
// ADR-0024：配置维度删除后不再与 A–E 历史审计做键序对照。

const STARTED = new Date("2026-09-14T18:08:46.922Z");
const FINISHED = new Date("2026-09-14T18:09:20.100Z");

const EMPTY_AUDIT: RunAudit = {
  requests: [],
  toolCallLog: [],
  phaseLog: [],
  rejections: [],
  cacheBreaks: [],
  truncated: false,
  truncationReasons: [],
};

/** 审计文件基础键序（可选尾键另行追加） */
const AUDIT_KEYS = [
  "runId",
  "caseId",
  "model",
  "effort",
  "startedAt",
  "finishedAt",
  "durationMs",
  "rounds",
  "toolCalls",
  "truncated",
  "truncationReasons",
  "usage",
  "findings",
  "phaseLog",
  "rejections",
  "cacheBreaks",
  "requests",
  "toolCallLog",
] as const;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-audit-"));
  tempDirs.push(dir);
  return dir;
}

function contentFixture(): AuditFileContent {
  return buildAuditFileContent({
    runId: "20260914T180846.922-VUL4J-1",
    caseId: "VUL4J-1",
    model: "deepseek-v4-flash",
    effort: "default",
    startedAt: STARTED,
    finishedAt: FINISHED,
    rounds: 1,
    toolCalls: 0,
    usage: { inputTokens: 9579, outputTokens: 14484, cacheReadTokens: 24064 },
    findings: [],
    audit: EMPTY_AUDIT,
  });
}

describe("buildRunId", () => {
  test("毫秒时间戳 + 用例，文件名安全", () => {
    expect(buildRunId(STARTED, "VUL4J-1")).toBe("20260914T180846.922-VUL4J-1");
  });

  test("用例 id 中的文件名不安全字符替换为下划线", () => {
    expect(buildRunId(STARTED, "VUL4J/1 x")).toBe("20260914T180846.922-VUL4J_1_x");
  });
});

describe("buildAuditFileContent", () => {
  test("字段集与键序固定（无可选尾键时）", () => {
    const content = contentFixture();
    expect(Object.keys(content)).toEqual([...AUDIT_KEYS]);
  });

  test("mrBoundary（#12 护栏留痕）：只在传入时在场，键序恒在尾部", () => {
    // 界内（不传 mrBoundary）：键缺席——护栏零介入的投影面证明
    const bare = contentFixture();
    expect("mrBoundary" in bare).toBe(false);
    expect(Object.keys(bare).at(-1)).toBe("toolCallLog");

    // 降级（传入 mrBoundary）：度量值与决策留痕，尾键扩展不扰动前缀
    const degraded = buildAuditFileContent({
      runId: "20260914T180846.922-VUL4J-1",
      caseId: "VUL4J-1",
      model: "deepseek-v4-flash",
      effort: "default",
      startedAt: STARTED,
      finishedAt: FINISHED,
      rounds: 1,
      toolCalls: 0,
      usage: { inputTokens: 9579, outputTokens: 14484, cacheReadTokens: 24064 },
      findings: [],
      audit: EMPTY_AUDIT,
      ledger: [],
      mrBoundary: { files: 11, changedLines: 22, degraded: true, reason: "too-many-files" },
    });
    const keys = Object.keys(degraded);
    expect(keys.slice(0, -2)).toEqual([...AUDIT_KEYS]);
    expect(keys.slice(-2)).toEqual(["ledger", "mrBoundary"]);
    expect(degraded.mrBoundary).toEqual({
      files: 11,
      changedLines: 22,
      degraded: true,
      reason: "too-many-files",
    });
  });

  test("规则 Skill 留痕（ruleSkill / skillPassLog）只在审计携带时出现在尾部", () => {
    const content = buildAuditFileContent({
      runId: "20260914T180846.922-VUL4J-1",
      caseId: "VUL4J-1",
      model: "deepseek-v4-flash",
      effort: "default",
      startedAt: STARTED,
      finishedAt: FINISHED,
      rounds: 1,
      toolCalls: 0,
      usage: { inputTokens: 9579, outputTokens: 14484, cacheReadTokens: 24064 },
      findings: [],
      audit: { ...EMPTY_AUDIT, ruleSkill: [], skillPassLog: [] },
    });
    const keys = Object.keys(content);
    expect(keys.slice(0, -2)).toEqual([...AUDIT_KEYS]);
    expect(keys.slice(-2)).toEqual(["ruleSkill", "skillPassLog"]);
  });

  test("元数据换算：ISO 时间戳与 durationMs", () => {
    const content = contentFixture();
    expect(content.startedAt).toBe("2026-09-14T18:08:46.922Z");
    expect(content.finishedAt).toBe("2026-09-14T18:09:20.100Z");
    expect(content.durationMs).toBe(FINISHED.getTime() - STARTED.getTime());
  });
});

describe("writeAuditFile", () => {
  test("落盘 <auditDir>/<runId>.json，2 空格缩进 + 尾随换行，往返一致", async () => {
    const content = contentFixture();
    const dir = tempDir();
    const auditDir = path.join(dir, "nested", "audit");
    const filePath = await writeAuditFile(auditDir, content);
    expect(path.isAbsolute(filePath)).toBe(true);
    expect(filePath).toBe(path.join(auditDir, `${content.runId}.json`));
    const text = readFileSync(filePath, "utf8");
    expect(text).toBe(`${JSON.stringify(content, null, 2)}\n`);
    expect(JSON.parse(text)).toEqual(content);
  });
});
