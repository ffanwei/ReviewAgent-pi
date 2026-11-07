#!/usr/bin/env node
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * CI 入口：对 `scenarios/` 下每个场景跑一次 `once`（单 worker，latency 按场景声明）。
 *
 * 刻意不并串、不重试、不吞退出码：一个场景失败就是这一轮失败（ADR-0048 决策 12）。
 * ramp 只用于本地探极限，不进 CI 门禁。
 */

const HERE = fileURLToPath(new URL(".", import.meta.url));
const RUN_SCRIPT = join(HERE, "run.mjs");
const SCENARIO_DIR = join(HERE, "scenarios");

const filter = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const scenarioFiles = readdirSync(SCENARIO_DIR)
  .filter((name) => name.endsWith(".json"))
  .sort();
const selected =
  filter.length === 0
    ? scenarioFiles
    : scenarioFiles.filter((name) => filter.some((needle) => name.includes(needle)));

if (selected.length === 0) {
  process.stderr.write(`test:replay: 没有匹配的场景（${filter.join(", ") || "all"}）\n`);
  process.exit(1);
}

const results = [];
for (const name of selected) {
  const scenarioPath = resolve(SCENARIO_DIR, name);
  process.stdout.write(`\n=== ${name} ===\n`);
  const run = spawnSync(process.execPath, [RUN_SCRIPT, "once", "--scenario", scenarioPath], {
    stdio: "inherit",
    env: process.env,
  });
  results.push({ name, status: run.status ?? 1, signal: run.signal });
}

const failed = results.filter((result) => result.status !== 0);
process.stdout.write("\n=== test:replay 汇总 ===\n");
for (const result of results) {
  process.stdout.write(
    `  ${result.status === 0 ? "PASS" : "FAIL"}  ${result.name}` +
      (result.signal === null ? "" : `（signal=${String(result.signal)}）`) +
      "\n",
  );
}
if (failed.length > 0) {
  process.stderr.write(`\ntest:replay: ${String(failed.length)} 个场景失败\n`);
  process.exitCode = 1;
}
