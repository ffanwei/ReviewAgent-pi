import { readdir, readFile } from "node:fs/promises";
import type { Dirent } from "node:fs";
import path from "node:path";

import {
  DEEPSEEK_API_BASE_URL,
  resolveApiKey,
  resolveEndpointUrl,
  REVIEWER_API_KEY_ENV_VARS,
  REVIEWER_URL_ENV_VARS,
  type EnvLookup,
} from "review-llm";

import type { Finding } from "review-pi";
import { buildReviewTipsDocument, dedupeFindingsByLine, reviewOf, type ReviewTipsDocument } from "./tips.js";
import type { TranslateEngine, TerminologyContext } from "./translate-projection.js";
import {
  projectReviewDocument,
  type ProjectedReviewDocument,
  type ReviewPresentationSource,
} from "./translate-projection.js";

/**
 * 真引擎装配（ADR-0010「英文产出 + 核外翻译投影」的消费端接线件）：CLI
 * 呈现投影缝（REVIEW_PI_PRESENTATION_ENGINE 注入的引擎模块）的默认实现。
 *
 * 模块协议（packages/review-pi/src/cli/presentation-projection.ts 单源定义）：
 * ESM default export = (source: { findings, toolCallLog, codeByFinding?,
 * rulePackDirs? }) => 投影文档 { provenance, findings, toolCallLog, tips }——
 * 自然语言字段（title / description / resultSummary）经 LLM 译中文，结构化
 * 字段字节直通（直通由 translate-projection.ts 逐字段锁定，本模块不复查）；
 * `tips` = 分组式检视意见（ADR-0017，严格 10 键封闭）。运行形状校验在 CLI
 * 缝侧（引擎失败 → 呈现降级英文源，检视产物不丢）。
 *
 * 边界纪律（ADR-0010 Considered Options）：
 * - 翻译是呈现关注点——本模块属核外装配面，**与 translate-projection.ts
 *   不同，本模块持网络与密钥**（真引擎由消费端装配的「装配」即此处）；
 * - 检视链零触碰：本模块不进任何检视请求路径，语言不进检视执行缝
 *   （语言零漂移回归仍绿）。
 *
 * ADR-0017 附加职责（同为核外装配面）：
 * - `code` 不由本模块取（CLI 按 `--repo` 抽好经 `codeByFinding` 注入）——
 *   引擎保持零源码文件系统访问，`Finding.line` 与 `--repo` 工作树天然对齐；
 * - `suggestion` 是**新增生成行为**（不是翻译）：每条 finding 一次网关调用，
 *   并发上限 SUGGESTION_CONCURRENCY，单条失败/超时 ⇒ 空串（不阻断落盘）；
 * - `ruleId` 白名单从本次 run 的规则包解压目录读 frontmatter `id`（只给目录，
 *   内核不解析规则文件）；读不到 ⇒ 空集 ⇒ 所有 ruleId 空串。
 *
 * 接入（经进程环境变量，与检视链同款单源解析 review-llm）：
 * - 网关与凭据复用 REVIEWER_URL / REVIEWER_API_KEY（CLI 进程已在凭据解析
 *   前装载 .env.local——本模块运行于同一进程，无需重复装载）；
 * - 翻译/建议模型 id 走 REVIEW_PI_PRESENTATION_MODEL（显式配置优先）；未配置时
 *   跟随本次检视的 `--model`（CLI 经呈现源 `modelId` 透传，ADR-0021），再缺省
 *   deepseek-v4-flash——呈现与检视同端点模型可避免「网关只服务 ep-xxx 时译文
 *   打不动」；呈现配置只是缺省值跟随，不是检视自变量；
 * - key 绝不硬编码、绝不出现在错误信息或任何落盘产物中。
 *
 * 翻译口径：术语表（terminology.ts 单源，随 TerminologyContext 注入）作
 * 引擎参考上下文（非硬替换）；代码标识（类名/方法名/路径/代码摘录）与
 * 结构化标识（P0–P3 等）保持原样不译；temperature 0 求确定译文。
 */

/** 翻译/建议模型 id 环境变量（呈现配置；缺省 DEFAULT_PRESENTATION_MODEL） */
export const PRESENTATION_MODEL_ENV_VAR = "REVIEW_PI_PRESENTATION_MODEL";

/** 缺省翻译模型（轻任务档；消费端可经环境变量覆盖） */
export const DEFAULT_PRESENTATION_MODEL = "deepseek-v4-flash";

/**
 * 单次翻译请求超时（引擎内部；CLI 缝侧另有总兜底）。长 description 的译文
 * 可达数百汉字——非流式 completion 要等全量生成完才回，实测单字段可上探
 * 数十秒（2026-10-20 真跑：~200 词 description 译 >30s 触发旧 30s 上界），
 * 90s 是「慢但可达」与「挂死早暴露」的折中。
 */
const TRANSLATION_REQUEST_TIMEOUT_MS = 90_000;

/** 单次建议生成请求超时（ADR-0017：与翻译同口径 90s） */
const SUGGESTION_REQUEST_TIMEOUT_MS = 90_000;

/** 建议生成并发上限（ADR-0017：逐条独立请求，4 路并发覆盖常见 4~8 条量级） */
export const SUGGESTION_CONCURRENCY = 4;

/** 服务标签：错误消息前缀（与检视链同款角色命名，不称具体服务商） */
const SERVICE_LABEL = "presentation translation LLM API";

/** 建议生成的服务标签（错误消息前缀，与翻译区分便于诊断） */
const SUGGESTION_SERVICE_LABEL = "presentation suggestion LLM API";

/** 引擎装配选项（网络件全注入——测试 fake fetch，真跑 globalThis.fetch） */
export interface GatewayEngineOptions {
  readonly endpointUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly fetchFn: typeof fetch;
  readonly env?: EnvLookup;
}

/** 分组意见的附加呈现源（ADR-0017：CLI 抽好的源码行 + 规则包解压目录） */
export interface PresentationEngineInput extends ReviewPresentationSource {
  readonly codeByFinding?: Readonly<Record<string, string>>;
  readonly rulePackDirs?: readonly string[];
  /**
   * 本次检视的模型 id（ADR-0021：`REVIEW_PI_PRESENTATION_MODEL` 缺席时的
   * 覆盖值——由 CLI 从 `--model` 透传，缺省覆盖下沉到调用方，引擎自身
   * 仍不读检视参数）。
   */
  readonly modelId?: string;
}

/** 引擎产物 = zh 投影文档 + 分组意见（tips 与 zh 弱耦合，形状由 CLI 缝校验） */
export interface EnginePresentationDocument extends ProjectedReviewDocument {
  readonly tips: ReviewTipsDocument;
}

/**
 * 投影呈现文档（CLI 缝调用入口）：装配网关翻译引擎 → zh 档翻译投影 →
 * 分组意见（ADR-0017）。网关/凭据解析失败在装配期抛错（CLI 缝归 degraded，
 * 呈现降级英文源）；建议生成失败逐条降级为空串（不拖累 zh）。
 */
export default async function projectZhPresentation(
  source: PresentationEngineInput,
): Promise<EnginePresentationDocument> {
  const env: EnvLookup = process.env;
  const gateway: GatewayEngineOptions = {
    endpointUrl: resolveEndpointUrl({
      defaultBaseUrl: DEEPSEEK_API_BASE_URL,
      envVarNames: [...REVIEWER_URL_ENV_VARS],
      clientError: (message) => new Error(message),
      env,
    }),
    apiKey: resolveApiKey({
      envVarNames: [...REVIEWER_API_KEY_ENV_VARS],
      serviceLabel: SERVICE_LABEL,
      clientError: (message) => new Error(message),
      env,
    }),
    modelId: resolvePresentationModelId(env, source.modelId),
    fetchFn: globalThis.fetch,
  };
  const projected = await projectReviewDocument(
    { engine: createGatewayTranslateEngine(gateway) },
    { source, language: "zh" },
  );
  const codeByFinding = source.codeByFinding ?? {};
  const knownRuleIds = await loadKnownRuleIds(source.rulePackDirs ?? []);
  // ADR-0023：tips 会对「同文件同行」去重，建议只为保留下来的行生成——
  // 已丢弃的行不该再花一次网关调用（口径与 buildReviewTipsDocument 同源）。
  const tipsFindings = dedupeFindingsByLine(projected.findings);
  const suggestions = await generateSuggestions(tipsFindings, codeByFinding, gateway);
  const tips = buildReviewTipsDocument({
    findings: tipsFindings,
    codeByFinding,
    knownRuleIds,
    suggestions,
  });
  return { ...projected, tips };
}

/**
 * 翻译模型 id（ADR-0021 三级链）：
 * 1. `REVIEW_PI_PRESENTATION_MODEL`（`.env.local` 显式配置优先）；
 * 2. 本次检视的模型 id（CLI 透传的 `--model`）——「没单独配就跟着检视模型走」；
 * 3. 缺省轻任务档 `DEFAULT_PRESENTATION_MODEL`（直调引擎、无 CLI 上下文时）。
 */
function resolvePresentationModelId(env: EnvLookup, reviewModelId?: string): string {
  const fromEnv = env[PRESENTATION_MODEL_ENV_VAR]?.trim();
  if (fromEnv !== undefined && fromEnv !== "") {
    return fromEnv;
  }
  const fromReview = reviewModelId?.trim();
  if (fromReview !== undefined && fromReview !== "") {
    return fromReview;
  }
  return DEFAULT_PRESENTATION_MODEL;
}

/**
 * 网关翻译引擎（TranslateEngine 实现）：OpenAI 兼容 chat/completions
 * 非流式调用——system 装翻译口径 + 术语表，user 装待译文本，取
 * choices[0].message.content 为译文。空响应/非 2xx/网络异常均抛人话错误
 * （CLI 缝统一归呈现降级，检视产物不丢）。
 */
export function createGatewayTranslateEngine(options: GatewayEngineOptions): TranslateEngine {
  return async (text: string, context: TerminologyContext): Promise<string> =>
    postCompletion(options, [
      { role: "system", content: translationSystemPrompt(context) },
      { role: "user", content: text },
    ], TRANSLATION_REQUEST_TIMEOUT_MS);
}

/** 建议生成入参（ADR-0017：一条 finding 一次调用） */
export interface SuggestionInput {
  readonly file: string;
  readonly line: number;
  /** 源码行（CLI 抽取；取不到即空串——建议仍可基于 review 给出） */
  readonly code: string;
  /** 已译中文的检视正文（title。description） */
  readonly review: string;
}

/** 建议生成引擎（注入缝：真引擎走网关，测试 fake） */
export type SuggestionEngine = (input: SuggestionInput) => Promise<string>;

/**
 * 网关建议引擎（ADR-0017）：给定源码行 + 中文检视结论，产出**一条可执行的
 * 中文修改建议**。这不是翻译——输入里没有现成建议文本，只能由模型新生成；
 * 信息不足时要求输出空串（宁可空，不编）。
 */
export function createGatewaySuggestionEngine(options: GatewayEngineOptions): SuggestionEngine {
  return async (input: SuggestionInput): Promise<string> => {
    const payload = {
      file: input.file,
      line: input.line,
      code: input.code,
      review: input.review,
    };
    const content = await postCompletion(
      options,
      [
        { role: "system", content: suggestionSystemPrompt() },
        { role: "user", content: JSON.stringify(payload, null, 2) },
      ],
      SUGGESTION_REQUEST_TIMEOUT_MS,
      SUGGESTION_SERVICE_LABEL,
    );
    const trimmed = content.trim();
    // 模型按口径「信息不足给空串」时输出空/占位——统一归一为空串
    return trimmed === "" || trimmed === "无" ? "" : trimmed;
  };
}

/**
 * 逐条生成建议（并发上限 SUGGESTION_CONCURRENCY）：单条失败（网络/超时/空
 * 响应）⇒ 该条缺席 ⇒ 落盘时为空串。绝不因建议失败拖累 zh 或整次投影。
 */
async function generateSuggestions(
  findings: readonly Finding[],
  codeByFinding: Readonly<Record<string, string>>,
  gateway: GatewayEngineOptions,
): Promise<Readonly<Record<string, string>>> {
  const suggestions: Record<string, string> = {};
  if (findings.length === 0) {
    return suggestions;
  }
  const generate = createGatewaySuggestionEngine(gateway);
  const queue: Finding[] = [...findings];
  const workers = Array.from(
    { length: Math.min(SUGGESTION_CONCURRENCY, queue.length) },
    async (): Promise<void> => {
      for (;;) {
        const finding = queue.shift();
        if (finding === undefined) {
          return;
        }
        try {
          const suggestion = await generate({
            file: finding.file,
            line: finding.line,
            code: codeByFinding[finding.id] ?? "",
            review: reviewOf(finding.title, finding.description),
          });
          if (suggestion !== "") {
            suggestions[finding.id] = suggestion;
          }
        } catch {
          // 单条建议失败是该条的缺席，不是整次投影的失败（ADR-0017 弱耦合）
        }
      }
    },
  );
  await Promise.all(workers);
  return suggestions;
}

/**
 * 建议生成口径（ADR-0017）：一条可执行改法，不重复问题描述，代码标识不译；
 * 信息不足时输出空字符串（宁可空，不编）。
 */
function suggestionSystemPrompt(): string {
  return [
    "你是 Java 代码检视的修复建议作者。输入是 JSON：file（文件路径）、line（行号）、code（该行源码）、review（中文检视结论）。",
    "只输出一条可直接执行的简体中文修改建议，不要解释、不要复述问题、不要代码块包裹。",
    "要求：",
    "- 给出具体改法（改成什么），可含一行示例代码；代码标识（类名、方法名、API）保持原样不译。",
    "- 不超过 120 字，直接可落地。",
    "- 若信息不足以给出具体改法，只输出空字符串（不要编造）。",
  ].join("\n");
}

/**
 * 规则包真规则 id 白名单（ADR-0017）：读每个解压目录下 `rules/*.md` 的
 * frontmatter `id`（如 `GEN-SQL-001`）。任何读取/解析失败都跳过该文件——
 * 白名单缺席只会让 ruleId 落空串，绝不影响投影。
 */
async function loadKnownRuleIds(packDirs: readonly string[]): Promise<ReadonlySet<string>> {
  const ids = new Set<string>();
  for (const packDir of packDirs) {
    const rulesDir = await findRulesDir(packDir);
    if (rulesDir === undefined) {
      continue;
    }
    let entries: string[];
    try {
      entries = await readdir(rulesDir);
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.endsWith(".md")) {
        continue;
      }
      try {
        const text = await readFile(path.join(rulesDir, entry), "utf8");
        const id = frontmatterId(text);
        if (id !== undefined) {
          ids.add(id);
        }
      } catch {
        // 单文件读失败 = 该规则不在白名单
      }
    }
  }
  return ids;
}

/**
 * 定位规则目录：zip 内可能是 `<packDir>/rules/` 或 `<packDir>/<packName>/rules/`
 * （解压保留归档顶层目录）。只探两层，找不到返回 undefined。
 */
async function findRulesDir(packDir: string): Promise<string | undefined> {
  const direct = path.join(packDir, "rules");
  if (await isDirectory(direct)) {
    return direct;
  }
  let entries: Dirent[];
  try {
    entries = await readdir(packDir, { withFileTypes: true });
  } catch {
    return undefined;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const candidate = path.join(packDir, entry.name, "rules");
    if (await isDirectory(candidate)) {
      return candidate;
    }
  }
  return undefined;
}

async function isDirectory(candidate: string): Promise<boolean> {
  try {
    return (await readdir(candidate, { withFileTypes: false })) !== undefined;
  } catch {
    return false;
  }
}

/** 取 markdown frontmatter 的 `id` 值（去引号；无 frontmatter/无 id 返回 undefined） */
function frontmatterId(text: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (block === null) {
    return undefined;
  }
  const line = /^id:\s*(.+?)\s*$/m.exec(block[1] ?? "");
  if (line === null) {
    return undefined;
  }
  const raw = (line[1] ?? "").trim();
  const unquoted = raw.replace(/^["'](.*)["']$/, "$1").trim();
  return unquoted === "" ? undefined : unquoted;
}

/**
 * 共享 completion 调用（OpenAI 兼容非流式）：非 2xx / 非 JSON / 空 completion /
 * 网络异常均抛人话错误（调用方决定隔离粒度：翻译 → 整次降级；建议 → 单条空串）。
 */
async function postCompletion(
  options: GatewayEngineOptions,
  messages: readonly { readonly role: string; readonly content: string }[],
  timeoutMs: number,
  serviceLabel: string = SERVICE_LABEL,
): Promise<string> {
  const body = {
    model: options.modelId,
    messages,
    stream: false,
    temperature: 0,
  };
  let response: Response;
  try {
    response = await options.fetchFn(options.endpointUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${options.apiKey}`,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${serviceLabel} request failed: ${message}`);
  }
  if (!response.ok) {
    const detail = await errorSnippetOf(response);
    throw new Error(`${serviceLabel} returned HTTP ${response.status}: ${detail}`);
  }
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error(`${serviceLabel} returned a non-JSON body`);
  }
  const content = readAssistantContent(payload);
  if (content === undefined || content.trim() === "") {
    throw new Error(`${serviceLabel} returned an empty completion`);
  }
  return content;
}

/**
 * 翻译口径系统提示词：只译自然语言、保留代码标识与结构化标识、术语表
 * 参考口径。随每次调用注入（TerminologyContext 单源——引擎不自带词表）。
 */
function translationSystemPrompt(context: TerminologyContext): string {
  const terminology = context.entries
    .map((entry) => `  - ${entry.en} → ${entry.zh}${entry.note !== undefined ? `（${entry.note}）` : ""}`)
    .join("\n");
  return [
    "你是代码检视结论的翻译引擎。把输入的英文检视文本翻译成简体中文，只输出译文本身，不要任何解释、前后缀或代码块包裹。",
    "翻译规则：",
    "- 代码标识保持原样不译：类名、方法名、变量名、文件路径、代码摘录（如 ObjectArrayCodec.java、parseArray(...)）。",
    "- 结构化标识保持原样不译：严重级代码（P0–P3）、规则 id、配置 id。",
    "- 译文必须完整：不得省略、缩写或合并输入内容。",
    "- 域词按下方术语表口径（参考口径，融进自然叙事，非逐词硬替换）。",
    `术语表（版本 v${context.terminologyVersion}）：`,
    terminology,
  ].join("\n");
}

/** 读取 choices[0].message.content（OpenAI 兼容信封；形状不符返回 undefined） */
function readAssistantContent(payload: unknown): string | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const choices = (payload as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return undefined;
  }
  const message = (choices[0] as { message?: unknown })?.message;
  if (message === null || typeof message !== "object") {
    return undefined;
  }
  const content = (message as { content?: unknown }).content;
  return typeof content === "string" ? content : undefined;
}

/** 非成功响应的报文摘要（错误诊断用；截长防爆屏） */
async function errorSnippetOf(response: Response): Promise<string> {
  try {
    const text = await response.text();
    return text.slice(0, 200);
  } catch {
    return "(unreadable error body)";
  }
}
