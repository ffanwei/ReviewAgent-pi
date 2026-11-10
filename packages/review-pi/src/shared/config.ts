import { createHash } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, posix, relative, resolve, sep, win32 } from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseJsonc, printParseErrorCode, type ParseError } from "jsonc-parser";

import { MCP_REPORT_EVENT_TYPES, type McpReportEventType } from "../contracts/mcp-report.js";
import { SUPPORTED_LANGUAGE_IDS } from "../codeintel/language-support.js";
import { DEFAULT_EXCLUDE_GLOBS } from "../codeintel/scan-defaults.js";

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
export const CONFIG_FILE_NAME = "PiAgent.jsonc";
/** 官方直连 base URL（与 review-llm `DEEPSEEK_API_BASE_URL` 同值；两处刻意不互相 import） */
export const OFFICIAL_REVIEWER_BASE_URL = "https://api.deepseek.com";
/** 网关档缺省输出预算（官方直连不发 max_tokens；网关不发则继承请求默认值，实测 2048 会截断） */
export const DEFAULT_GATEWAY_MAX_TOKENS = 32_768;
/** 检视模型缺省 id（`--model` / `model.default` 都缺席时的最终回落） */
export const DEFAULT_MODEL_ID = "deepseek-v4-flash";

/**
 * 制品内呈现引擎的哨兵值（`presentation.engine = "builtin"`，ADR-0026）。
 * 写一个哨兵而不是绝对路径：配置要能在机器之间、在源码树与分发包之间直接
 * 复制粘贴，制品位置由安装形态自己决定。
 */
export const BUILTIN_ENGINE_SENTINEL = "builtin";

/** 本包根（`src/shared` 与 `dist/shared` 同一相对深度） */
const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** 制品内呈现引擎模块绝对路径（`build:presentation` 落到 `<pkg>/presentation/`） */
export function builtinPresentationEnginePath(): string {
  return resolve(packageRoot, "presentation", "engine-zh.js");
}

/**
 * 生效呈现引擎的绝对路径（ADR-0026）：
 * - `null` / 空白 ⇒ `null`（恒等直通，不投影）；
 * - `"builtin"` ⇒ 制品内引擎（`<pkg>/presentation/engine-zh.js`）；
 * - 绝对路径 ⇒ 原样；
 * - 相对路径 ⇒ **相对配置文件所在目录**，不是 cwd。配置文件说"引擎在这"，
 *   它就该跟着配置文件走：`review-pi` 从哪个目录启动都是同一结果。
 *
 * 只做路径解析，不校验存在性——存在性检查在装载期（main），因为缺失要降级
 * 成「未配置引擎」继续检视，而不是让配置读取失败（ADR-0026）。
 */
export function resolvePresentationEnginePath(
  engine: string | null | undefined,
  configPath: string,
): string | null {
  const raw = engine?.trim();
  if (raw === undefined || raw === "") {
    return null;
  }
  if (raw === BUILTIN_ENGINE_SENTINEL) {
    return builtinPresentationEnginePath();
  }
  return isAbsolute(raw) ? raw : resolve(dirname(resolve(configPath)), raw);
}

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
  readonly reviewTurnMs: number;
  readonly oneShotMs: number;
  readonly presentationRequestMs: number;
  readonly presentationBufferMs: number;
}

/**
 * LLM 调用重试（ADR-0051）：`maxAttempts` 一律是**总尝试次数（含首次）**。
 *
 * 分工：
 * - Agent 内会话（主检视回合 / 规则 Skill 会话）用 `reviewTurnAttempts` +
 *   `maxRetryAfterMs` → pi-ai `maxRetries` / `maxRetryDelayMs`；
 * - 核外一次性调用（片级报文 / 收尾总结）用 `oneShotAttempts`；
 * - 内置呈现引擎逐请求用 `presentationAttempts`（外部注入引擎无法被本仓强制，
 *   该值经 `PresentationRuntime.retry` 作为契约穿参）；
 * - smoke 探针缺省**不重试**（`smokeAttempts = 1`），要重试须显式配置。
 *
 * `baseDelayMs` / `maxDelayMs` 只作用于核外一次性调用；Agent 层的退避由
 * pi-ai 自身固定（0.5s→8s），本仓不 fork 上游、只透传次数与超时。
 */
export interface RetryLimits {
  readonly maxAttempts: number;
  readonly baseDelayMs: number;
  readonly maxDelayMs: number;
  readonly maxRetryAfterMs: number;
  readonly reviewTurnAttempts: number;
  readonly oneShotAttempts: number;
  readonly presentationAttempts: number;
  readonly smokeAttempts: number;
}

/** 检视循环上限（ADR-0046） */
export interface LoopLimits {
  /**
   * 最大轮次（一轮 = 六阶段完整一遍）。**最后一轮强制 complete**：
   * 模型说「还要再审」也不再开新轮，本轮产出即最终结果——轮次上限是成本线，
   * 不是失败，不产生 `MAX_ROUNDS_REACHED` 截断。
   */
  readonly maxRounds: number;
}

export interface ConcurrencyLimits {
  readonly suggestion: number;
}

/**
 * 中文 tips 的置信度过滤（ADR-0052）：`confidence < min` 的检视意见不进入
 * `reviews_tips_zh.json` 与 `mrReviewResult.reviewTips`。英文 findings 不受影响。
 * 取值 0–1，缺省 0.5（= 过滤 Low 档）；`0` = 不过滤，`1` = 只保留满置信。
 */
export interface ConfidenceLimits {
  readonly min: number;
}

/**
 * 中文 tips / MCP 上报的严重级过滤：`severity` 低于 min 的检视意见不进入
 * `reviews_tips_zh.json` 与 `mrReviewResult.reviewTips`。英文 findings / stdout
 * / 审计 findings 不受影响。取值 P0–P3，缺省 P3（= 不过滤）。
 */
export interface SeverityLimits {
  readonly min: "P0" | "P1" | "P2" | "P3";
}

/**
 * 测试文件检视开关：`skip = true`（缺省）时，`run/mr-input.ts` 在检视输入阶段
 * 按文件块整块剔除测试文件；`false` 时原样保留。影响的是**检视输入本身**
 * （findings / tips / MCP 上报同时生效），与 `limits.severity` / `limits.confidence`
 * 的输出侧过滤不同。
 */
export interface TestFileLimits {
  readonly skip: boolean;
}

/**
 * 按 glob 跳过检视（ADR-0069）：命中的文件块在**检视输入阶段**整块剔除，
 * 不进 diff / findings / 中文 tips / MCP 意见；但它们仍是「变更过的文件」，
 * 收尾按 ADR-0068 补一条空 `reviewTips` 的 `mrReviewResult`。
 *
 * 匹配对象是 diff 里的仓库相对 POSIX 路径，大小写不敏感；不含 `/` 的 glob
 * 只比文件名（`*.md` 与 `**\/*.md` 等价）。空数组 = 不排除。
 */
export interface MrFilterLimits {
  readonly excludeGlobs: readonly string[];
}

/**
 * 非 diff 区域过滤：`enabled = true`（缺省）时，候选拦截链只保留落在本遍
 * diff 变更 hunk 内（或距 hunk 边界不超过 `contextLines` 行）的检视意见；
 * 文件不在本遍 diff 的直接拒绝（`OUT_OF_SCOPE`）。影响 findings / tips /
 * MCP / 审计（被拒候选只留 rejectionCounts），关闭 = 保留同文件远处甚至
 * 未改动文件里的意见。
 */
export interface FindingScopeLimits {
  readonly enabled: boolean;
  readonly contextLines: number;
}

export interface BoundaryLimits {
  /** `>` 即降级；null = 该维度不设界 */
  readonly maxFiles: number | null;
  readonly maxDiffLines: number | null;
  /** 过滤后的 diff 字符数上限；超限直接报错，null = 关闭该门禁 */
  readonly maxDiffChars: number | null;
}

export interface SplitLimits {
  /** 是否允许在过滤后 diff 超过 maxShardChars 时自动分片（ADR-0039）；false = 保持单遍旧行为 */
  readonly enabled: boolean;
  /** 单片字符目标（不是硬失败线；单块超过它才是预检错误） */
  readonly maxShardChars: number;
  /** 片数上限（成本护栏）：需要更多片直接报错，由使用方拆 MR */
  readonly maxShards: number;
  /** 每片附带的「其他文件变更摘要」字符上限 */
  readonly contextSummaryChars: number;
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
  readonly loop: LoopLimits;
  readonly timeouts: TimeoutLimits;
  readonly retry: RetryLimits;
  readonly concurrency: ConcurrencyLimits;
  readonly confidence: ConfidenceLimits;
  readonly severity: SeverityLimits;
  readonly testFiles: TestFileLimits;
  readonly mrFilter: MrFilterLimits;
  readonly findingScope: FindingScopeLimits;
  readonly boundary: BoundaryLimits;
  readonly split: SplitLimits;
  readonly archive: ArchiveLimits;
  readonly micro: MicroLimits;
}

export const DEFAULT_LIMITS: Limits = {
  loop: { maxRounds: 3 },
  timeouts: {
    skillPassMs: 1_200_000,
    skillBashMs: 120_000,
    ruleSkillExtractMs: 30_000,
    ripgrepMs: 30_000,
    probeHealthMs: 15_000,
    probeModelMs: 120_000,
    reviewTurnMs: 180_000,
    oneShotMs: 300_000,
    presentationRequestMs: 90_000,
    presentationBufferMs: 30_000,
  },
  retry: {
    maxAttempts: 3,
    baseDelayMs: 500,
    maxDelayMs: 10_000,
    maxRetryAfterMs: 30_000,
    reviewTurnAttempts: 3,
    oneShotAttempts: 3,
    presentationAttempts: 3,
    smokeAttempts: 1,
  },
  concurrency: { suggestion: 4 },
  confidence: { min: 0.5 },
  severity: { min: "P3" },
  testFiles: { skip: true },
  mrFilter: { excludeGlobs: [] },
  findingScope: { enabled: true, contextLines: 10 },
  boundary: { maxFiles: 10, maxDiffLines: 2_000, maxDiffChars: 1_500_000 },
  split: { enabled: true, maxShardChars: 400_000, maxShards: 12, contextSummaryChars: 8_000 },
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
  /**
   * 模型 id 前缀剥离（缺省 false = 原样直发）：true 时所有发往网关的模型 id
   * （`--model` / `model.default` / `model.presentation`）剥掉**最后一个 `/` 前
   * 的所有**（`pan/deeseek` → `deeseek`）。给「平台侧传 `厂商/模型` 形态、网关
   * 只注册裸名」的部署用。**必须显式开启**：OpenRouter 等网关的合法 id 本身就
   * 带斜杠，无条件剥离会把它们发坏。
   */
  readonly stripModelPrefix: boolean;
}

export interface ModelSettings {
  readonly default: string;
  /** null = 跟随本次检视模型（ADR-0021） */
  readonly presentation: string | null;
}

export interface PresentationSettings {
  /** 核外呈现引擎模块路径；null = 恒等直通 */
  readonly engine: string | null;
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

/** MCP 服务端连接（ADR-0037：v1 只有 HTTP 传输；ADR-0037 后续修订加老式 http-sse） */
export interface McpServerSettings {
  /**
   * `"http"` = Streamable HTTP（单端点 POST，响应回在 POST 上——推荐形态）；
   * `"http-sse"` = 老式 HTTP+SSE（2024-11-05 规范：GET 长连接收 `endpoint`
   * 事件，消息 POST 到该端点，**响应从 SSE 流回来**）。url 语义随形态：
   * http 填消息端点；http-sse 填 **SSE 端点**（如 `…/sse`）。
   */
  readonly transport: "http" | "http-sse";
  /**
   * 握手策略（ADR-0037 后续修订）：
   * - `"auto"`（缺省）：先试 `initialize`，服务端不认就降级为无状态直调
   *   （每个 `tools/call` 独立 POST，与 Postman 单发同形）；
   * - `"required"`：握手失败即视为上报不可用；
   * - `"off"`：从不发 `initialize`，直调 `tools/call`。
   */
  readonly handshake: "auto" | "required" | "off";
  readonly url: string;
  /** 秘密：审计 / stdout / stderr / `config show` 一律只报 set | missing */
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** 上报批次与背压（数值在装载期已校验过范围） */
export interface McpReportBatchSettings {
  readonly maxEvents: number;
  readonly maxDelayMs: number;
}

/** 上报策略（ADR-0037 决策 6；业务 tool 开关为 ADR-0045；`tool` 可选化为 ADR-0037 后续修订） */
export interface McpReportSettings {
  /** 指向 `servers` 里的名字；装载期校验存在 */
  readonly server: string;
  /**
   * 单槽位接收工具（批量塞进 `events` 数组）。**可选（ADR-0045 后默认形态）**：
   * 缺席 = 事件通道整体关闭——只调四个业务 tool，不用写占位名与
   * `include: []`。给了才发进度事件（`include` 缺省四类）。
   */
  readonly tool?: string;
  /**
   * 业务 tool 开关（ADR-0045）：true = 调 `startTask` / `endTask` /
   * `saveReviewSummary` / `mrReviewResult`；false = 只发进度事件。
   * 缺省 true——老 server 没有这批 tool 时可一行关闭（省得日志一片红字）。
   */
  readonly task: boolean;
  readonly include: readonly McpReportEventType[];
  readonly batch: McpReportBatchSettings;
  readonly queue: { readonly maxEvents: number };
  readonly flushTimeoutMs: number;
  /** findings 出站档位：v1 只支持 none / summary（正文永不出进程） */
  readonly findings: "none" | "summary";
}

/** `mcp` 配置块；未配置 = null（零建连、零请求） */
export interface McpSettings {
  readonly servers: Readonly<Record<string, McpServerSettings>>;
  readonly report: McpReportSettings;
}

export interface ResolvedConfig {
  readonly version: typeof CONFIG_VERSION;
  readonly reviewer: ReviewerSettings;
  readonly model: ModelSettings;
  readonly presentation: PresentationSettings;
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
  // 模型 id 前缀剥离：缺省 false（原样直发的现行契约）；非布尔 fail fast
  const stripModelPrefix = boolOr(reviewerObj.stripModelPrefix, "reviewer.stripModelPrefix", false);

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

  const limits = parseLimits(root.limits, warnings);
  const mcp = parseMcp(root.mcp, warnings);
  const codeintel = parseCodeIntel(root.codeintel, warnings);

  const config: ResolvedConfig = {
    version: CONFIG_VERSION,
    reviewer: { apiKey: apiKey === "" ? null : apiKey, baseUrl, maxOutputTokens, stripModelPrefix },
    model: { default: modelDefault.trim(), presentation: modelPresentation?.trim() ?? null },
    presentation: { engine: engine?.trim() ?? null },
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
    reviewer: { apiKey: null, baseUrl: OFFICIAL_REVIEWER_BASE_URL, maxOutputTokens: null, stripModelPrefix: false },
    model: { default: DEFAULT_MODEL_ID, presentation: null },
    presentation: { engine: null },
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

const ROOT_KEYS = ["$schema", "version", "reviewer", "model", "presentation", "codeintel", "limits", "mcp"] as const;
const REVIEWER_KEYS = ["apiKey", "baseUrl", "maxOutputTokens", "stripModelPrefix"] as const;
const MODEL_KEYS = ["default", "presentation"] as const;
const PRESENTATION_KEYS = ["engine"] as const;
const CODEINTEL_KEYS = ["languages", "excludeGlobs"] as const;
const MCP_KEYS = ["servers", "report"] as const;
const MCP_SERVER_KEYS = ["transport", "handshake", "url", "headers", "timeoutMs"] as const;
const MCP_REPORT_KEYS = [
  "server",
  "tool",
  "task",
  "include",
  "batch",
  "queue",
  "flushTimeoutMs",
  "findings",
] as const;
const MCP_BATCH_KEYS = ["maxEvents", "maxDelayMs"] as const;
const MCP_QUEUE_KEYS = ["maxEvents"] as const;

const LIMITS_KEYS = ["loop", "timeouts", "retry", "concurrency", "confidence", "severity", "testFiles", "mrFilter", "findingScope", "boundary", "split", "archive", "micro"] as const;
const LOOP_KEYS = ["maxRounds"] as const;
const TIMEOUT_KEYS = [
  "skillPassMs",
  "skillBashMs",
  "ruleSkillExtractMs",
  "ripgrepMs",
  "probeHealthMs",
  "probeModelMs",
  "reviewTurnMs",
  "oneShotMs",
  "presentationRequestMs",
  "presentationBufferMs",
] as const;
const RETRY_KEYS = [
  "maxAttempts",
  "baseDelayMs",
  "maxDelayMs",
  "maxRetryAfterMs",
  "reviewTurnAttempts",
  "oneShotAttempts",
  "presentationAttempts",
  "smokeAttempts",
] as const;
const CONCURRENCY_KEYS = ["suggestion"] as const;
const CONFIDENCE_KEYS = ["min"] as const;
const SEVERITY_KEYS = ["min"] as const;
const TEST_FILES_KEYS = ["skip"] as const;
const MR_FILTER_KEYS = ["excludeGlobs"] as const;
const FINDING_SCOPE_KEYS = ["enabled", "contextLines"] as const;
const BOUNDARY_KEYS = ["maxFiles", "maxDiffLines", "maxDiffChars"] as const;
const SPLIT_KEYS = ["enabled", "maxShardChars", "maxShards", "contextSummaryChars"] as const;
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

function parseLimits(raw: unknown, warnings: string[]): Limits {
  if (raw === undefined) {
    return DEFAULT_LIMITS;
  }
  const limits = asObject(raw, "limits", warnings);
  assertKnownKeys(limits, LIMITS_KEYS, "limits", warnings);

  const loopObj = optionalObject(limits.loop, "limits.loop", warnings);
  assertKnownKeys(loopObj, LOOP_KEYS, "limits.loop", warnings);
  const loop: LoopLimits = {
    maxRounds: intOr(loopObj.maxRounds, "limits.loop.maxRounds", 1, 20, DEFAULT_LIMITS.loop.maxRounds),
  };

  const timeoutsObj = optionalObject(limits.timeouts, "limits.timeouts", warnings);
  assertKnownKeys(timeoutsObj, TIMEOUT_KEYS, "limits.timeouts", warnings);
  const timeouts: TimeoutLimits = {
    skillPassMs: intOr(timeoutsObj.skillPassMs, "limits.timeouts.skillPassMs", 1_000, 3_600_000, DEFAULT_LIMITS.timeouts.skillPassMs),
    skillBashMs: intOr(timeoutsObj.skillBashMs, "limits.timeouts.skillBashMs", 1_000, 600_000, DEFAULT_LIMITS.timeouts.skillBashMs),
    ruleSkillExtractMs: intOr(timeoutsObj.ruleSkillExtractMs, "limits.timeouts.ruleSkillExtractMs", 1_000, 600_000, DEFAULT_LIMITS.timeouts.ruleSkillExtractMs),
    ripgrepMs: intOr(timeoutsObj.ripgrepMs, "limits.timeouts.ripgrepMs", 1_000, 600_000, DEFAULT_LIMITS.timeouts.ripgrepMs),
    probeHealthMs: intOr(timeoutsObj.probeHealthMs, "limits.timeouts.probeHealthMs", 1_000, 120_000, DEFAULT_LIMITS.timeouts.probeHealthMs),
    probeModelMs: intOr(timeoutsObj.probeModelMs, "limits.timeouts.probeModelMs", 10_000, 600_000, DEFAULT_LIMITS.timeouts.probeModelMs),
    reviewTurnMs: intOr(timeoutsObj.reviewTurnMs, "limits.timeouts.reviewTurnMs", 1_000, 3_600_000, DEFAULT_LIMITS.timeouts.reviewTurnMs),
    oneShotMs: intOr(timeoutsObj.oneShotMs, "limits.timeouts.oneShotMs", 1_000, 3_600_000, DEFAULT_LIMITS.timeouts.oneShotMs),
    presentationRequestMs: intOr(timeoutsObj.presentationRequestMs, "limits.timeouts.presentationRequestMs", 1_000, 3_600_000, DEFAULT_LIMITS.timeouts.presentationRequestMs),
    presentationBufferMs: intOr(timeoutsObj.presentationBufferMs, "limits.timeouts.presentationBufferMs", 0, 3_600_000, DEFAULT_LIMITS.timeouts.presentationBufferMs),
  };

  const retryObj = optionalObject(limits.retry, "limits.retry", warnings);
  assertKnownKeys(retryObj, RETRY_KEYS, "limits.retry", warnings);
  const maxAttempts = intOr(
    retryObj.maxAttempts,
    "limits.retry.maxAttempts",
    1,
    10,
    DEFAULT_LIMITS.retry.maxAttempts,
  );
  // 路径级次数缺省继承 maxAttempts；smoke 例外（缺省 1 = 探针不重试），
  // 只有显式 smokeAttempts 才改变探针行为。
  const inheritedAttempts = (key: keyof RetryLimits, raw: unknown): number =>
    intOr(raw, `limits.retry.${key}`, 1, 10, maxAttempts);
  const retry: RetryLimits = {
    maxAttempts,
    baseDelayMs: intOr(retryObj.baseDelayMs, "limits.retry.baseDelayMs", 0, 60_000, DEFAULT_LIMITS.retry.baseDelayMs),
    maxDelayMs: intOr(retryObj.maxDelayMs, "limits.retry.maxDelayMs", 0, 600_000, DEFAULT_LIMITS.retry.maxDelayMs),
    maxRetryAfterMs: intOr(retryObj.maxRetryAfterMs, "limits.retry.maxRetryAfterMs", 0, 600_000, DEFAULT_LIMITS.retry.maxRetryAfterMs),
    reviewTurnAttempts: inheritedAttempts("reviewTurnAttempts", retryObj.reviewTurnAttempts),
    oneShotAttempts: inheritedAttempts("oneShotAttempts", retryObj.oneShotAttempts),
    presentationAttempts: inheritedAttempts("presentationAttempts", retryObj.presentationAttempts),
    smokeAttempts: intOr(
      retryObj.smokeAttempts,
      "limits.retry.smokeAttempts",
      1,
      10,
      DEFAULT_LIMITS.retry.smokeAttempts,
    ),
  };

  const concurrencyObj = optionalObject(limits.concurrency, "limits.concurrency", warnings);
  assertKnownKeys(concurrencyObj, CONCURRENCY_KEYS, "limits.concurrency", warnings);
  const concurrency: ConcurrencyLimits = {
    suggestion: intOr(concurrencyObj.suggestion, "limits.concurrency.suggestion", 1, 16, DEFAULT_LIMITS.concurrency.suggestion),
  };

  const confidenceObj = optionalObject(limits.confidence, "limits.confidence", warnings);
  assertKnownKeys(confidenceObj, CONFIDENCE_KEYS, "limits.confidence", warnings);
  const confidence: ConfidenceLimits = {
    min: numberOr(
      confidenceObj.min,
      "limits.confidence.min",
      0,
      1,
      DEFAULT_LIMITS.confidence.min,
    ),
  };

  const severityObj = optionalObject(limits.severity, "limits.severity", warnings);
  assertKnownKeys(severityObj, SEVERITY_KEYS, "limits.severity", warnings);
  const severity: SeverityLimits = {
    min: severityOr(severityObj.min, "limits.severity.min", DEFAULT_LIMITS.severity.min),
  };

  const testFilesObj = optionalObject(limits.testFiles, "limits.testFiles", warnings);
  assertKnownKeys(testFilesObj, TEST_FILES_KEYS, "limits.testFiles", warnings);
  const testFiles: TestFileLimits = {
    skip: boolOr(testFilesObj.skip, "limits.testFiles.skip", DEFAULT_LIMITS.testFiles.skip),
  };

  const mrFilterObj = optionalObject(limits.mrFilter, "limits.mrFilter", warnings);
  assertKnownKeys(mrFilterObj, MR_FILTER_KEYS, "limits.mrFilter", warnings);
  const mrFilter: MrFilterLimits = {
    excludeGlobs: parseGlobList(
      mrFilterObj.excludeGlobs,
      "limits.mrFilter.excludeGlobs",
      DEFAULT_LIMITS.mrFilter.excludeGlobs,
    ),
  };

  const findingScopeObj = optionalObject(limits.findingScope, "limits.findingScope", warnings);
  assertKnownKeys(findingScopeObj, FINDING_SCOPE_KEYS, "limits.findingScope", warnings);
  const findingScope: FindingScopeLimits = {
    enabled: boolOr(
      findingScopeObj.enabled,
      "limits.findingScope.enabled",
      DEFAULT_LIMITS.findingScope.enabled,
    ),
    contextLines: intOr(
      findingScopeObj.contextLines,
      "limits.findingScope.contextLines",
      0,
      2_000,
      DEFAULT_LIMITS.findingScope.contextLines,
    ),
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
    maxDiffChars:
      boundaryObj.maxDiffChars === null
        ? null
        : (optionalInt(boundaryObj.maxDiffChars, "limits.boundary.maxDiffChars", {
            min: 1_000,
            max: 100_000_000,
            nullable: true,
          }) ?? DEFAULT_LIMITS.boundary.maxDiffChars),
  };

  const splitObj = optionalObject(limits.split, "limits.split", warnings);
  assertKnownKeys(splitObj, SPLIT_KEYS, "limits.split", warnings);
  const split: SplitLimits = {
    enabled: boolOr(splitObj.enabled, "limits.split.enabled", DEFAULT_LIMITS.split.enabled),
    maxShardChars: intOr(
      splitObj.maxShardChars,
      "limits.split.maxShardChars",
      10_000,
      100_000_000,
      DEFAULT_LIMITS.split.maxShardChars,
    ),
    maxShards: intOr(splitObj.maxShards, "limits.split.maxShards", 1, 64, DEFAULT_LIMITS.split.maxShards),
    contextSummaryChars: intOr(
      splitObj.contextSummaryChars,
      "limits.split.contextSummaryChars",
      1_000,
      64_000,
      DEFAULT_LIMITS.split.contextSummaryChars,
    ),
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

  return { loop, timeouts, retry, concurrency, confidence, severity, testFiles, mrFilter, findingScope, boundary, split, archive, micro };
}

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

/** glob 列表解析（`codeintel.excludeGlobs` 与 `limits.mrFilter.excludeGlobs` 共用） */
function parseGlobList(
  value: unknown,
  label: string,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${label} must be an array of glob patterns (got ${describe(value)})`,
    );
  }
  const globs: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigError(
        `${CONFIG_FILE_NAME}: ${label}[${String(index)}] must be a non-empty string (got ${describe(entry)})`,
      );
    }
    const glob = entry.trim();
    if (!globs.includes(glob)) {
      globs.push(glob);
    }
  });
  return globs;
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
    if (!SUPPORTED_LANGUAGE_IDS.includes(id)) {
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

/** 出站事件类型合法值（单一源：`contracts/mcp-report.ts`） */
const MCP_EVENT_TYPES: ReadonlySet<string> = new Set(MCP_REPORT_EVENT_TYPES);

/** 缺省上报事件集：`tool.*` / `skill.*` 频率最高、对机器流水价值最低，默认不发 */
const DEFAULT_MCP_INCLUDE: readonly McpReportEventType[] = [
  "run.start",
  "run.end",
  "phase",
  "request.end",
];

/**
 * `mcp` 块：未配置（或只有 servers 没有 report）= null，不是错误。
 * 有 report 但配置不自洽 = ConfigError（启动期 fail fast，不进主链）。
 */
function parseMcp(raw: unknown, warnings: string[]): McpSettings | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const mcp = asObject(raw, "mcp", warnings);
  assertKnownKeys(mcp, MCP_KEYS, "mcp", warnings);
  if (mcp.report === undefined || mcp.report === null) {
    return null;
  }

  const serversObj = optionalObject(mcp.servers, "mcp.servers", warnings);
  const servers: Record<string, McpServerSettings> = {};
  for (const [name, entry] of Object.entries(serversObj)) {
    if (name.trim() === "") {
      throw new ConfigError(`${CONFIG_FILE_NAME}: mcp.servers keys must be non-empty server names`);
    }
    servers[name] = parseMcpServer(name, entry, warnings);
  }

  const reportObj = asObject(mcp.report, "mcp.report", warnings);
  assertKnownKeys(reportObj, MCP_REPORT_KEYS, "mcp.report", warnings);
  const server = requiredNonEmptyString(reportObj.server, "mcp.report.server");
  // tool 可选（ADR-0045 后默认形态）：缺席 = 事件通道关闭，只调四个业务 tool。
  // 给了就必须是非空字符串（空串 = 用法错误，不是「关」）。
  const tool =
    reportObj.tool === undefined || reportObj.tool === null
      ? undefined
      : requiredNonEmptyString(reportObj.tool, "mcp.report.tool");
  if (servers[server] === undefined) {
    const known = Object.keys(servers);
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: mcp.report.server must name a configured server (got ${JSON.stringify(server)}; ` +
        `${known.length === 0 ? "mcp.servers is empty" : `known: ${known.join(", ")}`})`,
    );
  }
  // 业务 tool 开关（ADR-0045）：缺省 true（要业务上报就真调；老 server 一行关闭）
  const task = boolOr(reportObj.task, "mcp.report.task", true);
  const include = parseMcpInclude(reportObj.include);

  const batchObj = optionalObject(reportObj.batch, "mcp.report.batch", warnings);
  assertKnownKeys(batchObj, MCP_BATCH_KEYS, "mcp.report.batch", warnings);
  const batch: McpReportBatchSettings = {
    maxEvents: intOr(batchObj.maxEvents, "mcp.report.batch.maxEvents", 1, 1_000, 50),
    maxDelayMs: intOr(batchObj.maxDelayMs, "mcp.report.batch.maxDelayMs", 0, 600_000, 2_000),
  };

  const queueObj = optionalObject(reportObj.queue, "mcp.report.queue", warnings);
  assertKnownKeys(queueObj, MCP_QUEUE_KEYS, "mcp.report.queue", warnings);
  const queue = {
    maxEvents: intOr(queueObj.maxEvents, "mcp.report.queue.maxEvents", 1, 100_000, 1_000),
  };

  const flushTimeoutMs = intOr(reportObj.flushTimeoutMs, "mcp.report.flushTimeoutMs", 0, 600_000, 5_000);

  const findingsRaw = optionalString(reportObj.findings, "mcp.report.findings")?.trim() ?? "summary";
  if (findingsRaw !== "none" && findingsRaw !== "summary") {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: mcp.report.findings must be "none" or "summary" (got ${JSON.stringify(findingsRaw)}; ` +
        `finding 正文永不出进程，要正文请读 reviews_en.json)`,
    );
  }

  return {
    servers,
    report: {
      server,
      ...(tool !== undefined ? { tool } : {}),
      task,
      include,
      batch,
      queue,
      flushTimeoutMs,
      findings: findingsRaw,
    },
  };
}

function parseMcpServer(name: string, raw: unknown, warnings: string[]): McpServerSettings {
  const path = `mcp.servers.${name}`;
  const obj = asObject(raw, path, warnings);
  assertKnownKeys(obj, MCP_SERVER_KEYS, path, warnings);

  const transport = optionalString(obj.transport, `${path}.transport`)?.trim() ?? "http";
  if (transport !== "http" && transport !== "http-sse") {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path}.transport must be "http" (Streamable HTTP，单端点 POST) ` +
        `or "http-sse" (老式 HTTP+SSE，GET 长连接 + endpoint 事件；got ${JSON.stringify(transport)}；stdio 不在范围内)`,
    );
  }

  const handshakeRaw = optionalString(obj.handshake, `${path}.handshake`)?.trim() ?? "auto";
  if (handshakeRaw !== "auto" && handshakeRaw !== "required" && handshakeRaw !== "off") {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path}.handshake must be "auto" ` +
        `(握手失败降级为无状态直调，缺省), "required" ` +
        `(握手失败即上报不可用) or "off" (从不握手，直接 tools/call；got ${JSON.stringify(handshakeRaw)})`,
    );
  }
  const handshake = handshakeRaw;

  const url = requiredNonEmptyString(obj.url, `${path}.url`);
  if (!/^https?:\/\//.test(url)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path}.url must start with http:// or https:// (got ${JSON.stringify(url)})`,
    );
  }

  const headersObj = optionalObject(obj.headers, `${path}.headers`, warnings);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headersObj)) {
    if (typeof value !== "string") {
      throw new ConfigError(`${CONFIG_FILE_NAME}: ${path}.headers.${key} must be a string`);
    }
    headers[key] = value;
  }

  return {
    transport,
    handshake,
    url,
    headers,
    timeoutMs: intOr(obj.timeoutMs, `${path}.timeoutMs`, 100, 600_000, 60_000),
  };
}

/** `include` 缺省 = 稳定默认集；未知类型 fail fast（不静默忽略拼错的类型） */
function parseMcpInclude(raw: unknown): readonly McpReportEventType[] {
  if (raw === undefined || raw === null) {
    return DEFAULT_MCP_INCLUDE;
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: mcp.report.include must be an array of event types (got ${describe(raw)})`,
    );
  }
  const include: McpReportEventType[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string" || !MCP_EVENT_TYPES.has(entry)) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME}: mcp.report.include[${String(index)}] must be one of ` +
          `${MCP_REPORT_EVENT_TYPES.join(", ")} (got ${JSON.stringify(entry)})`,
      );
    }
    if (!include.includes(entry as McpReportEventType)) {
      include.push(entry as McpReportEventType);
    }
  });
  return include;
}

function requiredNonEmptyString(value: unknown, path: string): string {
  const text = optionalString(value, path)?.trim();
  if (text === undefined || text === "") {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} is required (non-empty string)`);
  }
  return text;
}

// ---------------------------------------------------------------------------
// 扁平值 / 摘要
// ---------------------------------------------------------------------------

function effectiveValues(config: ResolvedConfig): Readonly<Record<string, unknown>> {
  const values: Record<string, unknown> = {
    "reviewer.baseUrl": config.reviewer.baseUrl,
    "reviewer.maxOutputTokens": config.reviewer.maxOutputTokens,
    "reviewer.stripModelPrefix": config.reviewer.stripModelPrefix,
    "model.default": config.model.default,
    "model.presentation": config.model.presentation,
    "presentation.engine": config.presentation.engine,
    "codeintel.languages": config.codeintel.languages,
    "codeintel.excludeGlobs": config.codeintel.excludeGlobs,
  };
  for (const [group, entries] of Object.entries(config.limits)) {
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
  mark("presentation", asRecordOrUndefined(root.presentation));
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
      warnings.push(`PiAgent.jsonc: ${full} 已钉死（pinned），不会被采用`);
      continue;
    }
    warnings.push(`PiAgent.jsonc: unknown key ${full}${nearestHint(key, allowed)}`);
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

/**
 * 必填的「有值则校验，无值用缺省」有限小数（0–1 这类比例值；非有限数 /
 * 非数字 / 越界一律 fail fast，不把 "0.5" 当 0.5）。
 */
function numberOr(value: unknown, path: string, min: number, max: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be a number (got ${describe(value)})`);
  }
  if (value < min || value > max) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path} must be in ${String(min)}…${String(max)} (got ${String(value)})`,
    );
  }
  return value;
}

/**
 * 严重级阈值：缺省用 fallback；只接受 P0–P3（大小写不敏感，归一为大写），
 * 其它值 fail fast（不把 "P5" / 4 当合法档位）。
 */
function severityOr(
  value: unknown,
  path: string,
  fallback: "P0" | "P1" | "P2" | "P3",
): "P0" | "P1" | "P2" | "P3" {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (normalized === "P0" || normalized === "P1" || normalized === "P2" || normalized === "P3") {
      return normalized;
    }
  }
  throw new ConfigError(
    `${CONFIG_FILE_NAME}: ${path} must be one of P0, P1, P2, P3 (got ${describe(value)})`,
  );
}

/** 布尔开关：缺省用 fallback；出现非布尔值 fail fast（不把 "false" 当 false） */
function boolOr(value: unknown, path: string, fallback: boolean): boolean {  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path} must be true or false (got ${describe(value)})`,
    );
  }
  return value;
}

/**
 * 模型 id → 网关 wire 字段（`reviewer.stripModelPrefix` 开启时生效）：
 * 剥掉**最后一个 `/` 前的所有**（`pan/deeseek` → `deeseek`、`a/b/c` → `c`）。
 * 无斜杠原样返回；剥完为空（如 `pan/`）也原样返回——发送空 model 是更坏的
 * 失败形态，宁可让网关拒原串并留痕。开关关闭 = 逐字节原样（现行契约）。
 */
export function modelIdForGateway(rawModelId: string, stripPrefix: boolean): string {
  if (!stripPrefix) {
    return rawModelId;
  }
  const cut = rawModelId.lastIndexOf("/");
  return cut >= 0 && cut < rawModelId.length - 1 ? rawModelId.slice(cut + 1) : rawModelId;
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
  const enginePath =
    overrides.enginePath === undefined ? jsonString(BUILTIN_ENGINE_SENTINEL) : JSON.stringify(overrides.enginePath);
  // 排除 glob 直接从常量生成：模板与运行时默认值不会漂移
  const excludeGlobLines = DEFAULT_EXCLUDE_GLOBS.map((glob) => `      ${jsonString(glob)}`).join(",\n");
  return `{
  // PiAgent 运行配置（ADR-0025）。JSONC：允许注释与尾逗号。
  // 秘密（reviewer.apiKey / mcp 的 headers）只写在这里；环境变量不再被读取。
  // 配置版本：当前只支持 1，不匹配即 fail fast。
  // 分区导航：reviewer / model / presentation（模型接入与呈现）→ codeintel（代码智能）
  // → mcp（外发上报，缺省整块注释）→ limits（资源与行为护栏）。
  "version": 1,

  "reviewer": {
    // 模型网关密钥（必需）。审计与日志只报 set / missing，绝不回显值。
    "apiKey": ${apiKey},
    // 网关基址：官方直连用 https://api.deepseek.com；OpenAI 兼容网关需自带 /v1（不带 /chat/completions）。
    "baseUrl": ${baseUrl},
    // 单次请求输出上限：null = 自动——官方直连不发 max_tokens；网关发 ${String(DEFAULT_GATEWAY_MAX_TOKENS)}。
    "maxOutputTokens": ${maxOutputTokens},
    // 模型 id 前缀剥离：true = 发往网关的模型 id 剥掉最后一个 / 前的所有
    // （pan/deeseek → deeseek，覆盖 --model / model.default / model.presentation）。
    // 缺省 false = 原样直发（OpenRouter 等网关的合法 id 本身就带斜杠）。
    "stripModelPrefix": false
  },

  "model": {
    // 默认检视模型（--model 可覆盖）。
    "default": ${modelDefault},
    // 报文 / 总结 / 片级语义生成模型：null = 跟随本次检视模型（ADR-0021）。
    "presentation": ${modelPresentation}
  },

  "presentation": {
    // legacy 兼容键（ADR-0065 后 CLI 不再调用呈现引擎；控制台恒英文）。
    // builtin = 制品自带（跟着当前安装的 review-pi 包走）；null = 不配置；
    // 模块路径按本配置文件所在目录解析（ADR-0026）。
    "engine": ${enginePath}
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
    "loop": { "maxRounds": 3 },
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
      "presentationRequestMs": 90000,    // legacy 呈现引擎单次请求超时（ADR-0065 后 CLI 不再调用）。
      "presentationBufferMs": 30000      // legacy 呈现引擎整批总超时余量。
    },
    // LLM 调用重试（ADR-0051）：次数一律是「总尝试次数（含首次）」。
    // 主检视回合 / 规则 Skill 会话走 pi-ai 的流请求重试；报文 / 总结 / 内置呈现引擎 / smoke
    // 走本仓统一重试。只有请求建立阶段可重试——流已开始后断开会显式报错，不做整回合重放。
    // baseDelayMs / maxDelayMs 只作用于核外一次性调用；maxRetryAfterMs 同时约束服务端
    // Retry-After 与 pi-ai 的 maxRetryDelayMs。
    "retry": {
      "maxAttempts": 3,                  // 全局缺省：总尝试次数（1 = 不重试）。
      "baseDelayMs": 500,                // 指数退避基准（毫秒）。
      "maxDelayMs": 10000,               // 单次退避上限（毫秒）。
      "maxRetryAfterMs": 30000,          // 服务端要求等待的上限（毫秒）；0 = 不设上限。
      "reviewTurnAttempts": 3,           // 主检视回合 / 规则 Skill 会话总尝试次数。
      "oneShotAttempts": 3,              // 片级报文 / 收尾总结总尝试次数。
      "presentationAttempts": 3,         // legacy 呈现引擎逐请求总尝试次数（ADR-0065 后 CLI 不再调用）。
      "smokeAttempts": 1                 // smoke 探针总尝试次数（缺省 1 = 不重试）。
    },
    // legacy：呈现引擎的 suggestion 并发生成数（ADR-0065 后 CLI 不再调用）。
    "concurrency": { "suggestion": 4 },
    // 检视意见置信度过滤（ADR-0052）：confidence 低于 min 的意见不进入中文 tips
    // （reviews_tips_zh.json 与 mrReviewResult.reviewTips）；英文 findings / stdout 不受影响。
    // 0–1，缺省 0.5（= 过滤 Low 档）；0 = 不过滤。
    "confidence": { "min": 0.5 },
    // 检视意见严重级过滤：severity 低于 min 的意见不进入中文 tips
    // （reviews_tips_zh.json 与 mrReviewResult.reviewTips）；英文 findings / stdout 不受影响。
    // 取值 P0–P3，缺省 P3（= 不过滤）；P2 = 只保留 P0/P1/P2，丢弃 P3 建议级。
    "severity": { "min": "P3" },
    // 测试文件是否跳过检视（缺省 true = 跳过）：
    // true  = 检视输入阶段按文件块整块剔除测试文件（不进 diff、不产 findings、
    //         不进中文 tips / MCP 上报）；这种剔除发生在检视之前，与 severity /
    //         confidence 的输出侧过滤不同。
    // false = 测试文件与生产代码同等检视。
    "testFiles": { "skip": true },
    // 按 glob 跳过检视（ADR-0069，缺省空数组 = 不排除）：
    // 命中的文件块在检视输入阶段整块剔除（不进 diff、不产 findings、不进中文 tips /
    // MCP 意见）；它们仍是变更过的文件，收尾按 ADR-0068 补一条空 reviewTips 的
    // mrReviewResult。匹配对象是仓库相对 POSIX 路径，大小写不敏感；不含 "/" 的 glob
    // 只比文件名（*.md 与 **/*.md 等价），* / ? 不跨目录，** 跨目录。
    // 例：["**/*.md", "docs/**"] 跳过全部 Markdown 与 docs 目录。
    "mrFilter": { "excludeGlobs": [] },
    // 非 diff 区域过滤（缺省开启）：检视意见必须落在本遍 diff 的变更 hunk 内，
    // 或距 hunk 边界不超过 contextLines 行；文件不在本遍 diff 的意见直接丢弃。
    // 过滤发生在候选拦截链（OUT_OF_SCOPE），findings / tips / MCP / 审计同时生效；
    // 关闭 = 同文件远处、甚至未改动文件里的意见也保留。
    // contextLines 取值 0–2000；0 = 只保留 hunk 内。
    "findingScope": { "enabled": true, "contextLines": 10 },
    // MR 边界护栏：超界只告警（domainWarning）不拒检；null = 该维不设界。
    // maxDiffChars 是输入体积门：过滤后超限直接报错（不发模型请求），null = 关闭门禁。
    "boundary": {
      "maxFiles": 10,                    // 变更文件数上限。
      "maxDiffLines": 2000,              // 变更行数上限。
      "maxDiffChars": 1500000            // 过滤后 diff 字符数上限（超限直接报错）。
    },
    // 大 MR 分片（ADR-0039）：过滤后的 diff 超过一片预算时，按 diff --git 文件块切开
    // 分别检视（绝不切 hunk），最后把各片 findings 合并去重。只负责「文件多」；
    // 单个文件本身过大仍会报错（留给第三期按需读取）。
    // 注意：maxShardChars 应小于 maxDiffChars，否则体积门先报错、分片永不触发。
    "split": {
      "enabled": true,                   // 是否启用自动分片；false = 超预算仍单遍跑（旧行为，窗口风险自负）。
      "maxShardChars": 400000,           // 单片字符目标（约 10 万 tokens，给 128K 上下文的网关留余量）。
      "maxShards": 12,                   // 片数上限（成本护栏）；需要更多片即报错，请拆 MR 或调大此值。
      "contextSummaryChars": 8000        // 每片附带的「其他文件变更摘要」字符上限（不是证据源）。
    },
    // 规则包 zip 解压前的审计上限。
    "archive": {
      "maxArchiveBytes": 8388608,        // 压缩包体积上限（字节）。
      "maxEntries": 2000,                // 压缩包条目数上限。
      "maxTotalUncompressed": 67108864,  // 解压后总字节上限（防解压炸弹）。
      "maxCompressionRatio": 100         // 压缩比上限（解压后 / 压缩后，100 = 100:1）。
    },
    // 文本截断上限：工具输出、包头部、检索回显、调用链跳数、进度明细；一般不用改。
    "micro": {
      "skillBashOutputChars": 256000,    // 规则 Skill 中 bash 工具的输出字符上限。
      "packageHeadBytes": 8192,          // 读取文件头以提取包名时的最大字节数。
      "queryEchoChars": 120,             // 检索工具回显 query 的字符上限。
      "callChainHops": 2,                // get_call_chain 降级为名字级引用链时的跳数。
      "toolNameChars": 60,               // 未知名工具回显的字符上限。
      "argumentsSummaryChars": 80,       // 进度行里工具入参摘要的字符上限（脱敏）。
      "progressDetailChars": 120         // 进度行里失败 / 结果摘要的字符上限（只取首行）。
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
