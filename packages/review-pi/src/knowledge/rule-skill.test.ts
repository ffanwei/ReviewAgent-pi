import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import {
  loadSkills,
  type Skill,
  type SkillDiagnostic,
} from "@earendil-works/pi-agent-core";
import { PHASE_INSTRUCTIONS } from "../loop/phases.js";
import { buildRuleSkillBrief, RULE_CHECK_PHASE_INDEX } from "./rule-skill-brief.js";
import {
  loadRuleSkill,
  RULE_SKILL_DIR_NAME,
  type RuleSkill,
  type RuleSkillSpawn,
} from "./rule-skill.js";

// 规则 Skill 装载器（S3 窄缝）：只测**外部可观测行为**——给定仓库快照 + 一个
// zip，可观测结果 = (装载出的 skill | 降级原因 | strict 抛错)。
// 解压腿用注入的假 `spawn` + 假 `loadSkillsFn` 全离线（安全矩阵用自造 zip
// 中央目录精确触发）；另留 1 个**真解压集成用例**（系统 tar/unzip）。
//
// fixture 用测试内自造的最小 zip builder（store / deflate 两法均支持；符号
// 链接靠中央目录的 Unix mode 位表达）——避免把二进制 zip 提交进仓库。

const temps: string[] = [];

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "rule-skill-"));
  temps.push(dir);
  return dir;
}

// ---- 最小 zip builder ----

interface ZipEntrySpec {
  readonly name: string;
  readonly data?: Buffer;
  /** 压缩法：0 = store（默认），8 = deflate */
  readonly method?: 0 | 8;
  /** 有值 = Unix 条目（external attributes 高 16 位 = 该 mode）；用于造符号链接 */
  readonly unixMode?: number;
}

const SIG_LOCAL = 0x04034b50;
const SIG_CENTRAL = 0x02014b50;
const SIG_EOCD = 0x06054b50;

function buildZip(entries: readonly ZipEntrySpec[]): Buffer {
  const local: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = entry.data ?? Buffer.alloc(0);
    const method = entry.method ?? 0;
    const body = method === 8 ? deflateRawSync(raw) : raw;
    const crc = crc32(raw) >>> 0;

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(SIG_LOCAL, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0, 6);
    localHeader.writeUInt16LE(method, 8);
    localHeader.writeUInt16LE(0, 10);
    localHeader.writeUInt16LE(0, 12);
    localHeader.writeUInt32LE(crc, 14);
    localHeader.writeUInt32LE(body.length, 18);
    localHeader.writeUInt32LE(raw.length, 22);
    localHeader.writeUInt16LE(nameBuf.length, 26);
    localHeader.writeUInt16LE(0, 28);
    local.push(localHeader, nameBuf, body);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(SIG_CENTRAL, 0);
    const unixMode = entry.unixMode ?? 0;
    centralHeader.writeUInt16LE(unixMode !== 0 ? (3 << 8) | 20 : 20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0, 8);
    centralHeader.writeUInt16LE(method, 10);
    centralHeader.writeUInt16LE(0, 12);
    centralHeader.writeUInt16LE(0, 14);
    centralHeader.writeUInt32LE(crc, 16);
    centralHeader.writeUInt32LE(body.length, 20);
    centralHeader.writeUInt32LE(raw.length, 24);
    centralHeader.writeUInt16LE(nameBuf.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE((unixMode << 16) >>> 0, 38);
    centralHeader.writeUInt32LE(offset, 42);
    central.push(centralHeader, nameBuf);

    offset += localHeader.length + nameBuf.length + body.length;
  }

  const centralBody = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(SIG_EOCD, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBody.length, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);

  return Buffer.concat([...local, centralBody, eocd]);
}

const SKILL_MD = `---
name: sample-rule
description: Sample project rule skill
---
Check every public method for a null guard.
`;

function writeZip(dir: string, name: string, entries: readonly ZipEntrySpec[]): string {
  mkdirSync(dir, { recursive: true });
  const target = path.join(dir, name);
  writeFileSync(target, buildZip(entries));
  return target;
}

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function readBytes(target: string): Buffer {
  return readFileSync(target);
}

// ---- 注入缝 ----

function recordingSpawn(): { spawnFn: RuleSkillSpawn; calls: string[] } {
  const calls: string[] = [];
  const spawnFn: RuleSkillSpawn = async (command) => {
    calls.push(command);
    return { code: 0, stdout: "", stderr: "" };
  };
  return { spawnFn, calls };
}

function fakeLoader(
  skills: readonly Skill[],
  diagnostics: readonly SkillDiagnostic[] = [],
): typeof loadSkills {
  return (async () => ({ skills: [...skills], diagnostics: [...diagnostics] })) as unknown as typeof loadSkills;
}

function sampleSkill(overrides: Partial<Skill> = {}): Skill {
  return {
    name: "sample-rule",
    description: "Sample project rule skill",
    content: "Check every public method for a null guard.",
    filePath: "/host/absolute/cache/sample-rule/SKILL.md",
    ...overrides,
  };
}

// ---- 正常装载 / 降级 ----

test("正常装载：定位约定目录 zip → 解压 → 装载单一 skill，digest = zip sha256", async () => {
  const repo = tempRoot();
  const zipPath = writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn, calls } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });

  expect(skill.degradedReason).toBeUndefined();
  expect(skill.name).toBe("sample-rule");
  expect(skill.digest).toBe(sha256(await readBytes(zipPath)));
  expect(skill.source).toEqual({ kind: "zip", path: ".review-rules/rules.zip" });
  expect(calls).toHaveLength(1);
});

test("降级：约定目录缺席 → degradedReason 含 .review-rules（run 照常）", async () => {
  const repo = tempRoot();
  const skill = await loadRuleSkill({ repoPath: repo, cacheRoot: path.join(repo, "cache") });
  expect(skill.degradedReason).toContain(RULE_SKILL_DIR_NAME);
  expect(skill.name).toBe("");
  expect(skill.digest).toBe("");
});

test("降级：多 zip 且未指定 name → 要求消歧", async () => {
  const repo = tempRoot();
  const dir = path.join(repo, RULE_SKILL_DIR_NAME);
  writeZip(dir, "a.zip", [{ name: "a/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  writeZip(dir, "b.zip", [{ name: "b/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });
  expect(skill.degradedReason).toContain("multiple rule-skill archives");
});

test("--rule-skill-name 选中：多 zip 时命中指定名，落非降级", async () => {
  const repo = tempRoot();
  const dir = path.join(repo, RULE_SKILL_DIR_NAME);
  writeZip(dir, "a.zip", [{ name: "alpha/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  writeZip(dir, "b.zip", [{ name: "beta/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    skillName: "beta",
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill({ name: "beta" })]),
  });
  expect(skill.degradedReason).toBeUndefined();
  expect(skill.name).toBe("beta");
});

test("降级：包内无 SKILL.md（装载器交回空 skill 列表）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "sample-rule/README.md", data: Buffer.from("no skill here") },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([]),
  });
  expect(skill.degradedReason).toContain("no loadable rule skill");
});

// ---- 安全矩阵（解压前审计） ----

test("Zip Slip：条目名含 ../escape 被整包拒绝（降级）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "../escape/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });
  expect(skill.degradedReason).toContain("unsafe path");
});

test("绝对路径条目被拒（降级）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "/etc/passwd", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });
  expect(skill.degradedReason).toContain("unsafe path");
});

test("符号链接条目被拒（降级）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "link", data: Buffer.from("target"), unixMode: 0xa000 },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });
  expect(skill.degradedReason).toContain("symbolic link");
});

test("单包尺寸超限被拒（8 MiB 上界，测试用窄上界触发）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
    limits: { maxArchiveBytes: 10, maxEntries: 2000, maxTotalUncompressed: 1 << 20, maxCompressionRatio: 100, timeoutMs: 30_000 },
  });
  expect(skill.degradedReason).toContain("exceeds");
});

test("条目数超限被拒（降级）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "a.txt", data: Buffer.from("a") },
    { name: "b.txt", data: Buffer.from("b") },
    { name: "c.txt", data: Buffer.from("c") },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
    limits: { maxArchiveBytes: 1 << 20, maxEntries: 2, maxTotalUncompressed: 1 << 20, maxCompressionRatio: 100, timeoutMs: 30_000 },
  });
  expect(skill.degradedReason).toContain("too many entries");
});

test("解压炸弹（高压缩比）被拒（降级）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "bomb.bin", data: Buffer.alloc(200_000), method: 8 },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
    limits: { maxArchiveBytes: 1 << 20, maxEntries: 2000, maxTotalUncompressed: 100_000_000, maxCompressionRatio: 2, timeoutMs: 30_000 },
  });
  expect(skill.degradedReason).toContain("compression ratio");
});

test("解压后总字节超限被拒（降级）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "big.bin", data: Buffer.alloc(5_000) },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
    limits: { maxArchiveBytes: 1 << 20, maxEntries: 2000, maxTotalUncompressed: 1_000, maxCompressionRatio: 100, timeoutMs: 30_000 },
  });
  expect(skill.degradedReason).toContain("expands to");
});

test("非 zip 字节被拒（降级）", async () => {
  const repo = tempRoot();
  const dir = path.join(repo, RULE_SKILL_DIR_NAME);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "rules.zip"), "this is not a zip");
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });
  expect(skill.degradedReason).toContain("not a zip archive");
});

// ---- 解压失败 / 脱敏 / strict ----

test("解压失败 → 降级，且错误文本已脱敏（无宿主绝对路径）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const failingSpawn: RuleSkillSpawn = async () => ({
    code: 1,
    stdout: "",
    stderr: "tar: error opening C:\\Users\\secret\\repo\\.review-rules\\rules.zip",
  });

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: failingSpawn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });
  expect(skill.degradedReason).toBeDefined();
  expect(skill.degradedReason).not.toContain("secret");
  expect(skill.degradedReason).toContain("<path>");
});

test("缓存命中：同 zip 二次装载不再解压（spawn 只调一次）", async () => {
  const repo = tempRoot();
  const zipPath = writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn, calls } = recordingSpawn();
  const options = {
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  };

  const first = await loadRuleSkill(options);
  const second = await loadRuleSkill(options);

  expect(first.degradedReason).toBeUndefined();
  expect(second.degradedReason).toBeUndefined();
  expect(second.digest).toBe(first.digest);
  expect(calls).toHaveLength(1);
  // zip 未被触碰（解压缓存不写回仓库）
  expect(sha256(await readBytes(zipPath))).toBe(first.digest);
});

test("strict 模式：装载失败抛错（CI 可要求包必须成功）", async () => {
  const repo = tempRoot();
  await expect(
    loadRuleSkill({ repoPath: repo, cacheRoot: path.join(repo, "cache"), strict: true }),
  ).rejects.toThrow(/rule skill unavailable/);
});

test("诊断透传：内核 diagnostic 的 path 净化为缓存目录相对 POSIX", async () => {
  const repo = tempRoot();
  const zipPath = writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const digest = sha256(await readBytes(zipPath));
  const cacheDir = path.join(repo, "cache", digest);
  const { spawnFn } = recordingSpawn();
  const diagnostic: SkillDiagnostic = {
    type: "warning",
    code: "invalid_metadata",
    message: "name mismatch",
    path: path.join(cacheDir, "sample-rule", "SKILL.md"),
  };

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()], [diagnostic]),
  });

  expect(skill.diagnostics).toHaveLength(1);
  expect(skill.diagnostics[0]?.path).toBe("sample-rule/SKILL.md");
  expect(skill.diagnostics[0]?.path).not.toContain(repo);
});

test("显式 zip 路径优先于约定目录（source.path 原样 POSIX 化）", async () => {
  const repo = tempRoot();
  const explicitDir = tempRoot();
  const zipPath = writeZip(explicitDir, "from-elsewhere.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadRuleSkill({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    explicitZipPath: zipPath,
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });

  expect(skill.degradedReason).toBeUndefined();
  expect(skill.source.path).toBe(zipPath.split(path.sep).join("/"));
});

// ---- 简报（稳定伪路径 / 约定段 / 阶段对齐） ----

test("简报：RULE_CHECK_PHASE_INDEX 与候选阶段指令对齐", () => {
  expect(RULE_CHECK_PHASE_INDEX).toBe(4);
  expect(PHASE_INSTRUCTIONS[RULE_CHECK_PHASE_INDEX]).toContain("Phase 5 of 6");
  expect(PHASE_INSTRUCTIONS[RULE_CHECK_PHASE_INDEX]).toContain("candidates");
});

test("简报：使用稳定伪路径，绝不泄露宿主绝对路径；含三条硬约定", () => {
  const skill: RuleSkill = {
    name: "sample-rule",
    description: "Sample project rule skill",
    content: "Check every public method for a null guard.",
    filePath: "/host/absolute/cache/deadbeef/sample-rule/SKILL.md",
    digest: "deadbeef",
    source: { kind: "zip", path: ".review-rules/rules.zip" },
    diagnostics: [],
  };

  const brief = buildRuleSkillBrief(skill);

  expect(brief).toContain('<skill name="sample-rule" location=".review-rules/sample-rule/SKILL.md">');
  expect(brief).toContain("References are relative to .review-rules/sample-rule.");
  expect(brief).toContain(skill.content);
  expect(brief).toContain("ENGLISH ONLY");
  expect(brief).toContain("RULE-CHECK@<file>:<line>");
  expect(brief).toContain("Evidence is mandatory");
  expect(brief).toContain('"rule" field to the skill name "sample-rule"');
  // 净化：绝无宿主绝对路径 / digest 缓存目录
  expect(brief).not.toContain("/host/absolute");
  expect(brief).not.toContain("deadbeef");
});

// ---- 真解压集成（系统 tar / unzip；Windows 亦有 tar.exe） ----

test("真解压集成：默认 spawn + 默认 loadSkills 从 zip 装载 SKILL.md", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, RULE_SKILL_DIR_NAME), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
    { name: "sample-rule/notes.txt", data: Buffer.from("plain data file, never executed") },
  ]);

  const skill = await loadRuleSkill({ repoPath: repo, cacheRoot: path.join(repo, "cache") });

  expect(skill.degradedReason).toBeUndefined();
  expect(skill.name).toBe("sample-rule");
  expect(skill.description).toBe("Sample project rule skill");
  expect(skill.content).toContain("Check every public method");
});
