import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { ConfigId } from "../contracts/config.js";
import type { Finding } from "../contracts/finding.js";
import type { RunAudit, RunResult } from "../contracts/run.js";
import { buildRunRecord, runRecordPath, type RunRecord } from "../experiment/run-record.js";
import {
  buildDispositionRecord,
  describeRunRecordRef,
  readRunRecordRef,
  referredRunRecordPath,
  type RunRecordRef,
} from "./record.js";

// 处置记录契约（#15）：票面四要素（决定三值 + 时间 + 案例关联）+ 回溯锚
// （source/caseId/configId/rep/model，与 RunRecord 身份块逐键同序）。夹具
// 用 E 形态 run record（生产入口，2026-10-19 决策评论 B→E；模块本身
// config 无关——任意 configId 的 run record 都能处置，E 只是验收样例面）。

const COMPLETED_AT = new Date("2026-10-19T08:00:00.000Z");
const NOTED_AT = new Date("2026-10-19T10:30:00.000Z");

const AUDIT: RunAudit = {
  requests: [],
  toolCallLog: [],
  phaseLog: [{ round: 1, phase: "Change Understanding", requestCount: 1 }],
  rejections: [],
  cacheBreaks: [],
  truncated: false,
  truncationReasons: [],
};

function finding(id: string, severity: "P1" | "P2"): Finding {
  return {
    id,
    severity,
    category: "correctness",
    file: "A.java",
    line: 42,
    title: `${id} title`,
    description: `${id} description`,
    evidence: ["A.java:42"],
    rule: "test-rule",
    confidence: 0.5,
  };
}

/** 真 RunRecord 夹具（经 buildRunRecord 全链组装——契约对齐不是手拼 JSON） */
function runRecordFixture(configId: ConfigId = "E"): RunRecord {
  const result: RunResult = {
    caseId: "VUL4J-1",
    configId,
    model: "deepseek-v4-flash",
    findings: [finding("F100", "P1"), finding("F101", "P2")],
    usage: { inputTokens: 1000, outputTokens: 2000, cacheReadTokens: 0 },
    rounds: 1,
    toolCalls: 4,
    audit: AUDIT,
    auditPath: "audit.json",
  };
  return buildRunRecord({
    source: "vul4j",
    caseId: "VUL4J-1",
    configId,
    rep: 1,
    model: "deepseek-v4-flash",
    completedAt: COMPLETED_AT,
    result,
  });
}

/** readRunRecordRef 的期望投影（身份锚 + findings id 面） */
function refFixture(caseId = "VUL4J-1"): RunRecordRef {
  return {
    source: "vul4j",
    caseId,
    configId: "E",
    rep: 1,
    model: "deepseek-v4-flash",
    baseline: { findings: [{ id: "F100" }, { id: "F101" }] },
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-disposition-"));
  tempDirs.push(dir);
  return dir;
}

/** 夹具按 canonical 布局落盘（runRecordPath 真源拼路径），返回文件路径 */
function writeFixture(runsRoot: string, record: RunRecord = runRecordFixture()): string {
  const filePath = runRecordPath(runsRoot, "exp1", record);
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(record, null, 2), "utf8");
  return filePath;
}

describe("readRunRecordRef", () => {
  test("合法 run record → 身份锚 + findings id 投影（E 形态验收样例）", async () => {
    const ref = await readRunRecordRef(writeFixture(tempDir()));
    expect(ref).toEqual(refFixture());
  });

  test("config 无关：B 形态 run record 同样可读（无配置耦合）", async () => {
    const ref = await readRunRecordRef(writeFixture(tempDir(), runRecordFixture("B")));
    expect(ref.configId).toBe("B");
  });

  test("文件缺席 → 人话错误（含路径与 --run 指引）", async () => {
    const missing = path.join(tempDir(), "no-such-record.json");
    await expect(readRunRecordRef(missing)).rejects.toThrow(`run record file not found: ${missing}`);
  });

  test("JSON 不可解析 / 顶层非对象 → 人话错误", async () => {
    const dir = tempDir();
    const badJson = path.join(dir, "bad.json");
    writeFileSync(badJson, "{oops", "utf8");
    await expect(readRunRecordRef(badJson)).rejects.toThrow("not valid JSON");
    const array = path.join(dir, "array.json");
    writeFileSync(array, "[1,2]", "utf8");
    await expect(readRunRecordRef(array)).rejects.toThrow("expected a JSON object");
  });

  test("形状不符逐字段 fail fast：source / configId / rep / baseline / findings / finding.id", async () => {
    const base = runRecordFixture() as unknown as Record<string, unknown>;
    const bad = (mutate: (record: Record<string, unknown>) => void): string => {
      const copy: Record<string, unknown> = JSON.parse(JSON.stringify(base));
      mutate(copy);
      const filePath = path.join(tempDir(), "bad.json");
      writeFileSync(filePath, JSON.stringify(copy), "utf8");
      return filePath;
    };
    await expect(readRunRecordRef(bad((r) => {
      r.source = "github";
    }))).rejects.toThrow('field "source"');
    await expect(readRunRecordRef(bad((r) => {
      r.configId = "G";
    }))).rejects.toThrow('field "configId"');
    await expect(readRunRecordRef(bad((r) => {
      r.rep = 0;
    }))).rejects.toThrow('field "rep"');
    await expect(readRunRecordRef(bad((r) => {
      delete r.baseline;
    }))).rejects.toThrow('field "baseline"');
    await expect(readRunRecordRef(bad((r) => {
      (r.baseline as Record<string, unknown>).findings = "nope";
    }))).rejects.toThrow('field "baseline.findings"');
    await expect(readRunRecordRef(bad((r) => {
      (r.baseline as Record<string, unknown>).findings = [{ noId: true }];
    }))).rejects.toThrow('baseline.findings[0].id');
  });
});

describe("buildDispositionRecord", () => {
  test("票面四要素 + 回溯锚：键序锁定（前五键与 RunRecord 身份块同序），note 缺席省键", () => {
    const record = buildDispositionRecord({
      runRecord: refFixture(),
      findingId: "F100",
      decision: "accept",
      notedAt: NOTED_AT,
    });
    expect(record).toEqual({
      source: "vul4j",
      caseId: "VUL4J-1",
      configId: "E",
      rep: 1,
      model: "deepseek-v4-flash",
      findingId: "F100",
      disposition: "accept",
      notedAt: "2026-10-19T10:30:00.000Z",
    });
    expect(Object.keys(record)).toEqual([
      "source",
      "caseId",
      "configId",
      "rep",
      "model",
      "findingId",
      "disposition",
      "notedAt",
    ]);
    expect("note" in record).toBe(false);
  });

  test("note 在场居尾；空白 note 拒绝（fail fast，不落无意义空备注）", () => {
    const withNote = buildDispositionRecord({
      runRecord: refFixture(),
      findingId: "F100",
      decision: "reject",
      notedAt: NOTED_AT,
      note: "确实是历史回归",
    });
    expect(withNote.note).toBe("确实是历史回归");
    expect(Object.keys(withNote).at(-1)).toBe("note");
    expect(() =>
      buildDispositionRecord({
        runRecord: refFixture(),
        findingId: "F100",
        decision: "reject",
        notedAt: NOTED_AT,
        note: "  ",
      }),
    ).toThrow("note must be non-empty text");
  });

  test("三种处置决定可记录：accept / reject / false-positive", () => {
    for (const decision of ["accept", "reject", "false-positive"] as const) {
      const record = buildDispositionRecord({
        runRecord: refFixture(),
        findingId: "F101",
        decision,
        notedAt: NOTED_AT,
      });
      expect(record.disposition).toBe(decision);
    }
  });

  test("findingId 不在 baseline.findings → 人话错误（含 caseId/configId/findingId 定位与可用 id）", () => {
    expect(() =>
      buildDispositionRecord({
        runRecord: refFixture(),
        findingId: "F999",
        decision: "accept",
        notedAt: NOTED_AT,
      }),
    ).toThrow(
      'finding "F999" not found in run record vul4j/VUL4J-1/E/rep-1 (baseline.findings ids: F100, F101)',
    );
  });

  test("空 findings：人话错误（该运行无可处置 finding）", () => {
    const empty = { ...refFixture(), baseline: { findings: [] } };
    expect(() =>
      buildDispositionRecord({
        runRecord: empty,
        findingId: "F100",
        decision: "accept",
        notedAt: NOTED_AT,
      }),
    ).toThrow("baseline.findings is empty");
  });
});

describe("referredRunRecordPath（回溯 AC）", () => {
  test("处置锚重定位 run record：与 experiment 侧 runRecordPath 同构（含 caseId 消毒）", () => {
    const record = buildDispositionRecord({
      runRecord: refFixture(),
      findingId: "F100",
      decision: "accept",
      notedAt: NOTED_AT,
    });
    expect(referredRunRecordPath("runs", "phase2-pi", record)).toBe(
      runRecordPath("runs", "phase2-pi", runRecordFixture("E")),
    );

    const spaced = buildDispositionRecord({
      runRecord: refFixture("case/with space"),
      findingId: "F100",
      decision: "accept",
      notedAt: NOTED_AT,
    });
    const spacedRun = { ...runRecordFixture(), caseId: "case/with space" };
    expect(referredRunRecordPath("runs", "phase2-pi", spaced)).toBe(
      runRecordPath("runs", "phase2-pi", spacedRun),
    );
  });

  test("端到端回溯：处置记录的锚能定位到磁盘上真实存在的 run record 文件", async () => {
    const runsRoot = tempDir();
    const filePath = writeFixture(runsRoot);
    const ref = await readRunRecordRef(filePath);
    const record = buildDispositionRecord({
      runRecord: ref,
      findingId: "F101",
      decision: "false-positive",
      notedAt: NOTED_AT,
    });
    const relocated = referredRunRecordPath(runsRoot, "exp1", record);
    expect(relocated).toBe(filePath);
    expect(existsSync(relocated)).toBe(true);
  });

  test("describeRunRecordRef：source/caseId/configId/rep 定位串（错误文案用）", () => {
    expect(describeRunRecordRef(refFixture())).toBe("vul4j/VUL4J-1/E/rep-1");
  });
});
