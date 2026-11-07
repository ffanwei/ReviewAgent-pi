/**
 * MCP 业务 tool 契约（ADR-0045）：四个 tool 的名字、参数形状与报文校验。
 *
 * 名字来自**服务端契约**，硬编码为常量、不开配置面（`mcp.report.tool` 继续
 * 只管批量进度事件——两层语义分开）。参数一律**平铺**：MCP 的
 * `tools/call.arguments` 就是平铺对象，多包信封服务端解析不到。
 *
 * 本模块是纯逻辑层：零 I/O、零 import mcp 其它文件，只被 CLI（编排）与
 * `report.ts`（发送）使用；`loop/` / `run/` / `contracts/` 不感知它。
 */

/** 四个业务 tool 名（服务端契约；ADR-0045 决策 1） */
export const MCP_TASK_TOOL_NAMES = {
  startTask: "startTask",
  endTask: "endTask",
  saveReviewSummary: "saveReviewSummary",
  mrReviewResult: "mrReviewResult",
} as const;

/**
 * 业务 tool 之间的固定沉降间隔（毫秒，ADR-0053）：`mrReviewResult` 全部结束后
 * 等这么久再发 `saveReviewSummary`；`saveReviewSummary` 结束后再等这么久才发
 * `endTask`。
 *
 * 这是**临时的时间赌注**，不是序列化契约：服务端对 `tools/call` 的异步处理会
 * 让回调到前端的顺序与客户端发送顺序不一致，固定间隔只给服务端留排空时间。
 * 若服务端后续支持序号 / 完成标记，应删除该间隔（见 `docs/待优化维护清单.md`）。
 */
export const TASK_TOOL_SETTLE_MS = 5_000;

/**
 * 进程测试专用覆盖（**不是配置面**）：只允许把固定间隔压到 0 或其他非负整数，
 * 避免每条启用 MCP 的进程用例多等 10 秒。生产环境不设置该变量，读取结果恒为
 * `TASK_TOOL_SETTLE_MS`。非法值（负数 / 小数 / 非数字）一律回落缺省。
 */
export const TASK_TOOL_SETTLE_ENV = "PIAGENT_TEST_TASK_TOOL_SETTLE_MS";

/** 解析生效的沉降间隔（纯函数，env 由调用方注入，便于单测）。 */
export function resolveTaskToolSettleMs(
  env: Readonly<Record<string, string | undefined>>,
): number {
  const raw = env[TASK_TOOL_SETTLE_ENV];
  if (raw === undefined || !/^\d+$/.test(raw)) {
    return TASK_TOOL_SETTLE_MS;
  }
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) ? parsed : TASK_TOOL_SETTLE_MS;
}

/** `startTask` / `endTask` 参数 */
export interface TaskIdArgs {
  readonly taskId: string;
}

/** `saveReviewSummary` 参数：markdownContent = Markdown 总结报告正文 */
export interface SaveReviewSummaryArgs {
  readonly taskId: string;
  readonly markdownContent: string;
}

/** `mrReviewResult` 单条检视意见（服务端 AgentReviewTips 契约） */
export interface AgentReviewTip {
  /** 定位到问题代码行的源码；限制单行、不允许换行符 */
  readonly code: string;
  /** 审查意见描述（Markdown）：必须含 `[缺陷类型]` + 具体描述 + 影响评估 */
  readonly review: string;
  /** 改进建议（Markdown）：必须含 `[重构思路]` + 代码示例 */
  readonly suggestion: string;
  /** 问题类别（服务端枚举） */
  readonly category: AgentReviewCategory;
  /** 问题详细分类（必填非空） */
  readonly subcategory: string;
  /** 严重程度（服务端枚举，低到高） */
  readonly level: AgentReviewLevel;
  /** 规则 id；未匹配到场景规则 = null */
  readonly ruleId: string | null;
  /** 问题代码行号（单行号，字符串形态） */
  readonly lineNum: string;
}

/** `mrReviewResult` 参数：按文件平铺 */
export interface MrReviewResultArgs {
  readonly taskId: string;
  /** 相对工作空间路径，正斜杠分隔（发送层已规范化） */
  readonly filePath: string;
  readonly reviewTips: readonly AgentReviewTip[];
}

/** 一个文件的报文（报文调用产物；filePath 已规范化） */
export interface MrFileReport {
  readonly filePath: string;
  readonly reviewTips: readonly AgentReviewTip[];
}

/** 问题类别全集（服务端枚举） */
export const AGENT_REVIEW_CATEGORIES = [
  "可维护",
  "安全",
  "可靠性",
  "可测试性",
  "性能",
  "可移植",
  "可读性",
] as const;

export type AgentReviewCategory = (typeof AGENT_REVIEW_CATEGORIES)[number];

/** 严重程度全集（服务端枚举，低到高；Suggestion 档由报文调用产生，映射层不虚构） */
export const AGENT_REVIEW_LEVELS = ["Suggestion", "Minor", "Major", "Fatal"] as const;

export type AgentReviewLevel = (typeof AGENT_REVIEW_LEVELS)[number];

const CATEGORY_SET: ReadonlySet<string> = new Set(AGENT_REVIEW_CATEGORIES);
const LEVEL_SET: ReadonlySet<string> = new Set(AGENT_REVIEW_LEVELS);

/**
 * `filePath` 规范化（ADR-0045 决策 4）：反斜杠→正斜杠；拒绝绝对路径
 * （POSIX `/` 开头、Windows 盘符）、`..` / `.` / 空段、空串。返回 null = 非法
 * （调用方跳过该文件整组并留痕）——与进度事件字段白名单同源纪律：
 * **本地绝对路径不出进程**。
 */
export function normalizeReportFilePath(raw: string): string | null {
  const normalized = raw.trim().replace(/\\/g, "/");
  if (normalized === "" || normalized.startsWith("/")) {
    return null;
  }
  if (/^[A-Za-z]:/.test(normalized)) {
    return null;
  }
  const segments = normalized.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      return null;
    }
  }
  return segments.join("/");
}

export interface TipParseOutcome {
  readonly tip?: AgentReviewTip;
  /** 非法原因（英文短句；tip 在场时缺席） */
  readonly problem?: string;
}

/**
 * 未知对象 → 单条报文（严格校验，ADR-0045 决策 4）。非法字段**不修**：服务端的
 * 失败反馈是整批粒度，一条坏数据连累整个文件的 `reviewTips` 数组，宁可在客户端
 * 拦下（跳过 + 留痕）。`lineNum` 接受 number（模型常见输出形态）转 string；
 * `ruleId` 空串转 null（服务端契约是 string|null）。
 */
export function agentReviewTipFromUnknown(input: unknown): TipParseOutcome {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { problem: "tip must be an object" };
  }
  const record = input as Record<string, unknown>;
  const code = nonEmptyString(record.code);
  if (code === undefined) {
    return { problem: "code must be a non-empty string" };
  }
  if (/[\r\n]/.test(code)) {
    return { problem: "code must be a single line (no newlines)" };
  }
  const review = nonEmptyString(record.review);
  if (review === undefined) {
    return { problem: "review must be a non-empty string" };
  }
  const suggestion = nonEmptyString(record.suggestion);
  if (suggestion === undefined) {
    return { problem: "suggestion must be a non-empty string" };
  }
  const category = nonEmptyString(record.category);
  if (category === undefined) {
    return { problem: "category must be a non-empty string" };
  }
  if (!CATEGORY_SET.has(category)) {
    return {
      problem: `category must be one of ${AGENT_REVIEW_CATEGORIES.join(", ")} (got ${JSON.stringify(category)})`,
    };
  }
  const subcategory = nonEmptyString(record.subcategory);
  if (subcategory === undefined) {
    return { problem: "subcategory must be a non-empty string" };
  }
  const level = nonEmptyString(record.level);
  if (level === undefined) {
    return { problem: "level must be a non-empty string" };
  }
  if (!LEVEL_SET.has(level)) {
    return {
      problem: `level must be one of ${AGENT_REVIEW_LEVELS.join(", ")} (got ${JSON.stringify(level)})`,
    };
  }
  const ruleIdRaw = record.ruleId;
  let ruleId: string | null;
  if (ruleIdRaw === null || ruleIdRaw === undefined) {
    ruleId = null;
  } else if (typeof ruleIdRaw === "string") {
    ruleId = ruleIdRaw.trim() === "" ? null : ruleIdRaw;
  } else {
    return { problem: "ruleId must be a string or null" };
  }
  const lineNumRaw = record.lineNum;
  let lineNum: string | undefined;
  if (typeof lineNumRaw === "number" && Number.isInteger(lineNumRaw) && lineNumRaw >= 1) {
    lineNum = String(lineNumRaw);
  } else if (
    typeof lineNumRaw === "string" &&
    /^[1-9][0-9]*$/.test(lineNumRaw.trim())
  ) {
    lineNum = lineNumRaw.trim();
  }
  if (lineNum === undefined) {
    return { problem: "lineNum must be a single positive integer" };
  }
  return {
    tip: {
      code,
      review,
      suggestion,
      category: category as AgentReviewCategory,
      subcategory,
      level: level as AgentReviewLevel,
      ruleId,
      lineNum,
    },
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value;
}
