import { expect, test } from "vitest";

import { parseCliArgs } from "./args.js";

test("repo-spike：最小 dry-run 参数（任务目录缺省，不落 outDir）", () => {
  expect(
    parseCliArgs(["repo-spike", "--repo", "repo", "--taskId", "t1", "--dry-run"]),
  ).toEqual({
    ok: true,
    command: "repo-spike",
    args: {
      repo: "repo",
      taskId: "t1",
      resume: false,
      dryRun: true,
    },
  });
});

test("repo-review：产品命令名与任务目录缺省", () => {
  expect(
    parseCliArgs(["repo-review", "--repo", "repo", "--taskId", "t1", "--dry-run"]),
  ).toEqual({
    ok: true,
    command: "repo-review",
    args: {
      repo: "repo",
      taskId: "t1",
      resume: false,
      dryRun: true,
    },
  });
  expect(parseCliArgs(["repo-review", "--dry-run"])).toEqual({
    ok: false,
    message: "repo-review requires --repo <path>",
  });
});

test("repo-spike：分组、上限、路径过滤、规则包与进度旗标", () => {
  expect(
    parseCliArgs([
      "repo-spike",
      "--repo",
      "repo",
      "--taskId",
      "t1",
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
      "--include",
      "src/.+\\.ts$",
      "--exclude",
      ".*\\.test\\.ts$",
      "--files",
      "src/a.ts",
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
      taskId: "t1",
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
      resume: false,
      dryRun: false,
      pathPrefix: "src",
      files: ["src/a.ts"],
      includePatterns: ["src/.+\\.ts$"],
      excludePatterns: [".*\\.test\\.ts$"],
      configPath: "cfg.json",
      ruleSkillZips: ["z.zip"],
      ruleSkillDirs: ["a", "b", "c", "s"],
      strictRuleSkill: true,
      progress: false,
    },
  });
});

test("repo-spike：缺 --repo / 缺 --taskId / 非法 group-by / 非法整数 / 未知旗标", () => {
  expect(parseCliArgs(["repo-spike", "--dry-run"])).toEqual({
    ok: false,
    message: "repo-spike requires --repo <path>",
  });
  expect(parseCliArgs(["repo-spike", "--repo", "r", "--dry-run"])).toEqual({
    ok: false,
    message: "missing required flag --taskId (output goes to <tasks root>/<taskId>)",
  });
  expect(
    parseCliArgs(["repo-spike", "--repo", "r", "--taskId", "t", "--group-by", "module"]),
  ).toEqual({
    ok: false,
    message:
      'invalid --group-by "module" (expected directory, files, language or none)',
  });
  expect(
    parseCliArgs([
      "repo-spike",
      "--repo",
      "r",
      "--taskId",
      "t",
      "--max-files-per-group",
      "0",
    ]),
  ).toEqual({
    ok: false,
    message: 'invalid --max-files-per-group "0": expected 1..1000',
  });
  expect(parseCliArgs(["repo-spike", "--repo", "r", "--nope", "x"])).toEqual({
    ok: false,
    message: 'unknown flag "--nope"',
  });
});

test("repo-review：--resume / 总预算 / 组尝试次数", () => {
  const parsed = parseCliArgs([
    "repo-review",
    "--repo",
    "r",
    "--taskId",
    "t",
    "--resume",
    "--max-total-tokens",
    "1234",
    "--group-attempts",
    "3",
  ]);
  expect(parsed).toMatchObject({
    ok: true,
    command: "repo-review",
    args: {
      resume: true,
      maxTotalTokens: 1234,
      groupAttempts: 3,
    },
  });
});

test("repo-review：--tasks-dir / --taskId / --out 覆盖", () => {
  expect(
    parseCliArgs([
      "repo-review",
      "--repo",
      "r",
      "--taskId",
      "repo-task-1",
      "--tasks-dir",
      "D:/tasks",
    ]),
  ).toMatchObject({
    ok: true,
    command: "repo-review",
    args: {
      taskId: "repo-task-1",
      tasksDir: "D:/tasks",
    },
  });
  expect(parseCliArgs(["repo-review", "--repo", "r", "--taskId", "../x"])).toMatchObject({
    ok: false,
    message: expect.stringContaining("--taskId"),
  });
  expect(
    parseCliArgs([
      "repo-review",
      "--repo",
      "r",
      "--taskId",
      "t",
      "--tasks-dir",
      " ",
    ]),
  ).toEqual({
    ok: false,
    message: 'invalid --tasks-dir " ": must be a non-empty directory path',
  });
});

test("repo-review：--model 接受但忽略；非法正则逐条登记", () => {
  const parsed = parseCliArgs([
    "repo-review",
    "--repo",
    "r",
    "--taskId",
    "t",
    "--model",
    "some/model",
    "--include",
    "[",
    "--exclude",
    "src/.+\\.ts$",
  ]);
  expect(parsed).toMatchObject({
    ok: true,
    command: "repo-review",
    args: {
      ignoredModel: { raw: "some/model" },
      excludePatterns: ["src/.+\\.ts$"],
      ignoredPathFilterPatterns: [
        { flag: "--include", pattern: "[", reason: expect.any(String) },
      ],
    },
  });
});
