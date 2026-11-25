import { expect, test } from "vitest";

import { parseCliArgs } from "./args.js";

test("repo-spike：最小 dry-run 参数", () => {
  expect(parseCliArgs(["repo-spike", "--repo", "repo", "--dry-run"])).toEqual({
    ok: true,
    command: "repo-spike",
    args: {
      repo: "repo",
      outDir: "repo-spike-out",
      groupBy: "directory",
      maxFilesPerGroup: 10,
      maxGroupChars: 120_000,
      maxGroups: 500,
      maxFiles: 2_000,
      maxFileChars: 100_000,
      maxRounds: 1,
      groupConcurrency: 1,
      includeTests: false,
      dryRun: true,
    },
  });
});

test("repo-review：产品命令名与独立缺省输出目录", () => {
  expect(parseCliArgs(["repo-review", "--repo", "repo", "--dry-run"])).toEqual({
    ok: true,
    command: "repo-review",
    args: {
      repo: "repo",
      outDir: "repo-review-out",
      groupBy: "directory",
      maxFilesPerGroup: 10,
      maxGroupChars: 120_000,
      maxGroups: 500,
      maxFiles: 2_000,
      maxFileChars: 100_000,
      maxRounds: 1,
      groupConcurrency: 1,
      includeTests: false,
      dryRun: true,
    },
  });
  expect(parseCliArgs(["repo-review", "--dry-run"])).toEqual({
    ok: false,
    message: "repo-review requires --repo <path>",
  });
});

test("repo-spike：分组、上限、规则包与进度旗标", () => {
  expect(
    parseCliArgs([
      "repo-spike",
      "--repo",
      "repo",
      "--out",
      "out",
      "--group-by",
      "files",
      "--max-files-per-group",
      "3",
      "--max-group-chars",
      "5000",
      "--max-groups",
      "9",
      "--max-files",
      "7",
      "--max-file-chars",
      "9000",
      "--max-rounds",
      "2",
      "--group-concurrency",
      "2",
      "--path",
      "src",
      "--rule-skill",
      "a,b",
      "--rule-skill",
      "c",
      "--rule-skill-zip",
      "z.zip",
      "--skill",
      "s",
      "--strict-rule-skill",
      "--include-tests",
      "--no-progress",
      "--config",
      "cfg.json",
    ]),
  ).toEqual({
    ok: true,
    command: "repo-spike",
    args: {
      repo: "repo",
      outDir: "out",
      groupBy: "files",
      maxFilesPerGroup: 3,
      maxGroupChars: 5_000,
      maxGroups: 9,
      maxFiles: 7,
      maxFileChars: 9_000,
      maxRounds: 2,
      groupConcurrency: 2,
      includeTests: true,
      dryRun: false,
      pathPrefix: "src",
      configPath: "cfg.json",
      ruleSkillZips: ["z.zip"],
      ruleSkillDirs: ["a", "b", "c", "s"],
      strictRuleSkill: true,
      progress: false,
    },
  });
});

test("repo-spike：缺 --repo / 非法 group-by / 非法整数 / 未知旗标", () => {
  expect(parseCliArgs(["repo-spike", "--dry-run"])).toEqual({
    ok: false,
    message: "repo-spike requires --repo <path>",
  });
  expect(parseCliArgs(["repo-spike", "--repo", "r", "--group-by", "module"])).toEqual({
    ok: false,
    message:
      'invalid --group-by "module" (expected directory, files, language or none)',
  });
  expect(parseCliArgs(["repo-spike", "--repo", "r", "--max-files-per-group", "0"])).toEqual({
    ok: false,
    message: 'invalid --max-files-per-group "0": expected 1..1000',
  });
  expect(parseCliArgs(["repo-spike", "--repo", "r", "--nope", "x"])).toEqual({
    ok: false,
    message: 'unknown flag "--nope"',
  });
});
