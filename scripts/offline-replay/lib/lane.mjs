import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { REPO_ROOT } from "./scenario.mjs";

/**
 * lane = 一个并发 worker 独占的回放上下文（ADR-0048 决策 7）：
 * 独立 cwd + 独立 --tasks-dir + 固定 taskId + 只读共享配置。
 *
 * 为什么必须两个都隔离：任务目录里 run.json / reviews_en.json /
 * reviews_tips_zh.json 是固定名，rule-skill 缓存解压无锁；cwd 里
 * .review-pi-session.json 与 review-result.json 是 last-writer-wins。
 */

export const TASK_ID = "t-1";

export async function createLane({ runDir, label, scenario, server, index }) {
  const laneDir = join(runDir, "workers", label);
  const cwd = join(laneDir, "cwd");
  const home = join(laneDir, "home");
  const tasksDir = join(laneDir, "tasks");
  await Promise.all([
    mkdir(cwd, { recursive: true }),
    mkdir(home, { recursive: true }),
    mkdir(tasksDir, { recursive: true }),
  ]);

  const config = {
    version: 1,
    reviewer: {
      apiKey: "offline-replay",
      baseUrl: server.baseUrl,
    },
  };
  if (scenario.split?.maxShardChars !== undefined) {
    config.limits = { split: { maxShardChars: scenario.split.maxShardChars } };
  }
  if (scenario.mcp.mode === "stub") {
    config.mcp = {
      servers: {
        local: {
          transport: "http",
          url: server.mcpUrl,
          headers: {},
          timeoutMs: scenario.mcp.timeoutMs,
        },
      },
      report: {
        server: "local",
        ...(scenario.mcp.eventTool !== undefined ? { tool: scenario.mcp.eventTool } : {}),
      },
    };
  }
  const configPath = join(laneDir, "config.json");
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");

  // 运行期目录归一化（ADR-0049）：规则 Skill 会话的 location 会带 lane 绝对
  // 路径；同一 trace 在不同 lane / 不同运行重放时只有归一化后指纹才稳定。
  server.addPathRoot?.(laneDir, "<lane>");

  return {
    index,
    label,
    dir: laneDir,
    cwd,
    home,
    tasksDir,
    configPath,
    taskDir: join(tasksDir, TASK_ID),
  };
}

export function reviewArgs(lane, scenario) {
  const args = [
    "review",
    "--repo",
    scenario.fixture.repo,
    "--mr-diff",
    scenario.fixture.mrDiff,
    "--taskId",
    TASK_ID,
    "--tasks-dir",
    lane.tasksDir,
    "--config",
    lane.configPath,
    "--model",
    scenario.model,
    "--no-progress",
  ];
  for (const skillDir of scenario.ruleSkills ?? []) {
    args.push("--rule-skill", skillDir);
  }
  if (scenario.strictRuleSkill === true) {
    args.push("--strict-rule-skill");
  }
  return args;
}

export function laneEnv(lane, extra = {}) {
  const env = { ...process.env, ...extra };
  // 子进程沙箱 home：绝不读真实 ~/.PiAgent/PiAgent.jsonc（ADR-0025）。
  env.HOME = lane.home;
  env.USERPROFILE = lane.home;
  // 本地回环不应经过系统代理。
  for (const key of [
    "http_proxy",
    "https_proxy",
    "HTTP_PROXY",
    "HTTPS_PROXY",
    "ALL_PROXY",
    "all_proxy",
  ]) {
    delete env[key];
  }
  env.NO_PROXY = "127.0.0.1,localhost";
  env.no_proxy = env.NO_PROXY;
  env.NO_COLOR = "1";
  return env;
}

export function relativeToRepo(absolute) {
  const normalized = absolute.replaceAll("\\", "/");
  const root = REPO_ROOT.replaceAll("\\", "/");
  return normalized.startsWith(`${root}/`) ? normalized.slice(root.length + 1) : normalized;
}
