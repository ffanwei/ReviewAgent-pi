import { formatSkillInvocation, type Skill } from "@earendil-works/pi-agent-core";
import type { SkillCandidateBatch } from "../gate/candidate-merge.js";
import { formatHostPlatformNote } from "../tools/skill-bash.js";
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

/** skill 会话的平台注入缝（缺省当前进程；测试用） */
export interface SkillPassRuntimeInfo {
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}

/** skill 会话的输出契约：压住候选拦截链的 gate 陷阱 + JSON 外壳（中文，ADR-0090） */
function invocationContract(
  name: string,
  runtime: SkillPassRuntimeInfo,
  docMode: boolean,
): string {
  const opening = docMode
    ? "上面的会话是主检视会话到 Phase 5 为止的内容。以它为上下文，按本 skill 的规则检查本次变更文件（代码与文档）。你可以调用检视工具，也可以用 `bash` 工具运行本 skill 的辅助命令（PATH 上的任意可执行文件；工作目录是本 skill 的根目录；检视被检对象请用 review.* 工具）。"
    : "上面的会话是主检视会话到 Phase 5 为止的内容。以它为上下文，再按本 skill 的规则检查变更代码。你可以调用检视工具，也可以用 `bash` 工具运行本 skill 的辅助命令（PATH 上的任意可执行文件；工作目录是本 skill 的根目录）。";
  const evidence = docMode
    ? "- 证据必填：代码用符号 + 行号 + 摘录；文档用引文 + 目标文件:行 + review.get_file 的结果。没有证据的候选会被丢弃。"
    : "- 证据必填（符号 + 行号 + 摘录）；没有证据的候选会被丢弃。";
  const precedence = [
    "- 本会话按用户规则 Skill 检视；SKILL.md 对规则、证据、严重级与报告范围有最终解释权，不受通用“少提建议类”口径限制。",
    ...(docMode
      ? ["- 若本 skill 的 SKILL.md 对证据、示例或严重级有更具体规定，以其为准。"]
      : []),
  ];
  const closing = docMode
    ? '- 若检查后没有规则违例或文档问题存活，回复 {"candidates": []}。'
    : '- 若检查后没有规则违例存活，回复 {"candidates": []}。';
  return [
    "## 规则 Skill 检视遍（本会话）",
    opening,
    `- ${formatHostPlatformNote(runtime.platform, runtime.arch)}`,
    "",
    "输出契约：",
    "- 完成后只回一个 JSON 对象：{\"candidates\": [<符合 Finding 模式的对象>, ...]}。",
    "- 输出格式以本节契约为准；SKILL.md 只覆盖规则、证据与严重级，不得改变 JSON 外壳。",
    "- 即使没有候选，也必须输出 {\"candidates\": []}；不要使用 findings / issues / violations 等其它键，也不要在 JSON 前后添加解释或总结。",
    "- 多条候选必须是多个独立对象；每个对象只出现一次 id，用 },{ 分隔，不要把后一条候选的字段追加到前一个对象里。",
    `- 每条候选的 id 形如 \`${skillCandidateIdTemplate(name)}\`（不含轮次号）。`,
    "- 本 skill 包内的文件（SKILL.md 引用的 rules/、references/、scripts/ 等）用 review.get_file 读取：直接写包内相对路径即可（仓库里找不到时回退到包根）；也可写成 skill://<包内相对路径> 强制读包。被检视仓库的文件仍用普通相对路径。",
    `- "rule" 字段填该意见违反的本 skill rules/ 里具体规则的 frontmatter id（如 "GEN-SQL-001"）；只有无法对应到单条规则时才用 "${name}"。`,
    "- 自然语言字段（title / description / tips 各字段）一律中文；代码标识符与专有名词保留英文。",
    evidence,
    ...precedence,
    "- 不要重复主会话已报告的同一文件同一行的问题。只有确实是另一个缺陷时才再次报告该位置，并在 description 里明确说明差异。",
    closing,
  ].join("\n");
}

/**
 * 构造一个 skill 会话的首条 user 消息：内核 skill 块（真实 pack 路径）+
 * 宿主平台提示 + 输出契约。植入 `description` 与 `content` 由调用方的
 * `RuleSkill` 决定；`runtime` 只用于测试注入平台（缺省当前进程）。
 *
 * `docMode`：本次被检视的 diff 命中 skill / 文档时置 true——通用契约改用
 * 模态中性的证据口径，并让位给专用 SKILL.md 的具体规定；代码 MR 保持旧
 * 字节（离线 trace 与代码侧回归零漂移）。
 */
export function buildSkillPassInvocation(
  skill: RuleSkill,
  runtime: SkillPassRuntimeInfo = {},
  options: { readonly docMode?: boolean } = {},
): string {
  const raw: Skill = {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    filePath: skill.filePath,
  };
  return formatSkillInvocation(
    raw,
    invocationContract(skill.name, runtime, options.docMode === true),
  );
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
  "tips",
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
    "## 规则 Skill 候选",
    "Phase 5 之后独立运行的规则 Skill 检视遍产出了以下候选。请把它们与你自己的候选一起核验，采用同一标准。",
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
    "上面每条候选 id 都必须出现在你的 verdicts 数组里。只复述候选自身主张的证据不算核验。",
    "这些候选来自用户规则 Skill，按 Skill 的规则与严重级核验；不要以“只是建议/风格/文档/测试”为由驳回。",
  );
  return lines.join("\n");
}
