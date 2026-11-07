#!/usr/bin/env node
import { mkdir, rename, writeFile } from "node:fs/promises";
import { readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import os from "node:os";

import { assertLane, assertMcpAggregate } from "./lib/assert.mjs";
import { runCli } from "./lib/cli.mjs";
import { corpusReplies } from "./lib/corpora.mjs";
import { createLane } from "./lib/lane.mjs";
import { createResourceSampler } from "./lib/metrics.mjs";
import { startReplayServer } from "./lib/replay-server.mjs";
import {
  describeLatency,
  formatBytes,
  formatDuration,
  renderRampMarkdown,
  summarizeRuns,
} from "./lib/report.mjs";
import {
  REPO_ROOT,
  applyOverrides,
  loadScenario,
  validateLatencySafety,
} from "./lib/scenario.mjs";
import { buildTrace, extractSharedTools, loadTrace, saveTrace } from "./lib/trace.mjs";

const DEFAULT_STEPS = [1, 2, 4, 8, 16, 32];

async function main() {
  const subcommand = process.argv[2];
  const flags = parseFlags(process.argv.slice(3));
  switch (subcommand) {
    case "record":
      return record(flags);
    case "once":
      return once(flags);
    case "ramp":
      return ramp(flags);
    case "help":
    case "--help":
    case undefined:
      printUsage();
      return;
    default:
      throw new Error(`未知子命令 "${subcommand}"（可用：record / once / ramp）`);
  }
}

// ---------------------------------------------------------------- record

async function record(flags) {
  const scenario = applyOverrides(await loadScenario(requireScenario(flags)), flags);
  if (typeof scenario.corpus !== "string") {
    throw new Error("record 需要场景声明 corpus（one-finding / no-finding / reporting）");
  }
  const runDir = flags.runDir !== undefined ? resolve(flags.runDir) : defaultRunDir(scenario.id);
  await mkdir(runDir, { recursive: true });

  const server = await startReplayServer({
    mode: "record",
    corpus: corpusReplies(scenario.corpus),
    modelId: scenario.model,
    mcp: scenario.mcp,
  });
  let run;
  try {
    const lane = await createLane({ runDir, label: "record", scenario, server, index: 0 });
    run = await runCli({ lane, scenario, timeoutMs: scenario.timeoutMs });
    const mcpCalls = scenario.mcp.mode === "stub" ? server.mcpCalls() : undefined;
    await assertLane({ lane, scenario, run, mcpCalls });
  } finally {
    await server.close();
  }

  const trace = buildTrace({
    id: scenario.id,
    fixture: {
      repo: scenario.fixture.repoRelative,
      mrDiff: scenario.fixture.mrDiffRelative,
    },
    model: { id: scenario.model },
    tools: extractSharedTools(server.requestBodies.map((request) => request.body)),
    interactions: server.interactions,
  });
  const tracePath = flags.trace !== undefined ? resolve(flags.trace) : scenario.trace;
  const candidatePath = `${tracePath}.candidate.json`;
  await saveTrace(candidatePath, trace, {
    storeRequests: flags.storeRequests === true,
    requests: server.requestBodies,
  });

  if (flags.verify !== false) {
    await verifyTrace({ candidatePath, scenario, runDir });
  }

  await rename(candidatePath, tracePath);
  if (flags.storeRequests === true) {
    await rename(`${candidatePath.replace(/\.json$/u, ".requests.json")}`, `${tracePath.replace(/\.json$/u, ".requests.json")}`);
  }

  process.stdout.write(
    [
      `replay:record ${scenario.id}`,
      `  trace: ${relative(tracePath)}`,
      `  interactions: ${String(trace.interactions.length)}（review ${String(trace.interactions.filter((item) => item.kind === "review").length)} / oneshot ${String(trace.interactions.filter((item) => item.kind === "oneshot").length)}）`,
      `  tools: ${String(trace.tools.length)}`,
      `  run: exit=${String(run.status)} ${formatDuration(run.wallMs)}`,
      flags.verify === false
        ? "  已跳过回放自检（--no-verify）"
        : "  已通过回放自检（同一 trace 立即重放一次）",
      "",
    ].join("\n"),
  );
}

async function verifyTrace({ candidatePath, scenario, runDir }) {
  const trace = await loadTrace(candidatePath);
  const server = await startReplayServer({
    mode: "replay",
    trace,
    latency: { mode: "none" },
    mcp: scenario.mcp,
  });
  try {
    const lane = await createLane({ runDir, label: "verify", scenario, server, index: 0 });
    const run = await runCli({ lane, scenario, timeoutMs: scenario.timeoutMs });
    const mcpCalls = scenario.mcp.mode === "stub" ? server.mcpCalls() : undefined;
    await assertLane({ lane, scenario, run, mcpCalls });
    if (server.misses().length > 0) {
      throw new Error(`回放自检出现 ${String(server.misses().length)} 次未命中`);
    }
  } finally {
    await server.close();
  }
}

// ---------------------------------------------------------------- once

async function once(flags) {
  const scenario = applyOverrides(await loadScenario(requireScenario(flags)), flags);
  assertLatencySafety(scenario);
  const tracePath = flags.trace !== undefined ? resolve(flags.trace) : scenario.trace;
  const trace = await loadTrace(tracePath);
  const workers = flags.workers !== undefined ? parsePositiveInt(flags.workers, "--workers") : 1;
  const runDir = flags.runDir !== undefined ? resolve(flags.runDir) : defaultRunDir(scenario.id);
  await mkdir(runDir, { recursive: true });

  const server = await startReplayServer({
    mode: "replay",
    trace,
    latency: scenario.latency,
    mcp: scenario.mcp,
  });
  let group;
  try {
    group = await runWorkers({
      scenario,
      server,
      runDir,
      workers,
      label: "run",
      timeoutMs: scenario.timeoutMs,
    });
  } finally {
    await server.close();
  }

  const misses = server.misses();
  const pass = group.failures.length === 0 && misses.length === 0;
  const report = {
    scenario: scenario.id,
    trace: relative(tracePath),
    latency: scenario.latency,
    workers,
    outcomes: group.outcomes.map((outcome) => ({
      lane: outcome.lane.label,
      ok: outcome.ok,
      wallMs: outcome.run?.wallMs ?? null,
      status: outcome.run?.status ?? null,
      error: outcome.error,
    })),
    mcp: summarizeMcp(server.mcpCalls()),
    misses,
    resource: group.resource,
    pass,
  };
  await writeJson(join(runDir, "report.json"), report);

  const lines = [
    `replay:once ${scenario.id}`,
    `  trace: ${relative(tracePath)}（${String(trace.interactions.length)} interactions）`,
    `  latency: ${describeLatency(scenario.latency)}`,
    `  workers: ${String(workers)}`,
  ];
  for (const outcome of group.outcomes) {
    lines.push(
      outcome.ok
        ? `  ${outcome.lane.label}: ok  ${formatDuration(outcome.run.wallMs)}`
        : `  ${outcome.lane.label}: FAIL  ${outcome.error}`,
    );
  }
  lines.push(
    `  peak RSS: ${formatBytes(group.resource.peakRssBytes)}` +
      (group.resource.available ? "" : "（本环境不支持采样）"),
    `  产物: ${relative(join(runDir, "report.json"))}`,
    `  result: ${pass ? "PASS" : "FAIL"}`,
    "",
  );
  process.stdout.write(lines.join("\n"));
  if (!pass) {
    process.exitCode = 1;
  }
}

// ---------------------------------------------------------------- ramp

async function ramp(flags) {
  const scenario = applyOverrides(await loadScenario(requireScenario(flags)), flags);
  // ADR-0048 决策 8：ramp 缺省注入「用户视角」延迟；显式 --latency-mode /
  // --latency-ms 或场景自己声明 fixed 时以显式值为准。
  if (
    flags.latencyMode === undefined &&
    flags.latencyMs === undefined &&
    scenario.latency.mode === "none"
  ) {
    scenario.latency = { mode: "fixed", ms: 1500, jitter: 0.2, seed: 42 };
  }
  assertLatencySafety(scenario);
  const tracePath = flags.trace !== undefined ? resolve(flags.trace) : scenario.trace;
  const trace = await loadTrace(tracePath);
  const steps =
    flags.steps !== undefined
      ? parseSteps(flags.steps)
      : (scenario.ramp.steps ?? DEFAULT_STEPS);
  const warmup = flags.warmup !== undefined ? parsePositiveInt(flags.warmup, "--warmup") : 1;
  const measure = flags.measure !== undefined ? parsePositiveInt(flags.measure, "--measure") : 3;
  const runDir = flags.runDir !== undefined ? resolve(flags.runDir) : defaultRunDir(scenario.id);
  await mkdir(runDir, { recursive: true });

  const server = await startReplayServer({
    mode: "replay",
    trace,
    latency: scenario.latency,
    mcp: scenario.mcp,
  });
  const startedAt = Date.now();
  const stepsResult = [];
  const stop = { reason: "reached-max" };
  let limitWorkers = null;
  let baseline;
  let overheadBaseline;
  try {
    process.stdout.write(`replay:ramp ${scenario.id}\n  latency: ${describeLatency(scenario.latency)}\n  基线（1 worker × ${String(measure)}）……\n`);
    baseline = await runWorkers({
      scenario,
      server,
      runDir,
      workers: 1,
      label: "baseline",
      timeoutMs: scenario.timeoutMs,
      warmup: 1,
      measure,
    });
    if (baseline.failures.length > 0) {
      throw new Error(`单 run 基线失败（harness 不可用）：${baseline.failures[0]}`);
    }

    if (flags.overheadBaseline !== false && scenario.latency.mode === "fixed") {
      const overheadServer = await startReplayServer({
        mode: "replay",
        trace,
        latency: { mode: "none" },
        mcp: scenario.mcp,
      });
      try {
        overheadBaseline = await runWorkers({
          scenario,
          server: overheadServer,
          runDir,
          workers: 1,
          label: "baseline-nolatency",
          timeoutMs: scenario.timeoutMs,
          warmup: 1,
          measure,
        });
      } finally {
        await overheadServer.close();
      }
    }

    const singleRunCap = Math.max(60_000, (baseline.stats.medianMs ?? 0) * 3);
    const globalDeadline = startedAt + steps[steps.length - 1] * singleRunCap * 1.5;
    const baselineMedian = baseline.stats.medianMs ?? 0;
    const maxRssBytes =
      flags.maxRssMb !== undefined
        ? parsePositiveInt(flags.maxRssMb, "--max-rss-mb") * 1024 * 1024
        : os.totalmem() * 0.8;
    const maxHandles = flags.maxHandles !== undefined ? parsePositiveInt(flags.maxHandles, "--max-handles") : 20_000;

    for (const workers of steps) {
      if (Date.now() > globalDeadline) {
        stop.reason = "global-timeout";
        break;
      }
      process.stdout.write(`  workers=${String(workers)} …\n`);
      const group = await runWorkers({
        scenario,
        server,
        runDir,
        workers,
        label: `s${String(workers).padStart(2, "0")}`,
        timeoutMs: scenario.timeoutMs,
        warmup,
        measure,
      });
      const stats = group.stats;
      const step = {
        workers,
        stats,
        peakRssBytes: group.resource.peakRssBytes,
        peakHandles: group.resource.peakHandles,
        failures: group.failures,
        note: "",
      };
      stepsResult.push(step);

      if (stats.success < stats.total) {
        stop.reason = "failure";
        stop.atWorkers = workers;
        break;
      }
      if (baselineMedian > 0 && stats.p95Ms > baselineMedian * 2) {
        stop.reason = "p95";
        stop.atWorkers = workers;
        step.note = "p95 > 2× baseline";
        break;
      }
      if (group.resource.peakRssBytes !== null && group.resource.peakRssBytes > maxRssBytes) {
        stop.reason = "rss";
        stop.atWorkers = workers;
        step.note = "peak RSS 超阈值";
        break;
      }
      if (group.resource.peakHandles !== null && group.resource.peakHandles > maxHandles) {
        stop.reason = "handles";
        stop.atWorkers = workers;
        step.note = "句柄数超阈值";
        break;
      }
      limitWorkers = workers;
      if (workers === steps[steps.length - 1]) {
        stop.reason = "reached-max";
      }
    }
  } finally {
    await server.close();
  }

  const result = {
    scenario: scenario.id,
    trace: relative(tracePath),
    latency: scenario.latency,
    steps,
    warmup,
    measure,
    baseline,
    overheadBaseline,
    stepsResult,
    stop,
    limit: {
      workers: limitWorkers,
      reason:
        limitWorkers === null
          ? "第一档就未通过"
          : stop.reason === "reached-max"
            ? "测到配置上限且全部通过"
            : `在 workers=${String(stop.atWorkers ?? "?")} 处停止（${stop.reason}）`,
    },
    durationMs: Date.now() - startedAt,
    startedAt: new Date(startedAt).toISOString(),
  };

  // 报告层字段名对齐（renderRampMarkdown 读 steps / baseline）。
  const view = {
    ...result,
    steps: result.stepsResult,
    baseline: { stats: result.baseline.stats },
  };
  const markdown = renderRampMarkdown(view);
  await writeJson(join(runDir, "report.json"), result);
  await writeFile(join(runDir, "report.md"), markdown, "utf8");
  process.stdout.write(`\n${markdown}\n  产物: ${relative(runDir)}\n`);
}

// ---------------------------------------------------------------- workers

async function runWorkers({ scenario, server, runDir, workers, label, timeoutMs, warmup = 0, measure = 1 }) {
  const allOutcomes = [];
  const failures = [];
  const sampler = createResourceSampler();
  sampler.start();
  let resource;
  try {
    if (warmup > 0) {
      // 预热：跑一轮但不计入统计；失败直接算 step 失败（环境没热起来不能当测量值）
      const warm = await runBatch({ scenario, server, runDir, workers, label: `${label}-warmup`, timeoutMs, sampler });
      for (const outcome of warm.outcomes) {
        if (!outcome.ok) {
          failures.push(`warmup: ${outcome.error}`);
        }
      }
    }
    for (let iteration = 0; iteration < measure; iteration += 1) {
      const batch = await runBatch({
        scenario,
        server,
        runDir,
        workers,
        label: `${label}-m${String(iteration + 1).padStart(2, "0")}`,
        timeoutMs,
        sampler,
      });
      for (const outcome of batch.outcomes) {
        allOutcomes.push(outcome);
        if (!outcome.ok) {
          failures.push(`${outcome.lane.label}: ${outcome.error}`);
        }
      }
      if (scenario.mcp.mode === "stub" && workers > 1 && batch.mcpCalls.length > 0) {
        const problems = assertMcpAggregate(scenario, batch.mcpCalls, workers);
        if (problems.length > 0) {
          failures.push(`MCP 聚合断言：${problems.join("; ")}`);
        }
      }
    }
  } finally {
    resource = await sampler.stop();
  }
  return {
    outcomes: allOutcomes,
    failures,
    resource,
    stats: summarizeRuns(
      allOutcomes.map((outcome) => ({ ok: outcome.ok, wallMs: outcome.run?.wallMs ?? 0 })),
    ),
  };
}

async function runBatch({ scenario, server, runDir, workers, label, timeoutMs, sampler }) {
  const lanes = [];
  for (let index = 0; index < workers; index += 1) {
    lanes.push(
      await createLane({
        runDir,
        label: `${label}-w${String(index + 1).padStart(2, "0")}`,
        scenario,
        server,
        index,
      }),
    );
  }
  const mcpBefore = scenario.mcp.mode === "stub" ? server.mcpCalls().length : 0;
  const outcomes = await Promise.all(
    lanes.map(async (lane) => {
      let run;
      try {
        run = await runCli({
          lane,
          scenario,
          timeoutMs,
          onSpawn: (pid) => sampler.track(pid),
        });
        const mcpCalls =
          scenario.mcp.mode === "stub" && workers === 1
            ? server.mcpCalls().slice(mcpBefore)
            : undefined;
        await assertLane({ lane, scenario, run, mcpCalls });
        return { lane, run, ok: true };
      } catch (error) {
        return { lane, run, ok: false, error: String(error?.stack ?? error) };
      } finally {
        if (run?.pid !== undefined) {
          sampler.untrack(run.pid);
        }
      }
    }),
  );
  const mcpCalls = scenario.mcp.mode === "stub" ? server.mcpCalls().slice(mcpBefore) : [];
  return { outcomes, mcpCalls };
}

function summarizeMcp(calls) {
  const counts = {};
  for (const call of calls) {
    counts[call.name] = (counts[call.name] ?? 0) + 1;
  }
  return { total: calls.length, counts };
}

// ---------------------------------------------------------------- helpers

function requireScenario(flags) {
  if (flags.scenario === undefined) {
    throw new Error("缺少 --scenario（场景 id 或 JSON 路径）");
  }
  return flags.scenario;
}

function assertLatencySafety(scenario) {
  const problems = validateLatencySafety(scenario);
  if (problems.length > 0) {
    throw new Error(`模拟延迟超过安全阀，拒绝启动：\n  - ${problems.join("\n  - ")}`);
  }
}

function parseFlags(argv) {
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--") {
      continue;
    }
    if (!token.startsWith("--")) {
      throw new Error(`无法识别的参数 "${token}"（选项必须以 -- 开头）`);
    }
    const key = token.slice(2);
    if (key === "store-requests" || key === "no-verify" || key === "no-overhead-baseline") {
      flags[camel(key.replace(/^no-/u, ""))] = key.startsWith("no-") ? false : true;
      continue;
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`选项 --${key} 缺少值`);
    }
    index += 1;
    flags[camel(key)] = value;
  }
  return flags;
}

function camel(name) {
  return name.replace(/-([a-z])/gu, (_, letter) => letter.toUpperCase());
}

function parsePositiveInt(text, flag) {
  const value = Number(text);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${flag} 必须是正整数（收到 ${String(text)}）`);
  }
  return value;
}

function parseSteps(text) {
  const steps = text
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part !== "")
    .map((part) => parsePositiveInt(part, "--steps"));
  if (steps.length === 0) {
    throw new Error("--steps 不能为空");
  }
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index] <= steps[index - 1]) {
      throw new Error(`--steps 必须严格递增（${steps.join(",")}）`);
    }
  }
  return steps;
}

function defaultRunDir(scenarioId) {
  const stamp = new Date().toISOString().replace(/[:.]/gu, "-").replace("T", "_").slice(0, 19);
  return join(REPO_ROOT, "replay-runs", `${stamp}-${scenarioId}`);
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function relative(absolute) {
  const normalized = absolute.replaceAll("\\", "/");
  const root = REPO_ROOT.replaceAll("\\", "/");
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}

function printUsage() {
  process.stdout.write(
    [
      "离线回放工具（ADR-0048）",
      "",
      "用法：",
      "  node scripts/offline-replay/run.mjs record --scenario <id|path> [--trace <path>] [--store-requests] [--no-verify]",
      "  node scripts/offline-replay/run.mjs once   --scenario <id|path> [--workers N] [--latency-ms N] [--latency-mode none|fixed] [--run-dir <dir>]",
      "  node scripts/offline-replay/run.mjs ramp   --scenario <id|path> [--steps 1,5,10,20,30] [--warmup N] [--measure N] [--latency-mode none|fixed] [--latency-ms N] [--latency-jitter R] [--seed N]",
      "  node scripts/offline-replay/run.mjs help",
      "",
      "ramp 缺省延迟：fixed 1500ms、jitter 0.2、seed 42（场景声明 fixed 时用场景值；--latency-mode none 关掉）。",
      "",
      "场景 id：" + listScenarioIds().join(" / "),
      "",
    ].join("\n"),
  );
}

function listScenarioIds() {
  try {
    return readdirSync(join(REPO_ROOT, "scripts/offline-replay/scenarios"))
      .filter((name) => name.endsWith(".json"))
      .map((name) => name.slice(0, -5));
  } catch {
    return [];
  }
}

main().catch((error) => {
  process.stderr.write(`replay: ${error?.message ?? String(error)}\n`);
  process.exitCode = 1;
});
