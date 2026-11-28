import { describe, expect, test } from "vitest";
import type { FetchFunction } from "@earendil-works/pi-ai";

import type { RetryPolicy } from "../shared/llm-retry.js";
import {
  judgeFileVerdicts,
  VERDICT_BATCH_ENTRIES,
  type VerdictCandidate,
  type VerdictFileBatch,
} from "./history-verdict.js";
import {
  parseHistoryTipsDocument,
  type HistoryTipEntry,
  type LlmCandidateSignal,
} from "./history-tips.js";

const NO_WAIT: RetryPolicy = {
  maxAttempts: 1,
  baseDelayMs: 0,
  maxDelayMs: 0,
  maxRetryAfterMs: 0,
};

const LIMITS = { statuses: ["PENDING"], semanticVerdict: { enabled: true } } as const;

function completion(content: string): Response {
  return new Response(JSON.stringify({ choices: [{ message: { role: "assistant", content } }] }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function llm(fetch: FetchFunction) {
  return {
    baseUrl: "https://gw.example.com/v1",
    apiKey: "sk-verdict-sentinel",
    modelId: "deepseek-v4-flash",
    timeoutMs: 5_000,
    retry: NO_WAIT,
    fetch,
  };
}

function entry(overrides: Record<string, unknown> = {}): HistoryTipEntry {
  const parsed = parseHistoryTipsDocument(
    JSON.stringify([
      {
        id: "12",
        status: "PENDING",
        filePath: "src/a.ts",
        lineNum: 3,
        patchLine: 'const sql = "SELECT * FROM users WHERE id = " + userName;',
        reviewMsg: "SQL 拼接注入风险",
        ...overrides,
      },
    ]),
    LIMITS,
  );
  return parsed?.entries[0] as HistoryTipEntry;
}

function candidate(
  entryValue: HistoryTipEntry,
  signal: LlmCandidateSignal,
): VerdictCandidate {
  return { entry: entryValue, signal };
}

function batch(overrides: Partial<VerdictFileBatch> = {}): VerdictFileBatch {
  return {
    filePath: "src/a.ts",
    fileLines: [
      "import httpx",
      "const port = cfg.port",
      'const sql = "SELECT * FROM users WHERE id = " + userId;',
      "logger.info(sql)",
      "}",
    ],
    candidates: [
      candidate(entry(), {
        anchor: "gone",
        anchorLine: undefined,
        pair: { kind: "none" },
      }),
    ],
    findings: [
      { id: "F001", line: 3, title: "SQL 拼接注入风险", reviewText: "[缺陷类型] 注入。影响评估：高危。" },
    ],
    ...overrides,
  };
}

describe("judgeFileVerdicts：裁决契约与降级", () => {
  test("合法 verdicts 逐条返回；duplicate 携带 matchedFindingId", async () => {
    const fetch: FetchFunction = async () =>
      completion(
        JSON.stringify({
          verdicts: [
            { tipsId: 12, verdict: "fixed", matchedFindingId: null, note: "已参数化" },
          ],
        }),
      );
    const outcome = await judgeFileVerdicts({ llm: llm(fetch), batch: batch() });
    expect(outcome.failed).toBe(false);
    expect(outcome.outcomes).toEqual([
      { tipsId: 12, verdict: "fixed", note: "已参数化" },
    ]);
    expect(outcome.attempts).toBe(1);
  });

  test("duplicate 必须带合法 matchedFindingId，否则整批解析失败 → fail-open", async () => {
    const fetch: FetchFunction = async () =>
      completion(
        JSON.stringify({
          verdicts: [
            { tipsId: 12, verdict: "duplicate", matchedFindingId: "F999", note: "" },
          ],
        }),
      );
    const outcome = await judgeFileVerdicts({ llm: llm(fetch), batch: batch() });
    // 解析失败 → invokeStructured 修复重发一次，仍是坏回包 → 整批 failed
    expect(outcome.failed).toBe(true);
    expect(outcome.outcomes).toEqual([]);
    expect(outcome.attempts).toBe(2);
  });

  test("幻觉条目（候选外 tipsId）忽略；非法 verdict 值触发解析失败", async () => {
    const fetch: FetchFunction = async () =>
      completion(
        JSON.stringify({
          verdicts: [
            { tipsId: 999, verdict: "fixed", matchedFindingId: null, note: "" },
            { tipsId: 12, verdict: "maybe", matchedFindingId: null, note: "" },
          ],
        }),
      );
    const outcome = await judgeFileVerdicts({ llm: llm(fetch), batch: batch() });
    expect(outcome.failed).toBe(true);
  });

  test("回包不是 JSON：修复重发后仍失败 → failed（该批保守保留由编排层处理）", async () => {
    let calls = 0;
    const fetch: FetchFunction = async () => {
      calls += 1;
      return completion("这不是 JSON");
    };
    const outcome = await judgeFileVerdicts({ llm: llm(fetch), batch: batch() });
    expect(outcome.failed).toBe(true);
    expect(calls).toBe(2);
    expect(outcome.attempts).toBe(2);
  });

  test("条目超上限拆批：每条都判（无预算跳过），结果合并", async () => {
    const entries: HistoryTipEntry[] = [];
    for (let index = 0; index < VERDICT_BATCH_ENTRIES + 5; index += 1) {
      entries.push(entry({ id: String(index + 1), reviewMsg: `意见 ${String(index)}` }));
    }
    const candidates = entries.map((entryValue) =>
      candidate(entryValue, { anchor: "gone", anchorLine: undefined, pair: { kind: "none" } }),
    );
    const fetch: FetchFunction = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: { content?: string }[];
      };
      const user = body.messages?.[1]?.content ?? "";
      const ids = [...user.matchAll(/tipsId (\d+)/g)].map((match) => Number(match[1]));
      return completion(
        JSON.stringify({
          verdicts: ids.map((tipsId) => ({
            tipsId,
            verdict: "persist",
            matchedFindingId: null,
            note: "",
          })),
        }),
      );
    };
    const outcome = await judgeFileVerdicts({
      llm: llm(fetch),
      batch: batch({ candidates }),
    });
    expect(outcome.failed).toBe(false);
    expect(outcome.outcomes).toHaveLength(VERDICT_BATCH_ENTRIES + 5);
  });
});

describe("提示词装配（窗口与上下文）", () => {
  test("小文件整读：prompt 含整文件与行号；含历史意见与本次意见", async () => {
    let seenUser = "";
    const fetch: FetchFunction = async (_url, init) => {
      const body = JSON.parse(String(init?.body ?? "{}")) as {
        messages?: { content?: string }[];
      };
      seenUser = body.messages?.[1]?.content ?? "";
      return completion(
        JSON.stringify({
          verdicts: [{ tipsId: 12, verdict: "persist", matchedFindingId: null, note: "" }],
        }),
      );
    };
    await judgeFileVerdicts({ llm: llm(fetch), batch: batch() });
    expect(seenUser).toContain("（整文件）");
    expect(seenUser).toContain("tipsId 12");
    expect(seenUser).toContain("F001");
    expect(seenUser).toContain("行已不存在");
  });
});
