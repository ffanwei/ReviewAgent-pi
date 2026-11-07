import { readFile } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 场景 = 一次回放/录制的声明式描述（ADR-0048 决策 1）。
 * 路径一律相对仓库根；命令行只做覆盖（--latency-ms / --steps / --workers）。
 */

export const REPO_ROOT = resolve(fileURLToPath(new URL(".", import.meta.url)), "../../..");
const SCENARIO_DIR = resolve(REPO_ROOT, "scripts/offline-replay/scenarios");

const SUPPORTED_SCHEMA = 1;

export async function loadScenario(reference) {
  const path = resolveScenarioPath(reference);
  let raw;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    throw new Error(`读不到场景：${path}（${error.message}）`);
  }
  let scenario;
  try {
    scenario = JSON.parse(raw);
  } catch (error) {
    throw new Error(`场景不是合法 JSON：${path}（${error.message}）`);
  }
  return normalizeScenario(scenario, path);
}

export function resolveScenarioPath(reference) {
  if (reference.endsWith(".json") || reference.includes("/") || reference.includes(sep)) {
    return resolve(REPO_ROOT, reference);
  }
  return resolve(SCENARIO_DIR, `${reference}.json`);
}

export function normalizeScenario(input, source = "scenario") {
  if (input?.schemaVersion !== SUPPORTED_SCHEMA) {
    throw new Error(`${source}: schemaVersion 必须是 ${String(SUPPORTED_SCHEMA)}`);
  }
  if (typeof input.id !== "string" || input.id.trim() === "") {
    throw new Error(`${source}: 缺少 id`);
  }
  const fixture = input.fixture ?? {};
  if (typeof fixture.repo !== "string" || typeof fixture.mrDiff !== "string") {
    throw new Error(`${source}: fixture.repo / fixture.mrDiff 必填`);
  }
  if (typeof input.trace !== "string" || input.trace.trim() === "") {
    throw new Error(`${source}: 缺少 trace 路径`);
  }
  if (typeof input.model !== "string" || input.model.trim() === "") {
    throw new Error(`${source}: 缺少 model`);
  }

  const mcp = input.mcp ?? { mode: "off" };
  if (mcp.mode !== "off" && mcp.mode !== "stub") {
    throw new Error(`${source}: mcp.mode 必须是 off / stub`);
  }

  const latency = input.latency ?? { mode: "none" };
  if (latency.mode !== "none" && latency.mode !== "fixed") {
    throw new Error(`${source}: latency.mode 必须是 none / fixed`);
  }

  const expect = input.expect ?? {};
  return {
    schemaVersion: SUPPORTED_SCHEMA,
    id: input.id,
    source,
    trace: resolve(REPO_ROOT, input.trace),
    traceRelative: input.trace,
    fixture: {
      repo: resolve(REPO_ROOT, fixture.repo),
      mrDiff: resolve(REPO_ROOT, fixture.mrDiff),
      repoRelative: fixture.repo,
      mrDiffRelative: fixture.mrDiff,
    },
    model: input.model,
    corpus: input.corpus,
    mcp: {
      mode: mcp.mode,
      latencyMs: mcp.latencyMs ?? 0,
      failTools: mcp.failTools ?? [],
      eventTool: mcp.eventTool,
      timeoutMs: mcp.timeoutMs ?? 10_000,
    },
    latency: {
      mode: latency.mode,
      ms: latency.ms ?? 0,
      jitter: latency.jitter ?? 0,
      seed: latency.seed ?? 42,
    },
    timeoutMs: input.timeoutMs ?? 120_000,
    ramp: {
      steps:
        input.ramp?.steps === undefined
          ? undefined
          : normalizeSteps(input.ramp.steps, `${source}: ramp.steps`),
    },
    expect: {
      findings: expect.findings ?? [],
      phaseRecords: expect.phaseRecords,
      rounds: expect.rounds,
      tips: expect.tips ?? "any",
      tipFilePaths: expect.tipFilePaths ?? [],
      tipCounts: expect.tipCounts ?? [],
      mcpCalls: expect.mcpCalls ?? [],
      mcpFilePathCounts: expect.mcpFilePathCounts ?? [],
      mcpTipCounts: expect.mcpTipCounts ?? [],
    },
  };
}

function normalizeSteps(value, source) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${source} 必须是非空数组`);
  }
  const steps = value.map((item) => {
    if (!Number.isInteger(item) || item <= 0) {
      throw new Error(`${source} 的档位必须是正整数（收到 ${String(item)}）`);
    }
    return item;
  });
  for (let index = 1; index < steps.length; index += 1) {
    if (steps[index] <= steps[index - 1]) {
      throw new Error(`${source} 必须严格递增（${steps.join(",")}）`);
    }
  }
  return steps;
}

export function applyOverrides(scenario, flags) {
  const next = structuredClone(scenario);
  if (flags.latencyMode !== undefined) {
    next.latency.mode = flags.latencyMode;
  }
  if (flags.latencyMs !== undefined) {
    next.latency.ms = flags.latencyMs;
    if (next.latency.mode === "none") {
      next.latency.mode = "fixed";
    }
  }
  if (flags.latencyJitter !== undefined) {
    next.latency.jitter = flags.latencyJitter;
  }
  if (flags.seed !== undefined) {
    next.latency.seed = flags.seed;
  }
  if (flags.model !== undefined) {
    next.model = flags.model;
  }
  if (flags.timeoutMs !== undefined) {
    next.timeoutMs = flags.timeoutMs;
  }
  if (flags.mcp === "off" || flags.mcp === "stub") {
    next.mcp.mode = flags.mcp;
  }
  return next;
}

/**
 * 模拟延迟安全阀（ADR-0048 决策 10）：超过对应产品超时 50% 直接拒绝启动。
 * 返回违反项数组；空数组 = 通过。
 */
export function validateLatencySafety(scenario) {
  const problems = [];
  const { mode, ms, jitter } = scenario.latency;
  if (mode !== "fixed" || ms <= 0) {
    return problems;
  }
  const worst = ms * (1 + Math.max(0, jitter));
  const limits = [
    { name: "检视回合", limitMs: 60_000 },
    { name: "一次性模型调用（报文/总结）", limitMs: 90_000 },
  ];
  for (const item of limits) {
    const ceiling = item.limitMs / 2;
    if (worst >= ceiling) {
      problems.push(
        `${item.name}：latency ${String(ms)}ms（含抖动最高 ${String(Math.round(worst))}ms）` +
          ` ≥ 产品超时 ${String(item.limitMs)}ms 的 50%（${String(ceiling)}ms）`,
      );
    }
  }
  if (scenario.mcp.mode === "stub" && scenario.mcp.latencyMs > 0) {
    const mcpCeiling = scenario.mcp.timeoutMs / 2;
    if (scenario.mcp.latencyMs >= mcpCeiling) {
      problems.push(
        `MCP stub：latency ${String(scenario.mcp.latencyMs)}ms ≥ mcp timeout ${String(scenario.mcp.timeoutMs)}ms 的 50%`,
      );
    }
  }
  return problems;
}
