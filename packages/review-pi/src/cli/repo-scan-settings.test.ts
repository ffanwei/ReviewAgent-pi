import { describe, expect, test } from "vitest";

import { DEFAULT_LIMITS } from "../shared/config-limits.js";
import type { ResolvedConfig } from "../shared/config.js";
import type { RepoSpikeCliArgs } from "./args.js";
import { resolveRepoScanSettings } from "./repo-scan-settings.js";

function args(overrides: Partial<RepoSpikeCliArgs> = {}): RepoSpikeCliArgs {
  return {
    repo: "repo",
    taskId: "t1",
    resume: false,
    dryRun: false,
    ...overrides,
  };
}

function configWithRepoScan(overrides: Partial<ResolvedConfig["limits"]["repoScan"]>): ResolvedConfig {
  return {
    version: 1,
    reviewer: {
      apiKey: null,
      baseUrl: "http://example.invalid",
      maxOutputTokens: null,
      contextWindow: null,
      stripModelPrefix: false,
      modelFallback: "off",
    },
    model: { default: "test-model", presentation: null },
    codeintel: { languages: "auto", excludeGlobs: [] },
    limits: {
      ...DEFAULT_LIMITS,
      repoScan: { ...DEFAULT_LIMITS.repoScan, ...overrides },
    },
    mcp: null,
    path: "PiAgent.jsonc",
    exists: true,
    overridden: [],
    digest: "",
  };
}

describe("resolveRepoScanSettings：CLI > 配置 > 内置缺省", () => {
  test("无配置、无旗标 → 内置缺省（5 / 80k / 120k）", () => {
    expect(resolveRepoScanSettings(args(), undefined)).toEqual(DEFAULT_LIMITS.repoScan);
  });

  test("配置覆盖内置缺省", () => {
    const config = configWithRepoScan({
      groupBy: "language",
      maxFilesPerGroup: 8,
      maxGroupChars: 80_000,
      includeTests: true,
      includeRegex: ["^src/"],
      excludeRegex: ["\\.test\\.ts$"],
    });
    expect(resolveRepoScanSettings(args(), config)).toMatchObject({
      groupBy: "language",
      maxFilesPerGroup: 8,
      maxGroupChars: 80_000,
      includeTests: true,
      includeRegex: ["^src/"],
      excludeRegex: ["\\.test\\.ts$"],
    });
  });

  test("CLI 显式旗标覆盖配置；未传的字段仍取配置", () => {
    const config = configWithRepoScan({
      maxFilesPerGroup: 8,
      maxGroupChars: 80_000,
      groupConcurrency: 4,
      includeRegex: ["^src/"],
    });
    expect(
      resolveRepoScanSettings(
        args({ maxFilesPerGroup: 3, groupBy: "files" }),
        config,
      ),
    ).toMatchObject({
      groupBy: "files",
      maxFilesPerGroup: 3,
      maxGroupChars: 80_000,
      groupConcurrency: 4,
      includeRegex: ["^src/"],
    });
  });

  test("CLI 传空 --include → 本次清空配置白名单", () => {
    const config = configWithRepoScan({ includeRegex: ["^src/"] });
    expect(
      resolveRepoScanSettings(args({ includePatterns: [] }), config).includeRegex,
    ).toEqual([]);
  });
});
