import { expect, test } from "vitest";
import { mergeSkillCandidates } from "./candidate-merge.js";

// 跨 skill 候选合并（ADR-0014 决策 9）：候选门之前按 (file, line, category)
// 去重，CLI 顺序最先者胜出，被合并者计入 mergedCount，schema 非法者不参与。

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
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
    ...overrides,
  };
}

test("无 skill 批次时原样返回主候选", () => {
  const primary = [candidate(), candidate({ id: "F002", line: 50 })];
  const out = mergeSkillCandidates({ primary, batches: [] });
  expect(out.candidates).toEqual(primary);
  expect(out.mergedCounts).toEqual([]);
});

test("主候选在前，skill 候选按批次顺序追加", () => {
  const primary = [candidate()];
  const out = mergeSkillCandidates({
    primary,
    batches: [
      { skill: "a", candidates: [candidate({ id: "S001", line: 7 })] },
      { skill: "b", candidates: [candidate({ id: "S002", line: 9 })] },
    ],
  });
  expect(out.candidates.map((entry) => (entry as { id: string }).id)).toEqual(["F001", "S001", "S002"]);
  expect(out.mergedCounts).toEqual([0, 0]);
});

test("同 (file, line, category) 的 skill 候选被主候选合并", () => {
  const out = mergeSkillCandidates({
    primary: [candidate()],
    batches: [{ skill: "a", candidates: [candidate({ id: "S001", title: "same spot, other words" })] }],
  });
  expect(out.candidates).toHaveLength(1);
  expect((out.candidates[0] as { id: string }).id).toBe("F001");
  expect(out.mergedCounts).toEqual([1]);
});

test("跨 skill 重复：CLI 顺序最先的批次胜出", () => {
  const out = mergeSkillCandidates({
    primary: [],
    batches: [
      { skill: "a", candidates: [candidate({ id: "S001" })] },
      { skill: "b", candidates: [candidate({ id: "S002" }), candidate({ id: "S003", line: 43 })] },
      { skill: "c", candidates: [candidate({ id: "S004" })] },
    ],
  });
  expect(out.candidates.map((entry) => (entry as { id: string }).id)).toEqual(["S001", "S003"]);
  expect(out.mergedCounts).toEqual([0, 1, 1]);
});

test("同批次内重复也合并（先出现者胜出）", () => {
  const out = mergeSkillCandidates({
    primary: [],
    batches: [{ skill: "a", candidates: [candidate({ id: "S001" }), candidate({ id: "S002" })] }],
  });
  expect(out.candidates.map((entry) => (entry as { id: string }).id)).toEqual(["S001"]);
  expect(out.mergedCounts).toEqual([1]);
});

test("主候选内部重复不被去重（主路径行为零变化）", () => {
  const primary = [candidate(), candidate({ id: "F002" })];
  const out = mergeSkillCandidates({ primary, batches: [] });
  expect(out.candidates).toHaveLength(2);
});

test("schema 非法候选不参与去重，两条都留下（交给 SCHEMA_INVALID）", () => {
  const broken = candidate({ line: 0 });
  const out = mergeSkillCandidates({
    primary: [broken],
    batches: [{ skill: "a", candidates: [candidate({ id: "S001", line: 0 })] }],
  });
  expect(out.candidates).toHaveLength(2);
  expect(out.mergedCounts).toEqual([0]);
});

test("file / category 不同则不去重（语义冲突两条都留）", () => {
  const out = mergeSkillCandidates({
    primary: [candidate()],
    batches: [
      {
        skill: "a",
        candidates: [
          candidate({ id: "S001", file: "src/Bar.java" }),
          candidate({ id: "S002", category: "SECURITY" }),
        ],
      },
    ],
  });
  expect(out.candidates).toHaveLength(3);
  expect(out.mergedCounts).toEqual([0]);
});

test("存活批次与 mergedCounts 一一对应（Phase 6 清单只列存活项）", () => {
  const out = mergeSkillCandidates({
    primary: [candidate()],
    batches: [
      { skill: "a", candidates: [candidate({ id: "S001" }), candidate({ id: "S002", line: 7 })] },
      { skill: "b", candidates: [candidate({ id: "S003" })] },
    ],
  });
  expect(out.survivingBatches.map((batch) => batch.skill)).toEqual(["a", "b"]);
  expect(out.survivingBatches[0]?.candidates.map((entry) => (entry as { id: string }).id)).toEqual(["S002"]);
  expect(out.survivingBatches[1]?.candidates).toEqual([]);
});

test("入参不被原地修改", () => {
  const primary = [candidate()];
  const batches = [{ skill: "a", candidates: [candidate({ id: "S001" })] }];
  mergeSkillCandidates({ primary, batches });
  expect(primary).toHaveLength(1);
  expect(batches[0]?.candidates).toHaveLength(1);
});
