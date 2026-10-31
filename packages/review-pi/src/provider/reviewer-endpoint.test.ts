import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import { loadConfig } from "../shared/config.js";
import { resolveReviewerEndpoint } from "./reviewer-endpoint.js";

// 网关接入点（ADR-0025）：唯一来源是用户级配置快照；env 层已彻底关闭。
// 期望值来自独立真源：配置层校验/归一（baseUrl 协议 + 尾斜杠）与缺 key 的人话。
//
// 纪律：错误信息绝不包含 key 值（哨兵 key 断言）；baseUrl 是接入点
// 不是秘密，可出现在诊断里。

const tempDirs: string[] = [];

function configOf(text: string) {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-endpoint-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, "PiAgent.json");
  writeFileSync(filePath, text, "utf8");
  return loadConfig({ configPath: filePath }).config;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("配置驱动：baseUrl 尾斜杠归一，不追加 /chat/completions（pi SDK 自行拼路径）", () => {
  const endpoint = resolveReviewerEndpoint(
    configOf(
      '{"version":1,"reviewer":{"apiKey":"sk-reviewer","baseUrl":"https://gw.example.com/v1/"}}',
    ),
  );
  expect(endpoint.baseUrl).toBe("https://gw.example.com/v1");
  expect(endpoint.apiKey).toBe("sk-reviewer");
});

test("baseUrl 缺席 → 官方缺省接入点", () => {
  const endpoint = resolveReviewerEndpoint(
    configOf('{"version":1,"reviewer":{"apiKey":"sk-reviewer"}}'),
  );
  expect(endpoint.baseUrl).toBe("https://api.deepseek.com");
});

test("key 缺失 → fail fast：点名配置键并指向 config init，绝不回显 key 值", () => {
  const config = configOf('{"version":1}');
  let message = "";
  try {
    resolveReviewerEndpoint(config);
  } catch (error) {
    message = error instanceof Error ? error.message : String(error);
  }
  expect(message).toContain("reviewer.apiKey");
  expect(message).toContain("config init");
  expect(message).not.toContain("sk-");
});
