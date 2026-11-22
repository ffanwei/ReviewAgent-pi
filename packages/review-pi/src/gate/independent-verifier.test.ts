import { expect, test } from "vitest";
import type { Finding } from "../contracts/finding.js";
import { excerptAroundLine, parseFindingVerdict, verifyFinding } from "./independent-verifier.js";

const FINDING: Finding = {
  id: "F001",
  severity: "P1",
  category: "CORRECTNESS",
  file: "src/a.ts",
  line: 12,
  title: "Null dereference",
  description: "value may be null",
  evidence: ["src/a.ts:12 — value.toString()"],
  rule: "NULL-001",
  confidence: 0.8,
};

const LLM = {
  baseUrl: "https://example.invalid",
  apiKey: "test",
  modelId: "m",
  timeoutMs: 1000,
};

test("excerptAroundLine 带行号并夹住范围", () => {
  const text = Array.from({ length: 100 }, (_, index) => `line ${String(index + 1)}`).join("\n");
  const excerpt = excerptAroundLine(text, 50, 2, 10_000);
  expect(excerpt).toContain("50: line 50");
  expect(excerpt).toContain("48: line 48");
  expect(excerpt).toContain("52: line 52");
  expect(excerpt).not.toContain("47: line 47");
});

test("parseFindingVerdict：只接受布尔 pass", () => {
  expect(parseFindingVerdict('{"pass":true,"reason":"ok"}')).toEqual({ pass: true, reason: "ok" });
  expect(parseFindingVerdict('{"pass":false,"reason":"uncertain: not enough"}')).toEqual({
    pass: false,
    reason: "uncertain: not enough",
  });
  expect(parseFindingVerdict('{"reason":"missing"}')).toBeNull();
  expect(parseFindingVerdict("not json")).toBeNull();
});

test("verifyFinding：pass / reject / 坏回包 fail-open", async () => {
  const excerpt = excerptAroundLine("value.toString();", 1);
  const passed = await verifyFinding({ finding: FINDING, excerpt }, LLM, async () => ({
    ok: true,
    text: '{"pass":true,"reason":"line matches"}',
  }));
  expect(passed.status).toBe("pass");

  const rejected = await verifyFinding({ finding: FINDING, excerpt }, LLM, async () => ({
    ok: true,
    text: '{"pass":false,"reason":"already guarded"}',
  }));
  expect(rejected.status).toBe("reject");

  const uncertain = await verifyFinding({ finding: FINDING, excerpt }, LLM, async () => ({
    ok: true,
    text: '{"pass":false,"reason":"uncertain: excerpt missing call site"}',
  }));
  expect(uncertain.status).toBe("uncertain");

  const broken = await verifyFinding({ finding: FINDING, excerpt }, LLM, async () => ({
    ok: true,
    text: "not json",
  }));
  expect(broken.status).toBe("uncertain");
  expect(broken.rawReply).toBe("not json");

  const missing = await verifyFinding({ finding: FINDING, excerpt: null }, LLM, async () => ({
    ok: true,
    text: '{"pass":true,"reason":"x"}',
  }));
  expect(missing.status).toBe("uncertain");
});

test("verifyFinding：空回包触发一次有界重试，usage 累加", async () => {
  let calls = 0;
  const result = await verifyFinding({ finding: FINDING, excerpt: "1: x" }, LLM, async () => {
    calls += 1;
    return calls === 1
      ? { ok: true, text: "", usage: { inputTokens: 10, outputTokens: 5 } }
      : { ok: true, text: '{"pass":true,"reason":"ok"}', usage: { inputTokens: 20, outputTokens: 7 } };
  });
  expect(calls).toBe(2);
  expect(result.status).toBe("pass");
  expect(result.usage).toEqual({ inputTokens: 30, outputTokens: 12 });
});

test("verifyFinding：请求失败 fail-open", async () => {
  const result = await verifyFinding({ finding: FINDING, excerpt: "1: x" }, LLM, async () => {
    throw new Error("network");
  });
  expect(result.status).toBe("uncertain");
  expect(result.requestFailed).toBe(true);
});
