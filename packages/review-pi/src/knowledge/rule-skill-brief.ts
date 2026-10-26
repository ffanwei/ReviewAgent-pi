import { formatSkillInvocation, type Skill } from "@earendil-works/pi-agent-core";
import type { RuleSkill } from "./rule-skill.js";

/**
 * 规则 Skill 候选阶段简报（ADR-0012 / config F）。
 *
 * config F 的**唯一请求字节差**：候选阶段那条 user 消息尾部多出
 * `\n\n<skill name=… location=".review-rules/<name>/SKILL.md">…</skill>\n\n<约定段>`。
 *
 * 修正 F1：内核 `formatSkillInvocation` 会把 `skill.filePath` 写进 location 与
 * "References are relative to …" 两处——装载器给的 `filePath` 是解压缓存的宿主
 * 绝对路径（含 `--out`/`experimentId`），直接透传会让请求字节随机器与运行漂移。
 * 故这里先把 skill **净化**成稳定伪路径 `.review-rules/<name>/SKILL.md` 再交给
 * 内核格式化。
 *
 * 修正 F2：候选阶段下标在 loop 层是**未导出**的私有 `const`
 * （`agent-review-loop.ts`）——不与 loop 层耦合，本模块自带
 * `RULE_CHECK_PHASE_INDEX`，由单测与本仓候选阶段对齐。
 */

/**
 * 候选阶段下标（0-based）。模块内自带，不与 loop 层耦合；由单测相对
 * `PHASE_INSTRUCTIONS[4]`（"Phase 5 of 6 - Deep Reasoning."）对齐。
 */
export const RULE_CHECK_PHASE_INDEX = 4;

/** 稳定伪路径：净化宿主绝对路径（修正 F1） */
function stableLocation(name: string): string {
  return `.review-rules/${name}/SKILL.md`;
}

/**
 * 约定段：压住候选拦截链的三个 gate 陷阱
 * （`gate/candidate-gate.ts`：`NON_ENGLISH` / `DUPLICATE_ID` / `NO_EVIDENCE`），
 * 并让 `rule` 字段可无歧义追溯到 skill 名（Q16）。
 */
const INSTRUCTION = (name: string): string =>
  [
    "## Rule-based review (this phase)",
    "- Write EVERY finding field (id/title/description/category/evidence) in ENGLISH ONLY.",
    "- Emit the candidates that arise from the rules in the skill block above.",
    "- Prefix candidate ids with `RULE-CHECK@<file>:<line>`.",
    "- Evidence is mandatory (symbol + line + excerpt); candidates without evidence are dropped.",
    `- Set the "rule" field to the skill name "${name}".`,
  ].join("\n");

/**
 * 构造候选阶段简报：内核 skill 块（稳定伪路径）+ 约定段。
 * 输出**不含任何宿主绝对路径**（单测断言）。
 */
export function buildRuleSkillBrief(skill: RuleSkill): string {
  const sanitized: Skill = {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    filePath: stableLocation(skill.name),
  };
  return formatSkillInvocation(sanitized, INSTRUCTION(skill.name));
}
