import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { summarizeCliFailure } from "./cli.mjs";

/**
 * 语义断言（ADR-0048 决策 11）：行为等价，不做逐字节比对。
 * 断言面 = 退出码 + findings 集合 + tips 有无/形状 + 审计阶段数/轮次 +
 * （reporting）MCP 工具序列与报文形状。
 */

const UNIFIED_TIP_KEYS = [
  "id",
  "code",
  "review",
  "suggestion",
  "category",
  "subcategory",
  "severity",
  "level",
  "ruleId",
  "lineNum",
  "source",
  "confidence",
];

const AGENT_REVIEW_TIP_KEYS = [
  "code",
  "review",
  "suggestion",
  "category",
  "subcategory",
  "level",
  "ruleId",
  "lineNum",
];

const AGENT_REVIEW_LEVELS = new Set(["Fatal", "Major", "Minor", "Suggestion"]);

export async function assertLane({ lane, scenario, run, mcpCalls }) {
  const problems = [];
  if (run.timedOut) {
    problems.push(`子进程超时（${String(scenario.timeoutMs)}ms）`);
  }
  if (run.status !== 0) {
    problems.push(`退出码 ${String(run.status)}；${summarizeCliFailure(run)}`);
  }

  const outcome = tryParse(run.stdout);
  if (outcome === undefined) {
    problems.push("stdout 不是单个 JSON 文档");
  } else if (!Array.isArray(outcome.findings)) {
    problems.push("stdout 缺少 findings 数组");
  }

  const runs = join(lane.taskDir, "runs");
  const reviews = await readJson(join(runs, "reviews_en.json"));
  if (reviews === undefined) {
    problems.push(`缺少 ${join(runs, "reviews_en.json")}`);
  } else {
    const actual = projectFindings(Array.isArray(reviews.findings) ? reviews.findings : []);
    const expected = projectFindings(scenario.expect.findings);
    if (canonical(actual) !== canonical(expected)) {
      problems.push(
        `findings 集合不符：\n  actual   = ${JSON.stringify(actual)}\n  expected = ${JSON.stringify(expected)}`,
      );
    }
    if (outcome !== undefined && Array.isArray(outcome.findings)) {
      const fromStdout = projectFindings(outcome.findings);
      if (canonical(fromStdout) !== canonical(actual)) {
        problems.push("stdout.findings 与 reviews_en.json 不一致");
      }
    }
  }

  problems.push(...(await assertTips(runs, scenario)));
  problems.push(...(await assertAudit(lane, scenario)));
  problems.push(...(await assertShards(lane, scenario)));
  problems.push(...(await assertRuleSkill(lane, scenario)));
  problems.push(...assertStderr(run, scenario));
  problems.push(...assertMcp(scenario, mcpCalls));

  if (problems.length > 0) {
    throw new Error(`lane ${lane.label}: ${problems.join("; ")}`);
  }
  return {
    findings: projectFindings(Array.isArray(reviews?.findings) ? reviews.findings : []),
  };
}

async function assertTips(runs, scenario) {
  const problems = [];
  const tipsPath = join(runs, "reviews_tips_zh.json");
  const exists = await fileExists(tipsPath);
  const expectation = scenario.expect.tips;
  if (expectation === "absent" && exists) {
    problems.push("本场景不应产 reviews_tips_zh.json，但文件存在");
    return problems;
  }
  if (expectation === "present" && !exists) {
    problems.push("本场景应产 reviews_tips_zh.json，但文件缺席");
    return problems;
  }
  if (!exists || expectation === "any") {
    return problems;
  }
  const doc = await readJson(tipsPath);
  if (!Array.isArray(doc)) {
    problems.push("reviews_tips_zh.json 不是数组");
    return problems;
  }
  const filePaths = doc.map((group) => String(group?.filePath ?? ""));
  if (scenario.expect.tipFilePaths.length > 0 && canonical(filePaths) !== canonical(scenario.expect.tipFilePaths)) {
    problems.push(
      `tips 文件组不符：actual=${JSON.stringify(filePaths)} expected=${JSON.stringify(scenario.expect.tipFilePaths)}`,
    );
  }
  const counts = doc.map((group) => (Array.isArray(group?.reviewTips) ? group.reviewTips.length : -1));
  if (scenario.expect.tipCounts.length > 0 && canonical(counts) !== canonical(scenario.expect.tipCounts)) {
    problems.push(
      `tips 条数不符：actual=${JSON.stringify(counts)} expected=${JSON.stringify(scenario.expect.tipCounts)}`,
    );
  }
  for (const [index, group] of doc.entries()) {
    for (const [tipIndex, tip] of (group?.reviewTips ?? []).entries()) {
      for (const key of UNIFIED_TIP_KEYS) {
        if (!(key in tip)) {
          problems.push(`tips[${String(index)}].reviewTips[${String(tipIndex)}] 缺少 12 键之一：${key}`);
        }
      }
      for (const key of ["id", "review", "suggestion", "category", "subcategory", "level", "source", "confidence"]) {
        if (typeof tip?.[key] !== "string") {
          problems.push(`tips[${String(index)}].reviewTips[${String(tipIndex)}].${key} 必须是字符串`);
        }
      }
      if (typeof tip?.lineNum !== "number") {
        problems.push(`tips[${String(index)}].reviewTips[${String(tipIndex)}].lineNum 必须是数字`);
      }
      if (typeof tip?.ruleId !== "string") {
        problems.push(`tips[${String(index)}].reviewTips[${String(tipIndex)}].ruleId 必须是字符串`);
      }
      if (typeof tip?.code !== "string" || typeof tip?.severity !== "string") {
        problems.push(`tips[${String(index)}].reviewTips[${String(tipIndex)}].code/severity 必须是字符串`);
      }
    }
  }
  return problems;
}

async function assertAudit(lane, scenario) {
  const problems = [];
  const auditDir = join(lane.taskDir, "audit");
  let entries;
  try {
    entries = (await readdir(auditDir)).filter((name) => name.endsWith(".json"));
  } catch {
    return [`缺少审计目录 ${auditDir}`];
  }
  if (entries.length !== 1) {
    return [`审计文件数应为 1，实际 ${String(entries.length)}（${entries.join(", ")}）`];
  }
  const audit = await readJson(join(auditDir, entries[0]));
  if (audit === undefined) {
    return [`审计文件不是合法 JSON：${entries[0]}`];
  }
  if (scenario.expect.phaseRecords !== undefined) {
    const actual = Array.isArray(audit.phaseLog) ? audit.phaseLog.length : -1;
    if (actual !== scenario.expect.phaseRecords) {
      problems.push(`phaseLog 条数：actual=${String(actual)} expected=${String(scenario.expect.phaseRecords)}`);
    }
  }
  if (scenario.expect.rounds !== undefined && audit.rounds !== scenario.expect.rounds) {
    problems.push(`rounds：actual=${String(audit.rounds)} expected=${String(scenario.expect.rounds)}`);
  }
  if (scenario.expect.shards !== undefined) {
    const actual = Array.isArray(audit.shards) ? audit.shards.map((entry) => Number(entry?.index)) : [];
    if (canonical(actual) !== canonical(scenario.expect.shards)) {
      problems.push(
        `审计 shards 索引不符：actual=${JSON.stringify(actual)} expected=${JSON.stringify(scenario.expect.shards)}`,
      );
    }
  }
  return problems;
}

/** run.json.shards[] + 片转录/片审计可寻址（ADR-0039） */
async function assertShards(lane, scenario) {
  const expected = scenario.expect.shards;
  if (expected === undefined) {
    return [];
  }
  const problems = [];
  const runs = join(lane.taskDir, "runs");
  const record = await readJson(join(runs, "run.json"));
  if (record === undefined) {
    return [`缺少 ${join(runs, "run.json")}`];
  }
  const shards = Array.isArray(record.shards) ? record.shards : [];
  const indexes = shards.map((entry) => Number(entry?.index));
  if (canonical(indexes) !== canonical(expected)) {
    problems.push(`run.json.shards 索引不符：actual=${JSON.stringify(indexes)} expected=${JSON.stringify(expected)}`);
  }
  for (const shard of shards) {
    const label = `片 ${String(shard?.index)}`;
    if (typeof shard?.transcriptFile !== "string" || !(await fileExists(join(runs, shard.transcriptFile)))) {
      problems.push(`${label} 缺少转录 ${String(shard?.transcriptFile)}`);
    }
    if (typeof shard?.auditFile !== "string" || !(await fileExists(join(lane.taskDir, "audit", shard.auditFile)))) {
      problems.push(`${label} 缺少审计 ${String(shard?.auditFile)}`);
    }
  }
  return problems;
}

/** 规则 Skill 的装载、会话、转录与缓存（ADR-0014 / ADR-0018） */
async function assertRuleSkill(lane, scenario) {
  const want = scenario.expect.ruleSkill;
  const wantLog = scenario.expect.skillPassLog;
  const wantTranscript = scenario.expect.skillTranscript;
  const wantCache = scenario.expect.ruleSkillCache;
  if (want === undefined && wantLog === undefined && wantTranscript === undefined && wantCache === undefined) {
    return [];
  }
  const problems = [];
  const audit = await readSingleAudit(lane);
  if (audit === undefined) {
    return ["缺少可读的审计文件（规则 Skill 断言无法展开）"];
  }
  const ruleSkills = Array.isArray(audit.ruleSkill) ? audit.ruleSkill : [];
  if (want !== undefined) {
    if (ruleSkills.length !== 1) {
      problems.push(`ruleSkill 条数应为 1，实际 ${String(ruleSkills.length)}`);
    }
    const entry = ruleSkills[0];
    if (entry === undefined) {
      problems.push("ruleSkill 为空");
    } else {
      if (entry.name !== want.name) {
        problems.push(`ruleSkill.name：actual=${String(entry.name)} expected=${String(want.name)}`);
      }
      if (want.kind !== undefined && entry.kind !== want.kind) {
        problems.push(`ruleSkill.kind：actual=${String(entry.kind)} expected=${String(want.kind)}`);
      }
      if (typeof entry.digest !== "string" || !/^[0-9a-f]{64}$/u.test(entry.digest)) {
        problems.push(`ruleSkill.digest 不是 64 位小写十六进制：${String(entry.digest)}`);
      }
    }
  }
  if (wantLog !== undefined) {
    const logs = Array.isArray(audit.skillPassLog) ? audit.skillPassLog : [];
    if (logs.length !== wantLog) {
      problems.push(`skillPassLog 条数：actual=${String(logs.length)} expected=${String(wantLog)}`);
    }
    for (const [index, entry] of logs.entries()) {
      if (typeof entry?.skill !== "string" || entry.skill === "") {
        problems.push(`skillPassLog[${String(index)}].skill 必须是字符串`);
      }
    }
  }
  if (wantTranscript !== undefined) {
    const files = await collectFiles(lane.taskDir);
    const suffix = `-skill-${wantTranscript}-r1.json`;
    const found = files.find((file) => file.replaceAll("\\", "/").endsWith(suffix));
    if (found === undefined) {
      problems.push(`缺少 skill 转录（*${suffix}）`);
    } else {
      const body = await readFile(found, "utf8");
      if (!body.includes("Host platform: ")) {
        problems.push("skill 转录缺少宿主机平台提示（Host platform:）");
      }
    }
  }
  if (wantCache === true) {
    const entry = ruleSkills[0];
    if (entry !== undefined && typeof entry.digest === "string") {
      const cacheDir = join(lane.taskDir, ".cache", "rule-skills", `dir-${entry.digest}`);
      for (const name of ["SKILL.md", ".rule-skill-ready"]) {
        if (!(await fileExists(join(cacheDir, name)))) {
          problems.push(`规则包缓存缺少 ${name}（${cacheDir}）`);
        }
      }
      if (!(await fileExists(join(cacheDir, "rules")))) {
        problems.push(`规则包缓存缺少 rules/ 目录（${cacheDir}）`);
      }
    } else {
      problems.push("规则包缓存断言需要 audit.ruleSkill[0].digest");
    }
  }
  return problems;
}

function assertStderr(run, scenario) {
  return scenario.expect.stderrContains
    .filter((needle) => !run.stderr.includes(needle))
    .map((needle) => `stderr 缺少片段：${JSON.stringify(needle)}`);
}

async function readSingleAudit(lane) {
  const auditDir = join(lane.taskDir, "audit");
  let entries;
  try {
    entries = (await readdir(auditDir)).filter((name) => name.endsWith(".json"));
  } catch {
    return undefined;
  }
  if (entries.length !== 1) {
    return undefined;
  }
  return readJson(join(auditDir, entries[0]));
}

async function collectFiles(root) {
  const output = [];
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return output;
  }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      output.push(...(await collectFiles(full)));
    } else if (entry.isFile()) {
      output.push(full);
    }
  }
  return output;
}

function assertMcp(scenario, mcpCalls) {
  const problems = [];
  const expected = scenario.expect.mcpCalls;
  if (scenario.mcp.mode === "off") {
    if (expected.length > 0) {
      problems.push("mcp.mode=off 却声明了 mcpCalls 期望");
    }
    return problems;
  }
  if (mcpCalls === undefined) {
    // 多 worker 时调用记录按到达序交错，无法再归属到 lane；聚合断言在
    // runWorkers 里按「单次期望 × workers」做（见 assertMcpAggregate）。
    return problems;
  }
  const names = mcpCalls.map((call) => call.name);
  if (canonical(names) !== canonical(expected)) {
    problems.push(
      `MCP tool 序列不符：actual=${JSON.stringify(names)} expected=${JSON.stringify(expected)}`,
    );
  }
  const reports = mcpCalls.filter((call) => call.name === "mrReviewResult");
  const filePaths = reports.map((call) => String(call.args?.filePath ?? ""));
  const tipCounts = reports.map((call) =>
    Array.isArray(call.args?.reviewTips) ? call.args.reviewTips.length : -1,
  );
  if (
    scenario.expect.mcpFilePathCounts.length > 0 &&
    canonical(filePaths) !== canonical(scenario.expect.mcpFilePathCounts)
  ) {
    problems.push(
      `mrReviewResult filePath 序列不符：actual=${JSON.stringify(filePaths)} expected=${JSON.stringify(scenario.expect.mcpFilePathCounts)}`,
    );
  }
  if (scenario.expect.mcpTipCounts.length > 0 && canonical(tipCounts) !== canonical(scenario.expect.mcpTipCounts)) {
    problems.push(
      `mrReviewResult tips 条数不符：actual=${JSON.stringify(tipCounts)} expected=${JSON.stringify(scenario.expect.mcpTipCounts)}`,
    );
  }
  validateReportTips(problems, reports);
  const startCalls = mcpCalls.filter((call) => call.name === "startTask");
  for (const call of startCalls) {
    if (call.args?.taskId !== "t-1") {
      problems.push(`startTask.taskId 应为 t-1，实际 ${String(call.args?.taskId)}`);
    }
  }
  return problems;
}

/**
 * 并发 ramp 的 MCP 断言只能做聚合：多个 worker 共享一个 MCP stub，调用记录
 * 按到达序交错，无法再按 worker 归属。逐 lane 的顺序契约由 `once`（单 worker）
 * 覆盖；ramp 只验证「每个工具总次数 = 单次期望 × workers」与报文形状。
 */
export function assertMcpAggregate(scenario, mcpCalls, workers) {
  const problems = [];
  if (scenario.mcp.mode !== "stub") {
    return scenario.expect.mcpCalls.length === 0 ? problems : ["mcp.mode=off 却声明了 mcpCalls 期望"];
  }
  const actualCounts = new Map();
  for (const call of mcpCalls) {
    actualCounts.set(call.name, (actualCounts.get(call.name) ?? 0) + 1);
  }
  const expectedCounts = new Map();
  for (const name of scenario.expect.mcpCalls) {
    expectedCounts.set(name, (expectedCounts.get(name) ?? 0) + 1);
  }
  for (const [name, perRun] of expectedCounts) {
    const actual = actualCounts.get(name) ?? 0;
    const expected = perRun * workers;
    if (actual !== expected) {
      problems.push(`${name} 次数：actual=${String(actual)} expected=${String(expected)}（${String(perRun)}×${String(workers)}）`);
    }
  }
  for (const [name, count] of actualCounts) {
    if (!expectedCounts.has(name)) {
      problems.push(`出现未预期的 MCP tool：${name}（${String(count)} 次）`);
    }
  }
  const reports = mcpCalls.filter((call) => call.name === "mrReviewResult");
  const byPath = new Map();
  for (const call of reports) {
    const filePath = String(call.args?.filePath ?? "");
    const entry = byPath.get(filePath) ?? { count: 0, tipCounts: [] };
    entry.count += 1;
    entry.tipCounts.push(Array.isArray(call.args?.reviewTips) ? call.args.reviewTips.length : -1);
    byPath.set(filePath, entry);
  }
  const expectedPaths = scenario.expect.mcpFilePathCounts;
  const expectedTips = scenario.expect.mcpTipCounts;
  for (const [index, filePath] of expectedPaths.entries()) {
    const entry = byPath.get(filePath);
    if (entry === undefined) {
      problems.push(`缺少 mrReviewResult 文件：${filePath}`);
      continue;
    }
    if (entry.count !== workers) {
      problems.push(`${filePath} 上报次数：actual=${String(entry.count)} expected=${String(workers)}`);
    }
    const expected = expectedTips[index];
    for (const count of entry.tipCounts) {
      if (count !== expected) {
        problems.push(`${filePath} tips 条数：actual=${String(count)} expected=${String(expected)}`);
      }
    }
  }
  for (const filePath of byPath.keys()) {
    if (!expectedPaths.includes(filePath)) {
      problems.push(`出现未预期的 mrReviewResult 文件：${filePath}`);
    }
  }
  validateReportTips(problems, reports);
  return problems;
}

function validateReportTips(problems, reports) {
  for (const [index, call] of reports.entries()) {
    if (call.args?.taskId !== "t-1") {
      problems.push(`mrReviewResult[${String(index)}].taskId 应为 t-1，实际 ${String(call.args?.taskId)}`);
    }
    for (const [tipIndex, tip] of (call.args?.reviewTips ?? []).entries()) {
      const label = `mrReviewResult[${String(index)}].reviewTips[${String(tipIndex)}]`;
      for (const key of AGENT_REVIEW_TIP_KEYS) {
        if (!(key in tip)) {
          problems.push(`${label} 缺少 8 字段之一：${key}`);
        }
      }
      if (!AGENT_REVIEW_LEVELS.has(tip?.level)) {
        problems.push(`${label}.level 不在四档枚举内：${String(tip?.level)}`);
      }
      if (typeof tip?.lineNum !== "string") {
        problems.push(`${label}.lineNum 必须是字符串`);
      }
      if (!(typeof tip?.ruleId === "string" || tip?.ruleId === null)) {
        problems.push(`${label}.ruleId 必须是 string|null`);
      }
      for (const key of ["code", "review", "suggestion", "category", "subcategory"]) {
        if (typeof tip?.[key] !== "string") {
          problems.push(`${label}.${key} 必须是字符串`);
        }
      }
    }
  }
}

export function projectFindings(list) {
  return list
    .map((finding) => ({
      file: String(finding?.file ?? ""),
      line: Number(finding?.line ?? 0),
      severity: String(finding?.severity ?? ""),
      title: String(finding?.title ?? ""),
      rule: String(finding?.rule ?? ""),
    }))
    .sort((left, right) => canonical(left).localeCompare(canonical(right)));
}

function canonical(value) {
  return JSON.stringify(value);
}

async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch {
    return undefined;
  }
}

async function fileExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

function tryParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}
