// 六阶段指令（测量常量）：每条是发往模型的完整阶段 user 消息 content。
//
// 字节真源：DSH 线 t-series 审计各阶段 user 消息（testdata/golden/phase-1..6.txt），
// 由 src/loop/phases.test.ts 断言逐字节一致。任何改动都需要显式变更记录。
//
// 阶段语义（六阶段骨架，每个单元恰好各执行一次）：
// 1. Change Understanding → 2. Risk Classification → 3. Context Decision
// → 4. Context Retrieval → 5. Deep Reasoning → 6. Evidence Verification
export const PHASE_INSTRUCTIONS: readonly string[] = [
  `Phase 1 of 6 - Change Understanding.
Analyze the unified diff of this merge request. Identify what changed, which files and symbols are involved, and the intent of the change.
Reply with a single JSON object: {"summary": "<one-paragraph English summary of the change>"}`,

  `Phase 2 of 6 - Risk Classification.
Classify the risk of this change.
Reply with a single JSON object: {"riskClass": "Low" | "Medium" | "High", "reason": "<why>"}`,

  `Phase 3 of 6 - Context Decision.
Decide what additional context beyond the current conversation would be needed to review this change properly.
Reply with a single JSON object: {"neededContext": ["<item>", ...], "reason": "<why>"}`,

  `Phase 4 of 6 - Context Retrieval.
Retrieve the context you decided is needed. If tools are available you may call them by replying with tool calls; otherwise state that no further context can be retrieved in this configuration.
Reply with a single JSON object: {"notes": "<what context is now available, or why none could be retrieved>"}`,

  `Phase 5 of 6 - Deep Reasoning.
Reason in depth about the change and produce candidate findings. Only raise candidates you can support with concrete evidence (No Evidence, No Finding).
Reply with a single JSON object: {"candidates": [<finding objects per the Finding schema>, ...]}`,

  `Phase 6 of 6 - Evidence Verification.
Verify every candidate finding against the evidence. For each candidate decide whether the cited evidence actually supports the finding.
Reply with a single JSON object: {"verdicts": [{"id": "<candidate id>", "pass": true | false, "reason": "<why>"}, ...], "complete": true | false}
"complete" means the review is finished and no further round is needed; false means another review round is required.`,
] as const;

export const PHASE_COUNT = PHASE_INSTRUCTIONS.length;

/** 六阶段名（固定顺序；PhaseRecord.phase 与指令前缀一一对应） */
export const PHASE_ORDER: readonly string[] = [
  "Change Understanding",
  "Risk Classification",
  "Context Decision",
  "Context Retrieval",
  "Deep Reasoning",
  "Evidence Verification",
];
