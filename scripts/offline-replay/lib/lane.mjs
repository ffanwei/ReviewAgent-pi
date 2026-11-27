import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { REPO_ROOT } from "./scenario.mjs";

/**
 * lane = 一个并发 worker 独占的回放上下文（ADR-0048 决策 7）：
 * 独立 cwd + 独立 --tasks-dir + 固定 taskId + 只读共享配置。
 *
 * 为什么必须两个都隔离：任务目录里 run.json / reviews_all.json /
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
    // 检视模型单源（ADR-0093 阶段 1）：回放场景的模型写进配置；`--model` 已废弃
    // 并忽略，继续用旗标会让请求体 model 与录制期分叉、trace 哈希整批失配。
    model: { default: scenario.model },
  };
  const limits = {
    // 回放按请求哈希命中同一 interaction（ADR-0048）：失败响应重放多次仍是
    // 同一失败，重试无收益且会放大请求计数。回放 lane 固定单次尝试（ADR-0051）。
    retry: {
      maxAttempts: 1,
      reviewTurnAttempts: 1,
      oneShotAttempts: 1,
      presentationAttempts: 1,
      smokeAttempts: 1,
      // 流中断重放（ADR-0077）：回放按请求哈希命中原样响应，重放会把同一失败
      // 再放一遍并放大请求计数 → 回放 lane 固定单次尝试（同 ADR-0051 决策 5）。
      streamAttempts: 1,
    },
  };
  if (scenario.split?.maxShardChars !== undefined) {
    limits.split = { maxShardChars: scenario.split.maxShardChars };
  }
  // 超时覆盖（大 MR 的报文生成单次输出可达 16k tokens）：产品缺省 300s 在慢
  // 网关下仍可能不够；录制期客户端一旦超时中断读取——代理侧照样收全响应并落盘，
  // 得到一条「录制时从未被接受」的 interaction，回放期按成功命中即与原跑分叉。
  // 场景显式放大一次性调用超时，让录制与回放走同一条成功路径。
  if (scenario.timeouts?.oneShotMs !== undefined) {
    limits.timeouts = { oneShotMs: scenario.timeouts.oneShotMs };
  }
  // 非 diff 区域过滤（ADR-0064 缺省开启）：回放场景的 expect 断言的是**冻结
  // 模型产物**的确定性重放，而 canned 语料的哨兵意见故意指向 diff 之外的文件
  // （`sample.txt` / `README.md`）、`large-mr` 的期望 findings 是录制期产物。
  // 两者都不是「产品范围策略」的被测面（该策略由 run/gate 的 vitest 覆盖），
  // 开着会让回放把哨兵意见全判 OUT_OF_SCOPE，断言与产品策略耦合。这里与
  // `bin.process.test.ts` 的进程面用例同口径：回放 lane 显式关闭。
  limits.findingScope = { enabled: false };
  // 阶段计划（ADR-0113）：compact 是产品缺省；冻结 trace 录制于哪一版就按哪一版回放。
  // 未声明时沿用产品缺省（compact），声明 off 的旧 trace 不会被默认值改动打穿。
  if (scenario.stageCompression !== undefined) {
    limits.loop = { stageCompression: scenario.stageCompression };
  }
  // 预过滤 glob（ADR-0069）同理：回放断言的是冻结产物，`large-mr` 的期望产物里
  // README.md 被真实检视并上报；回放 lane 必须显式固定为空数组，才能与 trace
  // 逐字节对齐（ADR-0092 已把 Markdown 从产品缺省里移出，这里仍按录制期配置快照固定）。
  limits.mrFilter = { excludeGlobs: [] };
  // 测试文件跳过（ADR-0092 已把缺省改为 false）：这些 trace 录制于缺省 true 时期，
  // Phase 5 提示与 diff 形状都按「测试文件已剔除」冻结。回放 lane 显式固定 true，
  // 否则请求字节与录制期分叉、哈希命中率归零。
  limits.testFiles = { skip: true };
  config.limits = limits;
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
  // 长路径下规则 Skill 缓存根会回落到 os.tmpdir()/rp-rule-skills/<runHash>
  // （pass-runner.ts 的 ruleSkillCacheRoot）。它不在 lane 下，且 hash 由本 lane
  // 的 runsRoot 决定；不归一化会让 skill 会话首条消息每次运行都不同。
  const runsRoot = join(tasksDir, TASK_ID);
  const fallbackHash = createHash("sha256").update(resolve(runsRoot)).digest("hex").slice(0, 12);
  server.addPathRoot?.(join(tmpdir(), "rp-rule-skills", fallbackHash), "<rule-skill-cache>");

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
