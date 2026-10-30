import { expect, test } from "vitest";
import type { RuleSkill } from "./rule-skill.js";
import {
  buildSkillCandidatesBrief,
  buildSkillPassInvocation,
  skillCandidateIdTemplate,
} from "./skill-pass-brief.js";

// skill 检视会话提示词（ADR-0014）：会话首消息 = skill 块 + 输出契约；
// Phase 6 简报 = 存活候选清单（无候选 ⇒ undefined，阶段消息逐字节不变）。

const SKILL: RuleSkill = {
  name: "sample-rule",
  description: "Sample project rule skill",
  content: "Check every public method for a null guard.",
  filePath: "C:\\cache\\deadbeef\\sample-rule\\SKILL.md",
  digest: "deadbeef",
  source: { kind: "zip", path: ".review-rules/rules.zip" },
  diagnostics: [],
};

function candidate(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "RULE-CHECK@sample-rule@src/Foo.java:42",
    severity: "P1",
    category: "CORRECTNESS",
    file: "src/Foo.java",
    line: 42,
    title: "Null dereference",
    description: "The value may be null at this call site.",
    evidence: ["method Foo.bar at src/Foo.java:42"],
    rule: "sample-rule",
    confidence: 0.7,
    ...overrides,
  };
}

test("会话首消息：内核 skill 块（真实 pack 路径）+ 宿主平台提示 + 输出契约", () => {
  const prompt = buildSkillPassInvocation(SKILL, { platform: "win32", arch: "x64" });

  expect(prompt).toContain('<skill name="sample-rule" location="C:\\cache\\deadbeef\\sample-rule\\SKILL.md">');
  expect(prompt).toContain("References are relative to C:\\cache\\deadbeef\\sample-rule.");
  expect(prompt).toContain(SKILL.content);
  // ADR-0020：平台信息进会话指令（按当前 OS 选 bash 命令）
  expect(prompt).toContain("Host platform: Windows (win32, x64)");
  expect(prompt).toContain("prefer `python` over `python3`");
  expect(prompt).toContain('{"candidates": [<finding objects per the Finding schema>, ...]}');
  expect(prompt).toContain("RULE-CHECK@sample-rule@<file>:<line>");
  expect(prompt).toContain('"rule" field to the id of the specific rule from this skill\'s rules/');
  expect(prompt).toContain('e.g. "GEN-SQL-001"');
  expect(prompt).toContain('Use "sample-rule" only when the finding does not map to any single rule');
  expect(prompt).toContain("ENGLISH ONLY");
  expect(prompt).toContain("Evidence is mandatory");
  expect(prompt).toContain('{"candidates": []}');
});

test("会话首消息缺省用当前进程平台（有平台行即可；不钉死具体 OS）", () => {
  const prompt = buildSkillPassInvocation(SKILL);
  expect(prompt).toMatch(/Host platform: .+ \((win32|darwin|linux|freebsd|openbsd|sunos|aix|android), .+\)/);
});

test("候选 id 形态不含 round（跨轮稳定）", () => {
  expect(skillCandidateIdTemplate("beta")).toBe("RULE-CHECK@beta@<file>:<line>");
});

test("无候选（无批次 / 批次全空）⇒ undefined（阶段消息逐字节不变）", () => {
  expect(buildSkillCandidatesBrief([])).toBeUndefined();
  expect(
    buildSkillCandidatesBrief([
      { skill: "a", candidates: [] },
      { skill: "b", candidates: [] },
    ]),
  ).toBeUndefined();
});

test("候选清单：按 skill 分组、固定键序、提示逐条裁定", () => {
  const shuffled = {
    confidence: 0.7,
    rule: "sample-rule",
    line: 42,
    file: "src/Foo.java",
    category: "CORRECTNESS",
    severity: "P1",
    id: "RULE-CHECK@sample-rule@src/Foo.java:42",
    title: "Null dereference",
    description: "The value may be null at this call site.",
    evidence: ["method Foo.bar at src/Foo.java:42"],
  };
  const brief = buildSkillCandidatesBrief([
    { skill: "a", candidates: [candidate()] },
    { skill: "b", candidates: [] },
    { skill: "c", candidates: [candidate({ id: "S002", line: 9 })] },
  ]);

  expect(brief).toBeDefined();
  const text = brief as string;
  expect(text).toContain('<skill name="a">');
  expect(text).toContain('<skill name="c">');
  expect(text).not.toContain('<skill name="b">');
  expect(text).toContain(
    '{"id":"RULE-CHECK@sample-rule@src/Foo.java:42","severity":"P1","category":"CORRECTNESS","file":"src/Foo.java","line":42,"title":"Null dereference"',
  );
  // 键序固定：与入参键序无关（id 恒在首位）
  expect(text.indexOf('"id"')).toBeLessThan(text.indexOf('"severity"'));
  expect(text).toContain("must appear in your verdicts array");
});

test("schema 非法候选原样序列化（交给候选拦截链的 SCHEMA_INVALID）", () => {
  const brief = buildSkillCandidatesBrief([
    { skill: "a", candidates: [{ id: "broken", line: 0 }] },
  ]);
  expect(brief).toContain('{"id":"broken","line":0}');
});
