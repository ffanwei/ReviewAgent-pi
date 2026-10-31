import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT, loadSkills, type Skill, type SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * 规则 Skill 装载器（ADR-0012 / ADR-0014 / ADR-0018；ADR-0024 后是唯一形态的一部分）。
 *
 * 生命周期（全部发生在 `new Agent` 之前）：
 *   定位 zip（可多个、CLI 序）→ 内容 sha256 → 解压前审计（纯 Node 读 zip
 *   中央目录）→ 宿主 shell 解压 → 解压后复核 → 内核 loadSkills 装载 → 取 Skill。
 *
 * 纪律：
 * - **装载阶段仍不执行包内脚本**：这里只 `loadSkills` 读 `SKILL.md`（及其
 *   同目录数据文件）；脚本只在 skill 检视会话里经 `tools/skill-bash.ts` 的
 *   既有边界执行（ADR-0014 决策 7：无 shell、env 白名单、cwd = pack 根）；
 * - **不写回被检视仓库**：解压产物只落在 `<cacheRoot>/<sha256>/`；
 * - **失败降级**：定位/审计/解压/装载任一失败 → 该包成为 `degradedReason`
 *   条目（run 照常）；`strict` 模式下抛错（CI 可要求包必须成功）；
 * - **错误文本脱敏**：子进程 stderr 不回显宿主绝对路径（照 codeintel/rg.ts
 *   的"错误字节需跨环境可复现"纪律）；
 * - **零新增 npm 依赖**：node:child_process / node:crypto / node:fs / node:path
 *   + vendored 内核 `loadSkills`。
 * - **只认显式输入（ADR-0027）**：不扫描被检视仓库里的 `.review-rules/`——
 *   规则包能在 skill 会话里指挥进程执行，取得它必须是一次显式授权。
 */

/** 解压完成标记文件名（缓存命中判定；点号前缀让内核 loadSkills 忽略它） */
const READY_MARKER = ".rule-skill-ready";

export interface RuleSkillSource {
  /** 输入形态：zip 归档 / 已解压目录（--rule-skill）；后期加 "url"（下载腿） */
  readonly kind: "zip" | "dir";
  /** 归档或目录路径（仓库相对 POSIX；显式路径时可能为宿主路径） */
  readonly path: string;
}

export interface RuleSkillLimits {
  /** 单包字节上界（8 MiB） */
  readonly maxArchiveBytes: number;
  /** 条目数上界（2000） */
  readonly maxEntries: number;
  /** 解压后总字节上界（64 MiB） */
  readonly maxTotalUncompressed: number;
  /** 压缩比上界（100:1） */
  readonly maxCompressionRatio: number;
  /** 单次子进程超时（毫秒） */
  readonly timeoutMs: number;
}

export const DEFAULT_RULE_SKILL_LIMITS: RuleSkillLimits = {
  maxArchiveBytes: 8 * 1024 * 1024,
  maxEntries: 2000,
  maxTotalUncompressed: 64 * 1024 * 1024,
  maxCompressionRatio: 100,
  timeoutMs: 30_000,
};

export interface RuleSkill {
  /** frontmatter name（"xxx skill" 的 xxx） */
  readonly name: string;
  readonly description: string;
  /** SKILL.md 正文 */
  readonly content: string;
  /** 原始（宿主绝对）路径——仅供审计，勿直接进简报（简报用稳定伪路径） */
  readonly filePath: string;
  /** zip 内容 sha256（缓存键 + 审计留痕；降级且未读到字节时为空串） */
  readonly digest: string;
  readonly source: RuleSkillSource;
  /** 内核装载诊断（path 已净化为缓存目录相对形态） */
  readonly diagnostics: readonly SkillDiagnostic[];
  /** 有值 = 降级（空规则，不注入简报） */
  readonly degradedReason?: string;
}

export interface RuleSkillSpawnResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** 宿主 shell 执行缝（测试注入假实现；生产走 node:child_process.spawn） */
export type RuleSkillSpawn = (
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
) => Promise<RuleSkillSpawnResult>;

export interface LoadRuleSkillOptions {
  /** 被检视仓库快照根目录 */
  readonly repoPath: string;
  /** 解压缓存根（<out>/.cache/rule-skills，ADR-0027 去 experimentId 层） */
  readonly cacheRoot: string;
  /** 显式 zip 路径（--rule-skill-zip；优先于约定目录探测） */
  readonly explicitZipPath?: string;
  /**
   * 显式 zip 路径列表（ADR-0014：`--rule-skill-zip` 可重复）。
   * 顺序 = CLI 传入顺序 = 执行顺序；优先于 `explicitZipPath` 与约定目录。
   */
  readonly explicitZipPaths?: readonly string[];
  /**
   * 显式**已解压目录**列表（`--rule-skill` 可重复，ADR-0018）。
   * 目录先审计（符号链接 / 非普通文件 / 总字节）→ 按内容哈希复制进
   * `<cacheRoot>/dir-<digest>/` → 与 zip 走同一装载链路。
   * 顺序 = CLI 传入顺序；**排在全部 zip 之后**（两种形态共存时的装载序）。
   */
  readonly ruleSkillDirs?: readonly string[];
  /** 指定装载的 skill 名（--rule-skill-name；包内多 skill 时消歧，逐包生效） */
  readonly skillName?: string;
  /** 严格模式（--strict-rule-skill）：失败抛错而非降级 */
  readonly strict?: boolean;
  /** 测试注入缝：子进程执行 */
  readonly spawn?: RuleSkillSpawn;
  /** 测试注入缝：内核 loadSkills */
  readonly loadSkillsFn?: typeof loadSkills;
  readonly limits?: RuleSkillLimits;
}

/**
 * 装载全部规则 Skill（ADR-0014 决策 1：多 zip、CLI 顺序；ADR-0018：追加
 * `--rule-skill` 已解压目录，排在全部 zip 之后）。
 *
 * - 显式 zip 列表：逐包装载，顺序 = 传入顺序；
 * - 显式目录列表：逐目录装载（审计 → 内容哈希 → 复制进缓存 → 同一装载链路）；
 * - 单包失败只降级该包（在后面继续装载），`strict` 下任一失败即抛；
 * - **规则包只认显式输入**（ADR-0027）：不再扫描被检视仓库里的
 *   `.review-rules/*.zip`。规则包会指挥 skill 会话的 bash 工具执行进程，
 *   所以「仓库自带规则」必须由调用方显式授权（传路径），不能由仓库内容
 *   自动取得执行权；
 * - 什么都没给（既无 zip 也无目录）⇒ `[]`（N=0：F 与 E 逐字节相同的前提；
 *   不是降级条目——审计 `ruleSkill: []`），`strict` 下抛错。
 */
export async function loadRuleSkills(options: LoadRuleSkillOptions): Promise<readonly RuleSkill[]> {
  const limits = options.limits ?? DEFAULT_RULE_SKILL_LIMITS;
  const spawnFn = options.spawn ?? defaultSpawn;
  const loadSkillsFn = options.loadSkillsFn ?? loadSkills;
  const dirPaths = options.ruleSkillDirs ?? [];

  const located = await locateZipCandidates(options);
  const zipEntries = "reason" in located ? [] : located.entries;
  // 只给了显式目录（没有 zip）时，zip 侧的 reason 不是整体失败——目录照常装载
  if ("reason" in located && dirPaths.length === 0) {
    if (options.strict === true) {
      throw new Error(`rule skill unavailable: ${located.reason}`);
    }
    return [];
  }

  const skills: RuleSkill[] = [];
  for (const entry of zipEntries) {
    if (entry.reason !== undefined) {
      if (options.strict === true) {
        throw new Error(`rule skill unavailable: ${entry.reason}`);
      }
      skills.push(degradedRuleSkillForPath(entry.path, options, entry.reason));
      continue;
    }
    const attempt = await loadFromZip(entry.path, options, limits, spawnFn, loadSkillsFn);
    if ("skill" in attempt) {
      skills.push(attempt.skill);
      continue;
    }
    if (options.strict === true) {
      throw new Error(`rule skill unavailable: ${attempt.reason}`);
    }
    skills.push(degradedRuleSkillForPath(entry.path, options, attempt.reason));
  }

  // 目录形态排在全部 zip 之后（ADR-0018：共存时的装载序）
  for (const dirPath of dirPaths) {
    const attempt = await loadFromDirectory(dirPath, options, limits, loadSkillsFn);
    if ("skill" in attempt) {
      skills.push(attempt.skill);
      continue;
    }
    if (options.strict === true) {
      throw new Error(`rule skill unavailable: ${attempt.reason}`);
    }
    skills.push(degradedRuleSkillForDirectory(dirPath, options, attempt.reason));
  }
  return skills;
}

/** 降级占位（source 取具体 zip 的稳定来源表示） */
function degradedRuleSkillForPath(
  zipPath: string,
  options: LoadRuleSkillOptions,
  reason: string,
): RuleSkill {
  return {
    name: "",
    description: "",
    content: "",
    filePath: "",
    digest: "",
    source: { kind: "zip", path: sourcePathOf(zipPath, options.repoPath) },
    diagnostics: [],
    degradedReason: reason,
  };
}

/** 降级占位（目录形态：source.kind = "dir"） */
function degradedRuleSkillForDirectory(
  dirPath: string,
  options: LoadRuleSkillOptions,
  reason: string,
): RuleSkill {
  return {
    name: "",
    description: "",
    content: "",
    filePath: "",
    digest: "",
    source: { kind: "dir", path: sourcePathOf(dirPath, options.repoPath) },
    diagnostics: [],
    degradedReason: reason,
  };
}

interface LocatedZip {
  readonly path: string;
  /** 有值 = 定位阶段就失败的包（缺失 / 不可读），按降级条目处理 */
  readonly reason?: string;
}

/**
 * 定位候选 zip（ADR-0014 / ADR-0027）：
 * - 显式列表（`explicitZipPaths` 优先，其次单数 `explicitZipPath`）→ 逐包
 *   校验存在性，缺失包带着原因继续（不连坐其他包）；
 * - **没有显式输入就是没有**：仓库根 `.review-rules/` 不再被自动扫描
 *   （ADR-0027：规则包能指挥 skill 会话执行进程，取用必须显式授权）。
 */
async function locateZipCandidates(
  options: LoadRuleSkillOptions,
): Promise<{ readonly entries: readonly LocatedZip[] } | { readonly reason: string }> {
  const explicit = options.explicitZipPaths ?? (options.explicitZipPath !== undefined ? [options.explicitZipPath] : []);
  if (explicit.length === 0) {
    return { reason: "no rule-skill archive given (pass --rule-skill-zip or --rule-skill <dir>)" };
  }
  const entries: LocatedZip[] = [];
  for (const zipPath of explicit) {
    entries.push(
      (await fileExists(zipPath))
        ? { path: zipPath }
        : { path: zipPath, reason: `rule-skill archive not found: ${zipPath}` },
    );
  }
  return { entries };
}

async function loadFromZip(
  zipPath: string,
  options: LoadRuleSkillOptions,
  limits: RuleSkillLimits,
  spawnFn: RuleSkillSpawn,
  loadSkillsFn: typeof loadSkills,
): Promise<{ readonly skill: RuleSkill } | { readonly reason: string }> {
  // 尺寸守卫先于读取：stat 定尺寸，超限即拒（不把恶意大包整个读进内存）。
  // 设计 §2.2：readFile 前先 stat.size 拦截，兑现「资源受限」纪律（US19/US22）。
  let bytes: Uint8Array;
  try {
    if ((await stat(zipPath)).size > limits.maxArchiveBytes) {
      return { reason: `rule-skill archive exceeds ${limits.maxArchiveBytes} bytes` };
    }
    bytes = await readFile(zipPath);
  } catch (error) {
    return { reason: `failed to read rule-skill archive (${errorMessage(error)})` };
  }
  const digest = createHash("sha256").update(bytes).digest("hex");

  const parsed = readZipEntries(bytes);
  if ("error" in parsed) {
    return { reason: parsed.error };
  }
  const unsafe = auditZipEntries(parsed.entries, limits, bytes.byteLength);
  if (unsafe !== undefined) {
    return { reason: unsafe };
  }

  const cacheDir = path.join(options.cacheRoot, digest);
  const marker = path.join(cacheDir, READY_MARKER);
  if (!(await fileExists(marker))) {
    await rm(cacheDir, { recursive: true, force: true });
    await mkdir(cacheDir, { recursive: true });
    const extracted = await extractArchive(zipPath, cacheDir, limits, spawnFn);
    if (!extracted.ok) {
      await rm(cacheDir, { recursive: true, force: true });
      return { reason: extracted.reason };
    }
    const verifyReason = await verifyExtractedTree(cacheDir, limits);
    if (verifyReason !== undefined) {
      await rm(cacheDir, { recursive: true, force: true });
      return { reason: verifyReason };
    }
    await writeFile(marker, digest, "utf8");
  }

  const env = new NodeExecutionEnv({ cwd: cacheDir });
  const loaded = await loadSkillsFn(env, cacheDir, BACKGROUND_CONTEXT);
  const selected = selectSkill(loaded.skills, options.skillName);
  if ("reason" in selected) {
    return { reason: selected.reason };
  }
  return {
    skill: {
      name: selected.skill.name,
      description: selected.skill.description,
      content: selected.skill.content,
      filePath: selected.skill.filePath,
      digest,
      source: { kind: "zip", path: sourcePathOf(zipPath, options.repoPath) },
      diagnostics: loaded.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: sanitizeDiagnosticPath(diagnostic.path, cacheDir),
      })),
    },
  };
}

/**
 * 从**已解压目录**装载（ADR-0018：`--rule-skill`，与 zip 走同一装载链路）。
 *
 * 复制到 run 缓存而非原地当 pack 根，理由与 zip 同档：隔离（两次 run 互不
 * 干扰）、可写（skill 的 bash 工具会往 pack 根写东西，不该污染用户源码目录）、
 * 诊断路径可脱敏。
 *
 * 缓存键 = 目录**内容哈希**（相对路径 + 文件内容，排序后 sha256），前缀 `dir-`
 * 与 zip 的归档字节 sha256 分开；内容一变就是新目录，绝不会读到旧副本。
 * 审计口径与 zip 一致：符号链接 / 非普通文件 / 总字节超限一律拒绝（目录形态
 * **不是**绕过安全审计的后门）。
 */
async function loadFromDirectory(
  dirPath: string,
  options: LoadRuleSkillOptions,
  limits: RuleSkillLimits,
  loadSkillsFn: typeof loadSkills,
): Promise<{ readonly skill: RuleSkill } | { readonly reason: string }> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(dirPath);
  } catch (error) {
    return { reason: `rule-skill directory not found: ${dirPath}` };
  }
  if (!info.isDirectory()) {
    return { reason: `rule-skill path is not a directory: ${dirPath}` };
  }

  // 复制前先审：符号链接越界 / 非普通文件 / 总字节超限
  const auditReason = await verifyExtractedTree(dirPath, limits, "rule skill directory");
  if (auditReason !== undefined) {
    return { reason: auditReason };
  }

  let digest: string;
  try {
    digest = await hashDirectory(dirPath);
  } catch (error) {
    return { reason: `failed to read rule-skill directory (${errorMessage(error)})` };
  }

  const cacheDir = path.join(options.cacheRoot, `dir-${digest}`);
  const marker = path.join(cacheDir, READY_MARKER);
  if (!(await fileExists(marker))) {
    await rm(cacheDir, { recursive: true, force: true });
    await mkdir(cacheDir, { recursive: true });
    try {
      await cp(dirPath, cacheDir, { recursive: true, force: true });
    } catch (error) {
      await rm(cacheDir, { recursive: true, force: true });
      return { reason: `failed to copy rule-skill directory (${errorMessage(error)})` };
    }
    const verifyReason = await verifyExtractedTree(cacheDir, limits);
    if (verifyReason !== undefined) {
      await rm(cacheDir, { recursive: true, force: true });
      return { reason: verifyReason };
    }
    await writeFile(marker, digest, "utf8");
  }

  const env = new NodeExecutionEnv({ cwd: cacheDir });
  const loaded = await loadSkillsFn(env, cacheDir, BACKGROUND_CONTEXT);
  const selected = selectSkill(loaded.skills, options.skillName);
  if ("reason" in selected) {
    return { reason: selected.reason };
  }
  return {
    skill: {
      name: selected.skill.name,
      description: selected.skill.description,
      content: selected.skill.content,
      filePath: selected.skill.filePath,
      digest,
      source: { kind: "dir", path: sourcePathOf(dirPath, options.repoPath) },
      diagnostics: loaded.diagnostics.map((diagnostic) => ({
        ...diagnostic,
        path: sanitizeDiagnosticPath(diagnostic.path, cacheDir),
      })),
    },
  };
}

/**
 * 目录内容哈希（缓存键 + 审计留痕）：递归收集相对路径（POSIX 形），排序后
 * 依次喂 `<rel>\0<bytes>\0`。排序保证跨平台与目录遍历顺序无关的确定性。
 * 调用前已由 `verifyExtractedTree` 排除符号链接与非普通文件。
 */
async function hashDirectory(root: string): Promise<string> {
  const rels: string[] = [];
  const stack: string[] = [root];
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        rels.push(path.relative(root, full).split(path.sep).join("/"));
      }
    }
  }
  rels.sort();
  const hash = createHash("sha256");
  for (const rel of rels) {
    hash.update(rel);
    hash.update("\0");
    hash.update(await readFile(path.join(root, ...rel.split("/"))));
    hash.update("\0");
  }
  return hash.digest("hex");
}

/** 装载后取单一 skill：指定名精确匹配，否则要求恰好一个（0 / >1 均降级） */function selectSkill(
  skills: readonly Skill[],
  skillName: string | undefined,
): { readonly skill: Skill } | { readonly reason: string } {
  if (skillName !== undefined) {
    const match = skills.find((skill) => skill.name === skillName);
    if (match === undefined) {
      return { reason: `rule skill "${skillName}" not found in archive` };
    }
    return { skill: match };
  }
  if (skills.length === 0) {
    return { reason: "archive contains no loadable rule skill (SKILL.md with name + description)" };
  }
  if (skills.length === 1) {
    return { skill: skills[0] as Skill };
  }
  return { reason: "archive contains multiple rule skills; pass --rule-skill-name to choose one" };
}

// ---- 解压（宿主 shell：win32 tar / posix unzip，各自带回退） ----

interface SpawnSpec {
  readonly command: string;
  readonly args: readonly string[];
}

function primaryExtractionSpec(zipPath: string, destDir: string): SpawnSpec {
  return process.platform === "win32"
    ? { command: "tar", args: ["-xf", zipPath, "-C", destDir] }
    : { command: "unzip", args: ["-o", "-q", zipPath, "-d", destDir] };
}

function fallbackExtractionSpec(zipPath: string, destDir: string): SpawnSpec | undefined {
  if (process.platform === "win32") {
    const script = `Expand-Archive -LiteralPath '${zipPath.replace(/'/g, "''")}' -DestinationPath '${destDir.replace(/'/g, "''")}' -Force`;
    return { command: "powershell", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  return { command: "tar", args: ["-xf", zipPath, "-C", destDir] };
}

async function extractArchive(
  zipPath: string,
  destDir: string,
  limits: RuleSkillLimits,
  spawnFn: RuleSkillSpawn,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  const primary = await trySpawn(spawnFn, primaryExtractionSpec(zipPath, destDir), limits.timeoutMs);
  if (primary.ok) {
    return { ok: true };
  }
  const fallbackSpec = fallbackExtractionSpec(zipPath, destDir);
  if (fallbackSpec !== undefined) {
    const fallback = await trySpawn(spawnFn, fallbackSpec, limits.timeoutMs);
    if (fallback.ok) {
      return { ok: true };
    }
  }
  return { ok: false, reason: `failed to extract rule-skill archive (${primary.reason})` };
}

async function trySpawn(
  spawnFn: RuleSkillSpawn,
  spec: SpawnSpec,
  timeoutMs: number,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly reason: string }> {
  try {
    const result = await spawnFn(spec.command, spec.args, { timeoutMs });
    if (result.code === 0) {
      return { ok: true };
    }
    return { ok: false, reason: `exit code ${result.code}: ${sanitizeChildText(result.stderr)}` };
  } catch (error) {
    return { ok: false, reason: sanitizeChildText(errorMessage(error)) };
  }
}

/** 解压后复核：递归走缓存目录，拒绝符号链接 / 非普通文件 / 超量 */
async function verifyExtractedTree(
  root: string,
  limits: RuleSkillLimits,
  label = "extracted archive",
): Promise<string | undefined> {
  const stack: string[] = [root];
  let total = 0;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        return `${label} contains a symbolic link (${entry.name})`;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        return `${label} contains an unsupported entry (${entry.name})`;
      }
      const info = await lstat(full);
      total += info.size;
      if (total > limits.maxTotalUncompressed) {
        return `${label} exceeds ${limits.maxTotalUncompressed} bytes`;
      }
    }
  }
  return undefined;
}

// ---- zip 中央目录解析（解压前审计；纯 Node，跨平台确定性） ----

interface ZipEntry {
  readonly name: string;
  readonly uncompressedSize: number;
  readonly compressedSize: number;
  readonly symlink: boolean;
}

const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_HEADER_SIGNATURE = 0x02014b50;
const ZIP64_SENTINEL = 0xffffffff;
const EOCD_MIN_LENGTH = 22;
const MAX_COMMENT_LENGTH = 0xffff;

function readZipEntries(bytes: Uint8Array): { readonly entries: readonly ZipEntry[] } | { readonly error: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const eocd = findEndOfCentralDirectory(view);
  if (eocd < 0) {
    return { error: "not a zip archive (no end-of-central-directory record)" };
  }
  const totalEntries = view.getUint16(eocd + 10, true);
  const centralSize = view.getUint32(eocd + 12, true);
  const centralOffset = view.getUint32(eocd + 16, true);
  if (
    totalEntries === MAX_COMMENT_LENGTH ||
    centralOffset === ZIP64_SENTINEL ||
    centralSize === ZIP64_SENTINEL
  ) {
    return { error: "zip64 archives are not supported" };
  }
  if (centralOffset + centralSize > bytes.byteLength) {
    return { error: "corrupt zip archive (central directory out of bounds)" };
  }

  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  const decoder = new TextDecoder("utf-8");
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > bytes.byteLength) {
      return { error: "corrupt zip archive (truncated central directory)" };
    }
    if (view.getUint32(cursor, true) !== CENTRAL_HEADER_SIGNATURE) {
      return { error: "corrupt zip archive (bad central directory header)" };
    }
    const versionMadeBy = view.getUint16(cursor + 4, true);
    const compressedSize = view.getUint32(cursor + 20, true);
    const uncompressedSize = view.getUint32(cursor + 24, true);
    const nameLength = view.getUint16(cursor + 28, true);
    const extraLength = view.getUint16(cursor + 30, true);
    const commentLength = view.getUint16(cursor + 32, true);
    const externalAttributes = view.getUint32(cursor + 38, true);
    if (compressedSize === ZIP64_SENTINEL || uncompressedSize === ZIP64_SENTINEL) {
      return { error: "zip64 archives are not supported" };
    }
    const nameStart = cursor + 46;
    if (nameStart + nameLength > bytes.byteLength) {
      return { error: "corrupt zip archive (entry name out of bounds)" };
    }
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength));
    // versionMadeBy 高字节 = 3 表示 Unix；externalAttributes 高 16 位 = Unix mode
    const unixMode = externalAttributes >>> 16;
    const symlink = versionMadeBy >> 8 === 3 && (unixMode & 0xf000) === 0xa000;
    entries.push({ name, uncompressedSize, compressedSize, symlink });
    cursor = nameStart + nameLength + extraLength + commentLength;
  }
  return { entries };
}

function findEndOfCentralDirectory(view: DataView): number {
  const lowest = Math.max(0, view.byteLength - (EOCD_MIN_LENGTH + MAX_COMMENT_LENGTH));
  for (let offset = view.byteLength - EOCD_MIN_LENGTH; offset >= lowest; offset--) {
    if (view.getUint32(offset, true) === EOCD_SIGNATURE) {
      return offset;
    }
  }
  return -1;
}

/** 解压前审计：路径穿越 / 符号链接 / 条目数 / 解压总量 / 压缩比 / 重名 */
function auditZipEntries(entries: readonly ZipEntry[], limits: RuleSkillLimits, archiveBytes: number): string | undefined {
  if (entries.length === 0) {
    return "rule-skill archive contains no entries";
  }
  if (entries.length > limits.maxEntries) {
    return `rule-skill archive has too many entries (${entries.length} > ${limits.maxEntries})`;
  }
  const seen = new Set<string>();
  let totalUncompressed = 0;
  let totalCompressed = 0;
  for (const entry of entries) {
    if (entry.symlink) {
      return `rule-skill archive contains a symbolic link (${entry.name})`;
    }
    if (isUnsafeEntryName(entry.name)) {
      return `rule-skill archive contains an unsafe path (${entry.name})`;
    }
    const key = normalizeEntryKey(entry.name);
    if (seen.has(key)) {
      return `rule-skill archive contains a duplicate entry (${entry.name})`;
    }
    seen.add(key);
    totalUncompressed += entry.uncompressedSize;
    totalCompressed += entry.compressedSize;
  }
  if (totalUncompressed > limits.maxTotalUncompressed) {
    return `rule-skill archive expands to ${totalUncompressed} bytes (limit ${limits.maxTotalUncompressed})`;
  }
  const basis = totalCompressed > 0 ? totalCompressed : archiveBytes;
  if (basis > 0 && totalUncompressed / basis > limits.maxCompressionRatio) {
    return `rule-skill archive compression ratio ${Math.round(totalUncompressed / basis)}:1 exceeds ${limits.maxCompressionRatio}:1`;
  }
  return undefined;
}

function isUnsafeEntryName(name: string): boolean {
  if (name.length === 0 || name.includes("\0")) {
    return true;
  }
  if (name.startsWith("/") || name.startsWith("\\")) {
    return true;
  }
  if (/^[A-Za-z]:/.test(name)) {
    return true;
  }
  return name.split(/[\\/]+/).some((segment) => segment === "..");
}

function normalizeEntryKey(name: string): string {
  return name.replace(/\\/g, "/").replace(/\/+$/, "").normalize("NFC").toLowerCase();
}

// ---- 默认宿主 shell 执行（node:child_process.spawn） ----

function defaultSpawn(
  command: string,
  args: readonly string[],
  options: { readonly timeoutMs: number },
): Promise<RuleSkillSpawnResult> {
  return new Promise<RuleSkillSpawnResult>((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      reject(new Error(`extraction command "${command}" timed out after ${options.timeoutMs}ms`));
    }, options.timeoutMs);
    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      // 不回显解析后的可执行文件绝对路径（宿主机内部信息；错误字节需跨环境可复现）
      reject(new Error(`failed to spawn extraction command: ${error.message}`));
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
  });
}

// ---- 小工具 ----

async function fileExists(target: string): Promise<boolean> {
  try {
    await stat(target);
    return true;
  } catch {
    return false;
  }
}

/** 归档路径的稳定来源表示：仓库内 → 仓库相对 POSIX；否则原样 POSIX 化 */
function sourcePathOf(zipPath: string, repoPath: string): string {
  const relative = path.relative(repoPath, zipPath);
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return zipPath.split(path.sep).join("/");
}

/** 诊断路径净化：缓存目录相对 POSIX（无宿主绝对路径） */
function sanitizeDiagnosticPath(target: string, cacheDir: string): string {
  const relative = path.relative(cacheDir, target);
  if (relative.length > 0 && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return relative.split(path.sep).join("/");
  }
  return path.basename(target);
}

/** 子进程错误文本脱敏：压缩空白 + 截断 + 抹掉类路径 token */
function sanitizeChildText(text: string, limit = 200): string {
  const collapsed = text.replace(/\s+/g, " ").trim().slice(0, limit);
  return collapsed.replace(/(?:[A-Za-z]:)?[\\/][^\s"']*/g, "<path>");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
