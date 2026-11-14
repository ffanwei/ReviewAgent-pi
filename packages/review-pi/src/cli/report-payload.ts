import type { Finding } from "../contracts/finding.js";
import { isReviewCategory } from "../contracts/finding.js";
import { findingMergeKey } from "../run/findings-merge.js";
import {
  agentReviewTipFromUnknown,
  normalizeReportFilePath,
  type AgentReviewCategory,
  type AgentReviewLevel,
  type AgentReviewTip,
  type MrFileReport,
} from "../mcp/task-tools.js";

/**
 * 片级报文组装（ADR-0090：候选阶段直接产出 tips，本模块退化为纯投影）。
 *
 * 语义字段（review / suggestion / subcategory）不再经过任何模型调用——
 * 它们随候选一起产出、随 `Finding.tips` 交付。这里只做确定性组装与终检：
 * - `filePath` ← `finding.file` 规范化（反斜杠→正斜杠、拒绝对路径）；
 * - `code`    ← `codeByFinding[id]`（CLI 按 `--repo` + 行号抽的真源行）：读不到
 *   源码行就跳过该条，**绝不编**（与 `readCodeLines` 同纪律）；
 * - `lineNum` ← `String(finding.line)`；
 * - `ruleId`  ← 规则会话产出（候选 id 带 `RULE-CHECK@` 前缀）取 `finding.rule`，
 *   否则 `null`；
 * - `level`   ← `severity` 四档映射（P0→Fatal / P1→Major / P2→Minor /
 *   P3→Suggestion）；
 * - `category` ← `finding.category`（中文七类；归一化保证）；
 * - 按文件分组 ← `finding.file`。
 *
 * 边界纪律：**绝不抛错**；组装完成的 tip 仍过一道 `agentReviewTipFromUnknown`
 * 终检（防实现 bug，正常永远通过）。
 */

/**
 * `severity` → 工具 `level`（Q18：按工具契约用满四档——P3 是建议级）。
 * ADR-0052 起，本地 tips 的 `severity` 也用同一套四档映射（P3→Suggestion），
 * 统一 tips 的 `severity` 与 `level` **同值**。
 */
export const LEVEL_BY_SEVERITY: Readonly<Record<Finding["severity"], AgentReviewLevel>> = {
  P0: "Fatal",
  P1: "Major",
  P2: "Minor",
  P3: "Suggestion",
};

/** 规则会话候选 id 前缀（单源在 `knowledge/skill-pass-brief.ts` 的模板） */
const RULE_REVIEWER_ID_PREFIX = "RULE-CHECK@";

export interface ShardReportInput {
  readonly findings: readonly Finding[];
  /** 键 = finding id（CLI 按 `--repo` 抽的源码行；缺席 = 该条 code 无材料，跳过报文） */
  readonly codeByFinding: Readonly<Record<string, string>>;
}

/**
 * 一个文件的报文 + 生成这些 tips 的 finding。
 *
 * `findings` 与 `reviewTips` **同序同长**：每条 tip 的语义来源就是同位置的
 * finding。上报调用成功后，CLI 据此确定「平台最终收到的意见集合」，供收尾
 * 总结按已上报结果生成（ADR-0057）。
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
      /** 逐字段降级留痕（tips 缺失时由 finding 自身推导兜底的条目） */
      readonly degradedTips: readonly string[];
      /** 被跳过的文件组的问题清单（filePath 非法等） */
      readonly skippedFiles: readonly string[];
      /**
       * 语义字段登记（键 = 该片 finding 的**合并键** `(file,line,title)`），
       * 供聚合后组装 tips 复用——覆盖面独立于 `files`（tips 允许 code 空串、
       * filePath 用原文）。tips 不完整的 finding 不登记（按未覆盖留痕）。
       */
      readonly semanticByKey: ReadonlyMap<string, SemanticTipEntry>;
      /** 未登记成功的原因（键 = 合并键）：供聚合阶段逐条打印 */
      readonly uncoveredByKey: ReadonlyMap<string, string>;
    }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * 语义字段全集（mrReviewResult 与 tips 共用；ADR-0090 起直接来自 `Finding.tips`）：
 * `source` / `ruleId` 聚合重编号后无法从 merged finding 重推导，仍在此登记。
 */
export interface SemanticTipEntry {
  readonly review: string;
  readonly suggestion: string;
  readonly category: string;
  readonly subcategory: string;
  /** 判据来源：规则会话（rule-reviewer）还是主会话（common-reviewer） */
  readonly source: "rule-reviewer" | "common-reviewer";
  /** 规则会话产出才带（finding.rule），否则空串 */
  readonly ruleId: string;
}

/**
 * 纯确定性组装：findings 的 `tips` 块 → 按文件分组的报文。
 * 失败语义只剩结构问题（源码行读不到 / filePath 非法 / 终检不过），
 * 全部收敛进 skipped / degraded 留痕。
 */
export function buildShardReport(input: ShardReportInput): ShardReportOutcome {
  const skippedTips: string[] = [];
  const degradedTips: string[] = [];
  const skippedFiles: string[] = [];
  const reportedBadPaths = new Set<string>();
  const groups = new Map<string, { tips: AgentReviewTip[]; findings: Finding[] }>();
  const semanticByKey = new Map<string, SemanticTipEntry>();
  const uncoveredByKey = new Map<string, string>();

  for (const finding of input.findings) {
    const label = `${finding.file}:${String(finding.line)} (${finding.id})`;
    const tips = finding.tips;
    if (tips === undefined || tips.review.trim() === "") {
      uncoveredByKey.set(findingMergeKey(finding), "候选缺少 tips 语义块");
      skippedTips.push(`${label}: 候选缺少 tips 语义块`);
      continue;
    }
    const category = isReviewCategory(finding.category)
      ? finding.category
      : fallbackCategory(finding.category, label, degradedTips);
    const subcategory = tips.subcategory.trim() !== "" ? tips.subcategory.trim() : "未细分";
    const review = tips.review.trim() !== "" ? tips.review : finding.description;
    const suggestion = tips.suggestion;

    const isRuleSession = finding.id.startsWith(RULE_REVIEWER_ID_PREFIX);
    semanticByKey.set(findingMergeKey(finding), {
      review,
      suggestion,
      category,
      subcategory,
      source: isRuleSession ? "rule-reviewer" : "common-reviewer",
      ruleId: isRuleSession && finding.rule.trim() !== "" ? finding.rule : "",
    });

    // ---- mrReviewResult 报文的附加结构要求（不影响 tips 登记） ----
    const filePath = normalizeReportFilePath(finding.file);
    if (filePath === null) {
      if (!reportedBadPaths.has(finding.file)) {
        reportedBadPaths.add(finding.file);
        skippedFiles.push(`${finding.file}: 不是仓库相对 POSIX 路径`);
      }
      continue;
    }
    const code = input.codeByFinding[finding.id];
    if (code === undefined || code === "") {
      // 绝不编：源码行读不到（文件不在仓 / 行号越界）就不发这条报文
      // （tips 侧仍可用——ADR-0017 老契约允许 code 空串）
      skippedTips.push(`${filePath}:${String(finding.line)} (${finding.id}): 读不到源码行（code 不允许编造）`);
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
      skippedTips.push(`${filePath}:${String(finding.line)} (${finding.id}): 组装的 tip 未通过终检（${gate.problem ?? "非法"}）`);
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

/** category 兜底：非七类值回落「可维护」并留痕（归一化应已避免走到这里） */
function fallbackCategory(value: string, label: string, degraded: string[]): AgentReviewCategory {
  degraded.push(`${label}: category "${value}" 不在七类，回落「可维护」`);
  return "可维护";
}
