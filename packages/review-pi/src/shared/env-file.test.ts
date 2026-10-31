import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { parseEnvFile } from "./env-file.js";

// `config init --from-env` 的纯解析器（ADR-0025）：只读文件、不写
// `process.env`——env 层已彻底关闭，此函数是唯一的「一次性迁移输入」。
//
// 密钥纪律：解析结果的值只在内存里交给迁移映射；坏行只留行号，绝不回显原文。

const tempDirs: string[] = [];

function envFile(content: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-env-"));
  tempDirs.push(dir);
  const filePath = path.join(dir, ".env.local");
  writeFileSync(filePath, content, "utf8");
  return filePath;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("缺失文件 → exists:false，空结果不报错", () => {
  const result = parseEnvFile(path.join(tmpdir(), "no-such-dir", ".env.local"));
  expect(result.exists).toBe(false);
  expect(result.values.size).toBe(0);
  expect(result.malformedLines).toEqual([]);
});

test("KEY=VALUE 解析；首个 = 分割（值中 = 保留），两侧空白剥离", () => {
  const result = parseEnvFile(
    envFile("REVIEWER_URL=https://gw.example.com/v1\nREVIEWER_API_KEY=abc=def==\n"),
  );
  expect([...result.values.keys()]).toEqual(["REVIEWER_URL", "REVIEWER_API_KEY"]);
  expect(result.values.get("REVIEWER_URL")).toBe("https://gw.example.com/v1");
  expect(result.values.get("REVIEWER_API_KEY")).toBe("abc=def==");
});

test("空行与 # 注释行跳过；行内 # 是值的一部分（不解析）", () => {
  const result = parseEnvFile(
    envFile("# REVIEWER_API_KEY=sk-secret\n\nREVIEWER_URL=https://gw/v1#fragment\n"),
  );
  expect([...result.values.keys()]).toEqual(["REVIEWER_URL"]);
  expect(result.values.get("REVIEWER_URL")).toBe("https://gw/v1#fragment");
  expect(result.values.has("REVIEWER_API_KEY")).toBe(false);
});

test("成对引号剥离（单/双），不成对原样保留；BOM 与 CRLF 安全", () => {
  const content =
    "\uFEFFREVIEWER_URL=\"https://gw.example.com/v1\"\r\nREVIEWER_API_KEY='sk-quoted'\r\nNOTE=unclosed\"quote\r\n";
  const result = parseEnvFile(envFile(content));
  expect(result.values.get("REVIEWER_URL")).toBe("https://gw.example.com/v1");
  expect(result.values.get("REVIEWER_API_KEY")).toBe("sk-quoted");
  expect(result.values.get("NOTE")).toBe("unclosed\"quote");
});

test("空值行保留为空串（迁移期可区分「写了但为空」与「没写」）", () => {
  const result = parseEnvFile(envFile("REVIEWER_API_KEY=\nREVIEWER_URL=https://gw/v1\n"));
  expect(result.values.get("REVIEWER_API_KEY")).toBe("");
  expect(result.values.has("REVIEWER_URL")).toBe(true);
});

test("同名键首次出现胜出（与旧装载器「已设置有值则不覆盖」口径一致）", () => {
  const result = parseEnvFile(envFile("REVIEWER_API_KEY=first\nREVIEWER_API_KEY=second\n"));
  expect(result.values.get("REVIEWER_API_KEY")).toBe("first");
});

test("坏行留痕只报行号，绝不回显原文（裸贴 key 场景）", () => {
  const result = parseEnvFile(envFile("REVIEWER_API_KEY sk-bare-pasted-secret\nKEY = spaced\n"));
  expect(result.malformedLines).toEqual(["line 1", "line 2"]);
  expect(JSON.stringify(result)).not.toContain("sk-bare-pasted-secret");
  expect(result.values.size).toBe(0);
});
