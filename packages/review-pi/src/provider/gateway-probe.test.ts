import { expect, test } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";
import {
  formatSmokeDiagnostics,
  modelEchoMatches,
  probeGatewayHealth,
  probeModelReachability,
  runSmokeProbes,
} from "./gateway-probe.js";

// 冒烟双探针（#4，R4 网关+自由 id 关闭面）：网关健康（传输层可达）+
// 模型可达（鉴权/模型 id/请求体/回显），每类失败路径一条人话诊断。
// 期望措辞锚定真实失败形态：无 /v1 的网关 URL 会被静默路由到别的模型
// （本机 2026-09-19 实测：deepseek 请求 id 被路由到 glm-5.3-flash）——
// MODEL_MISMATCH 诊断必须点名这个签名。
// 离线纪律：fetch 全注入；诊断断言不含 key 值（哨兵断言）。

const BASE_URL = "https://gw.example.com/v1";
const API_KEY = "sk-probe-sentinel";
const MODEL_ID = "deepseek-v4-flash";

/** 请求捕获 + 脚本化响应的 fake 传输层（探针测试专用；非 SDK SSE 形态） */
function scriptedFetch(
  handler: (request: { url: string; init: RequestInit }) => Response | Promise<Response>,
): { fetch: FetchFunction; requests: { url: string; init: RequestInit }[] } {
  const requests: { url: string; init: RequestInit }[] = [];
  const fetch: FetchFunction = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    requests.push({ url, init: init ?? {} });
    return handler({ url, init: init ?? {} });
  };
  return { fetch, requests };
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function networkError(cause?: unknown): never {
  throw new TypeError("fetch failed", { cause });
}

test("网关健康：网络错误（ENOTFOUND）→ 不可达 + 人话诊断含地址与 DNS 归因", async () => {
  const { fetch } = scriptedFetch(() => networkError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND gw.example.com" }));
  const result = await probeGatewayHealth({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
  expect(result.reachable).toBe(false);
  expect(result.diagnostic).toContain(BASE_URL);
  expect(result.diagnostic).toContain("DNS");
  expect(result.diagnostic).toContain("reviewer.baseUrl");
});

test("网关健康：任何 HTTP 响应（含 404）= 网关活着（健康探针只判传输层可达）", async () => {
  const { fetch } = scriptedFetch(() => jsonResponse(404, { error: "not found" }));
  const result = await probeGatewayHealth({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
  expect(result.reachable).toBe(true);
  expect(result.diagnostic).not.toContain("DNS");
});

test("网关健康：请求命中 ${baseUrl}/models 且携带 Bearer；诊断不泄漏 key", async () => {
  const { fetch, requests } = scriptedFetch(() => jsonResponse(200, { object: "list", data: [{ id: "deepseek-v4-flash" }, { id: "glm-5.3" }] }));
  const result = await probeGatewayHealth({ baseUrl: BASE_URL, apiKey: API_KEY, fetch });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(`${BASE_URL}/models`);
  const headers = new Headers(requests[0]?.init.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  expect(result.reachable).toBe(true);
  // 200 + 可解析模型清单 → 细节里给出可见 id（人话提示）
  expect(result.detail).toContain("deepseek-v4-flash");
  expect(result.diagnostic).not.toContain(API_KEY);
  expect(result.detail ?? "").not.toContain(API_KEY);
});

test("网关健康：超时 → 不可达 + 超时措辞", async () => {
  const { fetch } = scriptedFetch(
    () =>
      new Promise<Response>(() => {
        // 永不 resolve：交给探针的 AbortSignal.timeout 触发
      }),
  );
  const result = await probeGatewayHealth({ baseUrl: BASE_URL, apiKey: API_KEY, fetch, healthTimeoutMs: 50 });
  expect(result.reachable).toBe(false);
  expect(result.diagnostic).toContain("timed out");
});

// ---- 探针 2：模型可达（每类失败路径一条人话诊断） ----

test("模型探针：请求形态——POST ${baseUrl}/chat/completions，体含模型 id + stream:false", async () => {
  const { fetch, requests } = scriptedFetch(() =>
    jsonResponse(200, {
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      usage: { prompt_tokens: 9, completion_tokens: 1, prompt_cache_hit_tokens: 4 },
    }),
  );
  await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(requests).toHaveLength(1);
  expect(requests[0]?.url).toBe(`${BASE_URL}/chat/completions`);
  expect(requests[0]?.init.method).toBe("POST");
  const headers = new Headers(requests[0]?.init.headers);
  expect(headers.get("authorization")).toBe(`Bearer ${API_KEY}`);
  expect(JSON.parse(String(requests[0]?.init.body))).toEqual({
    model: MODEL_ID,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 1,
    stream: false,
  });
});

test("模型探针：401 → AUTH_REJECTED，诊断点名配置键、绝不泄漏 key 值", async () => {
  const { fetch } = scriptedFetch(() =>
    jsonResponse(401, { error: { message: "Authentication Fails (incorrect api key)" } }),
  );
  const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(result.ok).toBe(false);
  expect(result.failureKind).toBe("AUTH_REJECTED");
  expect(result.diagnostic).toContain("reviewer.apiKey");
  expect(`${result.diagnostic}\n${result.detail ?? ""}`).not.toContain(API_KEY);
});

test("模型探针：404 → MODEL_NOT_FOUND，诊断含模型 id 与 /v1 路径提示", async () => {
  const { fetch } = scriptedFetch(() => jsonResponse(404, { error: { message: "path not found" } }));
  const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(result.failureKind).toBe("MODEL_NOT_FOUND");
  expect(result.diagnostic).toContain(MODEL_ID);
  expect(result.diagnostic).toContain("/v1");
});

test("模型探针：400 + deepseek 口径「Model Not Exist」→ MODEL_NOT_FOUND（不误判请求体被拒）", async () => {
  const { fetch } = scriptedFetch(() =>
    jsonResponse(400, { error: { message: "Model Not Exist", type: "invalid_request_error" } }),
  );
  const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: "no-such-model", fetch });
  expect(result.failureKind).toBe("MODEL_NOT_FOUND");
  expect(result.diagnostic).toContain("no-such-model");
});

test("模型探针：400 其他错误 → REQUEST_REJECTED，detail 含网关错误体摘录", async () => {
  const { fetch } = scriptedFetch(() =>
    jsonResponse(400, { error: { message: "Invalid request: field 'messages' is required" } }),
  );
  const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(result.failureKind).toBe("REQUEST_REJECTED");
  expect(result.detail).toContain("messages");
});

test("模型探针：429 → RATE_LIMITED", async () => {
  const { fetch } = scriptedFetch(() => jsonResponse(429, { error: { message: "Too Many Requests" } }));
  const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(result.failureKind).toBe("RATE_LIMITED");
});

test("模型探针：5xx → SERVER_ERROR", async () => {
  const { fetch } = scriptedFetch(() => jsonResponse(502, { error: { message: "upstream bad gateway" } }));
  const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(result.failureKind).toBe("SERVER_ERROR");
  expect(result.diagnostic).toContain("502");
});

test("模型探针：200 非 JSON / 缺 usage → MALFORMED_RESPONSE", async () => {
  const plain = scriptedFetch(() => new Response("<html>login page</html>", { status: 200 }));
  const noUsage = scriptedFetch(() =>
    jsonResponse(200, { model: MODEL_ID, choices: [{ index: 0 }] }),
  );
  for (const { fetch } of [plain, noUsage]) {
    const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
    expect(result.ok).toBe(false);
    expect(result.failureKind).toBe("MALFORMED_RESPONSE");
  }
});

test("模型探针：200 回显不一致（glm-5.3-flash）→ MODEL_MISMATCH，点名静默错路由签名与 /v1 修复", async () => {
  const { fetch } = scriptedFetch(() =>
    jsonResponse(200, {
      model: "glm-5.3-flash",
      choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      usage: { prompt_tokens: 9, completion_tokens: 1, prompt_cache_hit_tokens: 4 },
    }),
  );
  const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(result.ok).toBe(false);
  expect(result.failureKind).toBe("MODEL_MISMATCH");
  expect(result.diagnostic).toContain("glm-5.3-flash");
  expect(result.diagnostic).toContain("deepseek-v4-flash");
  expect(result.diagnostic).toContain("/v1");
});

test("模型探针：200 回显 = 版本化构建（deepseek-v4-flash-ga-260731）→ ok（网关别名解析合法），诊断注明解析产物", async () => {
  const { fetch } = scriptedFetch(() =>
    jsonResponse(200, {
      model: "deepseek-v4-flash-ga-260731",
      choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      usage: { prompt_tokens: 9, completion_tokens: 1, prompt_cache_hit_tokens: 4 },
    }),
  );
  const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  // 火山引擎网关把别名解析为带日期的 GA 快照（本机 2026-09-19 实测）——
  // 同族版本化构建是合法回显，不是静默错路由
  expect(result.ok).toBe(true);
  expect(result.respondedModel).toBe("deepseek-v4-flash-ga-260731");
  expect(result.diagnostic).toContain("deepseek-v4-flash-ga-260731");
});

test("modelEchoMatches：同族边界口径（分隔符后缀 = 版本化；跨界族 = 不匹配）", () => {
  expect(modelEchoMatches("deepseek-v4-flash", "deepseek-v4-flash")).toBe(true);
  expect(modelEchoMatches("deepseek-v4-flash", "deepseek-v4-flash-ga-260731")).toBe(true);
  expect(modelEchoMatches("deepseek-v4-flash", "deepseek-v4-flash.1")).toBe(true);
  expect(modelEchoMatches("glm-5.3", "glm-5.3-flash")).toBe(true); // 同族层级漂移不判错（已知局限：探针只拦跨族错路由）
  expect(modelEchoMatches("deepseek-v4-flash", "glm-5.3-flash")).toBe(false);
  expect(modelEchoMatches("deepseek-v4-flash", "deepseek-v4-flashy")).toBe(false); // 无分隔符的黏连不算版本化
  expect(modelEchoMatches("glm-5.3", "glm-5.35")).toBe(false);
});

test("模型探针：200 回显一致 → ok，rawUsage 逐字段捕获（R2 断言真源）", async () => {
  const { fetch } = scriptedFetch(() =>
    jsonResponse(200, {
      model: MODEL_ID,
      choices: [{ index: 0, message: { role: "assistant", content: "" } }],
      usage: { prompt_tokens: 1000, completion_tokens: 7, prompt_cache_hit_tokens: 240 },
    }),
  );
  const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(result.ok).toBe(true);
  expect(result.respondedModel).toBe(MODEL_ID);
  expect(result.rawUsage).toEqual({ promptTokens: 1000, completionTokens: 7, cacheReadTokens: 240 });
  expect(result.diagnostic).toContain("cacheRead 240");
});

test("模型探针：网络错误 → UNREACHABLE（探针 2 与探针 1 同归因措辞）", async () => {
  const { fetch } = scriptedFetch(() => networkError({ code: "ECONNREFUSED", message: "connect ECONNREFUSED 1.2.3.4:443" }));
  const result = await probeModelReachability({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(result.ok).toBe(false);
  expect(result.failureKind).toBe("UNREACHABLE");
  expect(result.diagnostic).toContain("connection refused");
});

// ---- 组合：runSmokeProbes + 人话汇总 ----

test("runSmokeProbes：网关不可达 → 模型探针跳过 + 组合 FAILED + 汇总双行可读", async () => {
  const { fetch } = scriptedFetch(() => networkError({ code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND gw.example.com" }));
  const result = await runSmokeProbes({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(result.ok).toBe(false);
  expect(result.health.reachable).toBe(false);
  expect(result.model.ok).toBe(false);
  expect(result.model.diagnostic).toContain("skipped");
  const text = formatSmokeDiagnostics(result);
  expect(text).toContain("FAILED");
  expect(text).toContain("[1/2] gateway health:");
  expect(text).toContain("[2/2] model reachability:");
  expect(text).toContain(BASE_URL);
  expect(text).toContain(MODEL_ID);
});

test("runSmokeProbes：双探针全过 → ok + 汇总 OK", async () => {
  const { fetch } = scriptedFetch(({ url }) =>
    url.endsWith("/models")
      ? jsonResponse(200, { object: "list", data: [{ id: MODEL_ID }] })
      : jsonResponse(200, {
          model: MODEL_ID,
          choices: [{ index: 0 }],
          usage: { prompt_tokens: 9, completion_tokens: 1, prompt_cache_hit_tokens: 4 },
        }),
  );
  const result = await runSmokeProbes({ baseUrl: BASE_URL, apiKey: API_KEY, modelId: MODEL_ID, fetch });
  expect(result.ok).toBe(true);
  expect(formatSmokeDiagnostics(result)).toContain("OK");
});
