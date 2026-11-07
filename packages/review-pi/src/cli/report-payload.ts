import type { FetchFunction } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import { DEFAULT_GATEWAY_MAX_TOKENS } from "../shared/config.js";
import type { RetryPolicy } from "../shared/llm-retry.js";
import { findingMergeKey } from "../run/findings-merge.js";
import {
  agentReviewTipFromUnknown,
  normalizeReportFilePath,
  AGENT_REVIEW_CATEGORIES,
  type AgentReviewCategory,
  type AgentReviewLevel,
  type AgentReviewTip,
  type MrFileReport,
} from "../mcp/task-tools.js";
import { completeOneShot, extractJsonObject } from "./one-shot-llm.js";

/**
 * 片级报文生成（ADR-0045 决策 4 修订 + 统一 tips 扩展）：**结构字段由代码
 * 确定性组装，模型只出语义字段**；一份语义输出**双消费**——mrReviewResult
 * 的报文组装 + 聚合后的 tips 组装（`cli/unified-tips.ts`）。
 *
 * 模型输出（按 finding id 对齐）：
 * `{"tips":[{"id","category","subcategory","review","suggestion"}]}`
 *
 * 其余报文字段全部不经过模型——它们的出生地本来就是代码，让模型转抄只会
 * 引入漂移（模型「不遵守提示词」是常态，不能指望）：
 * - `filePath` ← `finding.file` 规范化（反斜杠→正斜杠、拒绝对路径）：**按构造合法**；
 * - `code`    ← `codeByFinding[id]`（CLI 按 `--repo` + 行号抽的真源行）：单行
 *   **按构造成立**；读不到源码行就跳过该条，**绝不编**（与 `readCodeLines` 同纪律）；
 * - `lineNum` ← `String(finding.line)`；
 * - `ruleId`  ← 规则会话产出（候选 id 带 `RULE-CHECK@` 前缀）取 `finding.rule`，
 *   否则 `null`（结构性判定，与 tips 的 `sourceOf` 同判据）；
 * - `level`   ← `severity` 四档映射（P0→Fatal / P1→Major / P2→Minor /
 *   P3→Suggestion，Q18：按工具契约用满四档）：枚举**按构造合法**；
 * - 按文件分组 ← `finding.file`（模型不再分组，不存在漏文件 / 重复文件）。
 *
 * `category` 是唯一暴露给模型的枚举：模型给错时先用**确定性映射表**兜底
 * （Q19：常见英文类别 → 中文枚举，对 `finding.category` 查表），表也没有才
 * 跳过该条并留痕——宁缺毋假。
 *
 * **tips 复用口径（ADR-0045 统一 tips）**：`semanticByKey` 按**合并键**
 * `(file, line, title)` 登记语义字段的完整集（含 `source` / `ruleId`——
 * 聚合重编号后这两项无法从 merged finding 重derive），**与 mrReviewResult 的
 * 覆盖面独立**：tips 允许 `code` 空串（ADR-0017 老契约），所以「读不到源码行」
 * 只影响报文、不踢出 tips；`filePath` 不合法同理（tips 沿用 finding 原文）。
 *
 * 边界纪律：**绝不抛错**（失败收敛为 `{kind:"failed"}`）；组装完成的 tip 仍过
 * 一道 `agentReviewTipFromUnknown` 终检（防实现 bug，正常永远通过）。
 */

/** 报文调用的运行时（呈现档：模型 / 超时与呈现投影同档） */
export interface ReportLlmRuntime {
  readonly apiKey: string;
  readonly baseUrl: string;
  readonly modelId: string;
  /** 单次尝试超时（`limits.timeouts.oneShotMs`） */
  readonly timeoutMs: number;
  /** 重试策略（`limits.retry` 的 oneShot 路径；缺省 = 全局 default） */
  readonly retry?: RetryPolicy;
}

/**
 * 语义字段全集（统一生成的最小单位）：mrReviewResult 与 tips 共用。
 * `source` / `ruleId` 也在此——聚合重编号（`F001…`）后无法从 merged finding
 * 重新推导（`RULE-CHECK@` 前缀随片内 id 消失），必须在片级捕获。
 */
export interface SemanticTipEntry {
  readonly review: string;
  readonly suggestion: string;
  readonly category: string;
  readonly subcategory: string;
  /** 判据来源：规则会话（rule-reviewer）还是主会话（common-reviewer） */
  readonly source: "rule-reviewer" | "common-reviewer";
  /** 规则会话产出才带（finding.rule），否则空串（与 ADR-0017 `ruleIdOf` 同判据） */
  readonly ruleId: string;
}

export interface ShardReportInput {
  readonly findings: readonly Finding[];
  /** 键 = finding id（CLI 按 `--repo` 抽的源码行；缺席 = 该条 code 无材料，跳过报文） */
  readonly codeByFinding: Readonly<Record<string, string>>;
  readonly runtime: ReportLlmRuntime;
  readonly fetch?: FetchFunction;
}

/**
 * 一个文件的报文 + 生成这些 tips 的 finding。
 *
 * `findings` 与 `reviewTips` **同序同长**：每条 tip 的语义来源就是同位置的
 * finding。上报调用成功后，CLI 据此确定「平台最终收到的意见集合」，供收尾
 * 总结按已上报结果生成（ADR-0057）——`semanticByKey` 覆盖面更宽（tips 允许
 * `code` 空串），不能拿来当已上报集合用。
 */
export interface ShardFileReport extends MrFileReport {
  readonly findings: readonly Finding[];
}

export type ShardReportOutcome =
  | {
      readonly kind: "ok";
      /** 校验通过的文件报文（filePath 已规范化、按 finding 首见序分组） */
      readonly files: readonly ShardFileReport[];
      /** 被跳过的单条意见的问题清单（stderr 留痕用） */
      readonly skippedTips: readonly string[];
      /**
       * 逐字段降级留痕（缺失 / 非法字段用 finding 自身推导兜底，不丢整条）：
       * id 位置兜底、category 默认、subcategory/review/suggestion 派生的具体原因。
       */
      readonly degradedTips: readonly string[];
      /** 被跳过的文件组的问题清单（filePath 非法等） */
      readonly skippedFiles: readonly string[];
      /**
       * 语义字段登记（键 = 该片 finding 的**合并键** `(file,line,title)`），
       * 供聚合后组装 tips 复用——覆盖面独立于 `files`（tips 允许 code 空串、
       * filePath 用原文）。语义不完整的 finding 不登记（tips 侧按未覆盖留痕）。
       */
      readonly semanticByKey: ReadonlyMap<string, SemanticTipEntry>;
      /**
       * 未登记成功的原因（键 = 合并键）：只收「该条被逐条拒绝」的具体理由
       * （模型没给条目 / category 不可归一），供聚合阶段逐条打印。
       * 语言调用整体失败由 `kind:"failed"` 表达，不在此表。
       */
      readonly uncoveredByKey: ReadonlyMap<string, string>;
    }
  | { readonly kind: "failed"; readonly reason: string };

/** 报文调用的输出预算（与检视回合同源理由：网关缺省 2048 会静默截断 JSON） */
const REPORT_MAX_TOKENS = DEFAULT_GATEWAY_MAX_TOKENS;

/** 规则会话候选 id 前缀（单源在 `knowledge/skill-pass-brief.ts` 的模板；tips 侧同款复制） */
const RULE_REVIEWER_ID_PREFIX = "RULE-CHECK@";

/**
 * `severity` → 工具 `level`（Q18：按工具契约用满四档——P3 是建议级）。
 * ADR-0052 起，本地 tips 的 `severity` 也用同一套四档映射（P3→Suggestion），
 * 统一 tips 的 `severity` 与 `level` **同值**；不再存在三档 / 四档分叉。
 */
export const LEVEL_BY_SEVERITY: Readonly<Record<Finding["severity"], AgentReviewLevel>> = {
  P0: "Fatal",
  P1: "Major",
  P2: "Minor",
  P3: "Suggestion",
};

/**
 * `category` 兜底映射表（Q19）：模型给的枚举外值时，对 `finding.category`
 * （英文自由文本）按**大写精确匹配**查表。只做兜底不做首选——模型看得到
 * 上下文，归一更准；表未命中仍跳过（宁缺毋假）。
 */
const CATEGORY_FALLBACK: Readonly<Record<string, AgentReviewCategory>> = {
  SECURITY: "安全",
  VULNERABILITY: "安全",
  INJECTION: "安全",
  XSS: "安全",
  SSRF: "安全",
  CORRECTNESS: "可靠性",
  BUG: "可靠性",
  LOGIC: "可靠性",
  ERROR_HANDLING: "可靠性",
  RESOURCE_LEAK: "可靠性",
  CONCURRENCY: "可靠性",
  RACE_CONDITION: "可靠性",
  NULL_SAFETY: "可靠性",
  NPE: "可靠性",
  PERFORMANCE: "性能",
  PERF: "性能",
  EFFICIENCY: "性能",
  MEMORY: "性能",
  TESTABILITY: "可测试性",
  TEST: "可测试性",
  TESTING: "可测试性",
  PORTABILITY: "可移植",
  PORTABLE: "可移植",
  COMPATIBILITY: "可移植",
  READABILITY: "可读性",
  STYLE: "可读性",
  NAMING: "可读性",
  CLARITY: "可读性",
  MAINTAINABILITY: "可维护",
  MAINTENANCE: "可维护",
  DUPLICATION: "可维护",
  COMPLEXITY: "可维护",
  DESIGN: "可维护",
  API: "可维护",
};

const REPORT_SYSTEM_PROMPT = [
  "You convert finalized code-review findings into structured Chinese review tips for a platform.",
  "The findings are in English.",
  "Reply with a single JSON object and nothing else:",
  '{"tips":[{"id":"<finding id>","category":"…","subcategory":"…","review":"…","suggestion":"…"}]}',
  "One entry per finding, keyed by the finding id. Do not invent entries; do not drop findings.",
  "Schema checklist (all must hold):",
  "- id: the exact finding id string, non-empty",
  "- category: exactly one of 可维护, 安全, 可靠性, 可测试性, 性能, 可移植, 可读性",
  "- subcategory: non-empty Chinese subcategory that narrows category",
  '- review: non-empty Chinese Markdown containing "[缺陷类型]", a concrete description, and "影响评估"',
  '- suggestion: non-empty Chinese Markdown containing "[重构思路]", a concrete refactor approach, and "代码示例"',
  "- every value is a JSON string; no nested objects, no null, no omitted keys",
  "Complete example of a valid reply:",
  '{"tips":[{"id":"F001","category":"安全","subcategory":"URL 注入","review":"[缺陷类型] 未校验的重定向目标。影响评估：攻击者可构造钓鱼跳转，诱导用户访问恶意站点。","suggestion":"[重构思路] 使用白名单校验重定向目标，只允许站内路径。代码示例：`if (!ALLOWED.has(target)) { return; } redirect(target);`"}]}',
  "All other report fields (file path, source line, line number, level, rule id) are filled",
  "deterministically by the caller from the finding itself — do not output them.",
].join("\n");

export async function buildShardReport(input: ShardReportInput): Promise<ShardReportOutcome> {
  // 零 finding = 没有可报的文件（ADR-0045：零 finding 文件不发空包）
  if (input.findings.length === 0) {
    return {
      kind: "ok",
      files: [],
      skippedTips: [],
      degradedTips: [],
      skippedFiles: [],
      semanticByKey: new Map<string, SemanticTipEntry>(),
      uncoveredByKey: new Map<string, string>(),
    };
  }
  const completion = await completeOneShot({
    baseUrl: input.runtime.baseUrl,
    apiKey: input.runtime.apiKey,
    modelId: input.runtime.modelId,
    system: REPORT_SYSTEM_PROMPT,
    user: buildReportUserMessage(input.findings, input.codeByFinding),
    timeoutMs: input.runtime.timeoutMs,
    ...(input.runtime.retry !== undefined ? { retry: input.runtime.retry } : {}),
    maxTokens: REPORT_MAX_TOKENS,
    responseFormat: "json_object",
    ...(input.fetch !== undefined ? { fetch: input.fetch } : {}),
  });
  if (!completion.ok) {
    return { kind: "failed", reason: completion.reason };
  }
  const parsed = extractJsonObject(completion.text, { preferKey: "tips" });
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "failed", reason: "model output is not a JSON object" };
  }
  const rawTips = (parsed as Record<string, unknown>).tips;
  if (!Array.isArray(rawTips)) {
    return { kind: "failed", reason: 'model output must carry a "tips" array' };
  }

  // 模型条目按 id 索引；id 缺失时按位置对齐；编造的未知 id 单独留痕（不连累真实 finding）
  const knownIds = new Set(input.findings.map((finding) => finding.id));
  const byId = new Map<string, RawSemanticTip>();
  const skippedTips: string[] = [];
  const degradedTips: string[] = [];
  for (const [index, rawTip] of rawTips.entries()) {
    const outcome = semanticTipFromUnknown(rawTip);
    if (outcome.fields === undefined) {
      skippedTips.push(`tips[${String(index)}]: ${outcome.problem ?? "invalid"}`);
      continue;
    }
    let id = outcome.fields.id;
    if (id === undefined) {
      const positional = input.findings[index];
      if (positional !== undefined) {
        id = positional.id;
        degradedTips.push(
          `tips[${String(index)}]: id missing, aligned by position to ${JSON.stringify(id)}`,
        );
      }
    }
    if (id === undefined) {
      skippedTips.push(`tips[${String(index)}]: id must be a non-empty string`);
      continue;
    }
    if (!knownIds.has(id)) {
      skippedTips.push(`model returned an entry for unknown finding id ${JSON.stringify(id)}`);
      continue;
    }
    byId.set(id, { ...outcome.fields, id });
  }

  // 确定性组装：按 finding 首见序分组；语义字段逐项兜底（缺字段不再丢整条）。
  // 语义字段先登记进 semanticByKey（tips 消费，覆盖面宽），报文组装再叠加
  // 结构要求（code 非空、filePath 合法）——两条消费面独立。
  const skippedFiles: string[] = [];
  const reportedBadPaths = new Set<string>();
  const groups = new Map<string, { tips: AgentReviewTip[]; findings: Finding[] }>();
  const semanticByKey = new Map<string, SemanticTipEntry>();
  const uncoveredByKey = new Map<string, string>();
  for (const finding of input.findings) {
    const entry = byId.get(finding.id);
    if (entry === undefined) {
      const reason = "model gave no entry for this finding";
      uncoveredByKey.set(findingMergeKey(finding), reason);
      skippedTips.push(
        `${finding.file}:${String(finding.line)} (${finding.id}): ${reason}`,
      );
      continue;
    }
    const label = `${finding.file}:${String(finding.line)} (${finding.id})`;
    let category = resolveCategory(entry.category ?? "", finding.category);
    if (category === undefined) {
      category = DEFAULT_CATEGORY;
      degradedTips.push(`${label}: category fallback to ${DEFAULT_CATEGORY}`);
    }
    const subcategory =
      nonEmptyString(entry.subcategory) ??
      derivedSubcategory(finding, label, degradedTips);
    const review =
      nonEmptyString(entry.review) ?? derivedReview(finding, label, degradedTips);
    const suggestion =
      nonEmptyString(entry.suggestion) ?? derivedSuggestion(label, degradedTips);
    // 语义可行：登记（tips 侧可用；source/ruleId 必须在此捕获——聚合重编号后无法重推）
    const isRuleSession = finding.id.startsWith(RULE_REVIEWER_ID_PREFIX);
    semanticByKey.set(findingMergeKey(finding), {
      review,
      suggestion,
      category,
      subcategory,
      source: isRuleSession ? "rule-reviewer" : "common-reviewer",
      ruleId: isRuleSession && finding.rule.trim() !== "" ? finding.rule : "",
    });
    // ---- 以下为 mrReviewResult 报文的附加结构要求（不影响 tips 登记） ----
    const filePath = normalizeReportFilePath(finding.file);
    if (filePath === null) {
      if (!reportedBadPaths.has(finding.file)) {
        reportedBadPaths.add(finding.file);
        skippedFiles.push(`${finding.file}: not a repo-relative POSIX path`);
      }
      continue;
    }
    const code = input.codeByFinding[finding.id];
    if (code === undefined || code === "") {
      // 绝不编：源码行读不到（文件不在仓 / 行号越界）就不发这条报文
      // （tips 侧仍可用——ADR-0017 老契约允许 code 空串）
      skippedTips.push(
        `${filePath}:${String(finding.line)} (${finding.id}): source line unavailable (code must not be invented)`,
      );
      continue;
    }
    const ruleId = isRuleSession && finding.rule.trim() !== "" ? finding.rule : null;
    const composed = {
      code,
      review,
      suggestion,
      category,
      subcategory,
      level: LEVEL_BY_SEVERITY[finding.severity],
      ruleId,
      lineNum: String(finding.line),
    };
    // 终检（防实现 bug）：按构造应恒过；不过 = bug，跳过并原样留痕
    const gate = agentReviewTipFromUnknown(composed);
    if (gate.tip !== undefined) {
      const group = groups.get(filePath);
      if (group === undefined) {
        groups.set(filePath, { tips: [gate.tip], findings: [finding] });
      } else {
        group.tips.push(gate.tip);
        group.findings.push(finding);
      }
    } else {
      skippedTips.push(`${filePath}:${String(finding.line)} (${finding.id}): composed tip failed final gate (${gate.problem ?? "invalid"})`);
    }
  }

  return {
    kind: "ok",
    files: [...groups.entries()].map(([filePath, group]) => ({
      filePath,
      reviewTips: group.tips,
      findings: group.findings,
    })),
    skippedTips,
    degradedTips,
    skippedFiles,
    semanticByKey,
    uncoveredByKey,
  };
}

/** 模型类别不可归一时的保守默认（可维护 = 最不宣称具体缺陷性质） */
const DEFAULT_CATEGORY: AgentReviewCategory = "可维护";

/** category 解析：模型枚举内 → 直用；否则查 `finding.category` 的兜底表；都失败 → undefined */
function resolveCategory(modelCategory: string, findingCategory: string): AgentReviewCategory | undefined {
  if ((AGENT_REVIEW_CATEGORIES as readonly string[]).includes(modelCategory)) {
    return modelCategory as AgentReviewCategory;
  }
  return CATEGORY_FALLBACK[findingCategory.trim().toUpperCase()] ?? undefined;
}

/** 子类兜底：finding.category 的中文映射，再退「通用问题」（不编具体缺陷名） */
function derivedSubcategory(
  finding: Finding,
  label: string,
  degraded: string[],
): string {
  const mapped = CATEGORY_FALLBACK[finding.category.trim().toUpperCase()] ?? "通用问题";
  degraded.push(`${label}: subcategory missing, derived ${JSON.stringify(mapped)}`);
  return mapped;
}

/** review 兜底：只用 finding 自身的 title/description 组装（不补新事实） */
function derivedReview(finding: Finding, label: string, degraded: string[]): string {
  const impact = finding.description.trim() !== "" ? finding.description : finding.title;
  degraded.push(`${label}: review missing, derived from finding title/description`);
  return `[缺陷类型] ${finding.title}。影响评估：${impact}`;
}

/** suggestion 兜底：通用修复思路（不编具体代码） */
function derivedSuggestion(label: string, degraded: string[]): string {
  degraded.push(`${label}: suggestion missing, derived generic refactor guidance`);
  return "[重构思路] 根据缺陷类型与影响评估修复该问题，并补充覆盖该场景的测试。代码示例：按上述思路在相应位置调整实现。";
}

/**
 * 模型条目的宽松解析：只要求是对象；各语义字段缺失 / 空串时返回 undefined，
 * 由调用方按 finding 自身兜底（**逐字段救回**，不因一个字段坏掉丢整条）。
 */
interface RawSemanticTip {
  readonly id?: string;
  readonly category?: string;
  readonly subcategory?: string;
  readonly review?: string;
  readonly suggestion?: string;
}

function semanticTipFromUnknown(input: unknown): {
  readonly fields?: RawSemanticTip;
  readonly problem?: string;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { problem: "entry must be an object" };
  }
  const record = input as Record<string, unknown>;
  const id = nonEmptyString(record.id);
  const category = nonEmptyString(record.category);
  const subcategory = nonEmptyString(record.subcategory);
  const review = nonEmptyString(record.review);
  const suggestion = nonEmptyString(record.suggestion);
  return {
    fields: {
      ...(id !== undefined ? { id } : {}),
      ...(category !== undefined ? { category } : {}),
      ...(subcategory !== undefined ? { subcategory } : {}),
      ...(review !== undefined ? { review } : {}),
      ...(suggestion !== undefined ? { suggestion } : {}),
    },
  };
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  return value;
}

/** user 消息：findings（英文真源）+ 源码行，字段全量、顺序稳定 */
function buildReportUserMessage(
  findings: readonly Finding[],
  codeByFinding: Readonly<Record<string, string>>,
): string {
  const entries = findings.map((finding) => ({
    id: finding.id,
    severity: finding.severity,
    category: finding.category,
    file: finding.file,
    line: finding.line,
    title: finding.title,
    description: finding.description,
    evidence: finding.evidence,
    rule: finding.rule,
    confidence: finding.confidence,
    ...(codeByFinding[finding.id] !== undefined
      ? { sourceLine: codeByFinding[finding.id] }
      : {}),
  }));
  return ["Findings (final):", JSON.stringify(entries, null, 2)].join("\n");
}
