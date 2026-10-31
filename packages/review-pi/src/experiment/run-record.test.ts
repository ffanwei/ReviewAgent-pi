import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { CacheBreakRecord, RunAudit, RunResult } from "../contracts/run.js";
import {
  buildRunRecord,
  runRecordPath,
  toAuditLight,
  toRunSnapshot,
  writeRunRecord,
  type RunRecord,
} from "./run-record.js";

// RunRecord 投影（测量常量面）：键序在本仓内单源定义。
// 落盘路径：<runsRoot>/runs/mr/<caseId>/rep-<N>.json。

const COMPLETED_AT = new Date("2026-09-14T18:09:20.100Z");

const AUDIT: RunAudit = {
  requests: [],
  toolCallLog: [],
  phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 1 }],
  rejections: [],
  cacheBreaks: [],
  truncated: false,
  truncationReasons: [],
};

const RUN_RESULT: RunResult = {
  caseId: "VUL4J-1",
  model: "deepseek-v4-flash",
  findings: [],
  usage: { inputTokens: 9579, outputTokens: 14484, cacheReadTokens: 24064 },
  rounds: 1,
  toolCalls: 0,
  audit: AUDIT,
  auditPath: path.join(tmpdir(), "audit", "20260914T180846.922-VUL4J-1.json"),
};

const RECORD_KEYS = [
  "source",
  "caseId",
  "rep",
  "model",
  "verifier",
  "completedAt",
  "baseline",
  "effective",
  "verifierPass",
] as const;

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-run-record-"));
  tempDirs.push(dir);
  return dir;
}

function recordFixture(): RunRecord {
  return buildRunRecord({
    source: "mr",
    caseId: "VUL4J-1",
    rep: 1,
    model: "deepseek-v4-flash",
    completedAt: COMPLETED_AT,
    result: RUN_RESULT,
  });
}

describe("toAuditLight", () => {
  test("键序固定；空 cacheBreaks 省键，非空保留", () => {
    const light = toAuditLight(AUDIT);
    expect(Object.keys(light)).toEqual([
      "toolCallLog",
      "phaseLog",
      "rejections",
      "truncated",
      "truncationReasons",
    ]);

    const withBreaks = toAuditLight({
      ...AUDIT,
      cacheBreaks: [
        { requestIndex: 1, reason: "MODEL_CHANGED", zone: "MODEL", divergeByteOffset: 1 },
      ] as const satisfies readonly CacheBreakRecord[],
    });
    expect(Object.keys(withBreaks)).toContain("cacheBreaks");
    expect(withBreaks.cacheBreaks).toHaveLength(1);
  });
});

describe("toRunSnapshot", () => {
  test("RunResult → 快照（去 requests；auditPath 缺省空串）", () => {
    const snapshot = toRunSnapshot(RUN_RESULT);
    expect(Object.keys(snapshot)).toEqual(["findings", "usage", "rounds", "toolCalls", "audit", "auditPath"]);
    expect(snapshot.auditPath).toBe(RUN_RESULT.auditPath);
    expect("requests" in snapshot.audit).toBe(false);

    const withoutPath = toRunSnapshot({ ...RUN_RESULT, auditPath: undefined });
    expect(withoutPath.auditPath).toBe("");
  });

  test("domainWarning（#12 护栏降级标注）：在场透传且恒在尾部；界内缺席省键", () => {
    const degraded = toRunSnapshot({
      ...RUN_RESULT,
      domainWarning: "out-of-validated-domain (files>10 or diff>2K)",
    });
    expect(degraded.domainWarning).toBe("out-of-validated-domain (files>10 or diff>2K)");
    expect(Object.keys(degraded).at(-1)).toBe("domainWarning");

    // 界内（RunResult 无该键）：快照同样无该键——不是 undefined 值，是键不在
    const bare = toRunSnapshot(RUN_RESULT);
    expect("domainWarning" in bare).toBe(false);
    expect(Object.keys(bare)).toEqual(["findings", "usage", "rounds", "toolCalls", "audit", "auditPath"]);
  });
});

describe("buildRunRecord", () => {
  test("baseline-only 记录：键序固定，effective / verifierPass 恒 null", () => {
    const record = recordFixture();
    expect(Object.keys(record)).toEqual([...RECORD_KEYS]);
    expect(record.source).toBe("mr");
    expect(record.verifier).toBe("off");
    expect(record.completedAt).toBe("2026-09-14T18:09:20.100Z");
    expect(record.effective).toBeNull();
    expect(record.verifierPass).toBeNull();
    expect(Object.keys(record.baseline)).toEqual([
      "findings",
      "usage",
      "rounds",
      "toolCalls",
      "audit",
      "auditPath",
    ]);
  });
});

describe("runRecordPath / writeRunRecord", () => {
  test("路径：<runsRoot>/runs/<source>/<caseId>/rep-<N>.json（无 experimentId 层，ADR-0027）", () => {
    const record = recordFixture();
    expect(runRecordPath("out", record)).toBe(
      path.join("out", "runs", "mr", "VUL4J-1", "rep-1.json"),
    );
  });

  test("caseId 文件名不安全字符替换（点号保留）", () => {
    const record = buildRunRecord({
      source: "mr",
      caseId: "case/with space",
      rep: 2,
      model: "deepseek-v4-flash",
      completedAt: COMPLETED_AT,
      result: { ...RUN_RESULT, caseId: "case/with space" },
    });
    expect(runRecordPath("out", record)).toContain(
      path.join("case_with_space", "rep-2.json"),
    );
  });

  test("落盘 2 空格缩进 + 尾随换行，往返一致", async () => {
    const record = recordFixture();
    const runsRoot = tempDir();
    const filePath = await writeRunRecord(runsRoot, record);
    expect(filePath).toBe(runRecordPath(runsRoot, record));
    const text = readFileSync(filePath, "utf8");
    expect(text).toBe(`${JSON.stringify(record, null, 2)}\n`);
    const parsed = JSON.parse(text);
    expect(typeof parsed.completedAt).toBe("string");
    expect(Number.isNaN(Date.parse(parsed.completedAt))).toBe(false);
    expect(typeof parsed.baseline.usage.inputTokens).toBe("number");
    expect(typeof parsed.baseline.usage.outputTokens).toBe("number");
    expect(Array.isArray(parsed.baseline.findings)).toBe(true);
  });
});
