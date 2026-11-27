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
若变更涉及函数/方法契约（返回值、异常、空值、所有权或副作用）、错误路径或资源生命周期，把调用方与关键被调方列入 neededContext。
只回一个 JSON 对象：{"neededContext": ["<条目>", ...], "reason": "<中文理由>"}`,

  `Phase 4 of 6 - Context Retrieval.
检索你在上一阶段决定需要的上下文。若工具可用，可以回复工具调用来检索；否则说明当前配置下无法检索更多上下文。
只回一个 JSON 对象：{"notes": "<现在有哪些上下文可用，或为何无法检索（中文）>"}`,

  `Phase 5 of 6 - Deep Reasoning.
对变更做深度推理并产出候选意见。只提出你能用具体证据支撑的候选（No Evidence, No Finding）。
只报本次 diff 新增/修改行直接支撑、由本次变更引入或加重、且有具体失败场景的问题；finding 位置必须落在本遍 diff 的变更 hunk 内。search_code 的命中只能作为上下文，不能单独发起候选。不要报“仓库里本来存在”的问题，也不要报测试缺失、文档/注释/命名/格式类建议。
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
完整示例（两条候选；每条候选是数组中的独立对象，用 },{ 分隔；每个对象只出现一次 id）：
{"candidates":[{"id":"F001","severity":"P1","category":"可靠性","file":"src/Foo.java","line":42,"title":"用户缺失时发生空指针解引用","description":"findUser 可能返回 null，结果未判空即被解引用，请求路径可能抛出 NullPointerException。","evidence":["src/Foo.java:42 findUser(id) 之后调用 user.getName()","没有匹配行时 findUser 返回 null"],"rule":"CORRECTNESS-001","confidence":0.82,"tips":{"review":"[缺陷类型] 未判空的用户对象解引用。影响评估：请求路径抛 NPE。","suggestion":"[重构思路] 判空后走缺省分支。代码示例：\`if (user == null) { return; }\`","subcategory":"空指针安全"}},{"id":"F002","severity":"P2","category":"可维护","file":"src/main/java/com/example/Bar.java","line":88,"title":"异常路径只记录 message，丢失 cause 与堆栈","description":"catch 异常后只输出 e.getMessage()，原始异常类型和堆栈被丢弃，线上无法定位根因。","evidence":["src/main/java/com/example/Bar.java:88 — catch (Exception e) 中仅 logger.error(e.getMessage())"],"rule":"RELIABILITY-002","confidence":0.74,"tips":{"review":"[缺陷类型] 异常吞噬。影响评估：故障现场只剩一行 message，无法定位根因。","suggestion":"[重构思路] 记录异常对象而不是仅 message，保留 cause 与堆栈。","subcategory":"异常处理"}}]}`,

  `Phase 6 of 6 - Evidence Verification.
逐条核验候选意见的证据：每条候选所引证据是否真的支撑该结论。
若候选不是本次变更引入或加重、位置不在本遍 diff 的变更 hunk 内、或只有 search_code 上下文而没有 diff 证据，判 pass=false。
只回一个 JSON 对象：{"verdicts": [{"id": "<候选 id>", "pass": true | false, "reason": "<中文理由>"}, ...], "complete": true | false}
使用候选清单里的原 id（不要重新编号）；每条候选恰好一条裁决。
"complete" 为 true 表示评审完成、无需下一轮；false 表示需要再评审一轮。`,
] as const;

/**
 * 全仓扫描（repo 模式）的六阶段指令。
 *
 * 与 `PHASE_INSTRUCTIONS` 分离：MR 的六阶段消息保持逐字节冻结；repo 模式
 * 不出现「本次 diff」「变更」语义，Phase 1 改名为 Code Understanding。
 * Finding schema 与 MR 版本保持一致，避免两套候选契约。
 */
export const SCAN_PHASE_INSTRUCTIONS: readonly string[] = [
  `Phase 1 of 6 - Code Understanding.
分析本组文件的内容：涉及哪些文件与符号、整体意图、关键执行路径是什么。
只回一个 JSON 对象：{"summary": "<一段中文代码摘要>"}`,

  `Phase 2 of 6 - Risk Classification.
为本组代码评定风险等级。
只回一个 JSON 对象：{"riskClass": "Low" | "Medium" | "High", "reason": "<中文理由>"}`,

  `Phase 3 of 6 - Context Decision.
判断除当前会话外，还需要哪些额外上下文才能正确评审这些文件。
若代码涉及函数/方法契约（返回值、异常、空值、所有权或副作用）、错误路径或资源生命周期，把调用方与关键被调方列入 neededContext。
只回一个 JSON 对象：{"neededContext": ["<条目>", ...], "reason": "<中文理由>"}`,

  `Phase 4 of 6 - Context Retrieval.
检索你在上一阶段决定需要的上下文。若工具可用，可以回复工具调用来检索；否则说明当前配置下无法检索更多上下文。
只回一个 JSON 对象：{"notes": "<现在有哪些上下文可用，或为何无法检索（中文）>"}`,

  `Phase 5 of 6 - Deep Reasoning.
对代码做深度推理并产出候选意见。只提出你能用具体证据支撑的候选（No Evidence, No Finding）。
只报仓库中已存在代码里、有具体失败场景、且修复能避免真实缺陷的问题；finding 位置必须指向真实文件行。search_code 的命中只能作为上下文，不能单独发起候选。不要报测试缺失、文档/注释/命名/格式类建议。
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
完整示例（两条候选；每条候选是数组中的独立对象，用 },{ 分隔；每个对象只出现一次 id）：
{"candidates":[{"id":"F001","severity":"P1","category":"可靠性","file":"src/Foo.java","line":42,"title":"用户缺失时发生空指针解引用","description":"findUser 可能返回 null，结果未判空即被解引用，请求路径可能抛出 NullPointerException。","evidence":["src/Foo.java:42 findUser(id) 之后调用 user.getName()","没有匹配行时 findUser 返回 null"],"rule":"CORRECTNESS-001","confidence":0.82,"tips":{"review":"[缺陷类型] 未判空的用户对象解引用。影响评估：请求路径抛 NPE。","suggestion":"[重构思路] 判空后走缺省分支。代码示例：\`if (user == null) { return; }\`","subcategory":"空指针安全"}},{"id":"F002","severity":"P2","category":"可维护","file":"src/main/java/com/example/Bar.java","line":88,"title":"异常路径只记录 message，丢失 cause 与堆栈","description":"catch 异常后只输出 e.getMessage()，原始异常类型和堆栈被丢弃，线上无法定位根因。","evidence":["src/main/java/com/example/Bar.java:88 — catch (Exception e) 中仅 logger.error(e.getMessage())"],"rule":"RELIABILITY-002","confidence":0.74,"tips":{"review":"[缺陷类型] 异常吞噬。影响评估：故障现场只剩一行 message，无法定位根因。","suggestion":"[重构思路] 记录异常对象而不是仅 message，保留 cause 与堆栈。","subcategory":"异常处理"}}]}`,

  `Phase 6 of 6 - Evidence Verification.
逐条核验候选意见的证据：每条候选所引证据是否真的支撑该结论。
若候选没有具体失败场景、位置不在真实文件内、或只有 search_code 上下文而没有代码证据，判 pass=false。
只回一个 JSON 对象：{"verdicts": [{"id": "<候选 id>", "pass": true | false, "reason": "<中文理由>"}, ...], "complete": true | false}
使用候选清单里的原 id（不要重新编号）；每条候选恰好一条裁决。
"complete" 为 true 表示评审完成、无需下一轮；false 表示需要再评审一轮。`,
] as const;

export const PHASE_COUNT = PHASE_INSTRUCTIONS.length;

/**
 * 压缩阶段指令（`limits.loop.stageCompression = "compact"`，ADR-0113）：
 *
 * - Phase 1 吸收 Phase 2：一次请求同时产出变更摘要与风险分级；
 * - Phase 3 显式允许空 `neededContext`，让循环可以跳过 Phase 4；
 * - 其余阶段逐字节沿用 `PHASE_INSTRUCTIONS`。
 *
 * 阶段编号与名称保持不变（`Phase N of 6 - <name>.`），审计仍按六阶段记录。
 */
const COMPACT_UNDERSTANDING = `Phase 1 of 6 - Change Understanding.
分析本次合并请求的 unified diff：改了什么、涉及哪些文件与符号、变更意图是什么；同时评定本次变更的风险等级。
本阶段不要调用工具：只基于会话中已有的 diff 与上下文作答；需要检索的上下文留给后续阶段。
只回一个 JSON 对象：{"summary": "<一段中文变更摘要>", "riskClass": "Low" | "Medium" | "High", "reason": "<中文分级理由>"}`;

const COMPACT_CONTEXT_DECISION = `Phase 3 of 6 - Context Decision.
判断除当前会话外，还需要哪些额外上下文才能正确评审本次变更。
若变更涉及函数/方法契约（返回值、异常、空值、所有权或副作用）、错误路径或资源生命周期，把调用方与关键被调方列入 neededContext。
若当前会话里的 diff 与已有上下文已经足够评审，neededContext 返回空数组。
只回一个 JSON 对象：{"neededContext": ["<条目>", ...], "reason": "<中文理由>"}`;

export function buildStageInstruction(
  index: number,
  skipTestFiles: boolean,
  compression: "off" | "compact",
  reviewMode: "diff" | "repo" = "diff",
): string {
  if (reviewMode === "repo") {
    const instruction = SCAN_PHASE_INSTRUCTIONS[index];
    if (instruction === undefined) {
      throw new Error(`missing scan phase instruction at index ${String(index)}`);
    }
    return instruction;
  }
  if (compression === "compact") {
    if (index === 0) {
      return COMPACT_UNDERSTANDING;
    }
    if (index === 2) {
      return COMPACT_CONTEXT_DECISION;
    }
  }
  return buildPhaseInstruction(index, skipTestFiles);
}

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

/** 全仓扫描的六阶段名（Phase 1 为代码理解，不是变更理解） */
export const SCAN_PHASE_ORDER: readonly string[] = [
  "Code Understanding",
  "Risk Classification",
  "Context Decision",
  "Context Retrieval",
  "Deep Reasoning",
  "Evidence Verification",
];
