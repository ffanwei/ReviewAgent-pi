import type { ModelFallbackRecord } from "../contracts/run.js";
import type { ModelFallbackMode } from "../shared/config.js";
import type { ModelProbeResult } from "./gateway-probe.js";

/**
 * `--model` 不可用时的前置探测与单边降级（ADR-0080）。
 *
 * 纪律（三条，缺一不可）：
 * 1. **只认一个失败分类**：`MODEL_NOT_FOUND`（404 / "model not exist" 文案）。
 *    400 在本仓语义里还覆盖「模型不支持 function calling / 画像不匹配」，
 *    放进来会把配置错误降级成「换模型重跑」，比失败更糟；401/403/429/5xx /
 *    网络 / 响应畸形一律不换（换模型治不了，且会掩盖真正的 baseUrl 问题）。
 * 2. **探针是顾问不是守门员**：非 `MODEL_NOT_FOUND` 的探测结论不改变任何行为，
 *    照常开跑；探针请求与真实检视请求不等价（无 tools、无 reasoning_effort、
 *    max_tokens:1），不可让它成为新的失败源。
 * 3. **开跑前一次定死**：替换决策发生在任何模型请求之前，之后整 run 单向使用
 *    生效模型；分片 / Skill 会话 / 候选修复 / tips 总结不各判各的。
 *
 * 纯编排：网络由注入的 `probe` 提供，单测零网络。
 */

/** 唯一允许触发替换的失败分类 */
export const FALLBACK_TRIGGER = "MODEL_NOT_FOUND" as const;

/** 替换留痕里的原因值域（当前只有一种） */
export type ModelFallbackReason = ModelFallbackRecord["reason"];

export type ModelFallbackDecision =
  | { readonly kind: "keep-requested" }
  | {
      readonly kind: "use-fallback";
      readonly record: ModelFallbackRecord;
      /** stderr 人话一行（调用方补 `review-pi: ` 前缀） */
      readonly notice: string;
    }
  | {
      readonly kind: "abort";
      /** 人话错误（调用方作为异常消息抛出 → stderr 一行 + exit 1） */
      readonly message: string;
    };

/**
 * 是否值得探测：开关打开 + `--model` 显式传入 + 两个 id 剥前缀后不同。
 * 三者任一不满足 = 探测一次都不发（缺省 `off` 时零额外请求）。
 */
export function shouldProbeModelFallback(input: {
  readonly mode: ModelFallbackMode;
  readonly modelFromFlag: boolean;
  readonly requestedModelId: string;
  readonly fallbackModelId: string;
}): boolean {
  return (
    input.mode === "on-model-not-found" &&
    input.modelFromFlag &&
    input.requestedModelId !== input.fallbackModelId
  );
}

/**
 * 判定（纯函数）：给定主模型与默认模型的探测结果 → 保持 / 替换 / 中止。
 *
 * 主模型已是确定性死刑（404 不会被 pi-ai 重试）时，替换的期望收益恒为正：
 * 即使默认模型的探测结论不理想（429 / 超时 / 响应畸形），真实请求仍可能成功；
 * 失败时报出的是默认模型的真实错误，比「主模型不存在」更有信息量。只有
 * 「默认也 404」才说明两条路都断了。
 */
export function decideModelFallback(input: {
  readonly requestedModelId: string;
  readonly fallbackModelId: string;
  readonly requestedProbe: ModelProbeResult;
  readonly fallbackProbe: ModelProbeResult;
}): ModelFallbackDecision {
  const fatal = (probe: ModelProbeResult): boolean =>
    !probe.ok && probe.failureKind === FALLBACK_TRIGGER;

  if (!fatal(input.requestedProbe)) {
    return { kind: "keep-requested" };
  }
  if (fatal(input.fallbackProbe)) {
    return {
      kind: "abort",
      message:
        `--model ${JSON.stringify(input.requestedModelId)} 不可用（model not found），` +
        `配置文件 model.default ${JSON.stringify(input.fallbackModelId)} 同样不可用（model not found）；` +
        "已中止（先跑 review-pi smoke 排查网关与模型 id）",
    };
  }
  const noticeSuffix = input.fallbackProbe.ok
    ? ""
    : `；默认模型前置探测未通过（${input.fallbackProbe.diagnostic}），真实请求继续`;
  return {
    kind: "use-fallback",
    record: {
      requested: input.requestedModelId,
      used: input.fallbackModelId,
      reason: "model-not-found",
    },
    notice:
      `--model ${JSON.stringify(input.requestedModelId)} 不可用（model not found），` +
      `已改用配置文件 model.default ${JSON.stringify(input.fallbackModelId)}${noticeSuffix}`,
  };
}

/**
 * 探测编排：先探主模型；只有它判为 `MODEL_NOT_FOUND` 才探默认模型。
 * 其余探测结论（含 `ok` 与非 404 失败）一律「保持原模型、照常开跑」。
 */
export async function resolveReviewModel(input: {
  readonly mode: ModelFallbackMode;
  readonly modelFromFlag: boolean;
  readonly requestedModelId: string;
  readonly fallbackModelId: string;
  readonly probe: (modelId: string) => Promise<ModelProbeResult>;
}): Promise<ModelFallbackDecision> {
  if (!shouldProbeModelFallback(input)) {
    return { kind: "keep-requested" };
  }
  const requestedProbe = await input.probe(input.requestedModelId);
  if (requestedProbe.ok || requestedProbe.failureKind !== FALLBACK_TRIGGER) {
    return { kind: "keep-requested" };
  }
  const fallbackProbe = await input.probe(input.fallbackModelId);
  return decideModelFallback({
    requestedModelId: input.requestedModelId,
    fallbackModelId: input.fallbackModelId,
    requestedProbe,
    fallbackProbe,
  });
}
