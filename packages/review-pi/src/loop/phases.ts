// 六阶段指令：每条是发往模型的完整阶段 user 消息 content（中文原生，ADR-0090）。
//
// 内容可演进（ADR-0038 退役了对外部真源的逐字节对照）；把守的是骨架性质：
// 数量与命名序一一对应、`Phase N of 6 - <name>.` 起头（阶段名保持英文——
// PhaseRecord.phase 是契约值）、只回一个 JSON 对象（见 src/loop/phases.test.ts）。
//
// 阶段语义（六阶段骨架，每个单元恰好各执行一次）：
// 1. Change Understanding → 2. Risk Classification → 3. Context Decision
// → 4. Context Retrieval → 5. Deep Reasoning → 6. Evidence Verification
export const PHASE_INSTRUCTIONS: readonly string[] = [
  `Phase 1 of 6 - Change Understanding.
分析本次合并请求的 unified diff：改了什么、涉及哪些文件与符号、变更意图是什么。
只回一个 JSON 对象：{"summary": "<一段中文变更摘要>"}`,

  `Phase 2 of 6 - Risk Classification.
为本次变更评定风险等级。
只回一个 JSON 对象：{"riskClass": "Low" | "Medium" | "High", "reason": "<中文理由>"}`,

  `Phase 3 of 6 - Context Decision.
判断除当前会话外，还需要哪些额外上下文才能正确评审本次变更。
只回一个 JSON 对象：{"neededContext": ["<条目>", ...], "reason": "<中文理由>"}`,

  `Phase 4 of 6 - Context Retrieval.
检索你在上一阶段决定需要的上下文。若工具可用，可以回复工具调用来检索；否则说明当前配置下无法检索更多上下文。
只回一个 JSON 对象：{"notes": "<现在有哪些上下文可用，或为何无法检索（中文）>"}`,

  `Phase 5 of 6 - Deep Reasoning.
对变更做深度推理并产出候选意见。只提出你能用具体证据支撑的候选（No Evidence, No Finding）。
只回一个 JSON 对象：{"candidates": [<符合 Finding 模式的对象>, ...]}
每条候选必须满足以下清单：
- id: 非空字符串，本轮内唯一（如 "F001"）
- severity: 恰为 "P0"、"P1"、"P2" 或 "P3"
- category: 恰为 "可维护"、"安全"、"可靠性"、"可测试性"、"性能"、"可移植"、"可读性" 之一
- file: 仓库相对路径（正斜杠）
- line: 正整数（不是字符串、不是区间）
- title: 非空中文一行结论
- description: 非空中文说明（含影响）
- evidence: 非空字符串数组（绝不能是单个字符串）
- rule: 非空字符串
- confidence: 0 到 1 之间的数字（不是百分比字符串）
- tips.review: 中文 Markdown，含「[缺陷类型]」「影响评估」
- tips.suggestion: 中文 Markdown，含「[重构思路]」「代码示例」
- tips.subcategory: 非空中文细分类型
完整示例：
{"candidates":[{"id":"F001","severity":"P1","category":"可靠性","file":"src/Foo.java","line":42,"title":"用户缺失时发生空指针解引用","description":"findUser 可能返回 null，结果未判空即被解引用，请求路径可能抛出 NullPointerException。","evidence":["src/Foo.java:42 findUser(id) 之后调用 user.getName()","没有匹配行时 findUser 返回 null"],"rule":"CORRECTNESS-001","confidence":0.82,"tips":{"review":"[缺陷类型] 未判空的用户对象解引用。影响评估：请求路径抛 NPE。","suggestion":"[重构思路] 判空后走缺省分支。代码示例：\`if (user == null) { return; }\`","subcategory":"空指针安全"}}]}`,

  `Phase 6 of 6 - Evidence Verification.
逐条核验候选意见的证据：每条候选所引证据是否真的支撑该结论。
只回一个 JSON 对象：{"verdicts": [{"id": "<候选 id>", "pass": true | false, "reason": "<中文理由>"}, ...], "complete": true | false}
使用候选清单里的原 id（不要重新编号）；每条候选恰好一条裁决。
"complete" 为 true 表示评审完成、无需下一轮；false 表示需要再评审一轮。`,
] as const;

export const PHASE_COUNT = PHASE_INSTRUCTIONS.length;

/** 候选生成阶段（Phase 5 / 0-based 4）：测试文件提示的挂载点 */
export const CANDIDATES_PHASE_INDEX = 4;

/**
 * 测试文件提示（`limits.testFiles.skip`）：只作阶段消息的**可选附加段**，
 * `PHASE_INSTRUCTIONS` 本体保持稳定（与 Phase 6 skill brief 同缝）。
 *
 * 跳过检视时，测试文件块已从 diff 中整块剔除；提示模型不要凭文件名猜测或
 * 为测试文件产出 finding。关闭跳过时，提示模型按生产代码同等检视。
 */
export function buildTestFilePhaseNote(skipTestFiles: boolean): string {
  return skipTestFiles
    ? "注意：测试文件已按配置从本 diff 中剔除（limits.testFiles.skip = true）。不要检视测试文件，也不要为测试路径产出意见。"
    : "注意：测试文件已按配置包含在本 diff 中（limits.testFiles.skip = false）。当变更影响行为时，请按生产代码同等标准检视测试文件。";
}

/**
 * 单个阶段的完整指令（`PHASE_INSTRUCTIONS[index]` + 配置驱动的附加段）。
 * Phase 5 按 `skipTestFiles` 附加测试文件提示；其余阶段逐字节等于原指令。
 */
export function buildPhaseInstruction(index: number, skipTestFiles: boolean): string {
  const instruction = PHASE_INSTRUCTIONS[index];
  if (instruction === undefined) {
    throw new Error(`missing phase instruction at index ${index}`);
  }
  if (index !== CANDIDATES_PHASE_INDEX) {
    return instruction;
  }
  return `${instruction}\n\n${buildTestFilePhaseNote(skipTestFiles)}`;
}

/** 六阶段名（固定顺序；PhaseRecord.phase 与指令前缀一一对应，保持英文契约值） */
export const PHASE_ORDER: readonly string[] = [
  "Change Understanding",
  "Risk Classification",
  "Context Decision",
  "Context Retrieval",
  "Deep Reasoning",
  "Evidence Verification",
];
