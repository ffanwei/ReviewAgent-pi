import { expect, test } from "vitest";
import type { RuleSkill } from "./rule-skill.js";
import {
  buildSkillCandidatesBrief,
  buildSkillPassInvocation,
  skillCandidateIdTemplate,
} from "./skill-pass-brief.js";

// skill 检视会话提示词（ADR-0014 / ADR-0090 中文原生）：会话首消息 =
// skill 块 + 输出契约；Phase 6 简报 = 存活候选清单（无候选 ⇒ undefined，
// 阶段消息逐字节不变）。

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
    category: "可靠性",
    file: "src/Foo.java",
    line: 42,
    title: "空指针解引用",
    description: "该调用点的返回值可能为 null。",
    evidence: ["method Foo.bar at src/Foo.java:42"],
    rule: "sample-rule",
    confidence: 0.7,
    tips: {
      review: "[缺陷类型] 未判空即解引用。影响评估：抛 NullPointerException。",
      suggestion: "[重构思路] 判空。代码示例：`if (x == null) return;`",
      subcategory: "空指针安全",
    },
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
  expect(prompt).toContain('{"candidates": [<符合 Finding 模式的对象>, ...]}');
  expect(prompt).toContain("RULE-CHECK@sample-rule@<file>:<line>");
  expect(prompt).toContain('"rule" 字段填该意见违反的本 skill rules/ 里具体规则的 frontmatter id');
  expect(prompt).toContain('如 "GEN-SQL-001"');
  expect(prompt).toContain('只有无法对应到单条规则时才用 "sample-rule"');
  expect(prompt).toContain("自然语言字段（title / description / tips 各字段）一律中文");
  expect(prompt).toContain("证据必填");
  // 规则 Skill 去重软约束：硬去重仍由 category 归一 + candidate-merge 承担
  expect(prompt).toContain("不要重复主会话已报告的同一文件同一行的问题");
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
    '{"id":"RULE-CHECK@sample-rule@src/Foo.java:42","severity":"P1","category":"可靠性","file":"src/Foo.java","line":42,"title":"空指针解引用"',
  );
  // 键序固定：与入参键序无关（id 恒在首位）
  expect(text.indexOf('"id"')).toBeLessThan(text.indexOf('"severity"'));
  expect(text).toContain("上面每条候选 id 都必须出现在你的 verdicts 数组里");
});

test("schema 非法候选原样序列化（交给候选拦截链的 SCHEMA_INVALID）", () => {
  const brief = buildSkillCandidatesBrief([
    { skill: "a", candidates: [{ id: "broken", line: 0 }] },
  ]);
  expect(brief).toContain('{"id":"broken","line":0}');
});
