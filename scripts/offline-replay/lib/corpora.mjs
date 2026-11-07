/**
 * v1 录制语料：与 `packages/review-pi/src/cli/bin.process.test.ts` 的
 * `oneFindingCorpus` / `noFindingCorpus` / `oneFindingCorpusForReport` 同源。
 *
 * 语料只在 `record` 子命令里消费（把 canned 回复渲染成 wire 字节）；`once`
 * 与 `ramp` 只读冻结的 trace，不碰这里。改语料不会改已有 trace——要更新
 * 行为就重录。
 */

const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 };

function candidate(file) {
  return {
    id: "F100",
    severity: "P2",
    category: "correctness",
    file,
    line: 1,
    title: "Sentinel finding title",
    description: "Sentinel finding description",
    evidence: [`${file}:1`],
    rule: "sentinel-rule",
    confidence: 0.5,
  };
}

/** 一轮零工具完成：phase-5 出唯一候选，phase-6 裁决通过 + complete */
function oneFindingCorpus() {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [candidate("sample.txt")] }), usage: ZERO },
    {
      text: JSON.stringify({
        verdicts: [{ id: "F100", pass: true, reason: "stub verdict: evidence holds" }],
        complete: true,
      }),
      usage: ZERO,
    },
  ];
}

/** 零意见：候选为空、phase-6 complete:true ⇒ 不生成报文、总结用固定文案 */
function noFindingCorpus() {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ];
}

/**
 * 报文场景：finding 指向 fixture 里真实存在的 README.md:1（报文 code 由 CLI
 * 抽真源行）；再加报文语义回复与总结回复两条非流式调用。
 */
function reportingCorpus() {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [candidate("README.md")] }), usage: ZERO },
    {
      text: JSON.stringify({
        verdicts: [{ id: "F100", pass: true, reason: "stub verdict: evidence holds" }],
        complete: true,
      }),
      usage: ZERO,
    },
    {
      text: JSON.stringify({
        tips: [
          {
            id: "F100",
            category: "可靠性",
            subcategory: "测试桩",
            review: "[可靠性] 测试桩意见。影响评估：仅测试。",
            suggestion: "[重构思路] 无。代码示例：```无```",
          },
        ],
      }),
      usage: ZERO,
    },
    { text: "# 检视总结\n\n测试桩总结。", usage: ZERO },
  ];
}

/**
 * 规则 Skill 场景（ADR-0014）：主会话 Phase 5 出一条，独立 skill 会话再出一
 * 条，主会话 Phase 6 把两条候选一起裁定。工具面因此在第 6 条请求发生变化
 * （七检视工具 → 七检视工具 + bash），这正是 trace schema v2 的动机。
 */
function skillSingleFindingCorpus() {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [candidate("README.md")] }), usage: ZERO },
    { text: JSON.stringify({ candidates: [skillCandidate("src/main/java/com/example/Alpha.java")] }), usage: ZERO },
    {
      text: JSON.stringify({
        verdicts: [
          { id: "F100", pass: true, reason: "stub verdict: evidence holds" },
          { id: "F200", pass: true, reason: "stub verdict: skill evidence holds" },
        ],
        complete: true,
      }),
      usage: ZERO,
    },
  ];
}

function skillCandidate(file) {
  return {
    id: "F200",
    severity: "P2",
    category: "correctness",
    file,
    line: 3,
    title: "Sentinel skill finding",
    description: "Sentinel skill finding description",
    evidence: [`${file}:3`],
    rule: "sentinel-rule",
    confidence: 0.5,
  };
}

/**
 * 分片场景（ADR-0039）：两片各自完整跑六相位。片内候选落在本片文件上
 * （Alpha.java / Beta.java），合并后是两条独立 findings。
 */
function shardTwoFindingsCorpus() {
  return [...shardSixPhase("F100", "src/main/java/com/example/Alpha.java"), ...shardSixPhase("F200", "src/main/java/com/example/Beta.java")];
}

function shardSixPhase(id, file) {
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    {
      text: JSON.stringify({
        candidates: [
          {
            id,
            severity: "P2",
            category: "correctness",
            file,
            line: 3,
            title: `Sentinel finding in ${file}`,
            description: "Sentinel finding description",
            evidence: [`${file}:3`],
            rule: "sentinel-rule",
            confidence: 0.5,
          },
        ],
      }),
      usage: ZERO,
    },
    {
      text: JSON.stringify({ verdicts: [{ id, pass: true, reason: "stub verdict" }], complete: true }),
      usage: ZERO,
    },
  ];
}

const CORPORA = {
  "one-finding": oneFindingCorpus,
  "no-finding": noFindingCorpus,
  reporting: reportingCorpus,
  "skill-single-finding": skillSingleFindingCorpus,
  "shard-two-findings": shardTwoFindingsCorpus,
};

export function corpusReplies(name) {
  const factory = CORPORA[name];
  if (factory === undefined) {
    throw new Error(
      `unknown corpus "${name}" (known: ${Object.keys(CORPORA).join(", ")})`,
    );
  }
  return factory();
}
