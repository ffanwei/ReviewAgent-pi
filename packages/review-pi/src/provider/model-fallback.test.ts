import { describe, expect, test } from "vitest";

import type { ModelProbeResult } from "./gateway-probe.js";
import {
  decideModelFallback,
  resolveReviewModel,
  shouldProbeModelFallback,
} from "./model-fallback.js";

function ok(modelId: string): ModelProbeResult {
  return { ok: true, diagnostic: `model "${modelId}" is reachable` };
}

function fail(
  failureKind: NonNullable<ModelProbeResult["failureKind"]>,
  diagnostic = `probe failed: ${failureKind}`,
): ModelProbeResult {
  return { ok: false, failureKind, diagnostic };
}

const REQUESTED = "ep-requested";
const FALLBACK = "deepseek-v4-flash";

describe("shouldProbeModelFallback：三条同时满足才探测", () => {
  test("off / 未显式传 --model / 两名相同 → 不探测", () => {
    const base = {
      mode: "on-model-not-found" as const,
      modelFromFlag: true,
      requestedModelId: REQUESTED,
      fallbackModelId: FALLBACK,
    };
    expect(shouldProbeModelFallback(base)).toBe(true);
    expect(shouldProbeModelFallback({ ...base, mode: "off" })).toBe(false);
    expect(shouldProbeModelFallback({ ...base, modelFromFlag: false })).toBe(false);
    expect(shouldProbeModelFallback({ ...base, fallbackModelId: REQUESTED })).toBe(false);
  });
});

describe("decideModelFallback：只认 MODEL_NOT_FOUND（ADR-0080）", () => {
  test("主模型可用 → 保持原模型", () => {
    const decision = decideModelFallback({
      requestedModelId: REQUESTED,
      fallbackModelId: FALLBACK,
      requestedProbe: ok(REQUESTED),
      fallbackProbe: ok(FALLBACK),
    });
    expect(decision.kind).toBe("keep-requested");
  });

  test.each(["AUTH_REJECTED", "RATE_LIMITED", "SERVER_ERROR", "UNREACHABLE", "REQUEST_REJECTED", "MALFORMED_RESPONSE", "MODEL_MISMATCH"] as const)(
    "主模型 %s → 顾问模式保持原模型（不把探针变成失败源）",
    (kind) => {
      const decision = decideModelFallback({
        requestedModelId: REQUESTED,
        fallbackModelId: FALLBACK,
        requestedProbe: fail(kind),
        fallbackProbe: ok(FALLBACK),
      });
      expect(decision.kind).toBe("keep-requested");
    },
  );

  test("主 404 + 默认可用 → 替换，并生成留痕与 stderr 一行", () => {
    const decision = decideModelFallback({
      requestedModelId: REQUESTED,
      fallbackModelId: FALLBACK,
      requestedProbe: fail("MODEL_NOT_FOUND"),
      fallbackProbe: ok(FALLBACK),
    });
    expect(decision).toMatchObject({
      kind: "use-fallback",
      record: { requested: REQUESTED, used: FALLBACK, reason: "model-not-found" },
    });
    if (decision.kind !== "use-fallback") {
      throw new Error("expected use-fallback");
    }
    expect(decision.notice).toContain(`--model "${REQUESTED}" 不可用（model not found）`);
    expect(decision.notice).toContain(`已改用配置文件 model.default "${FALLBACK}"`);
    expect(decision.notice).not.toContain("前置探测未通过");
  });

  test("主 404 + 默认探测未通过（429）→ 照样替换，并附探测结论", () => {
    const decision = decideModelFallback({
      requestedModelId: REQUESTED,
      fallbackModelId: FALLBACK,
      requestedProbe: fail("MODEL_NOT_FOUND"),
      fallbackProbe: fail("RATE_LIMITED", "rate limited at https://gw (HTTP 429)"),
    });
    expect(decision.kind).toBe("use-fallback");
    if (decision.kind !== "use-fallback") {
      throw new Error("expected use-fallback");
    }
    expect(decision.notice).toContain("前置探测未通过");
    expect(decision.notice).toContain("rate limited at https://gw (HTTP 429)");
    expect(decision.notice).toContain("真实请求继续");
  });

  test("两边都 404 → 中止，错误同时点名两个 id", () => {
    const decision = decideModelFallback({
      requestedModelId: REQUESTED,
      fallbackModelId: FALLBACK,
      requestedProbe: fail("MODEL_NOT_FOUND"),
      fallbackProbe: fail("MODEL_NOT_FOUND"),
    });
    expect(decision.kind).toBe("abort");
    if (decision.kind !== "abort") {
      throw new Error("expected abort");
    }
    expect(decision.message).toContain(REQUESTED);
    expect(decision.message).toContain(FALLBACK);
    expect(decision.message).toContain("已中止");
  });
});

describe("resolveReviewModel：探测编排（零网络，注入 probe）", () => {
  function scripted(results: readonly ModelProbeResult[]): {
    readonly probe: (modelId: string) => Promise<ModelProbeResult>;
    readonly calls: string[];
  } {
    const calls: string[] = [];
    let index = 0;
    return {
      calls,
      probe: async (modelId: string) => {
        calls.push(modelId);
        const result = results[index];
        index += 1;
        if (result === undefined) {
          throw new Error("probe called more times than scripted");
        }
        return result;
      },
    };
  }

  test("off → 一次探测都不发", async () => {
    const { probe, calls } = scripted([]);
    const decision = await resolveReviewModel({
      mode: "off",
      modelFromFlag: true,
      requestedModelId: REQUESTED,
      fallbackModelId: FALLBACK,
      probe,
    });
    expect(decision.kind).toBe("keep-requested");
    expect(calls).toEqual([]);
  });

  test("主模型非 404 失败 → 只探一次，保持原模型", async () => {
    const { probe, calls } = scripted([fail("UNREACHABLE")]);
    const decision = await resolveReviewModel({
      mode: "on-model-not-found",
      modelFromFlag: true,
      requestedModelId: REQUESTED,
      fallbackModelId: FALLBACK,
      probe,
    });
    expect(decision.kind).toBe("keep-requested");
    expect(calls).toEqual([REQUESTED]);
  });

  test("主模型可用 → 只探一次，保持原模型", async () => {
    const { probe, calls } = scripted([ok(REQUESTED)]);
    const decision = await resolveReviewModel({
      mode: "on-model-not-found",
      modelFromFlag: true,
      requestedModelId: REQUESTED,
      fallbackModelId: FALLBACK,
      probe,
    });
    expect(decision.kind).toBe("keep-requested");
    expect(calls).toEqual([REQUESTED]);
  });

  test("主 404 → 再探默认模型并替换", async () => {
    const { probe, calls } = scripted([fail("MODEL_NOT_FOUND"), ok(FALLBACK)]);
    const decision = await resolveReviewModel({
      mode: "on-model-not-found",
      modelFromFlag: true,
      requestedModelId: REQUESTED,
      fallbackModelId: FALLBACK,
      probe,
    });
    expect(decision.kind).toBe("use-fallback");
    expect(calls).toEqual([REQUESTED, FALLBACK]);
  });
});
