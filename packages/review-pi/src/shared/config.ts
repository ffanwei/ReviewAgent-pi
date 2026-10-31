import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, posix, resolve, win32 } from "node:path";

import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

/**
 * 用户级运行配置（ADR-0025）：`~/.PiAgent/PiAgent.json`（JSONC）。
 *
 * 纪律：
 * - **唯一配置来源**。env 层（`REVIEWER_*` / `DEEPSEEK_*` / `REVIEW_PI_*`）不再被读取；
 *   本模块只读两个路径原语 `HOME`（POSIX）/ `USERPROFILE`（Windows），它们不承载配置值。
 * - 启动读一次 → 不可变快照；请求期不重读文件、不回写 `process.env`。
 * - 秘密只进内存；错误/警告/摘要/审计一律不回显 key 值或长度。
 * - 失败策略：类型/取值/版本/禁配字段 = fail fast；未知键 = 警告继续；权限过宽 = 警告继续。
 */

export const CONFIG_VERSION = 1;
export const CONFIG_DIR_NAME = ".PiAgent";
export const CONFIG_FILE_NAME = "PiAgent.json";
/** 官方直连 base URL（与 review-llm `DEEPSEEK_API_BASE_URL` 同值；两处刻意不互相 import） */
export const OFFICIAL_REVIEWER_BASE_URL = "https://api.deepseek.com";
/** 网关档缺省输出预算（官方直连不发 max_tokens；网关不发则继承请求默认值，实测 2048 会截断） */
export const DEFAULT_GATEWAY_MAX_TOKENS = 32_768;
/** 检视模型缺省 id（`--model` / `model.default` 都缺席时的最终回落） */
export const DEFAULT_MODEL_ID = "deepseek-v4-flash";

/** 配置错误：带键路径的人话，供 CLI 直接打印（不落堆栈） */
export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface TimeoutLimits {
  readonly skillPassMs: number;
  readonly skillBashMs: number;
  readonly ruleSkillExtractMs: number;
  readonly ripgrepMs: number;
  readonly probeHealthMs: number;
  readonly probeModelMs: number;
  readonly presentationRequestMs: number;
  readonly presentationBufferMs: number;
}

export interface ConcurrencyLimits {
  readonly suggestion: number;
}

export interface BoundaryLimits {
  /** `>` 即降级；null = 该维度不设界 */
  readonly maxFiles: number | null;
  readonly maxDiffLines: number | null;
}

export interface ArchiveLimits {
  readonly maxArchiveBytes: number;
  readonly maxEntries: number;
  readonly maxTotalUncompressed: number;
  readonly maxCompressionRatio: number;
}

export interface MicroLimits {
  readonly skillBashOutputChars: number;
  readonly packageHeadBytes: number;
  readonly queryEchoChars: number;
  readonly callChainHops: number;
  readonly toolNameChars: number;
  readonly argumentsSummaryChars: number;
  readonly progressDetailChars: number;
}

export interface Limits {
  readonly timeouts: TimeoutLimits;
  readonly concurrency: ConcurrencyLimits;
  readonly boundary: BoundaryLimits;
  readonly archive: ArchiveLimits;
  readonly micro: MicroLimits;
}

export const DEFAULT_LIMITS: Limits = {
  timeouts: {
    skillPassMs: 600_000,
    skillBashMs: 120_000,
    ruleSkillExtractMs: 30_000,
    ripgrepMs: 30_000,
    probeHealthMs: 15_000,
    probeModelMs: 120_000,
    presentationRequestMs: 90_000,
    presentationBufferMs: 30_000,
  },
  concurrency: { suggestion: 4 },
  boundary: { maxFiles: 10, maxDiffLines: 2_000 },
  archive: {
    maxArchiveBytes: 8 * 1024 * 1024,
    maxEntries: 2_000,
    maxTotalUncompressed: 64 * 1024 * 1024,
    maxCompressionRatio: 100,
  },
  micro: {
    skillBashOutputChars: 256_000,
    packageHeadBytes: 8_192,
    queryEchoChars: 120,
    callChainHops: 2,
    toolNameChars: 60,
    argumentsSummaryChars: 80,
    progressDetailChars: 120,
  },
};

export interface ReviewerSettings {
  /** 秘密；缺席 = null（review/smoke 运行期 fail fast） */
  readonly apiKey: string | null;
  readonly baseUrl: string;
  /** null = 自动判档（官方直连不发 max_tokens；网关发 DEFAULT_GATEWAY_MAX_TOKENS） */
  readonly maxOutputTokens: number | null;
}

export interface ModelSettings {
  readonly default: string;
  /** null = 跟随本次检视模型（ADR-0021） */
  readonly presentation: string | null;
}

export interface ModelCostOverride {
  readonly input?: number;
  readonly output?: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
}

/** 模型元数据覆盖（按 id 深合并到内置目录；序列化方言不可覆盖） */
export interface ModelOverride {
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly cost?: ModelCostOverride;
  readonly input?: readonly ("text" | "image")[];
}

export interface PresentationSettings {
  /** 核外呈现引擎模块路径；null = 恒等直通 */
  readonly engine: string | null;
}

export interface ResolvedConfig {
  readonly version: typeof CONFIG_VERSION;
  readonly reviewer: ReviewerSettings;
  readonly model: ModelSettings;
  readonly models: Readonly<Record<string, ModelOverride>>;
  readonly presentation: PresentationSettings;
  readonly limits: Limits;
  /** 生效配置文件绝对路径（缺省 home 路径或 --config 解析结果） */
  readonly path: string;
  /** 文件是否存在（false = 全缺省） */
  readonly exists: boolean;
  /** 来源 = 文件的扁平键（其余为缺省） */
  readonly overridden: readonly string[];
  /** `sha256(canonicalJson(values)).slice(0, 12)`；values 为全量非秘密生效值 */
  readonly digest: string;
}

/** 审计快照（只进审计文件；stdout 键集不变） */
export interface ConfigSnapshot {
  readonly path: string;
  readonly version: number;
  readonly digest: string;
  readonly values: Readonly<Record<string, unknown>>;
  readonly overridden: readonly string[];
  readonly secret: Readonly<Record<string, "set" | "missing">>;
}

export interface LoadedConfig {
  readonly config: ResolvedConfig;
  /** 非致命诊断（未知键 / 权限过宽 / 钉死键）；调用方写 stderr */
  readonly warnings: readonly string[];
}

export interface LoadConfigOptions {
  /** `--config` 的原始值（相对路径按 cwd 解析） */
  readonly configPath?: string;
  readonly cwd?: string;
  /** 路径原语来源（测试注入；缺省 process.env） */
  readonly env?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  /** 测试注入文件内容（缺省 readFileSync） */
  readonly readText?: (path: string) => string;
}

/** 生效配置文件路径：`--config` 优先，否则 `<home>/.PiAgent/PiAgent.json` */
export function resolveConfigPath(options: LoadConfigOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  if (options.configPath !== undefined) {
    return resolve(cwd, options.configPath);
  }
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
  if (home === undefined || home === "") {
    throw new ConfigError(
      `无法确定用户主目录（${platform === "win32" ? "USERPROFILE" : "HOME"} 为空）——请用 --config <path> 指定配置文件`,
    );
  }
  return join2(platform, home, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/** 注入 platform 时也必须用对应分隔符（测试跨平台确定性） */
function join2(platform: NodeJS.Platform, ...parts: string[]): string {
  return platform === "win32" ? win32.join(...parts) : posix.join(...parts);
}

/** 读取并校验配置；文件缺失 = 全缺省（不报错） */
export function loadConfig(options: LoadConfigOptions = {}): LoadedConfig {
  const path = resolveConfigPath(options);
  const readText = options.readText ?? ((file: string) => readFileSync(file, "utf8"));
  const warnings: string[] = [];
  if (!existsSync(path)) {
    const config = buildConfig({ raw: {}, path, exists: false, overridden: new Set(), warnings });
    return { config, warnings };
  }
  let text: string;
  try {
    text = readText(path);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ConfigError(`无法读取配置文件（${path}）：${message}`);
  }
  const errors: ParseError[] = [];
  const raw: unknown = parseJsonc(stripBom(text), errors, {
    allowTrailingComma: true,
    disallowComments: false,
  });
  const first = errors[0];
  if (first !== undefined) {
    const { line, column } = offsetToLineColumn(text, first.offset);
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: parse error at line ${String(line)}, column ${String(column)}: ${printParseErrorCode(first.error)}`,
    );
  }
  checkPermissions(path, options.platform ?? process.platform, warnings);
  const overridden = new Set<string>();
  const config = buildConfig({ raw, path, exists: true, overridden, warnings });
  return { config, warnings };
}

/** 审计快照（秘密只记 set/missing） */
export function configSnapshot(config: ResolvedConfig): ConfigSnapshot {
  return {
    path: config.path,
    version: config.version,
    digest: config.digest,
    values: effectiveValues(config),
    overridden: config.overridden,
    secret: { "reviewer.apiKey": config.reviewer.apiKey === null ? "missing" : "set" },
  };
}

/** 运行期取 key：缺失时给出可操作的人话（并说明 env 已不再被读取） */
export function requireApiKey(config: ResolvedConfig): string {
  const apiKey = config.reviewer.apiKey;
  if (apiKey === null) {
    throw new ConfigError(
      `配置中缺少 reviewer.apiKey（环境变量已不再被读取）——先跑 review-pi config init 生成 ${config.path}`,
    );
  }
  return apiKey;
}

// ---------------------------------------------------------------------------
// 校验与合并
// ---------------------------------------------------------------------------

interface BuildInput {
  readonly raw: unknown;
  readonly path: string;
  readonly exists: boolean;
  readonly overridden: Set<string>;
  readonly warnings: string[];
}

function buildConfig({ raw, path, exists, overridden, warnings }: BuildInput): ResolvedConfig {
  const root = asObject(raw === undefined ? {} : raw, "", warnings);
  assertKnownKeys(root, ROOT_KEYS, "", warnings);

  const versionRaw = root.version;
  if (versionRaw === undefined) {
    if (!exists) {
      // 文件缺失 = 全缺省（不是错误）
      return buildDefaults({ path, overridden, warnings });
    }
    throw new ConfigError(`${CONFIG_FILE_NAME}: version is required (expected ${String(CONFIG_VERSION)})`);
  }
  if (versionRaw !== CONFIG_VERSION) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: version must be ${String(CONFIG_VERSION)} (got ${describe(versionRaw)})`,
    );
  }

  const reviewerObj = optionalObject(root.reviewer, "reviewer", warnings);
  assertKnownKeys(reviewerObj, REVIEWER_KEYS, "reviewer", warnings);
  const apiKey = optionalString(reviewerObj.apiKey, "reviewer.apiKey")?.trim() ?? "";
  const baseUrlRaw = optionalString(reviewerObj.baseUrl, "reviewer.baseUrl");
  const baseUrl =
    baseUrlRaw === undefined ? OFFICIAL_REVIEWER_BASE_URL : normalizeBaseUrl(baseUrlRaw, "reviewer.baseUrl");
  const maxOutputTokens =
    optionalInt(reviewerObj.maxOutputTokens, "reviewer.maxOutputTokens", {
      min: 1,
      max: 1_000_000,
      nullable: true,
    }) ?? null;

  const modelObj = optionalObject(root.model, "model", warnings);
  assertKnownKeys(modelObj, MODEL_KEYS, "model", warnings);
  const modelDefault = optionalString(modelObj.default, "model.default") ?? DEFAULT_MODEL_ID;
  if (modelDefault.trim() === "") {
    throw new ConfigError(`${CONFIG_FILE_NAME}: model.default must be a non-empty model id`);
  }
  const modelPresentation = optionalString(modelObj.presentation, "model.presentation") ?? null;
  if (modelPresentation !== null && modelPresentation.trim() === "") {
    throw new ConfigError(`${CONFIG_FILE_NAME}: model.presentation must be a non-empty model id or null`);
  }

  const presentationObj = optionalObject(root.presentation, "presentation", warnings);
  assertKnownKeys(presentationObj, PRESENTATION_KEYS, "presentation", warnings);
  const engine = optionalString(presentationObj.engine, "presentation.engine") ?? null;
  if (engine !== null && engine.trim() === "") {
    throw new ConfigError(`${CONFIG_FILE_NAME}: presentation.engine must be a non-empty path or null`);
  }

  const models = parseModels(root.models, warnings);
  const limits = parseLimits(root.limits, warnings);

  const config: ResolvedConfig = {
    version: CONFIG_VERSION,
    reviewer: { apiKey: apiKey === "" ? null : apiKey, baseUrl, maxOutputTokens },
    model: { default: modelDefault.trim(), presentation: modelPresentation?.trim() ?? null },
    models,
    presentation: { engine: engine?.trim() ?? null },
    limits,
    path,
    exists,
    overridden: [],
    digest: "",
  };
  recordOverrides(root, overridden);
  const values = effectiveValues(config);
  return {
    ...config,
    overridden: [...overridden].sort(),
    digest: digestOf(values),
  };
}

/** 文件缺失时的全缺省配置（不读 version） */
function buildDefaults({
  path,
  overridden,
  warnings,
}: {
  readonly path: string;
  readonly overridden: Set<string>;
  readonly warnings: string[];
}): ResolvedConfig {
  void overridden;
  void warnings;
  const base: ResolvedConfig = {
    version: CONFIG_VERSION,
    reviewer: { apiKey: null, baseUrl: OFFICIAL_REVIEWER_BASE_URL, maxOutputTokens: null },
    model: { default: DEFAULT_MODEL_ID, presentation: null },
    models: {},
    presentation: { engine: null },
    limits: DEFAULT_LIMITS,
    path,
    exists: false,
    overridden: [],
    digest: "",
  };
  return { ...base, digest: digestOf(effectiveValues(base)) };
}

const ROOT_KEYS = ["$schema", "version", "reviewer", "model", "models", "presentation", "limits"] as const;
const REVIEWER_KEYS = ["apiKey", "baseUrl", "maxOutputTokens"] as const;
const MODEL_KEYS = ["default", "presentation"] as const;
const PRESENTATION_KEYS = ["engine"] as const;
const MODEL_OVERRIDE_KEYS = ["contextWindow", "maxTokens", "cost", "input"] as const;
/** 序列化方言：写了就 fail fast（不是可调项） */
const MODEL_PINNED_KEYS = [
  "id",
  "name",
  "api",
  "provider",
  "baseUrl",
  "reasoning",
  "compat",
  "thinkingFormat",
  "thinkingLevelMap",
] as const;
const COST_KEYS = ["input", "output", "cacheRead", "cacheWrite"] as const;

const LIMITS_KEYS = ["timeouts", "concurrency", "boundary", "archive", "micro"] as const;
const TIMEOUT_KEYS = [
  "skillPassMs",
  "skillBashMs",
  "ruleSkillExtractMs",
  "ripgrepMs",
  "probeHealthMs",
  "probeModelMs",
  "presentationRequestMs",
  "presentationBufferMs",
] as const;
const CONCURRENCY_KEYS = ["suggestion"] as const;
const BOUNDARY_KEYS = ["maxFiles", "maxDiffLines"] as const;
const ARCHIVE_KEYS = ["maxArchiveBytes", "maxEntries", "maxTotalUncompressed", "maxCompressionRatio"] as const;
const MICRO_KEYS = [
  "skillBashOutputChars",
  "packageHeadBytes",
  "queryEchoChars",
  "callChainHops",
  "toolNameChars",
  "argumentsSummaryChars",
  "progressDetailChars",
] as const;

/** 已钉死的键名（配置里出现 → 警告「不会被采用」） */
const PINNED_KEYS = new Set<string>([
  "maxRounds",
  "maxToolCalls",
  "toolResultBudgetChars",
  "temperature",
  "reasoningEffort",
  "reasoning_effort",
  "effort",
  "envAllowlist",
  "skillBashEnvAllowlist",
  "provider",
  "api",
  "compat",
  "thinkingFormat",
  "maxTokensField",
]);

function parseModels(raw: unknown, warnings: string[]): Readonly<Record<string, ModelOverride>> {
  if (raw === undefined) {
    return {};
  }
  if (!isPlainObject(raw)) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: models must be an object keyed by model id`);
  }
  const out: Record<string, ModelOverride> = {};
  for (const [id, value] of Object.entries(raw)) {
    const path = `models.${id}`;
    if (id.trim() === "") {
      throw new ConfigError(`${CONFIG_FILE_NAME}: models keys must be non-empty model ids`);
    }
    const entry = asObject(value, path, warnings);
    for (const key of Object.keys(entry)) {
      if ((MODEL_PINNED_KEYS as readonly string[]).includes(key)) {
        throw new ConfigError(
          `${CONFIG_FILE_NAME}: ${path}.${key} is pinned (serialization dialect is not configurable)`,
        );
      }
      if (!(MODEL_OVERRIDE_KEYS as readonly string[]).includes(key)) {
        throw new ConfigError(`${CONFIG_FILE_NAME}: ${path}.${key} is unknown${nearestHint(key, MODEL_OVERRIDE_KEYS)}`);
      }
    }
    const contextWindow = optionalInt(entry.contextWindow, `${path}.contextWindow`, {
      min: 1,
      max: 10_000_000,
      nullable: false,
    });
    const maxTokens = optionalInt(entry.maxTokens, `${path}.maxTokens`, {
      min: 1,
      max: 1_000_000,
      nullable: false,
    });
    const cost = parseCost(entry.cost, `${path}.cost`, warnings);
    const input = parseInput(entry.input, `${path}.input`);
    out[id] = {
      ...(typeof contextWindow === "number" ? { contextWindow } : {}),
      ...(typeof maxTokens === "number" ? { maxTokens } : {}),
      ...(cost !== undefined ? { cost } : {}),
      ...(input !== undefined ? { input } : {}),
    };
  }
  return out;
}

function parseCost(raw: unknown, path: string, warnings: string[]): ModelCostOverride | undefined {
  if (raw === undefined) {
    return undefined;
  }
  const entry = asObject(raw, path, warnings);
  assertKnownKeys(entry, COST_KEYS, path, warnings);
  const input = optionalNumber(entry.input, `${path}.input`, 0);
  const output = optionalNumber(entry.output, `${path}.output`, 0);
  const cacheRead = optionalNumber(entry.cacheRead, `${path}.cacheRead`, 0);
  const cacheWrite = optionalNumber(entry.cacheWrite, `${path}.cacheWrite`, 0);
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(cacheRead !== undefined ? { cacheRead } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite } : {}),
  };
}

function parseInput(raw: unknown, path: string): readonly ("text" | "image")[] | undefined {
  if (raw === undefined) {
    return undefined;
  }
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be a non-empty array of "text" / "image"`);
  }
  const seen: ("text" | "image")[] = [];
  for (const value of raw) {
    if (value !== "text" && value !== "image") {
      throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} entries must be "text" or "image"`);
    }
    if (!seen.includes(value)) {
      seen.push(value);
    }
  }
  return seen;
}

function parseLimits(raw: unknown, warnings: string[]): Limits {
  if (raw === undefined) {
    return DEFAULT_LIMITS;
  }
  const limits = asObject(raw, "limits", warnings);
  assertKnownKeys(limits, LIMITS_KEYS, "limits", warnings);

  const timeoutsObj = optionalObject(limits.timeouts, "limits.timeouts", warnings);
  assertKnownKeys(timeoutsObj, TIMEOUT_KEYS, "limits.timeouts", warnings);
  const timeouts: TimeoutLimits = {
    skillPassMs: intOr(timeoutsObj.skillPassMs, "limits.timeouts.skillPassMs", 1_000, 3_600_000, DEFAULT_LIMITS.timeouts.skillPassMs),
    skillBashMs: intOr(timeoutsObj.skillBashMs, "limits.timeouts.skillBashMs", 1_000, 600_000, DEFAULT_LIMITS.timeouts.skillBashMs),
    ruleSkillExtractMs: intOr(timeoutsObj.ruleSkillExtractMs, "limits.timeouts.ruleSkillExtractMs", 1_000, 600_000, DEFAULT_LIMITS.timeouts.ruleSkillExtractMs),
    ripgrepMs: intOr(timeoutsObj.ripgrepMs, "limits.timeouts.ripgrepMs", 1_000, 600_000, DEFAULT_LIMITS.timeouts.ripgrepMs),
    probeHealthMs: intOr(timeoutsObj.probeHealthMs, "limits.timeouts.probeHealthMs", 1_000, 120_000, DEFAULT_LIMITS.timeouts.probeHealthMs),
    probeModelMs: intOr(timeoutsObj.probeModelMs, "limits.timeouts.probeModelMs", 10_000, 600_000, DEFAULT_LIMITS.timeouts.probeModelMs),
    presentationRequestMs: intOr(timeoutsObj.presentationRequestMs, "limits.timeouts.presentationRequestMs", 1_000, 3_600_000, DEFAULT_LIMITS.timeouts.presentationRequestMs),
    presentationBufferMs: intOr(timeoutsObj.presentationBufferMs, "limits.timeouts.presentationBufferMs", 0, 3_600_000, DEFAULT_LIMITS.timeouts.presentationBufferMs),
  };

  const concurrencyObj = optionalObject(limits.concurrency, "limits.concurrency", warnings);
  assertKnownKeys(concurrencyObj, CONCURRENCY_KEYS, "limits.concurrency", warnings);
  const concurrency: ConcurrencyLimits = {
    suggestion: intOr(concurrencyObj.suggestion, "limits.concurrency.suggestion", 1, 16, DEFAULT_LIMITS.concurrency.suggestion),
  };

  const boundaryObj = optionalObject(limits.boundary, "limits.boundary", warnings);
  assertKnownKeys(boundaryObj, BOUNDARY_KEYS, "limits.boundary", warnings);
  const maxFiles =
    optionalInt(boundaryObj.maxFiles, "limits.boundary.maxFiles", {
      min: 1,
      max: 10_000,
      nullable: true,
    }) ?? DEFAULT_LIMITS.boundary.maxFiles;
  const maxDiffLines =
    optionalInt(boundaryObj.maxDiffLines, "limits.boundary.maxDiffLines", {
      min: 1,
      max: 1_000_000,
      nullable: true,
    }) ?? DEFAULT_LIMITS.boundary.maxDiffLines;
  const boundary: BoundaryLimits = {
    maxFiles: boundaryObj.maxFiles === null ? null : maxFiles,
    maxDiffLines: boundaryObj.maxDiffLines === null ? null : maxDiffLines,
  };

  const archiveObj = optionalObject(limits.archive, "limits.archive", warnings);
  assertKnownKeys(archiveObj, ARCHIVE_KEYS, "limits.archive", warnings);
  const archive: ArchiveLimits = {
    maxArchiveBytes: intOr(archiveObj.maxArchiveBytes, "limits.archive.maxArchiveBytes", 1, 1_000_000_000, DEFAULT_LIMITS.archive.maxArchiveBytes),
    maxEntries: intOr(archiveObj.maxEntries, "limits.archive.maxEntries", 1, 100_000, DEFAULT_LIMITS.archive.maxEntries),
    maxTotalUncompressed: intOr(archiveObj.maxTotalUncompressed, "limits.archive.maxTotalUncompressed", 1, 10_000_000_000, DEFAULT_LIMITS.archive.maxTotalUncompressed),
    maxCompressionRatio: intOr(archiveObj.maxCompressionRatio, "limits.archive.maxCompressionRatio", 1, 10_000, DEFAULT_LIMITS.archive.maxCompressionRatio),
  };

  const microObj = optionalObject(limits.micro, "limits.micro", warnings);
  assertKnownKeys(microObj, MICRO_KEYS, "limits.micro", warnings);
  const micro: MicroLimits = {
    skillBashOutputChars: intOr(microObj.skillBashOutputChars, "limits.micro.skillBashOutputChars", 1, 10_000_000, DEFAULT_LIMITS.micro.skillBashOutputChars),
    packageHeadBytes: intOr(microObj.packageHeadBytes, "limits.micro.packageHeadBytes", 1, 1_048_576, DEFAULT_LIMITS.micro.packageHeadBytes),
    queryEchoChars: intOr(microObj.queryEchoChars, "limits.micro.queryEchoChars", 1, 10_000, DEFAULT_LIMITS.micro.queryEchoChars),
    callChainHops: intOr(microObj.callChainHops, "limits.micro.callChainHops", 1, 3, DEFAULT_LIMITS.micro.callChainHops),
    toolNameChars: intOr(microObj.toolNameChars, "limits.micro.toolNameChars", 1, 10_000, DEFAULT_LIMITS.micro.toolNameChars),
    argumentsSummaryChars: intOr(microObj.argumentsSummaryChars, "limits.micro.argumentsSummaryChars", 1, 10_000, DEFAULT_LIMITS.micro.argumentsSummaryChars),
    progressDetailChars: intOr(microObj.progressDetailChars, "limits.micro.progressDetailChars", 1, 10_000, DEFAULT_LIMITS.micro.progressDetailChars),
  };

  return { timeouts, concurrency, boundary, archive, micro };
}

// ---------------------------------------------------------------------------
// 扁平值 / 摘要
// ---------------------------------------------------------------------------

function effectiveValues(config: ResolvedConfig): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {
    "reviewer.baseUrl": config.reviewer.baseUrl,
    "reviewer.maxOutputTokens": config.reviewer.maxOutputTokens,
    "model.default": config.model.default,
    "model.presentation": config.model.presentation,
    "presentation.engine": config.presentation.engine,
  };
  for (const [group, entries] of Object.entries(config.limits)) {
    for (const [key, value] of Object.entries(entries)) {
      values[`limits.${group}.${key}`] = value;
    }
  }
  for (const [id, override] of Object.entries(config.models)) {
    values[`models.${id}`] = override;
  }
  return sortKeys(values);
}

function digestOf(values: Readonly<Record<string, unknown>>): string {
  return createHash("sha256").update(canonicalJson(values), "utf8").digest("hex").slice(0, 12);
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function sortKeys(record: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, record[key]]));
}

/** 文件里实际出现的扁平键（含 models.<id> 前缀）——用于审计 `overridden` */
function recordOverrides(root: Record<string, unknown>, overridden: Set<string>): void {
  const mark = (group: string, obj: Record<string, unknown> | undefined): void => {
    if (obj === undefined) {
      return;
    }
    for (const key of Object.keys(obj)) {
      overridden.add(group === "" ? key : `${group}.${key}`);
    }
  };
  mark("reviewer", asRecordOrUndefined(root.reviewer));
  mark("model", asRecordOrUndefined(root.model));
  mark("presentation", asRecordOrUndefined(root.presentation));
  const models = asRecordOrUndefined(root.models);
  if (models !== undefined) {
    for (const [id, entry] of Object.entries(models)) {
      const obj = asRecordOrUndefined(entry);
      if (obj === undefined) {
        overridden.add(`models.${id}`);
        continue;
      }
      for (const key of Object.keys(obj)) {
        overridden.add(`models.${id}.${key}`);
      }
    }
  }
  const limits = asRecordOrUndefined(root.limits);
  if (limits !== undefined) {
    for (const [group, entry] of Object.entries(limits)) {
      const obj = asRecordOrUndefined(entry);
      if (obj === undefined) {
        overridden.add(`limits.${group}`);
        continue;
      }
      for (const key of Object.keys(obj)) {
        overridden.add(`limits.${group}.${key}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// 基础校验工具
// ---------------------------------------------------------------------------

function asObject(value: unknown, path: string, warnings: string[]): Record<string, unknown> {
  void warnings;
  if (!isPlainObject(value)) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path === "" ? "root" : path} must be an object`);
  }
  return value;
}

function optionalObject(value: unknown, path: string, warnings: string[]): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  return asObject(value, path, warnings);
}

function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  warnings: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) {
      continue;
    }
    const full = path === "" ? key : `${path}.${key}`;
    if (PINNED_KEYS.has(key)) {
      warnings.push(`PiAgent.json: ${full} 已钉死（pinned），不会被采用`);
      continue;
    }
    warnings.push(`PiAgent.json: unknown key ${full}${nearestHint(key, allowed)}`);
  }
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be a string (got ${typeof value})`);
  }
  return value;
}

function optionalNumber(value: unknown, path: string, min: number): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be a finite number (got ${describe(value)})`);
  }
  if (value < min) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be >= ${String(min)} (got ${String(value)})`);
  }
  return value;
}

function optionalInt(
  value: unknown,
  path: string,
  bounds: { readonly min: number; readonly max: number; readonly nullable: boolean },
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    if (!bounds.nullable) {
      throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be an integer (null is not allowed)`);
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be an integer (got ${describe(value)})`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path} must be in ${String(bounds.min)}…${String(bounds.max)} (got ${String(value)})`,
    );
  }
  return value;
}

/** 必填的「有值则校验，无值用缺省」整数 */
function intOr(value: unknown, path: string, min: number, max: number, fallback: number): number {
  const parsed = optionalInt(value, path, { min, max, nullable: false });
  return parsed === undefined ? fallback : (parsed as number);
}

function normalizeBaseUrl(value: string, path: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//.test(trimmed)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path} must start with http:// or https:// (got ${JSON.stringify(value)})`,
    );
  }
  return trimmed.replace(/\/+$/, "");
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

function offsetToLineColumn(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let column = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
      column = 1;
    } else {
      column += 1;
    }
  }
  return { line, column };
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** 编辑距离 ≤2 的最近键提示（只用于未知键，不用于禁配字段） */
function nearestHint(key: string, allowed: readonly string[]): string {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best !== undefined && bestDistance <= 2 ? ` (did you mean ${best}?)` : "";
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = previous[j] ?? 0;
      previous[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = temp;
    }
  }
  return previous[b.length] ?? 0;
}

function checkPermissions(path: string, platform: NodeJS.Platform, warnings: string[]): void {
  if (platform === "win32") {
    return;
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(
        `PiAgent.json: 权限 ${mode.toString(8).padStart(3, "0")} 宽于 0600（文件含秘密）；建议 chmod 600 ${path}`,
      );
    }
  } catch {
    // stat 失败交给读取路径报错；此处只做附加诊断
  }
}

// ---------------------------------------------------------------------------
// 写盘（config init）与模板
// ---------------------------------------------------------------------------

export interface WriteConfigOptions {
  readonly path: string;
  readonly force?: boolean;
  readonly content?: string;
}

/** 写缺省配置（目录自动创建；POSIX 0600；已存在且无 force = 拒绝覆盖） */
export function writeConfigFile(options: WriteConfigOptions): void {
  const { path } = options;
  if (existsSync(path) && options.force !== true) {
    throw new ConfigError(`配置文件已存在（${path}）——加 --force 覆盖`);
  }
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, options.content ?? DEFAULT_CONFIG_TEMPLATE, { encoding: "utf8", mode: 0o600 });
}

/** `config init` 可预填的值（`--from-env` 一次性迁移用；缺省 = 纯模板） */
export interface ConfigTemplateOverrides {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly maxOutputTokens?: number | null;
  readonly modelDefault?: string;
  readonly modelPresentation?: string | null;
  readonly enginePath?: string | null;
}

/**
 * 缺省 JSONC 模板（与仓库内 PiAgent.example.jsonc 同源；全部键 + 注释）。
 * 带 `overrides` 时只替换对应标量，注释与键序保持不变——`--from-env` 复用同一
 * 模板，避免「迁移产物」与「手写模板」两套形状。
 */
export function configTemplate(overrides: ConfigTemplateOverrides = {}): string {
  const apiKey = jsonString(overrides.apiKey ?? "");
  const baseUrl = jsonString(overrides.baseUrl ?? OFFICIAL_REVIEWER_BASE_URL);
  const maxOutputTokens =
    overrides.maxOutputTokens === undefined ? "null" : JSON.stringify(overrides.maxOutputTokens);
  const modelDefault = jsonString(overrides.modelDefault ?? DEFAULT_MODEL_ID);
  const modelPresentation =
    overrides.modelPresentation === undefined ? "null" : JSON.stringify(overrides.modelPresentation);
  const enginePath = overrides.enginePath === undefined ? "null" : JSON.stringify(overrides.enginePath);
  return `{
  // PiAgent 运行配置（ADR-0025）。JSONC：允许注释与尾逗号。
  // 秘密（reviewer.apiKey）只写在这里；环境变量不再被读取。
  "$schema": "https://example.invalid/piagent.schema.json",
  "version": 1,

  "reviewer": {
    "apiKey": ${apiKey},
    "baseUrl": ${baseUrl},
    // null = 自动：官方直连不发 max_tokens；网关发 ${String(DEFAULT_GATEWAY_MAX_TOKENS)}
    "maxOutputTokens": ${maxOutputTokens}
  },

  "model": {
    "default": ${modelDefault},
    // null = 跟随本次检视模型（ADR-0021）
    "presentation": ${modelPresentation}
  },

  // 模型元数据覆盖（按 id 深合并；序列化方言不可配）
  "models": {},

  "presentation": {
    // 核外中文呈现引擎模块路径；null = 不投影（英文直通）
    "engine": ${enginePath}
  },

  "limits": {
    "timeouts": {
      "skillPassMs": 600000,
      "skillBashMs": 120000,
      "ruleSkillExtractMs": 30000,
      "ripgrepMs": 30000,
      "probeHealthMs": 15000,
      "probeModelMs": 120000,
      "presentationRequestMs": 90000,
      "presentationBufferMs": 30000
    },
    "concurrency": { "suggestion": 4 },
    "boundary": {
      "maxFiles": 10,
      "maxDiffLines": 2000
    },
    "archive": {
      "maxArchiveBytes": 8388608,
      "maxEntries": 2000,
      "maxTotalUncompressed": 67108864,
      "maxCompressionRatio": 100
    },
    "micro": {
      "skillBashOutputChars": 256000,
      "packageHeadBytes": 8192,
      "queryEchoChars": 120,
      "callChainHops": 2,
      "toolNameChars": 60,
      "argumentsSummaryChars": 80,
      "progressDetailChars": 120
    }
  }
}
`;
}

/** 缺省模板（冻结产物；`writeConfigFile` 缺省内容） */
export const DEFAULT_CONFIG_TEMPLATE = configTemplate();

function jsonString(value: string): string {
  return JSON.stringify(value);
}
