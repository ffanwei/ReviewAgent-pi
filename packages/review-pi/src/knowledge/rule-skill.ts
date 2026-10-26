import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { BACKGROUND_CONTEXT, loadSkills, type Skill, type SkillDiagnostic } from "@earendil-works/pi-agent-core";
import { NodeExecutionEnv } from "@earendil-works/pi-agent-core/node";

/**
 * 规则 Skill 装载器（ADR-0012 / config F）。
 *
 * 生命周期（全部发生在 `new Agent` 之前）：
 *   定位 zip → 内容 sha256 → 解压前审计（纯 Node 读 zip 中央目录）→ 宿主
 *   shell 解压 → 解压后复核 → 内核 loadSkills 装载 → 取单一 Skill。
 *
 * 纪律：
 * - **规则包只当数据**：只 `loadSkills` 读 `SKILL.md`（及其同目录数据文件），
 *   绝不执行包内任何脚本；
 * - **不写回被检视仓库**：解压产物只落在 `<cacheRoot>/<sha256>/`；
 * - **失败降级**：定位/审计/解压/装载任一失败 → 返回 `degradedReason`
 *   （run 照常）；`strict` 模式下抛错（CI 可要求包必须成功）；
 * - **错误文本脱敏**：子进程 stderr 不回显宿主绝对路径（照 codeintel/rg.ts
 *   的"错误字节需跨环境可复现"纪律）；
 * - **零新增 npm 依赖**：node:child_process / node:crypto / node:fs / node:path
 *   + vendored 内核 `loadSkills`。
 */

/** 被检视项目投放规则 skill 的约定目录（仓库根下；只放 zip） */
export const RULE_SKILL_DIR_NAME = ".review-rules";

/** 解压完成标记文件名（缓存命中判定；点号前缀让内核 loadSkills 忽略它） */
const READY_MARKER = ".rule-skill-ready";

export interface RuleSkillSource {
  /** 现在只有 "zip"；后期加 "url"（下载腿） */
  readonly kind: "zip";
  /** 归档路径（仓库相对 POSIX；显式路径时可能为宿主路径） */
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
  /** 解压缓存根（<out>/<experimentId>/.cache/rule-skills） */
  readonly cacheRoot: string;
  /** 显式 zip 路径（--rule-skill-zip；优先于约定目录探测） */
  readonly explicitZipPath?: string;
  /** 指定装载的 skill 名（--rule-skill-name；约定目录多包 / 包内多 skill 时消歧） */
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
 * 装载单个规则 Skill。**永不因外部依赖抛错**（除非 `strict`）——任何失败都
 * 以 `degradedReason` 的降级形态返回，让 run 照常完成。
 */
export async function loadRuleSkill(options: LoadRuleSkillOptions): Promise<RuleSkill> {
  const limits = options.limits ?? DEFAULT_RULE_SKILL_LIMITS;
  const spawnFn = options.spawn ?? defaultSpawn;
  const loadSkillsFn = options.loadSkillsFn ?? loadSkills;

  const degraded = (reason: string): RuleSkill => {
    if (options.strict === true) {
      throw new Error(`rule skill unavailable: ${reason}`);
    }
    return {
      name: "",
      description: "",
      content: "",
      filePath: "",
      digest: "",
      source: { kind: "zip", path: options.explicitZipPath ?? RULE_SKILL_DIR_NAME },
      diagnostics: [],
      degradedReason: reason,
    };
  };

  const located = await locateZipCandidates(options);
  if ("reason" in located) {
    return degraded(located.reason);
  }

  let lastReason = "no rule skill could be loaded";
  for (const zipPath of located.zips) {
    const attempt = await loadFromZip(zipPath, options, limits, spawnFn, loadSkillsFn);
    if ("skill" in attempt) {
      return attempt.skill;
    }
    lastReason = attempt.reason;
  }
  return degraded(lastReason);
}

/** 定位候选 zip：显式路径优先；否则扫 `<repoPath>/.review-rules/*.zip` */
async function locateZipCandidates(
  options: LoadRuleSkillOptions,
): Promise<{ readonly zips: readonly string[] } | { readonly reason: string }> {
  if (options.explicitZipPath !== undefined) {
    if (!(await fileExists(options.explicitZipPath))) {
      return { reason: `rule-skill archive not found: ${options.explicitZipPath}` };
    }
    return { zips: [options.explicitZipPath] };
  }
  const dir = path.join(options.repoPath, RULE_SKILL_DIR_NAME);
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return { reason: `no rule-skill archive found (${RULE_SKILL_DIR_NAME}/ is missing)` };
  }
  const zips = names
    .filter((name) => name.toLowerCase().endsWith(".zip"))
    .sort()
    .map((name) => path.join(dir, name));
  if (zips.length === 0) {
    return { reason: `no rule-skill archive found in ${RULE_SKILL_DIR_NAME}/` };
  }
  if (zips.length > 1 && options.skillName === undefined) {
    return {
      reason: `multiple rule-skill archives in ${RULE_SKILL_DIR_NAME}/; pass --rule-skill-zip or --rule-skill-name`,
    };
  }
  return { zips };
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

/** 装载后取单一 skill：指定名精确匹配，否则要求恰好一个（0 / >1 均降级） */
function selectSkill(
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
async function verifyExtractedTree(root: string, limits: RuleSkillLimits): Promise<string | undefined> {
  const stack: string[] = [root];
  let total = 0;
  while (stack.length > 0) {
    const dir = stack.pop() as string;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        return `extracted archive contains a symbolic link (${entry.name})`;
      }
      if (entry.isDirectory()) {
        stack.push(full);
        continue;
      }
      if (!entry.isFile()) {
        return `extracted archive contains an unsupported entry (${entry.name})`;
      }
      const info = await lstat(full);
      total += info.size;
      if (total > limits.maxTotalUncompressed) {
        return `extracted archive exceeds ${limits.maxTotalUncompressed} bytes`;
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
