import { formatSkillInvocation, type Skill } from "@earendil-works/pi-agent-core";
import type { SkillCandidateBatch } from "../gate/candidate-merge.js";
import type { RuleSkill } from "./rule-skill.js";

/**
 * skill 检视会话的两段提示词（ADR-0014）。
 *
 * 1. `buildSkillPassInvocation`：skill 会话的 user 消息 = 内核 skill 块 +
 *    输出契约。**与 ADR-0012 的相反**：这里不再净化路径——skill 会话属
 *    **非测量档**，真实 pack 路径（`References are relative to …`）正是
 *    bash cwd 与脚本位置的诚实说明（验收 6 允许 skill 会话含真实路径）。
 *    （净化的是反向：skill 候选进主会话请求前，见 `skill-pass.ts`。）
 * 2. `buildSkillCandidatesBrief`：Phase 6 指令消息尾部的候选清单，告诉主
 *    会话「另有一批 skill 候选要一起裁定」。并入哪一相由 loop 决定（本模块
 *    不持有相位下标）。
 */

/** 候选 id 形态（跨轮稳定：不含 round；同 file/line 同 skill 恒同 id） */
export function skillCandidateIdTemplate(skillName: string): string {
  return `RULE-CHECK@${skillName}@<file>:<line>`;
}

/** skill 会话的输出契约：压住候选拦截链的三个 gate 陷阱 + JSON 外壳 */
function invocationContract(name: string): string {
  return [
    "## Rule-skill review pass (this session)",
    "The conversation above is the main review session up to Phase 5. Use it as context, then inspect the changed code against this skill's rules. You may call the review tools, and you may run this skill's helper commands with the `bash` tool (any executable on PATH; the working directory is this skill's root).",
    "",
    "Output contract:",
    `- When you are done, reply with a single JSON object: {"candidates": [<finding objects per the Finding schema>, ...]}.`,
    `- Use the id form \`${skillCandidateIdTemplate(name)}\` for every candidate (no round number).`,
    `- Set the "rule" field to the id of the specific rule from this skill's rules/ that the finding violates (that rule file's frontmatter id, e.g. "GEN-SQL-001"). Use "${name}" only when the finding does not map to any single rule.`,
    "- Write EVERY finding field (id/title/description/category/evidence) in ENGLISH ONLY.",
    "- Evidence is mandatory (symbol + line + excerpt); candidates without evidence are dropped.",
    '- If no rule violation survives your inspection, reply with {"candidates": []}.',
  ].join("\n");
}

/**
 * 构造一个 skill 会话的首条 user 消息：内核 skill 块（真实 pack 路径）+
 * 输出契约。植入 `description` 与 `content` 由调用方的 `RuleSkill` 决定。
 */
export function buildSkillPassInvocation(skill: RuleSkill): string {
  const raw: Skill = {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    filePath: skill.filePath,
  };
  return formatSkillInvocation(raw, invocationContract(skill.name));
}

/** Finding 字段的固定投影顺序（与 `gate/candidate-gate.ts` 的 toFinding 对齐） */
const FINDING_KEYS = [
  "id",
  "severity",
  "category",
  "file",
  "line",
  "title",
  "description",
  "evidence",
  "rule",
  "confidence",
] as const;

/** 候选 → 单行 JSON（合法候选按固定键序；非法候选原样序列化，交给 SCHEMA_INVALID） */
function serializeCandidate(candidate: unknown): string {
  if (typeof candidate === "object" && candidate !== null) {
    const record = candidate as Record<string, unknown>;
    if (FINDING_KEYS.every((key) => key in record)) {
      const ordered: Record<string, unknown> = {};
      for (const key of FINDING_KEYS) {
        ordered[key] = record[key];
      }
      return JSON.stringify(ordered);
    }
  }
  return JSON.stringify(candidate);
}

/**
 * 构造 Phase 6 的 skill 候选清单段。无候选（N=0 / 零产出）⇒ `undefined`
 * （阶段消息逐字节不变——N=0 的「F = E」断言由此成立）。
 *
 * 只列**存活**候选（跨 skill 去重后的批次，见 `gate/candidate-merge.ts`）：
 * 被合并者不会进入候选流，也就不该被要求裁定。
 */
export function buildSkillCandidatesBrief(
  batches: readonly SkillCandidateBatch[],
): string | undefined {
  const nonEmpty = batches.filter((batch) => batch.candidates.length > 0);
  if (nonEmpty.length === 0) {
    return undefined;
  }
  const lines: string[] = [
    "## Rule-skill candidates",
    "Independent rule-skill review passes ran after Phase 5 and produced the candidates below. Verify them together with your own candidates, applying the same standard.",
    "",
  ];
  for (const batch of nonEmpty) {
    lines.push(`<skill name="${batch.skill}">`);
    for (const candidate of batch.candidates) {
      lines.push(serializeCandidate(candidate));
    }
    lines.push("</skill>");
  }
  lines.push(
    "",
    "Every candidate id above must appear in your verdicts array. Evidence that only repeats the candidate's own claim does not verify it.",
  );
  return lines.join("\n");
}
