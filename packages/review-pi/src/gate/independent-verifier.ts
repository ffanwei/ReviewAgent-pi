// 独立证伪核验（F-05）：候选 finding → 新 one-shot 会话，只给 finding +
// 行号附近的文件片段，尝试证伪；不读仓库、不调用工具、不循环追问。
//
// 纪律：
// - 一次调用 + 至多一次解析重试（重试由 one-shot 层负责）；uncertain 不再追问；
// - 请求失败 / 超时 / 回包不可解析 → uncertain（调用方 fail-open，保留候选）；
// - 回包明确 pass=false 才是 reject；保护性主题由调用方决定是否 fail-open。
import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";
import { completeOneShot, extractJsonObject, type OneShotPurpose } from "../provider/one-shot-llm.js";
import { ZERO_USAGE } from "../provider/usage-map.js";

export type FindingVerificationStatus = "pass" | "reject" | "uncertain";

export interface IndependentVerifierLlm {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly modelId: string;
  readonly timeoutMs: number;
  readonly retry?: Parameters<typeof completeOneShot>[0]["retry"];
  readonly fetch?: Parameters<typeof completeOneShot>[0]["fetch"];
  readonly maxTokens?: number;
}

export interface VerifyFindingInput {
  readonly finding: Finding;
  /** 行号附近的文件片段（带行号）；null = 不可核对，直接 uncertain */
  readonly excerpt: string | null;
}

export interface FindingVerificationResult {
  readonly status: FindingVerificationStatus;
  readonly reason: string;
  readonly usage: LlmUsage;
  readonly requestFailed: boolean;
  /** 仅解析失败时保留：回包原文前 500 字符（审计用，不含 key） */
  readonly rawReply?: string;
}

export interface VerifierCompletion {
  readonly ok: boolean;
  readonly text?: string;
  readonly usage?: LlmUsage;
}

export type VerifierComplete = (input: {
  readonly system: string;
  readonly user: string;
  readonly maxTokens: number;
}) => Promise<VerifierCompletion>;

const VERIFY_MAX_TOKENS = 4_096;

const VERIFIER_SYSTEM_PROMPT = [
  "You are an independent code-review falsifier. You receive one finding and a numbered excerpt of the file around its line.",
  "Your job is to try to falsify the finding using ONLY the excerpt. Do not assume extra repository context.",
  "Return pass=true only when all are true:",
  "1) the excerpt contains the code referenced by the finding;",
  "2) the described defect is actually present in that code;",
  "3) the conclusion does not depend on unshown context.",
  "Return pass=false when the excerpt contradicts the finding, the referenced code is absent, or the described behavior is normal / already handled.",
  "If the excerpt is insufficient to decide, return pass=false with reason starting with \"uncertain:\".",
  "Do not evaluate style preferences. Do not reward confidence or severity.",
  'Reply with one JSON object only: {"pass":true|false,"reason":"short evidence-based reason"}',
].join("\n");

/** 提取行号附近片段，带行号；最多 8,000 字符，避免把整文件塞进 prompt */
export function excerptAroundLine(
  fileText: string,
  line: number,
  contextLines = 40,
  maxChars = 8_000,
): string {
  const lines = fileText.split(/\r?\n/);
  const start = Math.max(1, line - contextLines);
  const end = Math.min(lines.length, line + contextLines);
  const numbered: string[] = [];
  for (let index = start; index <= end; index += 1) {
    numbered.push(`${String(index)}: ${lines[index - 1] ?? ""}`);
  }
  let excerpt = numbered.join("\n");
  if (excerpt.length > maxChars) {
    excerpt = `${excerpt.slice(0, maxChars)}\n…[excerpt truncated]`;
  }
  return excerpt;
}

export async function verifyFinding(
  input: VerifyFindingInput,
  llm: IndependentVerifierLlm,
  complete?: VerifierComplete,
): Promise<FindingVerificationResult> {
  if (input.excerpt === null) {
    return { status: "uncertain", reason: "excerpt unavailable (fail-open)", usage: ZERO_USAGE, requestFailed: false };
  }
  const user = [
    `File: ${input.finding.file}`,
    `Line: ${String(input.finding.line)}`,
    `Finding: ${JSON.stringify({
      id: input.finding.id,
      severity: input.finding.severity,
      category: input.finding.category,
      title: input.finding.title,
      description: input.finding.description,
      evidence: input.finding.evidence,
      rule: input.finding.rule,
      confidence: input.finding.confidence,
    })}`,
    "",
    "Excerpt (line-numbered):",
    input.excerpt,
    "",
    "Return the JSON verdict now.",
  ].join("\n");
  // 有界重试：推理模型可能把 completion 预算全花在隐藏推理上，返回空 content
  // 或截断 JSON。只对这一类“解析失败”重发一次（不追问答辩），总调用 ≤2。
  const retryUser = `${user}\n\nIMPORTANT: reply with the JSON object only, no reasoning text.`;
  let usage: LlmUsage = ZERO_USAGE;
  let parsed: { readonly pass: boolean; readonly reason: string } | null = null;
  let lastText = "";
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    let completion: VerifierCompletion;
    try {
      completion = complete !== undefined
        ? await complete({ system: VERIFIER_SYSTEM_PROMPT, user: attempt === 1 ? user : retryUser, maxTokens: VERIFY_MAX_TOKENS })
        : await defaultComplete(llm, attempt === 1 ? user : retryUser);
    } catch {
      return { status: "uncertain", reason: "verifier request failed (fail-open)", usage, requestFailed: true };
    }
    usage = addUsage(usage, completion.usage);
    if (!completion.ok) {
      return { status: "uncertain", reason: "verifier request failed (fail-open)", usage, requestFailed: true };
    }
    lastText = completion.text ?? "";
    parsed = parseFindingVerdict(lastText);
    if (parsed !== null) {
      break;
    }
  }
  if (parsed === null) {
    return {
      status: "uncertain",
      reason: "verifier reply unparseable (fail-open)",
      usage,
      requestFailed: true,
      rawReply: lastText.slice(0, 500),
    };
  }
  if (parsed.pass) {
    return { status: "pass", reason: parsed.reason, usage, requestFailed: false };
  }
  // 验证器用 `uncertain:` 前缀表示“片段不足，无法判断”；这不是 reject。
  if (/^uncertain:/i.test(parsed.reason)) {
    return { status: "uncertain", reason: parsed.reason, usage, requestFailed: false };
  }
  return { status: "reject", reason: parsed.reason, usage, requestFailed: false };
}

async function defaultComplete(llm: IndependentVerifierLlm, user: string): Promise<VerifierCompletion> {
  const result = await completeOneShot({
    baseUrl: llm.baseUrl,
    apiKey: llm.apiKey,
    modelId: llm.modelId,
    system: VERIFIER_SYSTEM_PROMPT,
    user,
    timeoutMs: llm.timeoutMs,
    ...(llm.retry !== undefined ? { retry: llm.retry } : {}),
    ...(llm.fetch !== undefined ? { fetch: llm.fetch } : {}),
    maxTokens: llm.maxTokens ?? VERIFY_MAX_TOKENS,
    responseFormat: "json_object",
    purpose: "finding-verification" satisfies OneShotPurpose,
  });
  if (!result.ok) {
    return { ok: false };
  }
  return {
    ok: true,
    text: result.text,
    ...(result.usage !== undefined ? { usage: result.usage } : {}),
  };
}

function addUsage(left: LlmUsage, right: LlmUsage | undefined): LlmUsage {
  if (right === undefined) {
    return left;
  }
  const cacheReadTokens = (left.cacheReadTokens ?? 0) + (right.cacheReadTokens ?? 0);
  const cacheWriteTokens = (left.cacheWriteTokens ?? 0) + (right.cacheWriteTokens ?? 0);
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
  };
}

export function parseFindingVerdict(
  text: string,
): { readonly pass: boolean; readonly reason: string } | null {
  const parsed = extractJsonObject(text);
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return null;
  }
  const pass = (parsed as { pass?: unknown }).pass;
  if (typeof pass !== "boolean") {
    return null;
  }
  const reason = (parsed as { reason?: unknown }).reason;
  return { pass, reason: typeof reason === "string" ? reason.trim().slice(0, 500) : "" };
}
