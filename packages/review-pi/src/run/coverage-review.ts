import type { FetchFunction } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";
import { applyCandidateGate } from "../gate/candidate-gate.js";
import { normalizeCandidates } from "../gate/candidate-normalize.js";
import { findingContentKey } from "../finding/finding-key.js";
import { resolveRules } from "../knowledge/rule-catalog.js";
import { parseCandidatesReply } from "../loop/parse.js";
import { reviewModelOf } from "../provider/pi-client.js";
import { addUsage, ZERO_USAGE } from "../provider/usage-map.js";
import { completeOneShot } from "../shared/one-shot-llm.js";
import { SYSTEM_PROMPT } from "../zonea/system-prompt.js";
import type { ReviewRunContext } from "./pass-runner.js";

/**
 * 零 findings 文件的补充检视（分组实验）：
 * 主 pass 后，对每个没有产出 finding 的变更文件做一次单文件定向检视。
 *
 * 目标不是替代主检视，而是补“组太大、模型跳过了某些文件”的覆盖缺口。
 * 输出仍走同一候选归一化 + Evidence Gate（fail-open），并有文件数上限。
 */

export interface CoverageFile {
  readonly path: string;
  readonly diff: string;
}

export interface CoverageReviewResult {
  readonly findings: readonly Finding[];
  readonly files: number;
  readonly candidates: number;
  readonly errors: number;
  readonly usage: LlmUsage;
}

const MAX_FILE_DIFF_CHARS = 30_000;
const MAX_OUTPUT_TOKENS = 8_192;

export async function runCoverageReview(
  context: ReviewRunContext,
  files: readonly CoverageFile[],
): Promise<CoverageReviewResult> {
  const model = reviewModelOf(context.modelId, context.baseUrl);
  const findings: Finding[] = [];
  let candidates = 0;
  let errors = 0;
  let usage = ZERO_USAGE;
  const emittedIds = new Set<string>();
  const emittedContentKeys = new Set<string>();

  for (const file of files) {
    if (file.diff.length > MAX_FILE_DIFF_CHARS) {
      continue;
    }
    const ruleText = resolveFileRules(context, file.path);
    const result = await completeOneShot({
      baseUrl: model.baseUrl,
      apiKey: context.apiKey,
      modelId: model.id,
      system: SYSTEM_PROMPT,
      user: coveragePrompt(file, ruleText),
      timeoutMs: context.runtime.limits.timeouts.oneShotMs,
      maxTokens: MAX_OUTPUT_TOKENS,
      responseFormat: "json_object",
      purpose: "coverage-review",
      ...(context.fetch !== undefined ? { fetch: context.fetch as FetchFunction } : {}),
    });
    if (!result.ok) {
      errors += 1;
      continue;
    }
    if (result.usage !== undefined) {
      usage = addUsage(usage, result.usage);
    }
    const parsed = parseCandidatesReply(result.text);
    if (parsed.failure !== undefined || parsed.candidates.length === 0) {
      continue;
    }
    const normalized = normalizeCandidates({ candidates: parsed.candidates, round: 1 });
    candidates += normalized.candidates.length;
    const gate = applyCandidateGate({
      candidates: normalized.candidates,
      verdicts: new Map(),
      emittedIds,
      emittedContentKeys,
      round: 1,
      failOpenVerification: true,
    });
    findings.push(...gate.findings);
    for (const finding of gate.findings) {
      emittedContentKeys.add(findingContentKey(finding));
    }
  }

  return { findings, files: files.length, candidates, errors, usage };
}

function resolveFileRules(context: ReviewRunContext, file: string): string {
  if (context.ruleCatalog === undefined) {
    return "";
  }
  const limits = context.runtime.limits.rules;
  const resolved = resolveRules(
    context.ruleCatalog,
    [file],
    limits.maxRuleContextChars,
    limits.userOverrideBuiltin,
  );
  return resolved.text;
}

function coveragePrompt(file: CoverageFile, ruleText: string): string {
  return [
    "这是一次补充检视：只看下面这个文件的新增代码。",
    "只报高置信、由本次 diff 引入、能给出具体证据的缺陷；不确定就返回空候选。",
    '只输出 JSON：{"candidates":[<Finding>]}；无问题时返回 {"candidates":[]}。',
    ruleText.trim() === "" ? "" : `适用规则：\n${ruleText}`,
    `文件：${file.path}`,
    "diff：",
    file.diff,
  ]
    .filter((line) => line !== "")
    .join("\n");
}
