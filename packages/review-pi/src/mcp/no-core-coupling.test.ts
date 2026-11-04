import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { expect, test } from "vitest";

// ADR-0037 验收标准 11：核心零耦合。`src/mcp/**` 只允许被 `cli/` 引用——
// 库使用者与内核测试默认不付任何上报代价。

const SRC_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CORE_DIRS = [
  "audit",
  "contracts",
  "experiment",
  "export",
  "knowledge",
  "loop",
  "provider",
  "run",
  "shared",
  "tools",
  "zonea",
  "zoneb",
] as const;

function listTsFiles(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...listTsFiles(full));
      continue;
    }
    if (entry.endsWith(".ts")) {
      files.push(full);
    }
  }
  return files;
}

test("核心包（loop/run/contracts/tools/shared/…）不 import src/mcp/**", () => {
  const offenders: string[] = [];
  for (const dir of CORE_DIRS) {
    for (const file of listTsFiles(path.join(SRC_ROOT, dir))) {
      const text = readFileSync(file, "utf8");
      // 只匹配真正的路径段 `/mcp/`（`contracts/mcp-report.js` 不算）
      if (/["'][^"']*\/mcp\/[^"']*["']/.test(text)) {
        offenders.push(path.relative(SRC_ROOT, file));
      }
    }
  }
  expect(offenders).toEqual([]);
});

test("组装点只有 CLI：cli/main.ts 引用 mcp 出口", () => {
  const main = readFileSync(path.join(SRC_ROOT, "cli", "main.ts"), "utf8");
  expect(main).toContain('from "../mcp/index.js"');
});
