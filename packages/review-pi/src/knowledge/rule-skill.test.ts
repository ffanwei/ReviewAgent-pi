import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { crc32, deflateRawSync } from "node:zlib";
import { afterEach, expect, test } from "vitest";
import {
  loadSkills,
  type Skill,
  type SkillDiagnostic,
} from "@earendil-works/pi-agent-core";
import {
  loadRuleSkills,
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

/**
 * 测试固定的 zip 投放目录。ADR-0027 之后装载器**不再自动扫描**它，所以每个
 * 用例都必须显式把路径传进去——这里保留目录名只是为了让 source.path 的
 * 仓库相对形态（".review-rules/x.zip"）继续可断言。
 */
const FIXTURE_ZIP_DIR = ".review-rules";

/** 该 fixture 仓库里现存的 zip（文件名序） */
function fixtureZips(repo: string): string[] {
  try {
    return readdirSync(path.join(repo, FIXTURE_ZIP_DIR))
      .filter((name) => name.toLowerCase().endsWith(".zip"))
      .sort()
      .map((name) => path.join(repo, FIXTURE_ZIP_DIR, name));
  } catch {
    return [];
  }
}

/**
 * 单包读法（生产只有多包入口 `loadRuleSkills`）：取第一个装载结果。
 * 装载不到 = 测试自身的前提没造对，直接炸出来。
 */
async function loadOne(options: Parameters<typeof loadRuleSkills>[0]): Promise<RuleSkill> {
  const [first] = await loadRuleSkills(withFixtureZips(options));
  if (first === undefined) {
    throw new Error("expected the loader to return one rule skill");
  }
  return first;
}

/** 用例没显式给 zip 时，按 fixture 目录补齐（等价于 CLI 的 --rule-skill-zip） */
function withFixtureZips<
  T extends { repoPath: string; explicitZipPaths?: readonly string[]; explicitZipPath?: string },
>(options: T): T {
  if (options.explicitZipPaths !== undefined || options.explicitZipPath !== undefined) {
    return options;
  }
  return { ...options, explicitZipPaths: fixtureZips(options.repoPath) };
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

test("正常装载：显式 zip → 解压 → 装载单一 skill，digest = zip sha256", async () => {
  const repo = tempRoot();
  const zipPath = writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn, calls } = recordingSpawn();

  const skill = await loadOne({
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

test("N=0：没有任何显式规则包 ⇒ 空数组（不是降级条目；strict 才抛，ADR-0014 决策 15）", async () => {
  const repo = tempRoot();
  // 仓库里即使真放着 .review-rules/*.zip 也不再被自动装载（ADR-0027）
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "ignored.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const options = { repoPath: repo, cacheRoot: path.join(repo, "cache") };
  expect(await loadRuleSkills(options)).toEqual([]);
  await expect(loadRuleSkills({ ...options, strict: true })).rejects.toThrow(
    /no rule-skill archive given/,
  );
});

test("多 zip 全装：显式列表文件名序 = 装载序（ADR-0014）", async () => {
  const repo = tempRoot();
  const dir = path.join(repo, FIXTURE_ZIP_DIR);
  writeZip(dir, "b.zip", [{ name: "beta/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  writeZip(dir, "a.zip", [{ name: "alpha/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  const { spawnFn } = recordingSpawn();
  let call = 0;

  const skills = await loadRuleSkills({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    explicitZipPaths: fixtureZips(repo),
    spawn: spawnFn,
    loadSkillsFn: (async () => {
      call += 1;
      const name = call === 1 ? "alpha" : "beta";
      return { skills: [sampleSkill({ name })], diagnostics: [] };
    }) as unknown as typeof loadSkills,
  });
  expect(skills.map((skill) => skill.name)).toEqual(["alpha", "beta"]);
  expect(skills.map((skill) => skill.source.path)).toEqual([
    ".review-rules/a.zip",
    ".review-rules/b.zip",
  ]);
});

test("显式多 zip：顺序 = 传入顺序（不排序）", async () => {
  const repo = tempRoot();
  const dir = path.join(repo, FIXTURE_ZIP_DIR);
  const second = writeZip(dir, "a.zip", [{ name: "alpha/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  const first = writeZip(dir, "z.zip", [{ name: "zeta/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  const { spawnFn } = recordingSpawn();
  let call = 0;

  const skills = await loadRuleSkills({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    explicitZipPaths: [first, second],
    spawn: spawnFn,
    loadSkillsFn: (async () => {
      call += 1;
      const name = call === 1 ? "zeta" : "alpha";
      return { skills: [sampleSkill({ name })], diagnostics: [] };
    }) as unknown as typeof loadSkills,
  });
  expect(skills.map((skill) => skill.name)).toEqual(["zeta", "alpha"]);
});

test("没有任何显式输入 ⇒ 空数组；strict 才抛错", async () => {
  const empty = tempRoot();
  const withConventionDir = tempRoot();
  mkdirSync(path.join(withConventionDir, FIXTURE_ZIP_DIR), { recursive: true });

  expect(await loadRuleSkills({ repoPath: empty, cacheRoot: path.join(empty, "cache") })).toEqual([]);
  expect(
    await loadRuleSkills({
      repoPath: withConventionDir,
      cacheRoot: path.join(withConventionDir, "cache"),
    }),
  ).toEqual([]);
  await expect(
    loadRuleSkills({
      repoPath: withConventionDir,
      cacheRoot: path.join(withConventionDir, "cache"),
      strict: true,
    }),
  ).rejects.toThrow(/no rule-skill archive given/);
});

test("多 zip 单包失败只降级该包（其余照常装载）", async () => {
  const repo = tempRoot();
  const dir = path.join(repo, FIXTURE_ZIP_DIR);
  const good = writeZip(dir, "a.zip", [{ name: "alpha/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  const bad = writeZip(dir, "b.zip", [{ name: "../escape/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  const { spawnFn } = recordingSpawn();

  const skills = await loadRuleSkills({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    explicitZipPaths: [bad, good],
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill({ name: "alpha" })]),
  });
  expect(skills).toHaveLength(2);
  expect(skills[0]?.degradedReason).toContain("unsafe path");
  expect(skills[1]?.degradedReason).toBeUndefined();
  expect(skills[1]?.name).toBe("alpha");
});

test("--rule-skill-name 选中：多 zip 时命中指定名，落非降级", async () => {
  const repo = tempRoot();
  const dir = path.join(repo, FIXTURE_ZIP_DIR);
  writeZip(dir, "a.zip", [{ name: "alpha/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  writeZip(dir, "b.zip", [{ name: "beta/SKILL.md", data: Buffer.from(SKILL_MD) }]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
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
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "sample-rule/README.md", data: Buffer.from("no skill here") },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
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
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "../escape/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });
  expect(skill.degradedReason).toContain("unsafe path");
});

test("绝对路径条目被拒（降级）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "/etc/passwd", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });
  expect(skill.degradedReason).toContain("unsafe path");
});

test("符号链接条目被拒（降级）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "link", data: Buffer.from("target"), unixMode: 0xa000 },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });
  expect(skill.degradedReason).toContain("symbolic link");
});

test("单包尺寸超限被拒（8 MiB 上界，测试用窄上界触发）", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
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
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "a.txt", data: Buffer.from("a") },
    { name: "b.txt", data: Buffer.from("b") },
    { name: "c.txt", data: Buffer.from("c") },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
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
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "bomb.bin", data: Buffer.alloc(200_000), method: 8 },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
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
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "big.bin", data: Buffer.alloc(5_000) },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
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
  const dir = path.join(repo, FIXTURE_ZIP_DIR);
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "rules.zip"), "this is not a zip");
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
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
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const failingSpawn: RuleSkillSpawn = async () => ({
    code: 1,
    stdout: "",
    stderr: "tar: error opening C:\\Users\\secret\\repo\\.review-rules\\rules.zip",
  });

  const skill = await loadOne({
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
  const zipPath = writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn, calls } = recordingSpawn();
  const options = {
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  };

  const first = await loadOne(options);
  const second = await loadOne(options);

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
    loadRuleSkills({ repoPath: repo, cacheRoot: path.join(repo, "cache"), strict: true }),
  ).rejects.toThrow(/rule skill unavailable/);
});

test("诊断透传：内核 diagnostic 的 path 净化为缓存目录相对 POSIX", async () => {
  const repo = tempRoot();
  const zipPath = writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
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

  const skill = await loadOne({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()], [diagnostic]),
  });

  expect(skill.diagnostics).toHaveLength(1);
  expect(skill.diagnostics[0]?.path).toBe("sample-rule/SKILL.md");
  expect(skill.diagnostics[0]?.path).not.toContain(repo);
});

test("显式 zip 路径：source.path 原样 POSIX 化（ADR-0027 只认显式）", async () => {
  const repo = tempRoot();
  const explicitDir = tempRoot();
  const zipPath = writeZip(explicitDir, "from-elsewhere.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const { spawnFn } = recordingSpawn();

  const skill = await loadOne({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    explicitZipPath: zipPath,
    spawn: spawnFn,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });

  expect(skill.degradedReason).toBeUndefined();
  expect(skill.source.path).toBe(zipPath.split(path.sep).join("/"));
});

// ---- 已解压目录形态（ADR-0018：--rule-skill） ----

/** 目录内容哈希的独立实现（测试侧对照生产实现，不共享代码） */
function expectedDirDigest(files: Readonly<Record<string, string>>): string {
  const hash = createHash("sha256");
  for (const rel of Object.keys(files).sort()) {
    hash.update(rel);
    hash.update("\0");
    hash.update(Buffer.from(files[rel] as string));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** 造一个最小规则 skill 目录（<root>/sample-rule/SKILL.md） */
function writeRuleDir(root: string, content = SKILL_MD): string {
  const dir = path.join(root, "sample-rule");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path.join(dir, "SKILL.md"), content);
  return path.dirname(dir);
}

test("目录形态：--rule-skill 装载结果与 zip 等价，source.kind = dir，digest = 内容哈希", async () => {
  const repo = tempRoot();
  const skillDir = writeRuleDir(path.join(repo, "packs"));
  const cacheRoot = path.join(repo, "cache");
  const digest = expectedDirDigest({ "sample-rule/SKILL.md": SKILL_MD });

  const skill = await loadOne({
    repoPath: repo,
    cacheRoot,
    ruleSkillDirs: [skillDir],
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });

  expect(skill.degradedReason).toBeUndefined();
  expect(skill.name).toBe("sample-rule");
  expect(skill.content).toContain("Check every public method");
  expect(skill.digest).toBe(digest);
  expect(skill.source).toEqual({ kind: "dir", path: path.relative(repo, skillDir).split(path.sep).join("/") });
  // 复制进 run 缓存（不原地当 pack 根）：缓存里有副本 + ready 标记
  const cacheDir = path.join(cacheRoot, `dir-${digest}`);
  expect(readFileSync(path.join(cacheDir, "sample-rule", "SKILL.md"), "utf8")).toBe(SKILL_MD);
  expect(readFileSync(path.join(cacheDir, ".rule-skill-ready"), "utf8")).toBe(digest);
});

test("目录 + zip 共存：先全部 zip，再全部目录（ADR-0018 装载序）", async () => {
  const repo = tempRoot();
  const zipPath = writeZip(path.join(repo, "packs"), "alpha.zip", [
    { name: "alpha/SKILL.md", data: Buffer.from(SKILL_MD) },
  ]);
  const dirA = writeRuleDir(path.join(repo, "dirs-a"));
  const dirB = writeRuleDir(path.join(repo, "dirs-b"));

  const skills = await loadRuleSkills({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    explicitZipPaths: [zipPath],
    ruleSkillDirs: [dirA, dirB],
    loadSkillsFn: (async (_env: unknown, cwd: string) => {
      const name = cwd.includes(`${path.sep}dir-`) ? "from-dir" : "from-zip";
      return { skills: [sampleSkill({ name })], diagnostics: [] };
    }) as unknown as typeof loadSkills,
  });

  expect(skills.map((skill) => skill.source.kind)).toEqual(["zip", "dir", "dir"]);
  expect(skills.map((skill) => skill.name)).toEqual(["from-zip", "from-dir", "from-dir"]);
});

test("只有显式目录（没有 zip）时 strict 亦可跑通", async () => {
  const repo = tempRoot();
  const skillDir = writeRuleDir(path.join(repo, "packs"));

  const skills = await loadRuleSkills({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    ruleSkillDirs: [skillDir],
    strict: true,
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });

  expect(skills).toHaveLength(1);
  expect(skills[0]?.degradedReason).toBeUndefined();
});

test("目录缺席 ⇒ 降级条目；strict 抛错", async () => {
  const repo = tempRoot();
  const missing = path.join(repo, "no-such-dir");

  const [degraded] = await loadRuleSkills({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    ruleSkillDirs: [missing],
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });
  expect(degraded?.degradedReason).toContain("not found");
  expect(degraded?.source).toEqual({ kind: "dir", path: path.relative(repo, missing).split(path.sep).join("/") });

  await expect(
    loadRuleSkills({
      repoPath: repo,
      cacheRoot: path.join(repo, "cache"),
      ruleSkillDirs: [missing],
      strict: true,
    }),
  ).rejects.toThrow(/rule skill unavailable: rule-skill directory not found/);
});

test("目录内容变化 ⇒ 新缓存目录（缓存键跟内容，不读旧副本）", async () => {
  const repo = tempRoot();
  const packs = path.join(repo, "packs");
  const skillDir = writeRuleDir(packs);
  const cacheRoot = path.join(repo, "cache");
  const options = {
    repoPath: repo,
    cacheRoot,
    ruleSkillDirs: [skillDir],
    loadSkillsFn: fakeLoader([sampleSkill()]),
  };

  const first = await loadOne(options);
  writeFileSync(path.join(skillDir, "sample-rule", "SKILL.md"), `${SKILL_MD}Extra rule.\n`);
  const second = await loadOne(options);

  expect(second.digest).not.toBe(first.digest);
  expect(second.digest).toBe(
    expectedDirDigest({ "sample-rule/SKILL.md": `${SKILL_MD}Extra rule.\n` }),
  );
  expect(readFileSync(path.join(cacheRoot, `dir-${first.digest}`, "sample-rule", "SKILL.md"), "utf8")).toBe(SKILL_MD);
});

test("目录总字节超限被拒（目录形态不放水：同一套上限）", async () => {
  const repo = tempRoot();
  const skillDir = writeRuleDir(path.join(repo, "packs"));

  const [degraded] = await loadRuleSkills({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    ruleSkillDirs: [skillDir],
    loadSkillsFn: fakeLoader([sampleSkill()]),
    limits: {
      maxArchiveBytes: 1 << 20,
      maxEntries: 2000,
      maxTotalUncompressed: 10,
      maxCompressionRatio: 100,
      timeoutMs: 30_000,
    },
  });

  expect(degraded?.degradedReason).toContain("rule skill directory exceeds");
});

test.skipIf(process.platform === "win32")("目录含符号链接被拒（降级；不跟随链接读包外文件）", async () => {
  const repo = tempRoot();
  const skillDir = writeRuleDir(path.join(repo, "packs"));
  const outside = path.join(tempRoot(), "secret.txt");
  writeFileSync(outside, "outside the pack");
  symlinkSync(outside, path.join(skillDir, "sample-rule", "leak.txt"));

  const [degraded] = await loadRuleSkills({
    repoPath: repo,
    cacheRoot: path.join(repo, "cache"),
    ruleSkillDirs: [skillDir],
    loadSkillsFn: fakeLoader([sampleSkill()]),
  });

  expect(degraded?.degradedReason).toContain("symbolic link");
});

// ---- 真解压集成（系统 tar / unzip；Windows 亦有 tar.exe） ----

test("真解压集成：默认 spawn + 默认 loadSkills 从 zip 装载 SKILL.md", async () => {
  const repo = tempRoot();
  writeZip(path.join(repo, FIXTURE_ZIP_DIR), "rules.zip", [
    { name: "sample-rule/SKILL.md", data: Buffer.from(SKILL_MD) },
    { name: "sample-rule/notes.txt", data: Buffer.from("plain data file, never executed") },
  ]);

  const skill = await loadOne({ repoPath: repo, cacheRoot: path.join(repo, "cache") });

  expect(skill.degradedReason).toBeUndefined();
  expect(skill.name).toBe("sample-rule");
  expect(skill.description).toBe("Sample project rule skill");
  expect(skill.content).toContain("Check every public method");
});
