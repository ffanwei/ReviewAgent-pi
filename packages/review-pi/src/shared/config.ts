import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

import { SUPPORTED_LANGUAGE_IDS } from "../contracts/languages.js";
import { parseMcp, type McpSettings } from "./config-mcp.js";
import {
  asObject,
  asRecordOrUndefined,
  assertKnownKeys,
  boolOr,
  ConfigError,
  CONFIG_FILE_NAME,
  describe,
  isPlainObject,
  normalizeBaseUrl,
  optionalInt,
  optionalObject,
  optionalString,
  parseGlobList,
} from "./config-schema.js";
import { DEFAULT_LIMITS, parseLimits, type Limits } from "./config-limits.js";
import { DEFAULT_EXCLUDE_GLOBS } from "./scan-defaults.js";

export { ConfigError, CONFIG_FILE_NAME, modelIdForGateway } from "./config-schema.js";
export { DEFAULT_LIMITS } from "./config-limits.js";
export type {
  ArchiveLimits,
  BoundaryLimits,
  ConfidenceLimits,
  FindingScopeLimits,
  Limits,
  LoopLimits,
  MicroLimits,
  MrFilterLimits,
  RetryLimits,
  SeverityLimits,
  SplitLimits,
  TestFileLimits,
  TimeoutLimits,
} from "./config-limits.js";
export type {
  McpReportBatchSettings,
  McpReportSettings,
  McpServerSettings,
  McpSettings,
} from "./config-mcp.js";

/**
 * 用户级运行配置（ADR-0025）：`~/.PiAgent/PiAgent.jsonc`（JSONC）。
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
/** 官方直连 base URL（与 review-llm `DEEPSEEK_API_BASE_URL` 同值；两处刻意不互相 import） */
export const OFFICIAL_REVIEWER_BASE_URL = "https://api.deepseek.com";
/** 网关档缺省输出预算（官方直连不发 max_tokens；网关不发则继承请求默认值，实测 2048 会截断） */
export const DEFAULT_GATEWAY_MAX_TOKENS = 32_768;
/** 模板 / 展示用缺省 id（`config init` 模板、`config show` 无文件时的来源标记）。
 * review 运行期**不再**回落它：配置文件必须显式写出 `model.default`（ADR-0093）。 */
export const DEFAULT_MODEL_ID = "deepseek-v4-flash";

/**
 * 模型降级模式（ADR-0080）：
 * - `"off"` = 不探测、不替换（缺省；逐字节维持旧行为，零额外请求）；
 * - `"on-model-not-found"` = 开跑前探测 `--model`，只有网关明确返回
 *   model not found 才改用 `config.model.default`，并在 stderr / 审计 /
 *   平台总结留下替换痕迹。
 */
export const MODEL_FALLBACK_MODES = ["off", "on-model-not-found"] as const;
export type ModelFallbackMode = (typeof MODEL_FALLBACK_MODES)[number];

/**
 * base URL 的判档归一形：scheme / host 大小写不敏感、去尾斜杠；路径逐字符
 * 有意义（`/v1` 不是同一端点）。非 URL 字面按 trim + 去尾斜杠比较。
 */
function canonicalBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  try {
    const parsed = new URL(trimmed);
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, "")}`;
  } catch {
    return trimmed;
  }
}

/**
 * 是否官方直连（判档单源，ADR-0026）：常量与比较规则只在这里。未配置 =
 * 官方缺省。`maxTokensFor` 与配置侧都走这一个谓词，避免"同一 URL 两处判断
 * 不一样"（历史缺陷：`HTTPS://API.DEEPSEEK.COM` 被判成网关，于是官方直连
 * 也发 max_tokens，破坏 ADR-0002 的 wire 字节对齐）。
 */
export function isOfficialReviewerBaseUrl(baseUrl: string | null | undefined): boolean {
  const raw = baseUrl?.trim();
  if (raw === undefined || raw === "") {
    return true;
  }
  return canonicalBaseUrl(raw) === canonicalBaseUrl(OFFICIAL_REVIEWER_BASE_URL);
}
export interface ReviewerSettings {
  /** 秘密；缺席 = null（review/smoke 运行期 fail fast） */
  readonly apiKey: string | null;
  readonly baseUrl: string;
  /** null = 自动判档（官方直连不发 max_tokens；网关发 DEFAULT_GATEWAY_MAX_TOKENS） */
  readonly maxOutputTokens: number | null;
  /**
   * 模型真实上下文窗口（token）。null = 使用内核模型目录画像。
   * 目录外模型 id 会借用 `deepseek-v4-flash` 的 1,000,000，与第三方网关实际窗口
   * 常不一致；显式设置后，发送前会把输出预算收进窗口余量（ADR-0102）。
   */
  readonly contextWindow: number | null;
  /**
   * 模型 id 前缀剥离（缺省 false = 原样直发）：true 时所有发往网关的模型 id
   * （`--model` / `model.default` / `model.presentation`）剥掉**最后一个 `/` 前
   * 的所有**（`pan/deeseek` → `deeseek`）。给「平台侧传 `厂商/模型` 形态、网关
   * 只注册裸名」的部署用。**必须显式开启**：OpenRouter 等网关的合法 id 本身就
   * 带斜杠，无条件剥离会把它们发坏。
   */
  readonly stripModelPrefix: boolean;
  /**
   * `--model` 不可用时的降级模式（ADR-0080）。**ADR-0093 阶段 1 起已废弃**：
   * 键仍被识别（旧配置只收一条告警），生效值恒 `"off"`，阶段 2 删除。
   */
  readonly modelFallback: ModelFallbackMode;
}

export interface ModelSettings {
  /** 检视模型唯一来源（ADR-0093 阶段 1）：配置文件必须显式写出；`--model` 不覆盖 */
  readonly default: string;
  /** null = 跟随本次检视模型（ADR-0021；ADR-0093 阶段 1 起链为 presentation → model.default） */
  readonly presentation: string | null;
}

/**
 * 代码智能（符号 / 引用 / 调用链）的语言开关（ADR-0040）。
 *
 * - `"auto"` = 跟随本版本已实现的解析器（升级后自动获得新语言，不用改配置）；
 * - 数组 = 只启用列出的语言；未实现的条目在装载期告警并被丢弃（不静默降级）。
 *
 * 只影响符号级工具；检视本体读 diff，本来就不限语言。
 */
export interface CodeIntelSettings {
  readonly languages: "auto" | readonly string[];
  /**
   * 扫描排除 glob（ADR-0041）：`--no-ignore` 是确定性要求，多语言 glob 下
   * 必须显式排除 node_modules / dist / 生成物，否则会把依赖当源码扫。
   * 空数组 = 不排除任何东西（完全由语言 glob 决定）。
   */
  readonly excludeGlobs: readonly string[];
}

export const DEFAULT_CODEINTEL: CodeIntelSettings = Object.freeze({
  languages: "auto" as const,
  excludeGlobs: DEFAULT_EXCLUDE_GLOBS,
});


export interface ResolvedConfig {
  readonly version: typeof CONFIG_VERSION;
  readonly reviewer: ReviewerSettings;
  readonly model: ModelSettings;
  readonly codeintel: CodeIntelSettings;
  readonly limits: Limits;
  /** MCP 上报（ADR-0037）：未配置 = null */
  readonly mcp: McpSettings | null;
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

/** 生效配置文件路径：`--config` 优先，否则 `<home>/.PiAgent/PiAgent.jsonc` */
export function resolveConfigPath(options: LoadConfigOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  if (options.configPath !== undefined) {
    return resolve(cwd, options.configPath);
  }
  const platform = options.platform ?? process.platform;
  const home = homeDirectory({
    platform,
    ...(options.env !== undefined ? { env: options.env } : {}),
  });
  if (home === undefined) {
    throw new ConfigError(
      `无法确定用户主目录（${platform === "win32" ? "USERPROFILE" : "HOME"} 为空）——请用 --config <path> 指定配置文件`,
    );
  }
  return join2(platform, home, CONFIG_DIR_NAME, CONFIG_FILE_NAME);
}

/** 用户主目录（HOME / USERPROFILE）；为空返回 undefined（不猜路径） */
export function homeDirectory(
  options: { readonly env?: NodeJS.ProcessEnv; readonly platform?: NodeJS.Platform } = {},
): string | undefined {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = (platform === "win32" ? env.USERPROFILE : env.HOME)?.trim();
  return home === undefined || home === "" ? undefined : home;
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

/** 审计快照可选项 */
export interface ConfigSnapshotOptions {
  /**
   * 用户主目录：给定时把 `path` 与值里的家目录前缀折叠成 `~`（ADR-0027）。
   * 审计文件是可归档的留痕，机器绑定的绝对路径会让同一份 run 在另一台机器
   * 上不可读；`config show` 不带这个选项，用户看的永远是真实路径。
   */
  readonly home?: string | undefined;
}

/** 审计快照（秘密只记 set/missing；可选家目录归一化为 `~/...`） */
export function configSnapshot(
  config: ResolvedConfig,
  options: ConfigSnapshotOptions = {},
): ConfigSnapshot {
  const home = options.home;
  const values = effectiveValues(config);
  return {
    path: collapseHome(config.path, home),
    version: config.version,
    digest: config.digest,
    values:
      home === undefined
        ? values
        : (Object.fromEntries(
            Object.entries(values).map(([key, value]) => [key, collapseHomeDeep(value, home)]),
          ) as Readonly<Record<string, unknown>>),
    overridden: config.overridden,
    secret: secretMapOf(config),
  };
}

/**
 * 秘密状态（只报 set / missing，绝不回显值、长度或 header 名）。
 * `reviewer.apiKey` 与每个 MCP 服务端的 `headers` 同等待遇（ADR-0037 决策 6）。
 */
function secretMapOf(config: ResolvedConfig): Readonly<Record<string, "set" | "missing">> {
  const secret: Record<string, "set" | "missing"> = {
    "reviewer.apiKey": config.reviewer.apiKey === null ? "missing" : "set",
  };
  if (config.mcp !== null) {
    for (const [name, server] of Object.entries(config.mcp.servers)) {
      secret[`mcp.servers.${name}.headers`] = Object.keys(server.headers).length > 0 ? "set" : "missing";
    }
  }
  return secret;
}

/** 家目录前缀折叠：`C:\Users\x\a` / `/home/x/a` → `~/a`（POSIX 分隔符） */
function collapseHome(value: string, home: string | undefined): string {
  if (home === undefined || home.trim() === "" || !isAbsolute(value)) {
    return value;
  }
  const base = resolve(home.trim());
  const rest = relative(base, resolve(value));
  if (rest === "") {
    return "~";
  }
  if (rest.startsWith("..") || isAbsolute(rest)) {
    return value;
  }
  return `~/${rest.split(sep).join("/")}`;
}

/** 递归折叠值里的字符串（数组 / 对象 / 标量；只碰字符串） */
function collapseHomeDeep(value: unknown, home: string): unknown {
  if (typeof value === "string") {
    return collapseHome(value, home);
  }
  if (Array.isArray(value)) {
    return value.map((entry) => collapseHomeDeep(entry, home));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, entry]) => [
        key,
        collapseHomeDeep(entry, home),
      ]),
    );
  }
  return value;
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
  // 模型真实上下文窗口（ADR-0102）：null = 用内核目录画像（网关可能不准）
  const contextWindow =
    optionalInt(reviewerObj.contextWindow, "reviewer.contextWindow", {
      min: 1_024,
      max: 100_000_000,
      nullable: true,
    }) ?? null;
  // 模型 id 前缀剥离：缺省 false（原样直发的现行契约）；非布尔 fail fast
  const stripModelPrefix = boolOr(reviewerObj.stripModelPrefix, "reviewer.stripModelPrefix", false);
  // 模型降级（ADR-0080）在 ADR-0093 阶段 1 失效：`--model` 的值已不参与，
  // 键本身保留到阶段 2（旧配置不突然报错），装载期只给一条废弃告警，
  // 生效值恒 off（探测 / 替换代码路径不再被调用）。
  if (reviewerObj.modelFallback !== undefined) {
    warnings.push(
      "PiAgent.jsonc: reviewer.modelFallback 已废弃（ADR-0093 阶段 1），本版不生效；阶段 2 将删除该键",
    );
  }
  const modelFallback: ModelFallbackMode = "off";

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

  const limits = parseLimits(root.limits, warnings);
  const mcp = parseMcp(root.mcp, warnings);
  const codeintel = parseCodeIntel(root.codeintel, warnings);

  const config: ResolvedConfig = {
    version: CONFIG_VERSION,
    reviewer: { apiKey: apiKey === "" ? null : apiKey, baseUrl, maxOutputTokens, contextWindow, stripModelPrefix, modelFallback },
    model: { default: modelDefault.trim(), presentation: modelPresentation?.trim() ?? null },
    codeintel,
    limits,
    mcp,
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
    reviewer: { apiKey: null, baseUrl: OFFICIAL_REVIEWER_BASE_URL, maxOutputTokens: null, contextWindow: null, stripModelPrefix: false, modelFallback: "off" },
    model: { default: DEFAULT_MODEL_ID, presentation: null },
    codeintel: DEFAULT_CODEINTEL,
    limits: DEFAULT_LIMITS,
    mcp: null,
    path,
    exists: false,
    overridden: [],
    digest: "",
  };
  return { ...base, digest: digestOf(effectiveValues(base)) };
}

const ROOT_KEYS = ["$schema", "version", "reviewer", "model", "codeintel", "limits", "mcp"] as const;
const REVIEWER_KEYS = ["apiKey", "baseUrl", "maxOutputTokens", "contextWindow", "stripModelPrefix", "modelFallback"] as const;
const MODEL_KEYS = ["default", "presentation"] as const;
const CODEINTEL_KEYS = ["languages", "excludeGlobs"] as const;

// ---------------------------------------------------------------------------
// 代码智能语言开关（ADR-0040）
// ---------------------------------------------------------------------------

function parseCodeIntel(raw: unknown, warnings: string[]): CodeIntelSettings {
  const obj = optionalObject(raw, "codeintel", warnings);
  assertKnownKeys(obj, CODEINTEL_KEYS, "codeintel", warnings);
  return {
    languages: parseLanguageSelection(obj.languages, warnings),
    excludeGlobs: parseExcludeGlobs(obj.excludeGlobs),
  };
}

/** `codeintel.excludeGlobs`：非空字符串数组；去重保序；空数组 = 不排除 */
function parseExcludeGlobs(value: unknown): readonly string[] {
  return parseGlobList(value, "codeintel.excludeGlobs", DEFAULT_CODEINTEL.excludeGlobs);
}

/**
 * `codeintel.languages`：`"auto"` | 语言 id 数组。
 *
 * 未实现的条目**装载期告警并丢弃**（不静默返回空结果）；大小写与首尾空白归一，
 * 重复条目去重保序。空数组 = 显式关闭代码智能（符号级工具扫 0 个文件）。
 */
function parseLanguageSelection(
  value: unknown,
  warnings: string[],
): "auto" | readonly string[] {
  if (value === undefined || value === null) {
    return DEFAULT_CODEINTEL.languages;
  }
  if (value === "auto") {
    return "auto";
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: codeintel.languages must be "auto" or an array of language ids (got ${describe(value)})`,
    );
  }
  const selected: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigError(
        `${CONFIG_FILE_NAME}: codeintel.languages entries must be non-empty strings (got ${describe(entry)})`,
      );
    }
    const id = entry.trim().toLowerCase();
    if (!(SUPPORTED_LANGUAGE_IDS as readonly string[]).includes(id)) {
      warnings.push(
        `PiAgent.jsonc: codeintel.languages 里的 "${id}" 当前版本未实现，已跳过（已实现：${SUPPORTED_LANGUAGE_IDS.join(", ")}）`,
      );
      continue;
    }
    if (!selected.includes(id)) {
      selected.push(id);
    }
  }
  return selected;
}

// ---------------------------------------------------------------------------
// MCP 上报（ADR-0037）
// ---------------------------------------------------------------------------


// ---------------------------------------------------------------------------
// 扁平值 / 摘要
// ---------------------------------------------------------------------------

function effectiveValues(config: ResolvedConfig): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {
    "reviewer.baseUrl": config.reviewer.baseUrl,
    "reviewer.maxOutputTokens": config.reviewer.maxOutputTokens,
    "reviewer.contextWindow": config.reviewer.contextWindow,
    "reviewer.stripModelPrefix": config.reviewer.stripModelPrefix,
    "reviewer.modelFallback": config.reviewer.modelFallback,
    "model.default": config.model.default,
    "model.presentation": config.model.presentation,
    "codeintel.languages": config.codeintel.languages,
    "codeintel.excludeGlobs": config.codeintel.excludeGlobs,
  };
  for (const [group, entries] of Object.entries(config.limits)) {
    if (group === "coverage") {
      values["limits.coverage.repair.enabled"] = config.limits.coverage.repair.enabled;
      values["limits.coverage.repair.maxRequests"] = config.limits.coverage.repair.maxRequests;
      values["limits.coverage.repair.maxChars"] = config.limits.coverage.repair.maxChars;
      values["limits.coverage.repair.maxHunksPerRequest"] =
        config.limits.coverage.repair.maxHunksPerRequest;
      continue;
    }
    for (const [key, value] of Object.entries(entries)) {
      values[`limits.${group}.${key}`] = value;
    }
  }
  const mcp = config.mcp;
  if (mcp !== null) {
    // headers 是秘密：不进 values（与 reviewer.apiKey 同待遇），只在 secret 里报 set/missing
    for (const [name, server] of Object.entries(mcp.servers)) {
      values[`mcp.servers.${name}.transport`] = server.transport;
      values[`mcp.servers.${name}.handshake`] = server.handshake;
      values[`mcp.servers.${name}.url`] = server.url;
      values[`mcp.servers.${name}.timeoutMs`] = server.timeoutMs;
    }
    values["mcp.report.batch.maxDelayMs"] = mcp.report.batch.maxDelayMs;
    values["mcp.report.batch.maxEvents"] = mcp.report.batch.maxEvents;
    values["mcp.report.findings"] = mcp.report.findings;
    values["mcp.report.flushTimeoutMs"] = mcp.report.flushTimeoutMs;
    values["mcp.report.include"] = mcp.report.include;
    values["mcp.report.queue.maxEvents"] = mcp.report.queue.maxEvents;
    values["mcp.report.server"] = mcp.report.server;
    values["mcp.report.task"] = mcp.report.task;
    if (mcp.report.tool !== undefined) {
      values["mcp.report.tool"] = mcp.report.tool;
    }
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

/** 文件里实际出现的扁平键——用于审计 `overridden` */
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
  mark("codeintel", asRecordOrUndefined(root.codeintel));
  const mcp = asRecordOrUndefined(root.mcp);
  if (mcp !== undefined) {
    // 逐叶记账：`config show` 的 (file|default) 标记按前缀匹配，只记 "mcp.servers" 不够
    for (const [name, entry] of Object.entries(asRecordOrUndefined(mcp.servers) ?? {})) {
      const obj = asRecordOrUndefined(entry);
      if (obj === undefined) {
        overridden.add(`mcp.servers.${name}`);
        continue;
      }
      for (const key of Object.keys(obj)) {
        overridden.add(`mcp.servers.${name}.${key}`);
      }
    }
    for (const key of Object.keys(asRecordOrUndefined(mcp.report) ?? {})) {
      overridden.add(`mcp.report.${key}`);
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


function checkPermissions(path: string, platform: NodeJS.Platform, warnings: string[]): void {
  if (platform === "win32") {
    return;
  }
  try {
    const mode = statSync(path).mode & 0o777;
    if ((mode & 0o077) !== 0) {
      warnings.push(
        `PiAgent.jsonc: 权限 ${mode.toString(8).padStart(3, "0")} 宽于 0600（文件含秘密）；建议 chmod 600 ${path}`,
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

/** 写缺省配置（目录自动创建，POSIX 0700；文件 0600；已存在且无 force = 拒绝覆盖） */
export function writeConfigFile(options: WriteConfigOptions): void {
  const { path } = options;
  if (existsSync(path) && options.force !== true) {
    throw new ConfigError(`配置文件已存在（${path}）——加 --force 覆盖`);
  }
  // 目录装的是含秘密的单文件：0700 让同机其他用户连"这里有个配置文件"都看不到。
  // Windows 上 mode 只影响只读位，传了也无害。
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, options.content ?? DEFAULT_CONFIG_TEMPLATE, { encoding: "utf8", mode: 0o600 });
  // writeFileSync 的 mode 只在**创建**时生效：--force 覆盖既有文件不会改权限，
  // 于是 0644 的文件永远修不好。写后显式 chmod（POSIX 才有意义，其余平台 no-op）。
  try {
    chmodSync(path, 0o600);
  } catch {
    // 权限修不了不阻断写盘：读取侧有 checkPermissions 的宽权限警告兜底
  }
}

/** `config init` 可预填的值（`--from-env` 一次性迁移用；缺省 = 纯模板） */
export interface ConfigTemplateOverrides {
  readonly apiKey?: string;
  readonly baseUrl?: string;
  readonly maxOutputTokens?: number | null;
  readonly modelDefault?: string;
  readonly modelPresentation?: string | null;
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
  // 排除 glob 直接从常量生成：模板与运行时默认值不会漂移
  const excludeGlobLines = DEFAULT_EXCLUDE_GLOBS.map((glob) => `      ${jsonString(glob)}`).join(",\n");
  return `{
  // PiAgent 运行配置（ADR-0025）。JSONC：允许注释与尾逗号。
  // 秘密（reviewer.apiKey / mcp 的 headers）只写在这里；环境变量不再被读取。
  // 配置版本：当前只支持 1，不匹配即 fail fast。
  // 分区导航：reviewer / model（模型接入）→ codeintel（代码智能）
  // → mcp（外发上报，缺省整块注释）→ limits（资源与行为护栏）。
  "version": 1,

  "reviewer": {
    // 模型网关密钥（必需）。审计与日志只报 set / missing，绝不回显值。
    "apiKey": ${apiKey},
    // 网关基址：官方直连用 https://api.deepseek.com；OpenAI 兼容网关需自带 /v1（不带 /chat/completions）。
    "baseUrl": ${baseUrl},
    // 单次请求输出上限：null = 自动——官方直连不发 max_tokens；网关发 ${String(DEFAULT_GATEWAY_MAX_TOKENS)}。
    "maxOutputTokens": ${maxOutputTokens},
    // 模型真实上下文窗口（token）：null = 使用内核模型目录画像。
    // 目录外 id 借用 deepseek-v4-flash 的 1,000,000，可能与网关实际不符；
    // 设置后发送前会把输出预算收进窗口余量，并在溢出 400 时降预算重试（ADR-0102）。
    "contextWindow": null,
    // 模型 id 前缀剥离：true = 发往网关的模型 id 剥掉最后一个 / 前的所有
    // （pan/deeseek → deeseek，覆盖 model.default / model.presentation）。
    // 缺省 false = 原样直发（OpenRouter 等网关的合法 id 本身就带斜杠）。
    "stripModelPrefix": false,
    // 已废弃（ADR-0093 阶段 1）：本版不生效，保留一个版本以免旧配置突然报错；
    // 阶段 2 删除。检视模型一律取 model.default。
    "modelFallback": "off"
  },

  "model": {
    // 检视模型唯一来源（ADR-0093 阶段 1）：必须显式给出；--model 已废弃并忽略。
    "default": ${modelDefault},
    // 收尾总结模型（ADR-0090 后报文 / tips 零模型调用）：null = 跟随本次检视模型。
    "presentation": ${modelPresentation}
  },

  // 代码智能（符号 / 引用 / 调用链）启用哪些语言。检视本体读 diff，本来就不限语言；
  // 这里只控制符号级工具的扫描范围，不影响普通检视。
  // "auto" = 跟随当前版本已实现的解析器（推荐：升级后自动获得新语言，不用改配置）。
  // 数组 = 只启用列出的语言；未实现的条目装载期告警并跳过，不静默。
  // 已实现：java / typescript（含 ts / tsx / js / jsx）/ python / go / cpp（.c / .h / .cc / .cpp / .cxx / .hpp / .hh / .hxx）。
  "codeintel": {
    "languages": "auto",
    // 扫描排除（ADR-0041）：依赖与生成物不是手写源码。空数组 = 不排除。
    "excludeGlobs": [
${excludeGlobLines}
    ]
  },

  // MCP 上报（ADR-0037）：把进度 / 状态 / 结果外发给已有的 MCP 服务（HTTP + JSON-RPC）。
  // 整块注释掉 = 不上报（零建连、零请求、退出码与产物字节都不变）；要用就取消注释。
  // "mcp": {
  //   // 服务端连接：一个键名对应一个 MCP 服务，report.server 按名字引用。
  //   "servers": {
  //     "ops": {
  //       // 传输形态："http" = Streamable HTTP（单端点 POST，推荐）；
  //       // "http-sse" = 老式 HTTP+SSE（GET 长连接收 endpoint 事件，url 填 SSE 端点）。
  //       "transport": "http",
  //       // 握手策略："auto"（缺省）= 先试 initialize，服务端不认就降级为无状态
  //       // 直调（每次 tools/call 独立 POST，与 Postman 单发同形）；"required" =
  //       // 握手失败即上报不可用；"off" = 从不握手。
  //       "handshake": "auto",
  //       // 服务端点：http 填消息端点；http-sse 填 SSE 端点（如 …/sse）。
  //       "url": "https://mcp.example.com/mcp",
  //       // 额外请求头（秘密）：与 reviewer.apiKey 同等待遇，只报 set / missing。
  //       "headers": { "Authorization": "Bearer <token>" },
  //       // 单次请求超时（毫秒）。
  //       "timeoutMs": 60000
  //     }
  //   },
  //   "report": {
  //     // 使用哪个服务端（上面 servers 里的键名）。
  //     "server": "ops",
  //     // 事件通道（可选）：给了 tool 才批量发进度事件；不给 = 只调四个业务 tool
  //     // （startTask / endTask / saveReviewSummary / mrReviewResult，ADR-0045）。
  //     "tool": "report_events",
  //     // 业务 tool 开关（ADR-0045）：false = 一个业务 tool 都不调；缺省 true。
  //     "task": true,
  //     // 事件类型收窄（仅事件通道生效）；缺省四类：run.start / run.end / phase / request.end。
  //     "include": ["run.start", "run.end", "phase", "request.end"],
  //     // 批量：积满 maxEvents 条或距首条超过 maxDelayMs 即发（毫秒）。
  //     "batch": { "maxEvents": 50, "maxDelayMs": 2000 },
  //     // 背压队列上限：进程内最多积压多少条事件，溢出丢最旧并计入 dropped。
  //     "queue": { "maxEvents": 1000 },
  //     // 收尾冲刷超时（毫秒）：退出前尽力排空未发事件的上限。
  //     "flushTimeoutMs": 5000,
  //     // findings 出站档位：none / summary；finding 正文永不出进程。
  //     "findings": "summary"
  //   }
  // },

  // 资源与行为护栏：轮次、超时、重试、并发、过滤阈值、MR 边界、分片、解压与截断。
  // 全部可调；取值超出允许范围会在装载期 fail fast。
  "limits": {
    // 检视轮次（ADR-0046）：一轮 = 六阶段完整一遍（约 6 次模型请求）。
    // 最后一轮强制 complete：模型说「还要再审」也不再开新轮，本轮产出即最终结果；
    // 轮次上限是成本线，不是失败（不产生截断）。范围 1–20。
    // stageCompression：compact（默认）= 合并 Phase 1+2、Phase 1 不调工具、
    // Phase 3 无额外上下文需求时跳过 Phase 4（审计仍保留六阶段记录）；off = 六阶段各发一次请求。
    "loop": { "maxRounds": 3, "phase5Sweep": false, "stageCompression": "compact" },
    // 各阶段超时（毫秒）。
    "timeouts": {
      "skillPassMs": 1200000,            // 单个规则 Skill 会话的总超时。
      "skillBashMs": 120000,             // 规则 Skill 里 bash 工具单次执行超时。
      "ruleSkillExtractMs": 30000,       // 规则包 zip 解压超时。
      "ripgrepMs": 30000,                // ripgrep 单次调用超时。
      "probeHealthMs": 15000,            // smoke 网关健康探针超时。
      "probeModelMs": 120000,            // smoke 模型探针超时。
      "reviewTurnMs": 180000,            // 主检视回合 / 规则 Skill 会话单次请求的建立超时（流开始前的等待）。
      "oneShotMs": 300000,               // 片级报文 / 收尾总结单次请求超时。
    },
    // LLM 调用重试（ADR-0051）：次数一律是「总尝试次数（含首次）」。
    // 主检视回合 / 规则 Skill 会话走 pi-ai 的流请求重试；总结 / smoke 走本仓统一重试。只有请求建立阶段可重试——流已开始后断开会显式报错，不做整回合重放。
    // baseDelayMs / maxDelayMs 只作用于核外一次性调用；maxRetryAfterMs 同时约束服务端
    // Retry-After 与 pi-ai 的 maxRetryDelayMs。
    "retry": {
      "maxAttempts": 3,                  // 全局缺省：总尝试次数（1 = 不重试）。
      "baseDelayMs": 500,                // 指数退避基准（毫秒）。
      "maxDelayMs": 10000,               // 单次退避上限（毫秒）。
      "maxRetryAfterMs": 30000,          // 服务端要求等待的上限（毫秒）；0 = 不设上限。
      "reviewTurnAttempts": 3,           // 主检视回合 / 规则 Skill 会话总尝试次数。
      "oneShotAttempts": 3,              // 片级报文 / 收尾总结总尝试次数。
      "smokeAttempts": 1,                // smoke 探针总尝试次数（缺省 1 = 不重试）。
      // 流中断重放（ADR-0077 / ADR-0101）：流已开始后断开或干净 EOF 截断时，
      // 缓冲当前响应并在本层重发。
      // 总尝试次数（含首次）：3 = 1 次首次 + 2 次重放；1 = 关闭重放。
      "streamAttempts": 3,
      // 重放总墙钟预算（毫秒，从首次尝试发出起算、含退避）；0 = 不设上限。
      // 到点即停止「再发起一次」；已发出的尝试不会被打断。
      "streamReplayBudgetMs": 600000
    },
    // 检视意见置信度过滤（ADR-0052）：confidence 低于 min 的意见不进入中文 tips
    // （reviews_tips_zh.json 与 mrReviewResult.reviewTips）；英文 findings / stdout 不受影响。
    // 0–1，缺省 0.5（= 过滤 Low 档）；0 = 不过滤。
    "confidence": { "min": 0.5 },
    // 检视意见严重级过滤：severity 低于 min 的意见不进入中文 tips
    // （reviews_tips_zh.json 与 mrReviewResult.reviewTips）；英文 findings / stdout 不受影响。
    // 取值 P0–P3，缺省 P3（= 不过滤）；P2 = 只保留 P0/P1/P2，丢弃 P3 建议级。
    "severity": { "min": "P3" },
    // 测试文件是否跳过检视（缺省 false = 不跳过，ADR-0092）：
    // false = 测试文件与生产代码同等检视；
    // true  = 检视输入阶段按文件块整块剔除测试文件（不进 diff、不产 findings、
    //         不进中文 tips / MCP 上报）；这种剔除发生在检视之前，与 severity /
    //         confidence 的输出侧过滤不同。
    "testFiles": { "skip": false },
    // 按 glob 跳过检视（ADR-0069；缺省排除 lockfile / fixtures / snapshot，ADR-0092）：
    // 命中的文件块在检视输入阶段整块剔除（不进 diff、不产 findings、不进中文 tips /
    // MCP 意见）；它们仍是变更过的文件，收尾按 ADR-0068 补一条空 reviewTips 的
    // mrReviewResult。匹配对象是仓库相对 POSIX 路径，大小写不敏感；不含 "/" 的 glob
    // 只比文件名（*.md 与 **/*.md 等价），* / ? 不跨目录，** 跨目录。
    // 空数组 = 不排除任何文件。例：["**/*.md", "docs/**"] 跳过全部 Markdown 与 docs 目录
    // （Markdown 不再默认排除，需要时显式配置，ADR-0092）。
    //
    // includeRegex / excludeRegex（ADR-0078）：按**正则**限定检视范围，缺省 []。
    // includeRegex 非空 = 白名单：命中者越过 testFiles / lockfile / generated /
    // excludeGlobs 等启发式（binary 恒剔）；excludeRegex 再从候选中剔除（优先于
    // include）。正则大小写敏感，匹配前把 git 的引号 + 八进制路径归一化。
    // 同类多条 = OR；CLI --include / --exclude 出现时整体替换对应维度，
    // 传空值 = 本次清空该维度。例：includeRegex ["^src/.*\\\\.ts$"]。
    "mrFilter": {
      "excludeGlobs": ["**/*.lock", "**/fixtures/**", "**/*.snap"],
      "includeRegex": [],
      "excludeRegex": []
    },
    // 非 diff 区域过滤（缺省开启）：检视意见必须落在本遍 diff 的变更 hunk 内，
    // 或距 hunk 边界不超过 contextLines 行；文件不在本遍 diff 的意见直接丢弃。
    // 过滤发生在候选拦截链（OUT_OF_SCOPE），findings / tips / MCP / 审计同时生效；
    // 关闭 = 同文件远处、甚至未改动文件里的意见也保留。
    // contextLines 取值 0–2000；0 = 只保留 hunk 内。
    "findingScope": { "enabled": true, "contextLines": 10 },
    // 证据接地（F-04）：off = 不核对；warn = 只计数；drop = 无接地候选拒绝。
    // minMatchChars 是长代码片段的窗口匹配长度；整段逐字命中不受此限。
    "evidence": { "mode": "off", "minMatchChars": 30 },
    // MR 边界护栏：超界只告警（domainWarning）不拒检；null = 该维不设界。
    // maxDiffChars 是输入体积门：过滤后超限直接报错（不发模型请求），null = 关闭门禁。
    "boundary": {
      "maxFiles": 10,                    // 变更文件数上限。
      "maxDiffLines": 2000,              // 变更行数上限。
      "maxDiffChars": 1000000            // 过滤后 diff 字符数上限（超限直接报错；约 1.6 万–2.9 万变更行）。
    },
    // 大 MR 分片（ADR-0039）：过滤后的 diff 超过一片预算时，按 diff --git 文件块切开
    // 分别检视（绝不切 hunk），最后把各片 findings 合并去重。
    // 单个文件本身超过 maxShardChars 时，只保留文件头 + 前缀若干个完整 hunk（尾部
    // 整 hunk 丢弃并留痕，ADR-0070），不再报错。
    // 注意：maxShardChars 应小于 maxDiffChars，否则体积门先报错、分片永不触发。
    // 片尺寸按 128K 上下文定（ADR-0071）：单片 12 万字符 ≈ 3.1 万 tokens diff，
    // 叠加工具往返 + 输出的固定增长 ≈ 4.5 万，峰值 ≈ 8 万（实测口径见 ADR-0071）。
    "split": {
      "enabled": true,                   // 是否启用自动分片；false = 超预算仍单遍跑（旧行为，窗口风险自负）。
      "maxShardChars": 120000,           // 单片字符目标（约 1900–3500 变更行；峰值上下文约 8 万 tokens）。
      "maxShards": 12,                   // 片数上限（成本护栏）；1000000/120000 最坏 9 片，12 片留余量。
      "contextSummaryChars": 8000,       // 每片附带的「其他文件变更摘要」字符上限（不是证据源）。
      "concurrency": 1                   // 同一次 review 内并行片数（1 = 串行旧行为；1–8）。
    },
    // 规则包 zip 解压前的审计上限。
    "archive": {
      "maxArchiveBytes": 8388608,        // 压缩包体积上限（字节）。
      "maxEntries": 2000,                // 压缩包条目数上限。
      "maxTotalUncompressed": 67108864,  // 解压后总字节上限（防解压炸弹）。
      "maxCompressionRatio": 100         // 压缩比上限（解压后 / 压缩后，100 = 100:1）。
    },
    // 文本截断上限：工具输出、检索回显、调用链跳数、进度明细；一般不用改。
    "micro": {
      "skillBashOutputChars": 256000,    // 规则 Skill 中 bash 工具的输出字符上限。
      "queryEchoChars": 120,             // 检索工具回显 query 的字符上限。
      "callChainHops": 2,                // get_call_chain 降级为名字级引用链时的跳数。
      "toolNameChars": 60,               // 未知名工具回显的字符上限。
      "argumentsSummaryChars": 80,       // 进度行里工具入参摘要的字符上限（脱敏）。
      "progressDetailChars": 120         // 进度行里失败 / 结果摘要的字符上限（只取首行）。
    },
    // 覆盖缺口补漏（F-01b）：只对账本里 not-reached 的 hunk 发独立一次性请求。
    // enabled = false（缺省）时行为与 F-01a 完全一致；开启后每个 pass 最多
    // maxRequests 个请求，单请求最多 maxHunksPerRequest 个 hunk / maxChars 字符。
    // 因上限未发出的缺口保持 not-reached(cause=budget)。
    "coverage": {
      "repair": {
        "enabled": false,
        "maxRequests": 8,
        "maxChars": 24000,
        "maxHunksPerRequest": 6
      }
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
