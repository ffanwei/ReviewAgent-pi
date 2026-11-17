import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, test } from "vitest";
import { buildSkillReviewBrief, detectSkillReview, isDocPath, buildSkillPhase5Override, buildSkillPhase6VerificationNote } from "./skill-review.js";

const tempDirs: string[] = [];

function tempRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-skill-review-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function diffFor(...paths: readonly string[]): string {
  return paths
    .map((filePath) =>
      [
        `diff --git a/${filePath} b/${filePath}`,
        `--- a/${filePath}`,
        `+++ b/${filePath}`,
        "@@ -1,1 +1,2 @@",
        " keep",
        "+added",
      ].join("\n"),
    )
    .join("\n");
}

function writeFile(repo: string, relativePath: string, content = "x\n"): void {
  const absolute = path.join(repo, ...relativePath.split("/"));
  mkdirSync(path.dirname(absolute), { recursive: true });
  writeFileSync(absolute, content, "utf8");
}

test("isDocPath：只认 Markdown / MDX / RST / AsciiDoc", () => {
  expect(isDocPath("SKILL.md")).toBe(true);
  expect(isDocPath("docs/a.MDX")).toBe(true);
  expect(isDocPath("docs/a.rst")).toBe(true);
  expect(isDocPath("docs/a.adoc")).toBe(true);
  expect(isDocPath("src/main.ts")).toBe(false);
  expect(isDocPath("scripts/run.sh")).toBe(false);
  expect(isDocPath("Makefile")).toBe(false);
});

test("变更的是 references 文件：向上找到 SKILL.md，按 doc 归属并整文件放行", () => {
  const repo = tempRepo();
  writeFile(repo, "skills/foo/SKILL.md", "---\nname: foo\ndescription: d\n---\n");
  writeFile(repo, "skills/foo/references/a.md");

  const profile = detectSkillReview(diffFor("skills/foo/references/a.md"), repo);

  expect(profile).toBeDefined();
  expect(profile?.roots).toHaveLength(1);
  expect(profile?.roots[0]?.root).toBe("skills/foo");
  expect(profile?.roots[0]?.manifest).toBe("skills/foo/SKILL.md");
  expect(profile?.roots[0]?.changedMembers).toEqual([
    { path: "skills/foo/references/a.md", role: "doc" },
  ]);
  expect(profile?.docFiles).toEqual(["skills/foo/references/a.md"]);
  expect(profile?.wholeFilePaths).toEqual(["skills/foo/references/a.md"]);
});

test("变更的是 SKILL.md：角色为 manifest，同样整文件放行", () => {
  const repo = tempRepo();
  writeFile(repo, "skills/foo/SKILL.md");

  const profile = detectSkillReview(diffFor("skills/foo/SKILL.md"), repo);

  expect(profile?.roots[0]?.changedMembers).toEqual([
    { path: "skills/foo/SKILL.md", role: "manifest" },
  ]);
  expect(profile?.wholeFilePaths).toEqual(["skills/foo/SKILL.md"]);
});

test("只改脚本：仍归属 skill 组，但不进入文档整文件集合", () => {
  const repo = tempRepo();
  writeFile(repo, "skills/foo/SKILL.md");
  writeFile(repo, "skills/foo/scripts/run.sh");

  const profile = detectSkillReview(diffFor("skills/foo/scripts/run.sh"), repo);

  expect(profile?.roots[0]?.changedMembers).toEqual([
    { path: "skills/foo/scripts/run.sh", role: "script" },
  ]);
  expect(profile?.docFiles).toEqual([]);
  expect(profile?.wholeFilePaths).toEqual([]);
  expect(buildSkillReviewBrief(profile!)).toContain("script");
});

test("没有 SKILL.md 祖先：不建组（全代码路径零漂移）", () => {
  const repo = tempRepo();
  writeFile(repo, "docs/a.md");

  expect(detectSkillReview(diffFor("docs/a.md"), repo)).toBeUndefined();
});

test("大小写变体 skill.md 也能识别为 manifest", () => {
  const repo = tempRepo();
  writeFile(repo, "skills/foo/skill.md");

  const profile = detectSkillReview(diffFor("skills/foo/skill.md"), repo);

  expect(profile?.roots[0]?.manifest).toBe("skills/foo/skill.md");
  expect(profile?.roots[0]?.changedMembers[0]?.role).toBe("manifest");
});

test("路径含 .. 不越出 repo 建组", () => {
  const repo = tempRepo();
  writeFile(repo, "skills/foo/SKILL.md");

  expect(detectSkillReview(diffFor("../outside.md"), repo)).toBeUndefined();
});

test("brief 列出根、成员角色与核验口径", () => {
  const repo = tempRepo();
  writeFile(repo, "skills/foo/SKILL.md");

  const profile = detectSkillReview(diffFor("skills/foo/SKILL.md"), repo);
  const brief = buildSkillReviewBrief(profile!);

  expect(brief).toContain("skills/foo");
  expect(brief).toContain("manifest");
  expect(brief).toContain("review.get_file");
  expect(brief).toContain("未变更的兄弟文件只能作为证据");
  expect(brief).toContain("Phase 5");
  expect(brief).toContain("Phase 6");
});

test("Phase 5 覆盖：文档证据 / tips 标记 / 严重级 / 文档示例", () => {
  const repo = tempRepo();
  writeFile(repo, "skills/foo/SKILL.md");
  writeFile(repo, "skills/foo/references/a.md");

  const profile = detectSkillReview(
    diffFor("skills/foo/SKILL.md", "skills/foo/references/a.md"),
    repo,
  );
  const override = buildSkillPhase5Override(profile!);

  expect(override).toContain("覆盖系统提示");
  expect(override).toContain("原文引文");
  expect(override).toContain("review.get_file");
  expect(override).toContain("[重构思路]");
  expect(override).toContain("代码示例");
  expect(override).toContain("P3 只用于措辞");
  expect(override).toContain("SKILL-REF-001");
  expect(override).toContain("可维护");
});

test("装载专用 skill 时：Phase 5 让出领域清单，只保留平台口径", () => {
  const repo = tempRepo();
  writeFile(repo, "skills/foo/SKILL.md");

  const profile = detectSkillReview(diffFor("skills/foo/SKILL.md"), repo);
  const override = buildSkillPhase5Override(profile!, { ruleSkillLoaded: true });

  expect(override).toContain("以其 SKILL.md 为准");
  expect(override).toContain("review.get_file");
  expect(override).not.toContain("SKILL-REF-001");
});

test("Phase 6 覆盖：只接受具体反驳，不以缺少代码符号驳回", () => {
  const note = buildSkillPhase6VerificationNote();
  expect(note).toContain("引文不符");
  expect(note).toContain("目标不存在");
  expect(note).toContain("缺少代码符号");
});

test("确定性引用核对：区分存在 / 缺失，跳过 URL、锚点、占位符与越界路径", () => {
  const repo = tempRepo();
  writeFile(repo, "skills/foo/references/a.md");
  writeFile(repo, "skills/foo/scripts/run.sh");
  writeFile(
    repo,
    "skills/foo/SKILL.md",
    [
      "# Foo",
      "See [a](references/a.md) and [missing](references/old.md).",
      "Use `scripts/run.sh`.",
      "External [x](https://example.com) and [anchor](#section).",
      "Placeholder `references/<name>.md`.",
      "Escape [e](../outside.md).",
    ].join("\n"),
  );

  const profile = detectSkillReview(diffFor("skills/foo/SKILL.md"), repo);
  const check = profile?.roots[0]?.referenceCheck;

  expect(check).toBeDefined();
  expect(check?.verified.map((ref) => ref.resolved)).toEqual([
    "skills/foo/references/a.md",
    "skills/foo/scripts/run.sh",
  ]);
  expect(check?.missing.map((ref) => ref.resolved)).toEqual(["skills/foo/references/old.md"]);
  expect(check?.missing[0]?.line).toBe(2);
  expect(check?.truncated).toBe(false);
});

test("引用事实进入初始 brief 与 Phase 5；专用 skill 在场时仍保留事实", () => {
  const repo = tempRepo();
  writeFile(
    repo,
    "skills/foo/SKILL.md",
    ["# Foo", "详见 [old](references/old.md)。"].join("\n"),
  );

  const profile = detectSkillReview(diffFor("skills/foo/SKILL.md"), repo);
  const brief = buildSkillReviewBrief(profile!, { ruleSkillLoaded: true });
  const phase5 = buildSkillPhase5Override(profile!, { ruleSkillLoaded: true });

  expect(brief).toContain("缺失引用");
  expect(brief).toContain("references/old.md");
  expect(phase5).toContain("确定性引用核对");
  expect(phase5).toContain("references/old.md");
});

test("manifest 没有可核对引用：事实行明确为“缺失引用：无”", () => {
  const repo = tempRepo();
  writeFile(repo, "skills/foo/SKILL.md", "# Foo\n");

  const profile = detectSkillReview(diffFor("skills/foo/SKILL.md"), repo);
  const brief = buildSkillReviewBrief(profile!);

  expect(profile?.roots[0]?.referenceCheck?.verified).toEqual([]);
  expect(profile?.roots[0]?.referenceCheck?.missing).toEqual([]);
  expect(brief).toContain("缺失引用：无");
});
