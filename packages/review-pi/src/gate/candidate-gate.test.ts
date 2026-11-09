import { expect, test } from "vitest";
import { findingContentKey } from "../finding/finding-key.js";
import type { VerificationVerdict } from "../loop/parse.js";
import { applyCandidateGate } from "./candidate-gate.js";
import { buildDiffScope } from "./diff-scope.js";

// 候选拦截链（测量常量面：六阶段语义的一部分）。
// 顺序：SCHEMA_INVALID → NON_ENGLISH → NO_EVIDENCE → VERIFICATION_FAILED → OUT_OF_SCOPE → DUPLICATE_ID，
// 每个候选最多留痕一条（首个失败阶段）。

const VALID_CANDIDATE = {
  id: "F001",
  severity: "P1",
  category: "CORRECTNESS",
  file: "src/Foo.java",
  line: 42,
  title: "Null dereference",
  description: "The value may be null at this call site.",
  evidence: ["method Foo.bar at src/Foo.java:42"],
  rule: "CORRECTNESS-001",
  confidence: 0.8,
};

function verdicts(entries: Record<string, VerificationVerdict>): ReadonlyMap<string, VerificationVerdict> {
  return new Map(Object.entries(entries));
}

test("合法候选 + 验证通过 → 产出 finding 并登记 id", () => {
  const out = applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(),
    round: 1,
  });
  expect(out.findings).toHaveLength(1);
  expect(out.findings[0]?.id).toBe("F001");
  expect(out.rejections).toEqual([]);
  expect([...out.emittedIds]).toEqual(["F001"]);
});

test("schema 失败优先于后续一切阶段（首个失败阶段留痕）", () => {
  const broken = { ...VALID_CANDIDATE, line: 0 };
  const out = applyCandidateGate({
    candidates: [broken],
    verdicts: new Map(), // 无裁决：若无 schema 失败本应 VERIFICATION_FAILED
    emittedIds: new Set(["F001"]), // 已产出：若无前序失败本应 DUPLICATE_ID
    round: 1,
  });
  expect(out.findings).toEqual([]);
  expect(out.rejections).toHaveLength(1);
  expect(out.rejections[0]?.stage).toBe("SCHEMA_INVALID");
  expect(out.rejections[0]?.candidateId).toBe("F001");
});

test("含 CJK 字符的候选被 NON_ENGLISH 拦截", () => {
  const out = applyCandidateGate({
    candidates: [{ ...VALID_CANDIDATE, title: "空指针解引用" }],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(),
    round: 1,
  });
  expect(out.rejections[0]?.stage).toBe("NON_ENGLISH");
});

test("evidence 空或全空白被 NO_EVIDENCE 拦截（No Evidence, No Finding）", () => {
  for (const evidence of [[], ["   "]] as const) {
    const out = applyCandidateGate({
      candidates: [{ ...VALID_CANDIDATE, evidence: [...evidence] }],
      verdicts: verdicts({ F001: { pass: true, reason: "" } }),
      emittedIds: new Set(),
      round: 1,
    });
    expect(out.rejections[0]?.stage, JSON.stringify(evidence)).toBe("NO_EVIDENCE");
  }
});

test("无裁决或裁决不通过被 VERIFICATION_FAILED 拦截", () => {
  const missing = applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: new Map(),
    emittedIds: new Set(),
    round: 1,
  });
  expect(missing.rejections[0]?.stage).toBe("VERIFICATION_FAILED");

  const rejected = applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: verdicts({ F001: { pass: false, reason: "evidence does not support the claim" } }),
    emittedIds: new Set(),
    round: 1,
  });
  expect(rejected.rejections[0]?.stage).toBe("VERIFICATION_FAILED");
  expect(rejected.rejections[0]?.reason).toContain("evidence does not support the claim");
});

test("已产出的内容键被 DUPLICATE_ID 拦截（不按 id 判重）", () => {
  const out = applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(["F001"]),
    emittedContentKeys: new Set([findingContentKey(VALID_CANDIDATE)]),
    round: 2,
  });
  expect(out.findings).toEqual([]);
  expect(out.rejections[0]?.stage).toBe("DUPLICATE_ID");
});

test("跨轮复用同一 id 但内容不同 → 不拦（模型每轮从 F001 重编是常态）", () => {
  const out = applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(["F001"]),
    emittedContentKeys: new Set([findingContentKey({ ...VALID_CANDIDATE, title: "Different issue" })]),
    round: 2,
  });
  expect(out.findings).toHaveLength(1);
  expect(out.rejections).toEqual([]);
});

test("同一轮同内容不同 id → 第二条按内容键拦截", () => {
  const out = applyCandidateGate({
    candidates: [VALID_CANDIDATE, { ...VALID_CANDIDATE, id: "F002" }],
    verdicts: verdicts({
      F001: { pass: true, reason: "" },
      F002: { pass: true, reason: "" },
    }),
    emittedIds: new Set(),
    round: 1,
  });
  expect(out.findings.map((finding) => finding.id)).toEqual(["F001"]);
  expect(out.rejections[0]?.stage).toBe("DUPLICATE_ID");
  expect(out.rejections[0]?.candidateId).toBe("F002");
});

test("裁决 id 对不上但条数一致 → 位置兜底，不让候选全灭", () => {
  const out = applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: verdicts({ "candidate-1": { pass: true, reason: "" } }),
    emittedIds: new Set(),
    round: 1,
  });
  expect(out.findings).toHaveLength(1);
  expect(out.rejections).toEqual([]);
});

test("缺 id 的候选以 round-N-candidate-I 兜底标识留痕", () => {
  const { id: _omit, ...noId } = VALID_CANDIDATE;
  const out = applyCandidateGate({
    candidates: [noId],
    verdicts: new Map(),
    emittedIds: new Set(),
    round: 3,
  });
  expect(out.rejections[0]?.candidateId).toBe("round-3-candidate-0");
});

test("入参 emittedIds 不被原地修改（不可变纪律）", () => {
  const emittedIds = new Set<string>();
  applyCandidateGate({
    candidates: [VALID_CANDIDATE],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds,
    round: 1,
  });
  expect(emittedIds.size).toBe(0);
});

test("非 diff 区域过滤：hunk 内保留，hunk 外按 OUT_OF_SCOPE 拦截", () => {
  const diff = [
    "diff --git a/src/Foo.java b/src/Foo.java",
    "--- a/src/Foo.java",
    "+++ b/src/Foo.java",
    "@@ -40,5 +40,5 @@",
    " line",
    " line",
    "+changed",
    " line",
    " line",
  ].join("\n");
  const scope = buildDiffScope(diff, 2);

  const kept = applyCandidateGate({
    candidates: [VALID_CANDIDATE], // src/Foo.java:42（hunk 40–44 + 前后 2 行）
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(),
    round: 1,
    scope,
  });
  expect(kept.findings).toHaveLength(1);
  expect(kept.rejections).toEqual([]);

  const outside = applyCandidateGate({
    candidates: [{ ...VALID_CANDIDATE, line: 100 }],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(),
    round: 1,
    scope,
  });
  expect(outside.findings).toEqual([]);
  expect(outside.rejections[0]?.stage).toBe("OUT_OF_SCOPE");
  expect(outside.rejections[0]?.reason).toContain("outside the changed hunks");
  expect(outside.rejections[0]?.reason).toContain("±2 lines");
});

test("非 diff 区域过滤：文件不在本遍 diff → OUT_OF_SCOPE（原因可区分）", () => {
  const diff = [
    "diff --git a/src/Foo.java b/src/Foo.java",
    "--- a/src/Foo.java",
    "+++ b/src/Foo.java",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
  const out = applyCandidateGate({
    candidates: [{ ...VALID_CANDIDATE, file: "src/Other.java" }],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(),
    round: 1,
    scope: buildDiffScope(diff, 10),
  });
  expect(out.findings).toEqual([]);
  expect(out.rejections[0]?.stage).toBe("OUT_OF_SCOPE");
  expect(out.rejections[0]?.reason).toContain("not part of the reviewed diff");
});

test("OUT_OF_SCOPE 先于 DUPLICATE_ID：范围外的重复候选只留一条拦截记录", () => {
  const diff = [
    "diff --git a/src/Foo.java b/src/Foo.java",
    "--- a/src/Foo.java",
    "+++ b/src/Foo.java",
    "@@ -1,1 +1,1 @@",
    "-old",
    "+new",
  ].join("\n");
  const out = applyCandidateGate({
    candidates: [{ ...VALID_CANDIDATE, line: 999 }],
    verdicts: verdicts({ F001: { pass: true, reason: "" } }),
    emittedIds: new Set(["F001"]),
    emittedContentKeys: new Set([findingContentKey({ ...VALID_CANDIDATE, line: 999 })]),
    round: 2,
    scope: buildDiffScope(diff, 10),
  });
  expect(out.rejections).toHaveLength(1);
  expect(out.rejections[0]?.stage).toBe("OUT_OF_SCOPE");
});

