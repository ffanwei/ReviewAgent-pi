import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { checkRuntimeArtifacts } from "../../bin/lib/cli-runtime.js";
import { sseBody, type FakeReply } from "../provider/fake-fetch.js";
import { REVIEW_MODEL_ID } from "../provider/pi-client.js";
import { REVIEW_PI_VERSION } from "../shared/version.js";
import { KERNEL_PACKAGES } from "./version-command.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";

// #7 P3b 进程级烟测：spawn 真 bin（bin/review-pi.js → spawn dist/cli/main.js），
// loopback stub 服务器在真 HTTP 传输层上回放 fake 适配器同款 wire——SSE 渲染
// 单源 sseBody（stub 与 fake 适配器逐字节同格式）。这是真适配器路径的唯一
// 离线覆盖：真 OpenAI SDK 序列化 + globalThis.fetch + 真套接字 + 真进程边界。
//
// 哨兵纪律（票面验收）：key 只允许出现在 Authorization 头（stub 侧断言已
// 收到 Bearer <sentinel>）；绝不出现在 stdout/stderr/审计/运行记录（进程
// 输出面与 --tasks-dir 落盘面全量扫描）。.env.local 装载摘要只报键名（单测面
// 已锁），本档再证一层：显式环境变量胜过 .env.local（诱饵值不进传输层）。
//
// 退出码契约：成功（含诚实截断）0 / 其余 1；拒跑 1 + 人话提示。

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const BIN_PATH = path.join(packageDir, "bin", "review-pi.js");

/** 哨兵 key：只该进 Authorization 头；出现在任何输出/落盘面即失败 */
const SENTINEL_KEY = "sk-process-smoke-sentinel-7f31";
/** .env.local 诱饵（显式环境变量必须胜出——诱饵值连传输层都不该到） */
const DECOY_KEY = "sk-decoy-from-env-local";
/**
 * 进程测试统一的任务 id（ADR-0033）：产物落 `<tasks-dir>/t-1/`。
 * 刻意与 caseId 不同源——caseId 仍由 MR 文件名派生（VUL4J-1 / MR-1234）。
 */
const CLI_TASK_ID = "t-1";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

// ---- 自愈构建：与 bin 同一真源判鲜（cli-runtime 腿表），陈旧即按腿重建 ----
// CI 有显式 dist 前置构建（见 .github/workflows/ci.yml），本钩子通常 no-op；
// 本地首次跑或源码新于产物时自愈，保证进程烟测永远对着新鲜产物。
beforeAll(async () => {
  const check = checkRuntimeArtifacts();
  if (check.ok) {
    return;
  }
  const staleCommands = new Set(check.refusals.map((refusal) => refusal.buildCommand));
  // 内核四包是 npm 依赖（安装布局，不参与判鲜）：自愈只需要重建本包产物。
  // 依赖真的缺席时 pnpm install 由人显式执行（拒跑文案会给指引）。
  const buildOrder = [
    "pnpm --filter @baize/review-pi build",
  ];
  for (const command of buildOrder) {
    if (!staleCommands.has(command)) {
      continue;
    }
    const run = spawnSync(command, {
      cwd: repoRoot,
      shell: true,
      encoding: "utf8",
      timeout: 480_000,
    });
    if (run.status !== 0) {
      throw new Error(
        `self-heal build failed (${command}, exit ${run.status}):\n${run.stdout ?? ""}${run.stderr ?? ""}`,
      );
    }
  }
}, 600_000);

// ---- loopback stub：真 HTTP 传输层上的 canned 网关 ----

interface StubRequestRecord {
  readonly method: string;
  readonly url: string;
  readonly authorization: string;
  readonly body?: unknown;
}

interface LoopbackStub {
  /** 网关 base URL（自带 /v1——OpenAI SDK 只追加 /chat/completions） */
  readonly baseUrl: string;
  readonly requests: () => readonly StubRequestRecord[];
  readonly close: () => Promise<void>;
}

/**
 * 回环网关 stub：health GET /v1/models、模型探针 POST /v1/chat/completions
 * （stream:false → JSON completion 回显）、检视回合 POST /v1/chat/completions
 * （stream:true → 依序回放脚本回复的 SSE，sseBody 与 fake 适配器同渲染器）。
 * 脚本耗尽即 500（脚本错配是测试自身的 bug，要炸出来不能静默复用旧回复）。
 */
function startLoopbackStub(
  replies: readonly FakeReply[],
  options: {
    readonly truncateFirstStream?: boolean;
    /** 这些 model id 一律 404（模拟网关没注册该模型：探针与真实请求同样被拒） */
    readonly missingModels?: readonly string[];
    /** 模型探针（max_tokens:1 的非流式请求）对这些 model 返回 429 */
    readonly probeRateLimitedModels?: readonly string[];
  } = {},
): Promise<LoopbackStub> {
  const queue = [...replies];
  const requests: StubRequestRecord[] = [];
  let truncated = false;
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = JSON.parse(raw) as unknown;
      } catch {
        body = undefined;
      }
      requests.push({
        method: request.method ?? "",
        url: request.url ?? "",
        authorization: request.headers.authorization ?? "",
        ...(body !== undefined ? { body } : {}),
      });
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: REVIEW_MODEL_ID }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        const model = (body as { model?: unknown } | undefined)?.model;
        const modelId = typeof model === "string" ? model : undefined;
        // 模型不存在：探针与真实请求一视同仁（404 不重试，ADR-0080 进程面用）
        if (modelId !== undefined && options.missingModels?.includes(modelId) === true) {
          response.writeHead(404, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "Model Not Exist", code: "model_not_found" } }));
          return;
        }
        const wantsStream = (body as { stream?: unknown } | undefined)?.stream === true;
        if (!wantsStream) {
          const maxTokens = (body as { max_tokens?: unknown } | undefined)?.max_tokens;
          // 非流式两类：smoke 模型探针（max_tokens:1 的 ping）回显；其余是一次性
          // 模型调用（ADR-0045 报文 / 总结生成）——依序消费脚本回复，回 JSON。
          if (maxTokens === 1) {
            if (modelId !== undefined && options.probeRateLimitedModels?.includes(modelId) === true) {
              response.writeHead(429, { "content-type": "application/json" });
              response.end(JSON.stringify({ error: { message: "rate limited (stub)" } }));
              return;
            }
            response.writeHead(200, { "content-type": "application/json" });
            response.end(
              JSON.stringify({
                model: modelId ?? REVIEW_MODEL_ID,
                choices: [
                  { index: 0, message: { role: "assistant", content: "pong" }, finish_reason: "stop" },
                ],
                usage: { prompt_tokens: 1, completion_tokens: 1 },
              }),
            );
            return;
          }
          const reply = queue.shift();
          if (reply === undefined) {
            response.writeHead(500, { "content-type": "application/json" });
            response.end(JSON.stringify({ error: { message: "stub: scripted replies exhausted" } }));
            return;
          }
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              choices: [
                { index: 0, message: { role: "assistant", content: reply.text }, finish_reason: "stop" },
              ],
              usage: { prompt_tokens: 1, completion_tokens: 1 },
            }),
          );
          return;
        }
        // ADR-0077 进程面用例：第一次流请求发一帧就掐断 socket（**不消费**脚本回复），
        // 让重放路径真的跑一次；后续请求照常回放脚本。
        if (options.truncateFirstStream === true && !truncated) {
          truncated = true;
          response.writeHead(200, { "content-type": "text/event-stream" });
          response.write(
            `data: ${JSON.stringify({
              id: "chatcmpl-truncated",
              object: "chat.completion.chunk",
              model: REVIEW_MODEL_ID,
              choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
            })}\n\n`,
          );
          setTimeout(() => response.destroy(), 30);
          return;
        }
        const reply = queue.shift();
        if (reply === undefined) {
          response.writeHead(500, { "content-type": "application/json" });
          response.end(JSON.stringify({ error: { message: "stub: scripted replies exhausted" } }));
          return;
        }
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end(sseBody(reply));
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { message: `stub: unexpected ${request.method} ${request.url}` } }));
    });
  });
  return new Promise<LoopbackStub>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        requests: () => requests.map((record) => ({ ...record })),
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections?.();
            server.close(() => closed());
          }),
      });
    });
  });
}

// ---- 进程面辅助 ----

interface CliRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** 子进程 cwd（每次 run 一个隔离 temp 目录；ADR-0017 执行目录副本落在其中） */
  readonly cwd: string;
  /** 子进程 HOME / USERPROFILE（沙箱；缺省 tasks 根 = `<home>/.PiAgent/tasks`，ADR-0033） */
  readonly home: string;
}

interface RunBinOptions {
  /** 网关 base URL（写进本 run 的最小配置文件；缺省不写 baseUrl = 官方缺省） */
  readonly gatewayBaseUrl?: string;
  /** 呈现引擎模块路径（写进配置 `presentation.engine`） */
  readonly presentationEngine?: string;
  /** MCP 服务端 URL（写进配置 `mcp.servers.stub` + `mcp.report`；缺席 = 不配上报） */
  readonly mcpServerUrl?: string;
  /** `mcp.report.tool`（事件槽位；**缺席 = 事件通道关闭**，只调四个业务 tool——ADR-0045 后默认形态） */
  readonly mcpEventTool?: string;
  /** `limits.retry.streamAttempts` 覆盖（ADR-0077 进程面用例） */
  readonly streamAttempts?: number;
  /** `mcp.report.task`（ADR-0045 业务 tool 开关；缺省 true——只在给了 mcpServerUrl 时写） */
  readonly mcpTask?: boolean;
  /** 直接指定配置文件全文（覆盖默认最小配置） */
  readonly configText?: string;
  /** 配置文件落点（缺省 = 子进程 cwd 的 PiAgent.jsonc） */
  readonly configPath?: string;
  /**
   * 是否自动追加 `--config <path>`（缺省 true）。config 子命令用例自己带
   * `--config`，或要测「缺省用户级路径」时置 false。
   */
  readonly appendConfigArg?: boolean;
  /** 显式注入子进程的非配置类环境变量（HOME/USERPROFILE 始终指向沙箱） */
  readonly env?: Record<string, string>;
  /** 预写进子进程 cwd 的 .env.local 内容（本版已不读取；只用于「不被读取」断言） */
  readonly seedEnvLocal?: string;
  /** 预置到子进程 cwd 的文件名（内容固定 `{"stale":true}`；ADR-0017 副本清理用） */
  readonly seedCwdFiles?: readonly string[];
  /** 预置到子进程 cwd 的**目录名**（占位模拟不可写；ADR-0017 副本失败语义用） */
  readonly seedCwdDirs?: readonly string[];
  /**
   * 复用已存在的目录作为子进程 cwd（缺省每次新建 tmpdir）。
   * 跨两次进程调用共享状态时用（导出命令要读上一次 review 写的 cwd 索引）。
   */
  readonly cwd?: string;
  readonly timeoutMs?: number;
}

/** 最小配置（version + reviewer；可选 baseUrl / 呈现引擎 / MCP 上报） */
function minimalConfigText(options: RunBinOptions): string {
  const reviewer: Record<string, unknown> = { apiKey: SENTINEL_KEY };
  if (options.gatewayBaseUrl !== undefined) {
    reviewer["baseUrl"] = options.gatewayBaseUrl;
  }
  return `${JSON.stringify(
    {
      version: 1,
      reviewer,
      // 进程面用例的哨兵候选指向 diff 之外的文件（sample.txt / README.md），
      // 与本开关无关；显式关闭以保留既有输出断言。默认开启行为由 run 层
      // 集成测试（review-run.test.ts）与 config 单测覆盖。
      limits: {
        findingScope: { enabled: false },
        ...(options.streamAttempts !== undefined
          ? { retry: { streamAttempts: options.streamAttempts } }
          : {}),
      },
      ...(options.presentationEngine !== undefined
        ? { presentation: { engine: options.presentationEngine } }
        : {}),
      ...(options.mcpServerUrl !== undefined
        ? {
            mcp: {
              servers: {
                stub: {
                  transport: "http",
                  url: options.mcpServerUrl,
                  headers: {},
                  timeoutMs: 10_000,
                },
              },
              report: {
                server: "stub",
                ...(options.mcpEventTool !== undefined ? { tool: options.mcpEventTool } : {}),
                ...(options.mcpTask !== undefined ? { task: options.mcpTask } : {}),
              },
            },
          }
        : {}),
    },
    null,
    2,
  )}\n`;
}

/**
 * spawn 真 bin（cwd = 干净 tmpdir——不捡到仓库根的 .env.local）。**每个用例都
 * 显式 `--config <tmp>`，且 HOME / USERPROFILE 指向空沙箱**：用户级
 * `~/.PiAgent/PiAgent.jsonc` 与真实 home 绝不参与进程测试（ADR-0025）。
 *
 * 退出码/stdout/stderr 全捕获；超时即杀（status null）。
 *
 * 必须异步 spawn（不能 spawnSync）：stub 服务器活在本进程——spawnSync 会
 * 冻结事件循环，子进程的 HTTP 请求永远等不到 accept（子等响应、亲等退出，
 * 活锁成对超时）。异步 spawn 让事件循环在 await 间隙继续伺服 stub。
 */
function runBin(args: readonly string[], options: RunBinOptions = {}): Promise<CliRunResult> {
  const cwd = options.cwd ?? makeTempDir("review-pi-cli-cwd-");
  const sandboxHome = makeTempDir("review-pi-cli-home-");
  const configPath = options.configPath ?? path.join(cwd, "PiAgent.jsonc");
  if (options.configText !== undefined) {
    writeFileSync(configPath, options.configText, "utf8");
  } else if (options.configPath === undefined) {
    writeFileSync(configPath, minimalConfigText(options), "utf8");
  }
  if (options.seedEnvLocal !== undefined) {
    writeFileSync(path.join(cwd, ".env.local"), options.seedEnvLocal, "utf8");
  }
  for (const name of options.seedCwdFiles ?? []) {
    writeFileSync(path.join(cwd, name), '{"stale":true}\n', "utf8");
  }
  for (const name of options.seedCwdDirs ?? []) {
    mkdirSync(path.join(cwd, name), { recursive: true });
  }
  const argv =
    options.appendConfigArg === false ? [...args] : [...args, "--config", configPath];
  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...argv], {
      cwd,
      // 业务 tool 固定沉降（ADR-0053）在进程用例里压缩为 0：否则每条启用 MCP
      // 的用例都会多等 10 秒。需要的用例用 `options.env` 显式覆盖。
      env: {
        ...process.env,
        HOME: sandboxHome,
        USERPROFILE: sandboxHome,
        PIAGENT_TEST_TASK_TOOL_SETTLE_MS: "0",
        ...options.env,
      },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
    }, options.timeoutMs ?? 100_000);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    });
    child.on("close", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timer);
        resolve({ status: code, stdout, stderr, cwd, home: sandboxHome });
      }
    });
  });
}

/** 递归收集目录下全部文件路径（落盘面哨兵扫描用） */
function collectFiles(root: string): readonly string[] {
  const files: string[] = [];
  const visit = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        visit(full);
      } else {
        files.push(full);
      }
    }
  };
  visit(root);
  return files;
}

/** 哨兵泄漏断言：进程输出面 + --tasks-dir 落盘面全量不含 key */
function expectNoKeyLeak(haystacks: readonly { label: string; text: string }[]): void {
  for (const { label, text } of haystacks) {
    expect(text.includes(SENTINEL_KEY), `${label} must not contain the API key`).toBe(false);
    expect(text.includes(DECOY_KEY), `${label} must not contain the .env.local decoy key`).toBe(false);
  }
}

/** 一轮零工具完成脚本：phase-5 出唯一候选 F100，phase-6 裁决通过 + complete */
function oneFindingCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const candidate = {
    id: "F100",
    severity: "P2",
    category: "correctness",
    file: "sample.txt",
    line: 1,
    title: "Sentinel finding title",
    description: "Sentinel finding description",
    evidence: ["sample.txt:1"],
    rule: "sentinel-rule",
    confidence: 0.5,
  };
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [candidate] }), usage: ZERO },
    {
      text: JSON.stringify({ verdicts: [{ id: "F100", pass: true, reason: "stub verdict: evidence holds" }], complete: true }),
      usage: ZERO,
    },
    // ADR-0065：业务关闭的 run 也会在收尾做一次片级语义生成产中文 tips。
    { text: payloadReplyForSentinelFinding(), usage: ZERO },
  ];
}

/** 轮次上限语料：3 轮 × 6 相位，phase-6 恒 complete:false（最后一轮强制 complete） */
function truncationCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const replies: FakeReply[] = [];
  for (let round = 0; round < 3; round++) {
    replies.push(
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: '{"candidates":[]}', usage: ZERO },
      { text: '{"verdicts":[],"complete":false}', usage: ZERO },
    );
  }
  return replies;
}

/**
 * 报文生成用的单候选语料（ADR-0045 决策 4 修订）：同 oneFindingCorpus，但
 * finding 指向 fixture 里**真实存在**的文件（README.md:1）——报文的 `code`
 * 由 CLI 按 `--repo` 抽真源行，文件不存在就该跳过（绝不编）。
 */
function oneFindingCorpusForReport(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const candidate = {
    id: "F100",
    severity: "P2",
    category: "correctness",
    file: "README.md",
    line: 1,
    title: "Sentinel finding title",
    description: "Sentinel finding description",
    evidence: ["README.md:1"],
    rule: "sentinel-rule",
    confidence: 0.5,
  };
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [candidate] }), usage: ZERO },
    {
      text: JSON.stringify({ verdicts: [{ id: "F100", pass: true, reason: "stub verdict: evidence holds" }], complete: true }),
      usage: ZERO,
    },
  ];
}

/**
 * 零意见语料：一轮跑完候选为空、phase-6 complete:true。零意见不生成报文、
 * 总结也用固定文案 ⇒ 之后没有任何一次性模型调用。
 */
function noFindingCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: '{"candidates":[]}', usage: ZERO },
    { text: '{"verdicts":[],"complete":true}', usage: ZERO },
  ];
}

/** 子进程网关覆盖（写入本 run 的最小配置文件；不再经环境变量） */
/**
 * 「流中途断开」网关桩（ADR-0076 验收）：先发一帧 SSE 让流真的开始，再销毁
 * socket——复现真实环境里代理 / 网关掐断连接造成的 `TypeError: terminated`。
 */
function startTruncatingStub(): Promise<{
  readonly baseUrl: string;
  readonly close: () => Promise<void>;
}> {
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      if (request.method === "GET" && request.url === "/v1/models") {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: REVIEW_MODEL_ID }] }));
        return;
      }
      if (request.method === "POST" && request.url === "/v1/chat/completions") {
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.write(
          `data: ${JSON.stringify({
            id: "chatcmpl-truncated",
            object: "chat.completion.chunk",
            model: REVIEW_MODEL_ID,
            choices: [{ index: 0, delta: { content: "partial" }, finish_reason: null }],
          })}\n\n`,
        );
        setTimeout(() => response.destroy(), 30);
        return;
      }
      response.writeHead(404, { "content-type": "application/json" });
      response.end("{}");
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

function stubEnv(stubBaseUrl: string): RunBinOptions {
  return { gatewayBaseUrl: stubBaseUrl };
}

// ---- 检视命令面 ----

test(
  "单 MR 检视（唯一形态，ADR-0024）：exit 0 + stdout 单 JSON + 候选存活成 finding + 落盘 + 凭据哨兵",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--taskId", CLI_TASK_ID, "--tasks-dir", outDir],
        {
          ...stubEnv(stub.baseUrl),
          // .env.local 诱饵：本版已不再读取（诱饵 URL 是死端口，诱饵 key 不入传输层）
          seedEnvLocal: `REVIEWER_URL=http://127.0.0.1:9/v1\nREVIEWER_API_KEY=${DECOY_KEY}\n`,
        },
      );

      expect(run.status).toBe(0);
      // stdout 契约：单个 JSON 文档（尾随换行；多余字节即 JSON.parse 失败）
      const outcome = JSON.parse(run.stdout) as {
        ok: boolean;
        caseId: string;
        runId: string;
        truncated: boolean;
        rounds: number;
        toolCalls: number;
        findings: { id: string; severity: string; title: string; file: string }[];
        auditPath: string;
      };
      expect(outcome).toMatchObject({
        ok: true,
        caseId: "VUL4J-1",
        truncated: false,
        rounds: 1,
        toolCalls: 0,
      });
      expect(outcome.runId).toMatch(/^\d{8}_\d{6}_\d{3}$/);
      // 候选 → 裁决通过 → finding 存活（独立期望：字面量造的候选，非代码回算）
      expect(outcome.findings).toHaveLength(1);
      expect(outcome.findings[0]).toMatchObject({
        id: "F100",
        severity: "P2",
        title: "Sentinel finding title",
        file: "sample.txt",
      });
      // 审计与运行记录落盘（audit 文件名与 runId 同源）
      expect(existsSync(outcome.auditPath)).toBe(true);
      expect(path.basename(outcome.auditPath)).toBe(`${outcome.runId}.json`);
      expect(collectFiles(outDir).length).toBeGreaterThanOrEqual(2);
      // 请求时间线（ADR-0076）：成功 run 也写；每行一个 JSON 对象
      const timelinePath = path.join(outDir, CLI_TASK_ID, "runs", "request-timeline.jsonl");
      expect(existsSync(timelinePath)).toBe(true);
      const timelineLines = readFileSync(timelinePath, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as { kind: string; site?: string; runId?: string | null });
      expect(timelineLines.some((line) => line.kind === "request" && line.site === "main")).toBe(
        true,
      );
      // 收尾阶段（tips / 总结）续写同一次 run：runId 已确定，写进行里
      expect(
        timelineLines.some(
          (line) => line.kind === "request" && line.runId === outcome.runId,
        ),
      ).toBe(true);

      // 传输层：六回合检视 + 一次业务关闭下的 tips 语义生成；全部带哨兵 Authorization 头
      const requests = stub.requests();
      expect(requests).toHaveLength(7);
      for (const request of requests) {
        expect(request.method).toBe("POST");
        expect(request.url).toBe("/v1/chat/completions");
        expect(request.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
      }

      // 哨兵纪律：key 绝不进 stdout/stderr/落盘面
      const diskTexts = collectFiles(outDir).map((file) => ({
        label: path.basename(file),
        text: readFileSync(file, "utf8"),
      }));
      expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }, ...diskTexts]);
      // .env.local 残留提示：只声明「不再读取」，绝不回显文件内容
      expect(run.stderr).toContain("已不再读取 .env.local");
      expect(run.stderr).not.toContain(DECOY_KEY);
      // 开跑前回显生效参数（stderr；stdout 仍是单 JSON 文档）；ADR-0043 把打印点
      // 从收尾挪到开跑前——回显头必须早于收尾总结行。
      expect(run.stderr).toContain("review-pi: 本次 review 传入参数");
      expect(run.stderr.indexOf("review-pi: 本次 review 传入参数")).toBeLessThan(
        run.stderr.indexOf("✓ 完成"),
      );
      expect(run.stderr).toContain(mrFile);
      expect(run.stderr).toContain(repoFixturePath("sample"));
      // 落盘位置回显的是 taskId + tasks 根（ADR-0033），不再是任何 --out 路径
      expect(run.stderr).toContain(CLI_TASK_ID);
      expect(run.stderr).toContain(outDir);
      expect(run.stderr).not.toContain("--out");
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "请求时间线（ADR-0076）：流中途断开 → exit 1 + task 目录留下失败现场（attempt/request 行 + 归因）",
  async () => {
    const stub = await startTruncatingStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
        ],
        { ...stubEnv(stub.baseUrl), streamAttempts: 1 },
      );

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("review turn failed");
      // 失败现场一行人读摘要（同时被 review-pi.log 镜像）
      expect(run.stderr).toContain("request-timeline:");

      const timelinePath = path.join(outDir, CLI_TASK_ID, "runs", "request-timeline.jsonl");
      expect(existsSync(timelinePath)).toBe(true);
      const lines = readFileSync(timelinePath, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines.some((line) => line["kind"] === "attempt")).toBe(true);
      const request = lines.find((line) => line["kind"] === "request");
      expect(request).toBeDefined();
      expect(request?.["site"]).toBe("main");
      expect(request?.["stopReason"]).toBe("error");
      expect(request?.["error"]).not.toBeNull();
      // 失败 run 仍不产契约产物（不落 partial audit / run.json，ADR-0076 决策 5）
      expect(existsSync(path.join(outDir, CLI_TASK_ID, "runs", "run.json"))).toBe(false);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "流中断重放（ADR-0077）：第一次掐断、第二次成功 → exit 0；时间线留 replay 0/1，审计不重复请求",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus(), { truncateFirstStream: true });
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
        ],
        { ...stubEnv(stub.baseUrl), streamAttempts: 2 },
      );

      expect(run.status, run.stderr).toBe(0);
      const outcome = JSON.parse(run.stdout) as {
        ok: boolean;
        findings: unknown[];
        auditPath: string;
      };
      expect(outcome.ok).toBe(true);
      expect(outcome.findings).toHaveLength(1);

      const timelinePath = path.join(outDir, CLI_TASK_ID, "runs", "request-timeline.jsonl");
      const lines = readFileSync(timelinePath, "utf8")
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const requests = lines.filter((line) => line["kind"] === "request");
      const firstReplay = requests.find((line) => line["replay"] === 0);
      const secondReplay = requests.find((line) => line["replay"] === 1);
      expect(firstReplay?.["error"]).not.toBeNull();
      expect(firstReplay?.["bytes"]).toBeGreaterThan(0);
      expect(secondReplay?.["stopReason"]).toBe("stop");
      expect(secondReplay?.["error"]).toBeNull();

      // 重放不产生第二条审计请求：`onPayload` 只在首次尝试触发（6 阶段 = 6 条）
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        requests: unknown[];
      };
      expect(audit.requests).toHaveLength(6);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "缺省落盘根（ADR-0033）：不传 --tasks-dir 时产到 <home>/.PiAgent/tasks/<taskId>/",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--taskId", "home-task"],
        stubEnv(stub.baseUrl),
      );

      expect(run.status).toBe(0);
      const taskDir = path.join(run.home, ".PiAgent", "tasks", "home-task");
      expect(existsSync(path.join(taskDir, "runs", "run.json"))).toBe(true);
      expect(existsSync(path.join(taskDir, "runs", "reviews_en.json"))).toBe(true);
      expect(readdirSync(path.join(taskDir, "audit"))).toHaveLength(1);
      // 参数回显报的是生效的 tasks 根（并标注「缺省」来源）+ 任务 id 本身
      expect(run.stderr).toContain(path.join(run.home, ".PiAgent", "tasks"));
      expect(run.stderr).toContain("缺省：~/.PiAgent/tasks");
      expect(run.stderr).toContain("--taskId");
      expect(run.stderr).toContain("home-task");
      expect(run.stderr).not.toContain("--out");
      // 业务关闭也会产统一 tips（ADR-0065）——不再依赖呈现引擎
      expect(existsSync(path.join(taskDir, "runs", "reviews_tips_zh.json"))).toBe(true);
      expect(existsSync(path.join(run.cwd, "review-result.json"))).toBe(true);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "MR 输入形态（ADR-0029）：--mr-json 接口数组 → 装载期补文件头，与 --mr-diff 同一条检视路径",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const jsonFile = path.join(makeTempDir("review-pi-cli-mr-"), "MR-1234.json");
      // 接口原样形状之一：每项只有 new_path 与 diff（从 @@ 开始，无文件头）
      writeFileSync(
        jsonFile,
        JSON.stringify([
          {
            new_path: "src/main/java/com/alibaba/fastjson/serializer/ObjectArrayCodec.java",
            diff:
              "@@ -174,7 +174,7 @@ public <T> T deserialze(DefaultJSONParser parser, Type type, Object fieldName) {\n" +
              "             componentType = componentClass = clazz.getComponentType();\n" +
              "         }\n" +
              "         JSONArray array = new JSONArray();\n" +
              "+        parser.parseArray(componentClass, array, fieldName);\n" +
              "-        parser.parseArray(componentType, array, fieldName);\n" +
              " \n" +
              "         return (T) toObjectArray(parser, componentClass, array);\n" +
              "     }",
            // 额外字段一概忽略（只按「路径 + 正文」两个语义取字段）
            old_path: "ignored/old.ts",
            new_file: true,
            sha: "deadbeef",
          },
        ]),
        "utf8",
      );

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr-json", jsonFile, "--taskId", CLI_TASK_ID, "--tasks-dir", outDir],
        stubEnv(stub.baseUrl),
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as {
        ok: boolean;
        caseId: string;
        findings: { id: string; file: string }[];
      };
      // caseId = JSON 文件名去扩展名（与 --mr-diff 同款派生）
      expect(outcome).toMatchObject({ ok: true, caseId: "MR-1234" });
      expect(outcome.findings).toHaveLength(1);
      // 产物落在 <tasks 根>/<taskId>/runs/ 下，路径不因输入是 JSON 而变化
      expect(existsSync(path.join(outDir, CLI_TASK_ID, "runs", "reviews_en.json"))).toBe(true);
      // taskId 与 caseId 是两个维度：caseId 来自 MR 文件名，taskId 来自 --taskId
      expect(path.join(outDir, CLI_TASK_ID, "runs", "reviews_en.json")).not.toContain("MR-1234");
      expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test("--mr-json 坏输入：非法 JSON / 空 diff 数组 → exit 1 + 人话（进程面不抛堆栈）", async () => {
  const dir = makeTempDir("review-pi-cli-mr-");
  const env = { ...stubEnv("http://127.0.0.1:9/v1"), timeoutMs: 30_000 };

  const broken = path.join(dir, "broken.json");
  writeFileSync(broken, "[{ oops", "utf8");
  const bad = await runBin(
    [
      "review",
      "--repo",
      repoFixturePath("sample"),
      "--mr-json",
      broken,
      "--taskId",
      CLI_TASK_ID,
    ],
    env,
  );
  expect(bad.status).toBe(1);
  expect(bad.stdout).toBe("");
  expect(bad.stderr).toContain("--mr-json: 不是合法 JSON");

  const empty = path.join(dir, "empty.json");
  writeFileSync(empty, JSON.stringify([{ new_path: "a/b.png", diff: "" }]), "utf8");
  const nothing = await runBin(
    [
      "review",
      "--repo",
      repoFixturePath("sample"),
      "--mr-json",
      empty,
      "--taskId",
      CLI_TASK_ID,
    ],
    env,
  );
  expect(nothing.status).toBe(1);
  expect(nothing.stderr).toContain("没有可转换的文本 diff");
});

test(
  "轮次上限：phase-6 恒 complete:false → exit 0 + rounds=3 + 最后一轮强制 complete（不截断）",
  async () => {
    const stub = await startLoopbackStub(truncationCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--taskId", CLI_TASK_ID, "--tasks-dir", outDir],
        stubEnv(stub.baseUrl),
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as {
        truncated: boolean;
        rounds: number;
        findings: unknown[];
      };
      expect(outcome.truncated).toBe(false);
      expect(outcome.rounds).toBe(3);
      expect(outcome.findings).toEqual([]);
      // 3 轮 × 6 相位 = 18 回合全走真 HTTP
      expect(stub.requests()).toHaveLength(18);
      expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "limits.loop.maxRounds 配置生效：写 1 → 一轮即强制 complete、只发 6 次请求",
  async () => {
    const stub = await startLoopbackStub(truncationCorpus().slice(0, 6));
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runCliReview(outDir, mrFile, {
        gatewayBaseUrl: stub.baseUrl,
        configText: JSON.stringify({
          version: 1,
          reviewer: { apiKey: SENTINEL_KEY, baseUrl: stub.baseUrl },
          limits: { loop: { maxRounds: 1 } },
        }),
      });

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as { truncated: boolean; rounds: number };
      expect(outcome.rounds).toBe(1);
      expect(outcome.truncated).toBe(false);
      expect(stub.requests()).toHaveLength(6);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "Phase 5 解析失败：stderr 可见一行 + 退出码不变 + 审计 phaseLog 带 parseFailure",
  async () => {
    const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
    const stub = await startLoopbackStub([
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "not a JSON reply at all", usage: ZERO },
      { text: '{"verdicts":[],"complete":true}', usage: ZERO },
    ]);
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--taskId", CLI_TASK_ID, "--tasks-dir", outDir],
        stubEnv(stub.baseUrl),
      );

      // 旁路可见性：解析失败不改退出码、stdout 仍是单 JSON 文档
      expect(run.status).toBe(0);
      expect(run.stderr).toContain(
        "review-pi: [r1 phase5] 候选解析失败（not-json），本轮 0 候选；详见审计 phaseLog",
      );
      const outcome = JSON.parse(run.stdout) as { findings: unknown[]; auditPath: string };
      expect(outcome.findings).toEqual([]);

      // 同时落审计（可机读）
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        phaseLog: { phase: string; parseFailure?: { expected: string; kind: string } }[];
      };
      expect(audit.phaseLog[4]?.parseFailure).toEqual({
        expected: "candidates",
        kind: "not-json",
      });
      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
      ]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- 配置文件显式路径（ADR-0025：--config） ----

test(
  "--config：只读指定配置文件（cwd 之外），cwd 的 .env.local 不被读取；key 绝不回显",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");
      const configDir = makeTempDir("review-pi-cli-conf-");
      const configPath = path.join(configDir, "PiAgent.jsonc");
      writeFileSync(
        configPath,
        `${JSON.stringify({
          version: 1,
          reviewer: { apiKey: SENTINEL_KEY, baseUrl: stub.baseUrl },
        })}\n`,
        "utf8",
      );

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--config",
          configPath,
        ],
        {
          appendConfigArg: false,
          // cwd 诱饵：若实现退回 cwd 的 .env.local，请求会打向死端口并带上诱饵 key
          seedEnvLocal: `REVIEWER_URL=http://127.0.0.1:9/v1\nREVIEWER_API_KEY=${DECOY_KEY}\n`,
        },
      );

      expect(run.status).toBe(0);
      const requests = stub.requests();
      expect(requests).toHaveLength(6);
      // 本用例的配置未关 findingScope：哨兵候选落在 diff 之外被剔除 ⇒ 零意见，
      // 统一 tips 走 `[]` 兜底（不触发语义生成模型调用，故仍恰好六回合）。
      expect(existsSync(path.join(outDir, CLI_TASK_ID, "runs", "reviews_tips_zh.json"))).toBe(true);
      for (const request of requests) {
        expect(request.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
      }
      expect(run.stderr).toContain("已不再读取 .env.local");
      expect(run.stdout).not.toContain(SENTINEL_KEY);
      expect(run.stderr).not.toContain(SENTINEL_KEY);
      expect(run.stderr).not.toContain(DECOY_KEY);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test("--config 指向不存在的文件 → exit 1 + 人话错误含路径 + stdout 干净（不静默回落缺省）", async () => {
  const missing = path.join(makeTempDir("review-pi-cli-conf-"), "no-such.json");
  const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");

  const run = await runBin(
    [
      "review",
      "--repo",
      repoFixturePath("sample"),
      "--mr-diff",
      mrFile,
      "--taskId",
      CLI_TASK_ID,
      "--config",
      missing,
    ],
    { appendConfigArg: false },
  );

  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("--config 指定的文件不存在");
  expect(run.stderr).toContain(missing);
});

test("--config 指向目录（读失败）→ exit 1 + 人话错误，不抛堆栈", async () => {
  const dir = makeTempDir("review-pi-cli-conf-");
  const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");

  const run = await runBin(
    [
      "review",
      "--repo",
      repoFixturePath("sample"),
      "--mr-diff",
      mrFile,
      "--taskId",
      CLI_TASK_ID,
      "--config",
      dir,
    ],
    { appendConfigArg: false },
  );

  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("无法读取配置文件");
  expect(run.stderr).not.toContain("    at ");
});

// ---- 呈现引擎配置（ADR-0065）：`presentation.engine` 保留但不再驱动控制台 ----
// 引擎模块是外部 ESM（翻译算法/网络/密钥全在核外）——fixture 现场 tmp .mjs。

/** 成功引擎 fixture：只译 title/description，结构化字段与 toolCallLog 直通 */
function writeProjectionEngineFixture(name: string, body: string): string {
  const enginePath = path.join(makeTempDir("review-pi-projection-engine-"), name);
  writeFileSync(enginePath, body, "utf8");
  return enginePath;
}

test(
  "控制台恒英文（ADR-0065）：presentation.engine 配置不再触发翻译 → stdout 英文源档 + 无 presentation 键",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      // 若仍走旧投影路径，这个引擎会立刻炸出来；恒英文后它根本不会被加载/调用。
      const enginePath = writeProjectionEngineFixture(
        "engine.mjs",
        `export default async () => { throw new Error("engine must not be called"); };\n`,
      );
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--taskId", CLI_TASK_ID, "--tasks-dir", outDir],
        { gatewayBaseUrl: stub.baseUrl, presentationEngine: enginePath },
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as {
        findings: { id: string; severity: string; title: string; description: string; file: string; line: number }[];
        presentation?: unknown;
        auditPath: string;
      };
      // stdout = 英文真源本身：自然语言字段与合并 findings 逐字段一致
      expect(outcome.findings).toHaveLength(1);
      expect(outcome.findings[0]).toMatchObject({
        id: "F100",
        severity: "P2",
        title: "Sentinel finding title",
        description: "Sentinel finding description",
        file: "sample.txt",
        line: 1,
      });
      // 呈现留痕键整体退场（不再有 presentation / degraded 语义）
      expect("presentation" in outcome).toBe(false);
      expect(run.stderr).not.toContain("呈现投影");
      expect(run.stderr).not.toContain("engine must not be called");
      // 审计与 stdout 同源英文
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        findings: { title: string }[];
      };
      expect(audit.findings[0]?.title).toBe("Sentinel finding title");
      // 请求面：六回合检视 + 一次业务关闭下的 tips 语义生成（不是逐字段翻译）
      expect(stub.requests()).toHaveLength(7);
      expect(countOneShotGatewayCalls(stub)).toBe(1);
      // 中文 tips 仍照产（统一生成唯一真源）
      expect(existsSync(path.join(cliRunsDir(outDir), "reviews_tips_zh.json"))).toBe(true);
      expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- 检视意见中文导出（ADR-0013 Step B / ADR-0065）：tips 生命周期矩阵 ----
// 中文 tips 由片级统一生成产出（业务开 / 关同一条路径），与 en 同目录。
// 路径基线：<out>/runs/（ADR-0032：无 mr/<caseId>/rep-N 层）

/** 本次 run 的产物目录（reviews_en.json / reviews_tips_zh.json 同层，ADR-0032 / ADR-0033） */
function cliRunsDir(outDir: string): string {
  return path.join(outDir, CLI_TASK_ID, "runs");
}

/** 单 MR 检视调用（唯一形态；可选注入呈现引擎与 cwd 预置文件） */
function runCliReview(
  outDir: string,
  mrFile: string,
  config: RunBinOptions,
  options: RunBinOptions = {},
): Promise<CliRunResult> {
  return runBin(
    ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--taskId", CLI_TASK_ID, "--tasks-dir", outDir],
    { ...options, ...config },
  );
}

function writeMr(diff: string): string {
  const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
  writeFileSync(mrFile, diff, "utf8");
  return mrFile;
}

test(
  "中文产物：业务关闭也产 tips（ADR-0065 统一生成兜底）→ 12 键落盘 + stdout 恒英文 + 无引擎/无翻译",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), stubEnv(stub.baseUrl));

      expect(run.status).toBe(0);
      const runsDir = cliRunsDir(outDir);
      expect(existsSync(path.join(runsDir, "reviews_en.json"))).toBe(true);
      // ADR-0022：zh 文件停产——中文交付物只有 tips
      expect(existsSync(path.join(runsDir, "reviews_zh.json"))).toBe(false);

      const outcome = JSON.parse(run.stdout) as {
        findings: { id: string; severity: string; title: string; description: string; file: string; line: number }[];
        presentation?: unknown;
      };
      // 控制台恒英文（ADR-0065）：没有 presentation 键，findings 与英文真源一致
      expect("presentation" in outcome).toBe(false);
      expect(outcome.findings[0]).toMatchObject({
        id: "F100",
        severity: "P2",
        title: "Sentinel finding title",
        description: "Sentinel finding description",
        file: "sample.txt",
        line: 1,
      });
      // 六回合检视 + 一次片级语义生成（业务关闭的统一 tips 兜底）
      expect(stub.requests()).toHaveLength(7);
      expect(countOneShotGatewayCalls(stub)).toBe(1);
      // 分组意见（ADR-0017 / ADR-0065）：12 键统一形态，业务关闭也照产
      const tipsPath = path.join(runsDir, "reviews_tips_zh.json");
      expect(existsSync(tipsPath)).toBe(true);
      const tips = JSON.parse(readFileSync(tipsPath, "utf8")) as unknown[];
      expect(Array.isArray(tips)).toBe(true);
      const firstTip = (tips as { reviewTips: Record<string, unknown>[] }[])[0]?.reviewTips[0];
      expect(firstTip).toMatchObject({
        id: "F100",
        review: "[可靠性] 测试桩意见。影响评估：仅测试。",
        suggestion: "[重构思路] 无。代码示例：```无```",
        category: "可靠性",
        subcategory: "测试桩",
        severity: "Minor",
        level: "Minor",
        ruleId: "",
        lineNum: 1,
        source: "common-reviewer",
        confidence: "Medium",
      });
      expect(typeof firstTip?.["code"]).toBe("string");
      // 执行目录副本（ADR-0017 决策 14 / ADR-0027）：cwd 只放 review-result.json，
      // 内容与 runs/ 那份逐字节相同
      const cwdTipsPath = path.join(run.cwd, "reviews_tips_zh.json");
      const cwdResultPath = path.join(run.cwd, "review-result.json");
      expect(existsSync(cwdTipsPath)).toBe(false);
      expect(existsSync(cwdResultPath)).toBe(true);
      const repTipsText = readFileSync(tipsPath, "utf8");
      expect(readFileSync(cwdResultPath, "utf8")).toBe(repTipsText);
      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
        { label: "reviews_tips_zh.json", text: repTipsText },
        { label: "cwd review-result.json", text: readFileSync(cwdResultPath, "utf8") },
      ]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test("中文产物：未配置引擎也产 tips（ADR-0065 业务关闭统一生成）→ tips 落盘 + reviews_zh.json 缺席", async () => {
  const stub = await startLoopbackStub(oneFindingCorpus());
  try {
    const outDir = makeTempDir("review-pi-cli-out-");
    const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), stubEnv(stub.baseUrl));

    expect(run.status).toBe(0);
    const runsDir = cliRunsDir(outDir);
    expect(existsSync(path.join(runsDir, "reviews_en.json"))).toBe(true);
    expect(existsSync(path.join(runsDir, "reviews_zh.json"))).toBe(false);
    expect(existsSync(path.join(runsDir, "reviews_tips_zh.json"))).toBe(true);
    // 本次 run 无陈旧 zh / tips ⇒ 无「已清除陈旧」噪声
    expect(run.stderr).not.toContain("已清除陈旧");
  } finally {
    await stub.close();
  }
}, 180_000);

test("中文产物：陈旧 zh + tips → zh 被清除、tips 被本次统一生成覆盖 + stderr 留痕", async () => {
  const stub = await startLoopbackStub(oneFindingCorpus());
  try {
    const outDir = makeTempDir("review-pi-cli-out-");
    // 预置陈旧 zh 与分组意见（上一 run 遗留；本次会被清除 / 覆盖）
    const runsDir = cliRunsDir(outDir);
    mkdirSync(runsDir, { recursive: true });
    const stalePath = path.join(runsDir, "reviews_zh.json");
    writeFileSync(stalePath, '{"stale":true}\n', "utf8");
    const staleTipsPath = path.join(runsDir, "reviews_tips_zh.json");
    writeFileSync(staleTipsPath, '{"stale":true}\n', "utf8");

    const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), stubEnv(stub.baseUrl), {
      seedCwdFiles: ["reviews_tips_zh.json", "review-result.json"],
    });

    expect(run.status).toBe(0);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(staleTipsPath)).toBe(true);
    expect(readFileSync(staleTipsPath, "utf8")).not.toContain("stale");
    expect(existsSync(path.join(runsDir, "reviews_en.json"))).toBe(true);
    // cwd 里上次留下的副本被本次结果覆盖（「有就是本次的」）
    expect(existsSync(path.join(run.cwd, "review-result.json"))).toBe(true);
    expect(readFileSync(path.join(run.cwd, "review-result.json"), "utf8")).not.toContain("stale");
    expect(run.stderr).toContain("已清除陈旧");
  } finally {
    await stub.close();
  }
}, 180_000);

test(
  "分组意见：语义生成失败 → 只有 tips 缺席（stdout 恒英文、exit 0、stderr 说明），弱耦合",
  async () => {
    // 只有六回合检视回复：收尾的 tips 语义生成拿不到回复 ⇒ 500 ⇒ 失败路径
    const stub = await startLoopbackStub(oneFindingCorpus().slice(0, 6));
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), stubEnv(stub.baseUrl));

      expect(run.status).toBe(0);
      const runsDir = cliRunsDir(outDir);
      expect(existsSync(path.join(runsDir, "reviews_zh.json"))).toBe(false);
      expect(existsSync(path.join(runsDir, "reviews_tips_zh.json"))).toBe(false);
      // cwd 副本同理不产（使「有就是本次的」成立）
      expect(existsSync(path.join(run.cwd, "reviews_tips_zh.json"))).toBe(false);
      expect(existsSync(path.join(run.cwd, "review-result.json"))).toBe(false);
      expect(run.stderr).toContain("中文 tips 语义生成失败");
      expect(run.stderr).toContain("本次不产分组意见");
      // stdout 仍是英文源档（tips 坏不拖累 stdout 与 en）
      const outcome = JSON.parse(run.stdout) as { findings: { title: string }[] };
      expect(outcome.findings[0]?.title).toBe("Sentinel finding title");
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "分组意见：执行目录副本写不进（cwd 的 review-result.json 被占成目录）→ stderr 警告 + exit 0 + runs/ 那份照产",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runCliReview(
        outDir,
        writeMr(goldenFixture("vul4j-1.diff")),
        stubEnv(stub.baseUrl),
        // cwd 的目标名被目录占住 ⇒ 写文件必然失败
        { seedCwdDirs: ["reviews_tips_zh.json", "review-result.json"] },
      );

      // 便捷副本不配把检视判失败：exit 0
      expect(run.status).toBe(0);
      expect(run.stderr).toContain("执行目录副本写入失败");
      expect(run.stderr).toContain("review-result.json");
      // run 产物目录那份不受牵连
      expect(existsSync(path.join(cliRunsDir(outDir), "reviews_tips_zh.json"))).toBe(true);
      // stdout 仍是完整 JSON 文档（未被 stderr 污染）
      expect(() => JSON.parse(run.stdout)).not.toThrow();
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test("中文产物：写盘失败（tips 路径预占为目录）→ exit 1 + 错误人话 + stdout 干净", async () => {
  const stub = await startLoopbackStub(oneFindingCorpus());
  try {
    const outDir = makeTempDir("review-pi-cli-out-");
    // 预占 tips 路径为目录 ⇒ writeFile 失败（EISDIR）⇒ 显式抛错 ⇒ exit 1
    const runsDir = cliRunsDir(outDir);
    mkdirSync(path.join(runsDir, "reviews_tips_zh.json"), { recursive: true });

    const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), stubEnv(stub.baseUrl));

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("failed to persist grouped review export");
    expect(run.stderr).toContain("reviews_tips_zh.json");
  } finally {
    await stub.close();
  }
}, 180_000);

test("陈旧产物拒跑：dist 回拨 30 天 → exit 1 + 人话提示 + stdout 干净（mtime 门）", async () => {
  const entry = path.join(packageDir, "dist", "cli", "main.js");
  const original = statSync(entry).mtime;
  const backdated = new Date(original.getTime() - 30 * 24 * 60 * 60 * 1000);
  utimesSync(entry, backdated, backdated);
  try {
    const run = await runBin(["review", "--repo", repoFixturePath("sample"), "--mr-diff", "x.diff"], {
      ...stubEnv("http://127.0.0.1:9/v1"),
      timeoutMs: 30_000,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("拒跑");
    expect(run.stderr).toContain("产物过期");
    expect(run.stderr).toContain("pnpm --filter @baize/review-pi build");
  } finally {
    utimesSync(entry, original, original);
  }
});

test("用法错误：缺 --mr-diff / --mr-json → exit 1 + 人话错误 + usage 文案 + stdout 干净", async () => {
  const run = await runBin(["review", "--repo", repoFixturePath("sample")], {
    ...stubEnv("http://127.0.0.1:9/v1"),
    timeoutMs: 30_000,
  });
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("review-pi:");
  expect(run.stderr).toContain("usage:");
});

// ---- version 命令面（ADR-0079）----

test("version：stdout 单行、exit 0、不加载配置（无缺配置提示 / 不读 .env.local）", async () => {
  const run = await runBin(["--version"], {
    appendConfigArg: false,
    seedEnvLocal: "REVIEWER_API_KEY=sk-should-not-be-read",
    timeoutMs: 30_000,
  });
  expect(run.status).toBe(0);
  expect(run.stdout).toBe(`review-pi ${REVIEW_PI_VERSION}\n`);
  // 版本命令在配置装载之前返回：沙箱 HOME 里没有配置文件，也不该出现提示
  expect(run.stderr).toBe("");
  expect(run.stderr).not.toContain("未找到用户级配置文件");
  expect(run.stderr).not.toContain(".env.local");
});

test("version --json：产品 / Node / 内核四包实际解析版本；stdout 单个 JSON 文档", async () => {
  const run = await runBin(["version", "--json"], {
    appendConfigArg: false,
    timeoutMs: 30_000,
  });
  expect(run.status).toBe(0);
  expect(run.stderr).toBe("");
  const parsed = JSON.parse(run.stdout) as {
    name: string;
    version: string;
    node: string;
    kernel: Record<string, string | null>;
  };
  expect(parsed.name).toBe("@baize/review-pi");
  expect(parsed.version).toBe(REVIEW_PI_VERSION);
  expect(parsed.node).toBe(process.version);
  expect(Object.keys(parsed.kernel)).toEqual([...KERNEL_PACKAGES]);
  // 本仓安装布局下四包都在位（自愈构建钩子已保证）：实际解析到的就是锁定的 0.85.1
  for (const specifier of KERNEL_PACKAGES) {
    expect(parsed.kernel[specifier]).toMatch(/^\d+\.\d+\.\d+/);
  }
});

test("version 用法错误：未知旗标 / 重复 --json → exit 1 + usage + stdout 干净", async () => {
  const unknown = await runBin(["version", "--config", "x.jsonc"], {
    appendConfigArg: false,
    timeoutMs: 30_000,
  });
  expect(unknown.status).toBe(1);
  expect(unknown.stdout).toBe("");
  expect(unknown.stderr).toContain('unknown flag "--config"');
  expect(unknown.stderr).toContain("usage:");

  const duplicate = await runBin(["version", "--json", "--json"], {
    appendConfigArg: false,
    timeoutMs: 30_000,
  });
  expect(duplicate.status).toBe(1);
  expect(duplicate.stdout).toBe("");
  expect(duplicate.stderr).toContain("duplicate flag --json");
});

test("运行失败：--repo 指向文件（非目录）→ exit 1 + 错误人话 + stdout 干净", async () => {
  const notADir = path.join(makeTempDir("review-pi-cli-repo-"), "plain.txt");
  writeFileSync(notADir, "not a directory", "utf8");
  const run = await runBin(
    [
      "review",
      "--repo",
      notADir,
      "--mr-diff",
      path.join(path.dirname(notADir), "x.diff"),
      "--taskId",
      CLI_TASK_ID,
    ],
    { ...stubEnv("http://127.0.0.1:9/v1"), timeoutMs: 30_000 },
  );
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("--repo is not a directory");
});

// ---- smoke 命令面 ----

test("smoke 子命令：双探针通过 → exit 0 + stdout 人话报告；哨兵只进 Authorization 头", async () => {
  const stub = await startLoopbackStub([]);
  try {
    const run = await runBin(["smoke"], stubEnv(stub.baseUrl));

    expect(run.status).toBe(0);
    // 人话报告（stdout）：OK 结论 + 双探针行
    expect(run.stdout).toContain(`smoke probes at ${stub.baseUrl} (model ${REVIEW_MODEL_ID}): OK`);
    expect(run.stdout).toContain("[1/2] gateway health:");
    expect(run.stdout).toContain("[2/2] model reachability:");
    // 双探针各一请求，均带哨兵 Authorization 头
    const requests = stub.requests();
    expect(requests).toHaveLength(2);
    for (const request of requests) {
      expect(request.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
    }
    expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }]);
  } finally {
    await stub.close();
  }
});

test("smoke 子命令：网关不可达 → exit 1 + 人话诊断（健康探针失败，模型探针跳过）", async () => {
  // 死端口（无监听）：连接拒绝即失败，不依赖超时
  const run = await runBin(["smoke"], { ...stubEnv("http://127.0.0.1:9/v1"), timeoutMs: 60_000 });

  expect(run.status).toBe(1);
  expect(run.stdout).toContain("FAILED");
  expect(run.stdout).toContain("gateway unreachable at http://127.0.0.1:9/v1");
  expect(run.stdout).toContain("skipped: the gateway is unreachable");
});

// ---- 规则 Skill 目录形态（ADR-0018：--rule-skill） ----

/** 规则 Skill 目录形态零候选脚本：4 相位 OK + Phase-5 空候选 + N 个 skill 会话空候选 + Phase-6 空裁决 */
function ruleSkillDirCorpus(skillSessions = 1): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [] }), usage: ZERO },
    ...Array.from({ length: skillSessions }, () => ({
      text: JSON.stringify({ candidates: [] }),
      usage: ZERO,
    })),
    { text: JSON.stringify({ verdicts: [], complete: true }), usage: ZERO },
  ];
}

test.each(["--rule-skill", "--skill"] as const)(
  "%s：已解压目录装载，审计标 kind = dir，副本落 run 缓存而非原地",
  async (flag) => {
    const stub = await startLoopbackStub(ruleSkillDirCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");
      const skillDir = path.join(packageDir, "testdata", "rule-skills", "general-code-review");

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          flag,
          skillDir,
          "--strict-rule-skill",
        ],
        stubEnv(stub.baseUrl),
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as { auditPath: string };
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        ruleSkill: { source: string; kind?: string; digest: string; name: string }[];
        skillPassLog?: { skill: string }[];
      };
      expect(audit.ruleSkill).toHaveLength(1);
      expect(audit.ruleSkill[0]).toMatchObject({ kind: "dir", name: "general-code-review" });
      expect(audit.ruleSkill[0]?.digest).toMatch(/^[0-9a-f]{64}$/);
      expect(audit.ruleSkill[0]?.source).toBe(skillDir.split(path.sep).join("/"));
      // 装载成功 = 会话真的跑了（round × skill 一条），不是"传了但没生效"
      expect(audit.skillPassLog).toHaveLength(1);

      // ADR-0020：skill 会话的首条 user 消息带宿主平台提示（转录里可核）
      const transcriptFile = collectFiles(outDir).find((file) =>
        /-skill-general-code-review-r1\.json$/.test(file),
      );
      expect(transcriptFile).toBeDefined();
      const transcript = readFileSync(transcriptFile as string, "utf8");
      expect(transcript).toContain("Host platform: ");
      expect(transcript).toContain("without a shell");

      const cacheDir = path.join(
        outDir,
        CLI_TASK_ID,
        ".cache",
        "rule-skills",
        `dir-${audit.ruleSkill[0]?.digest as string}`,
      );
      expect(existsSync(path.join(cacheDir, "SKILL.md"))).toBe(true);
      expect(existsSync(path.join(cacheDir, "rules"))).toBe(true);
      expect(existsSync(path.join(cacheDir, ".rule-skill-ready"))).toBe(true);
      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
      ]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- 同名 skill 优先级（--skill 覆盖 --rule-skill） ----

test(
  "同名 skill：--skill 传入的目录覆盖 --rule-skill 的版本（只保留一个会话）",
  async () => {
    const stub = await startLoopbackStub(ruleSkillDirCorpus(1));
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");
      const baseDir = path.join(packageDir, "testdata", "rule-skills", "general-code-review");
      const overrideDir = path.join(makeTempDir("review-pi-rule-override-"), "general-code-review");
      mkdirSync(overrideDir, { recursive: true });
      writeFileSync(
        path.join(overrideDir, "SKILL.md"),
        "---\nname: general-code-review\ndescription: Override pack.\n---\n\nOverride body.\n",
        "utf8",
      );

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--rule-skill",
          baseDir,
          "--skill",
          overrideDir,
          "--strict-rule-skill",
        ],
        stubEnv(stub.baseUrl),
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as { auditPath: string };
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        ruleSkill: { source: string; kind?: string; digest: string; name: string }[];
        skillPassLog?: { skill: string }[];
      };
      // 同名只保留一个：胜出者是 --skill 传入的目录（source 指向它）
      expect(audit.ruleSkill).toHaveLength(1);
      expect(audit.ruleSkill[0]).toMatchObject({ kind: "dir", name: "general-code-review" });
      expect(audit.ruleSkill[0]?.source).toBe(overrideDir.split(path.sep).join("/"));
      expect(audit.skillPassLog).toHaveLength(1);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "--rule-skill 1 个 + --skill 2 个（其中一个同名）：去重后只装载 2 个 skill，--skill 版本胜出",
  async () => {
    const stub = await startLoopbackStub(ruleSkillDirCorpus(2));
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");
      const baseDir = path.join(packageDir, "testdata", "rule-skills", "general-code-review");
      const overrideDir = path.join(makeTempDir("review-pi-rule-override-"), "general-code-review");
      mkdirSync(overrideDir, { recursive: true });
      writeFileSync(
        path.join(overrideDir, "SKILL.md"),
        "---\nname: general-code-review\ndescription: Override pack.\n---\n\nOverride body.\n",
        "utf8",
      );
      const extraDir = path.join(makeTempDir("review-pi-rule-extra-"), "general-code-review-extra");
      mkdirSync(extraDir, { recursive: true });
      writeFileSync(
        path.join(extraDir, "SKILL.md"),
        "---\nname: general-code-review-extra\ndescription: Extra pack.\n---\n\nExtra body.\n",
        "utf8",
      );

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          // 1 个 --rule-skill + 2 个 --skill，其中一个与 --rule-skill 同名
          "--rule-skill",
          baseDir,
          "--skill",
          `${overrideDir},${extraDir}`,
          "--strict-rule-skill",
        ],
        stubEnv(stub.baseUrl),
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as { auditPath: string };
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        ruleSkill: { source: string; kind?: string; digest: string; name: string }[];
        skillPassLog?: { skill: string }[];
      };
      // 3 个输入目录 → 2 个 skill：同名者只留在 --skill 传入的版本
      expect(audit.ruleSkill).toHaveLength(2);
      expect(audit.ruleSkill.map((entry) => entry.name).sort()).toEqual([
        "general-code-review",
        "general-code-review-extra",
      ]);
      const winner = audit.ruleSkill.find((entry) => entry.name === "general-code-review");
      expect(winner?.source).toBe(overrideDir.split(path.sep).join("/"));
      expect(winner?.digest).not.toBe("");
      expect(audit.ruleSkill.find((entry) => entry.name === "general-code-review-extra")?.source).toBe(
        extraDir.split(path.sep).join("/"),
      );
      // 去重后只有 2 个 skill 会话，不是 3 个
      expect(audit.skillPassLog).toHaveLength(2);
      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
      ]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "--rule-skill 与 --skill 传同一个目录（字面重复）：去重后只装载一次",
  async () => {
    const stub = await startLoopbackStub(ruleSkillDirCorpus(2));
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");
      const baseDir = path.join(packageDir, "testdata", "rule-skills", "general-code-review");
      const extraDir = path.join(makeTempDir("review-pi-rule-extra-"), "general-code-review-extra");
      mkdirSync(extraDir, { recursive: true });
      writeFileSync(
        path.join(extraDir, "SKILL.md"),
        "---\nname: general-code-review-extra\ndescription: Extra pack.\n---\n\nExtra body.\n",
        "utf8",
      );

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--rule-skill",
          baseDir,
          "--skill",
          `${baseDir},${extraDir}`,
          "--strict-rule-skill",
        ],
        stubEnv(stub.baseUrl),
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as { auditPath: string };
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        ruleSkill: { source: string; kind?: string; digest: string; name: string }[];
        skillPassLog?: { skill: string }[];
      };
      // 同一个目录出现两次，仍只算一个 skill
      expect(audit.ruleSkill).toHaveLength(2);
      expect(audit.ruleSkill.filter((entry) => entry.name === "general-code-review")).toHaveLength(1);
      expect(audit.skillPassLog).toHaveLength(2);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- 规则包缺值（B 档：按未传处理，但零静默） ----

test(
  "--rule-skill 缺值：按未传处理（exit 0）+ stderr 一行提示，不报用法错误",
  async () => {
    const stub = await startLoopbackStub(ruleSkillDirCorpus(0));
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          // 只给旗标、不给值（PowerShell 变量为空时就是这个形态）
          "--rule-skill",
        ],
        stubEnv(stub.baseUrl),
      );

      // 不再让整条命令起不来：照常检视、exit 0
      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain("requires a value");
      expect(run.stderr).toContain("review-pi: --rule-skill 缺少值，已忽略（本轮不装载该包）");
      // 零静默：紧接着那句「未装载任何规则包」要如实说「未传或缺值」
      expect(run.stderr).toContain("未装载任何规则包（--rule-skill-zip / --rule-skill / --skill 未传或缺值");

      // 审计里没有规则包条目、也没有 skill 会话 = 真的按「没传」跑了
      const outcome = JSON.parse(run.stdout) as { auditPath: string };
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        ruleSkill?: unknown[];
        skillPassLog?: unknown[];
      };
      expect(audit.ruleSkill).toEqual([]);
      expect(audit.skillPassLog ?? []).toEqual([]);
      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
      ]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- 规则包多值输入（ADR-0034：逗号列表） ----
test(
  "--rule-skill 逗号列表：一次传两个目录就是两个规则包，各自开会话（ADR-0034）",
  async () => {
    const stub = await startLoopbackStub(ruleSkillDirCorpus(2));
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");
      const skillDir = path.join(packageDir, "testdata", "rule-skills", "general-code-review");
      // 第二个目录必须换一个 skill 名：同名 skill 会按「后装载者胜出」去重（本轮口径）
      const altDir = path.join(makeTempDir("review-pi-rule-alt-"), "general-code-review-alt");
      mkdirSync(altDir, { recursive: true });
      writeFileSync(
        path.join(altDir, "SKILL.md"),
        "---\nname: general-code-review-alt\ndescription: Second pack.\n---\n\nSecond body.\n",
        "utf8",
      );

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--rule-skill",
          `${skillDir},${altDir}`,
          "--strict-rule-skill",
        ],
        stubEnv(stub.baseUrl),
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as { auditPath: string };
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        ruleSkill: { source: string; kind?: string; digest: string; name: string }[];
        skillPassLog?: { skill: string }[];
      };
      expect(audit.ruleSkill).toHaveLength(2);
      expect(audit.ruleSkill.map((entry) => entry.kind)).toEqual(["dir", "dir"]);
      expect(audit.skillPassLog).toHaveLength(2);
      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
      ]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- 运行进度投影（ADR-0016）进程面 ----

/** stdout 的键集（`ok` + ReviewOutcome）：进度绝不能新增键 */
const REVIEW_OUTCOME_KEYS = [
  "ok",
  "caseId",
  "runId",
  "truncated",
  "rounds",
  "toolCalls",
  "findings",
  "auditPath",
];

test(
  "进度缺省打印（非 TTY）：stderr 逐行投影阶段/请求/收尾摘要，stdout 仍是单 JSON 文档、键集不变",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
        ],
        stubEnv(stub.baseUrl),
      );

      expect(run.status).toBe(0);
      // stdout 契约零改动：单 JSON 文档、键集固定、无 progress 键
      const outcome = JSON.parse(run.stdout) as Record<string, unknown>;
      expect(Object.keys(outcome)).toEqual(REVIEW_OUTCOME_KEYS);
      expect(run.stdout.endsWith("}\n")).toBe(true);
      expect(run.stdout).not.toContain("\r");

      // stderr：事件行逐条追加（非 TTY 不画状态行）
      expect(run.stderr).toContain("▶ phase 1/6 Change Understanding (round 1)");
      expect(run.stderr).toContain("▶ phase 6/6 Evidence Verification (round 1)");
      expect(run.stderr).toContain("req 1 ");
      expect(run.stderr).toMatch(
        /✓ 完成 · 耗时 \d+\.\ds · 模型调用 6 次 · token 输入 [\d,]+（未命中） · 输出 [\d,]+ · 缓存命中 [\d,]+（[\d.]+%） · 工具 0 次（主会话 0 \+ 规则 Skill 0） · Ledger 命中 \d+ 次（未重复读取原文） · \$\d+\.\d{4}/,
      );
      expect(run.stderr).not.toContain("\r");
      // 进度只报计数与摘要：结果全文（findings 文本 / 工具结果）不落地 stderr
      expect(run.stderr).not.toContain("Sentinel finding description");
      expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "进度缺省打印（非 TTY）与 --no-progress 静音，但收尾摘要仍恒打一行；--progress 已移除 = 用法错误 exit 1",
  async () => {
    const quietStub = await startLoopbackStub([...oneFindingCorpus(), ...oneFindingCorpus()]);
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const outDir2 = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");
      const baseArgs = [
        "review",
        "--repo",
        repoFixturePath("sample"),
        "--mr-diff",
        mrFile,
        "--taskId",
        CLI_TASK_ID,
        "--tasks-dir",
        outDir,
      ];

      // 缺省（不传任何进度旗标）= 打印，不再看 stderr 是否 TTY
      const auto = await runBin(baseArgs, stubEnv(quietStub.baseUrl));
      expect(auto.status).toBe(0);
      expect(auto.stderr).toContain("▶ phase");
      expect(auto.stderr).toContain("req 1 ");
      // 进度关闭 ≠ 零输出：收尾摘要恒定打印（一行，避免「跑完什么都没说」）
      expect(auto.stderr).toContain("✓ 完成 · 耗时 ");
      // 阶段账本（最后一块）：总墙钟 + 主链路分段 + 审计明细，grep 前缀 [time]
      expect(auto.stderr).toContain("[time] 阶段耗时 | 总墙钟 ");
      expect(auto.stderr).toContain("[time] 阶段 | 六阶段审计 ");
      expect(auto.stderr).toContain("[time] 审计明细 | P1 ");
      expect(auto.stderr.indexOf("[time] 阶段耗时")).toBeGreaterThan(
        auto.stderr.indexOf("✓ 完成 · 耗时 "),
      );
      // 整任务 LLM 账本（ADR-0066）：在 [time] 块之后、恒走 stderr（因此进 review-pi.log）
      expect(auto.stderr).toContain("[usage] 任务总计 | 模型调用 ");
      expect(auto.stderr.indexOf("[usage] 任务总计")).toBeGreaterThan(
        auto.stderr.indexOf("[time] 阶段耗时"),
      );

      const explicitOff = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir2,
          "--no-progress",
        ],
        stubEnv(quietStub.baseUrl),
      );
      expect(explicitOff.status).toBe(0);
      expect(explicitOff.stderr).not.toContain("▶ phase");
      expect(explicitOff.stderr).not.toContain("req 1 ");
      expect(explicitOff.stderr).toContain("✓ 完成 · 耗时 ");
      // --no-progress 只静音事件行，收尾摘要与阶段账本照打
      expect(explicitOff.stderr).toContain("[time] 阶段耗时 | 总墙钟 ");
      expect(explicitOff.stderr).toContain("[usage] 任务总计 | 模型调用 ");

      // `--progress` 已移除（ADR-0055）：给迁移提示并 exit 1，不再静默接受
      const removed = await runBin([...baseArgs, "--progress"], {
        ...stubEnv(quietStub.baseUrl),
        timeoutMs: 30_000,
      });
      expect(removed.status).toBe(1);
      expect(removed.stdout).toBe("");
      expect(removed.stderr).toContain("--progress 已移除（ADR-0055）");
      expect(removed.stderr).toContain("usage:");
    } finally {
      await quietStub.close();
    }
  },
  240_000,
);

// ---- cwd session 索引 + export（ADR-0036）----
// 生产用法：在代码仓目录跑 review → cwd 落一份 `.review-pi-session.json`（绝对路径，
// 重复执行整份覆盖）→ `review-pi export` 直接读它打印主 / skill session。
// export 是纯文件系统命令：不加载配置、不需要 key、不调网关（这里把配置文件挪走、
// HOME 指向空沙箱来证明）。

test(
  "review 写好 cwd 索引；export 不读配置即可打印路径，--path 复制，--taskId 从任务目录反推",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const cwd = makeTempDir("review-pi-cli-index-");
      const outDir = makeTempDir("review-pi-cli-out-");
      const review = await runCliReview(
        outDir,
        writeMr(goldenFixture("vul4j-1.diff")),
        stubEnv(stub.baseUrl),
        { cwd },
      );
      expect(review.status).toBe(0);

      const indexPath = path.join(cwd, ".review-pi-session.json");
      expect(existsSync(indexPath)).toBe(true);
      const index = JSON.parse(readFileSync(indexPath, "utf8")) as {
        version: number;
        taskId: string;
        tasksDir: string;
        runId: string;
        repo: string;
        updatedAt: string;
        mains: string[];
        skills: string[];
      };
      const outcome = JSON.parse(review.stdout) as { runId: string };
      expect(index.version).toBe(2);
      expect(index.taskId).toBe(CLI_TASK_ID);
      expect(index.tasksDir).toBe(path.resolve(outDir));
      expect(index.runId).toBe(outcome.runId);
      // 绝对路径 + 指向真实文件（单遍 = 一条主会话 = session-<runId>.json）
      expect(index.mains).toHaveLength(1);
      const main = index.mains[0] as string;
      expect(path.isAbsolute(main)).toBe(true);
      expect(main).toBe(
        path.join(path.resolve(outDir), CLI_TASK_ID, "runs", `session-${outcome.runId}.json`),
      );
      expect(existsSync(main)).toBe(true);
      // 本次没装规则包 → 没有 skill 会话
      expect(index.skills).toEqual([]);
      // opencode-trace 留痕（ADR-0074）：run 时默认落盘 manifest.json + sessions/
      expect(existsSync(path.join(path.dirname(main), "opencode-trace", "manifest.json"))).toBe(true);

      // 配置文件缺席 + 空 HOME：export 仍应工作（不加载配置是硬约束）。
      // ADR-0072：缺省返回 OpenCode 兼容版（runs/opencode/），--native 返回原生。
      const compatMain = path.join(path.dirname(main), "opencode", path.basename(main));
      const absentConfig = path.join(cwd, "absent.jsonc");
      const exportRun = await runBin(["export"], {
        cwd,
        appendConfigArg: false,
        configPath: absentConfig,
        timeoutMs: 30_000,
      });
      expect(exportRun.status).toBe(0);
      expect(exportRun.stdout).toBe(`${compatMain}\n`);
      expect(exportRun.stderr).toBe("");

      const nativeRun = await runBin(["export", "--native"], {
        cwd,
        appendConfigArg: false,
        configPath: absentConfig,
        timeoutMs: 30_000,
      });
      expect(nativeRun.status).toBe(0);
      expect(nativeRun.stdout).toBe(`${main}\n`);

      // --path：平铺复制到 cwd 下的目录，返回复制后的绝对路径（--native 复制原生）
      const copyRun = await runBin(["export", "--native", "--path", "sessions"], {
        cwd,
        appendConfigArg: false,
        configPath: absentConfig,
        timeoutMs: 30_000,
      });
      const copied = path.join(cwd, "sessions", path.basename(main));
      expect(copyRun.status).toBe(0);
      expect(copyRun.stdout).toBe(`${copied}\n`);
      expect(readFileSync(copied, "utf8")).toBe(readFileSync(main, "utf8"));

      // --taskId：不经索引，直接读任务目录的 run.json（runId 由 auditPath 反推）
      const taskRun = await runBin(
        ["export", "--taskId", CLI_TASK_ID, "--tasks-dir", outDir, "--native"],
        { cwd, appendConfigArg: false, configPath: absentConfig, timeoutMs: 30_000 },
      );
      expect(taskRun.status).toBe(0);
      expect(taskRun.stdout).toBe(`${main}\n`);
      expectNoKeyLeak([
        { label: "export stdout", text: exportRun.stdout },
        { label: "export stderr", text: exportRun.stderr },
      ]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- 大 MR 分片（ADR-0039）进程面 ----
// 配置里把单片预算压到下限 10_000 字符；两文件 diff（各 < 10k、合计 > 10k）必然分两片。
// 断言：stderr 有一行片数提示 + 各事件带 [sN/M] 前缀；stdout 键集不变；
// run.json 有 shards[]；session 索引 v2 记两条主转录；export 按片顺序打印。

/** 两文件 diff：每块约 7.5k 字符（< 10k），合计 > 10k；变更行 182 < 200（不触发边界降级） */
function twoFileDiffForSharding(): string {
  const block = (name: string, marker: string): string =>
    [
      `diff --git a/${name} b/${name}`,
      `--- a/${name}`,
      `+++ b/${name}`,
      "@@ -1,2 +1,91 @@",
      `-old ${marker}`,
      `+new ${marker}`,
      ...Array.from(
        { length: 90 },
        (_, index) => `+padding ${marker} ${"x".repeat(45)} ${String(index)}`,
      ),
    ].join("\n");
  return [
    block("src/main/java/com/example/Alpha.java", "SHARD-ALPHA"),
    block("src/main/java/com/example/Beta.java", "SHARD-BETA"),
  ].join("\n");
}

test(
  "分片检视：stderr 报告片数与 [sN/M] 前缀，stdout 键集不变，run.json/索引/export 可寻址",
  async () => {
    // 一片 = 六回合检视；两片串行跑完后，收尾统一做一次 tips 语义生成（ADR-0065）。
    // 语料必须按「12 条检视 + 1 条 tips」排序——直接拼两个 oneFindingCorpus 会把
    // 第一份的 tips 回复错位插到第二片的第一回合。
    const reviewTurns = oneFindingCorpus().slice(0, 6);
    const tipsReply = oneFindingCorpus().slice(6);
    const corpus = [...reviewTurns, ...reviewTurns, ...tipsReply];
    const stub = await startLoopbackStub(corpus);
    try {
      const cwd = makeTempDir("review-pi-cli-shards-");
      const outDir = makeTempDir("review-pi-cli-out-");
      const diff = twoFileDiffForSharding();
      expect(diff.length).toBeGreaterThan(10_000);
      const mrFile = writeMr(diff);
      // 最小配置 + 分片预算压到下限（其余项走缺省）
      const configText = `${JSON.stringify(
        {
          version: 1,
          reviewer: { apiKey: SENTINEL_KEY, baseUrl: stub.baseUrl },
          limits: { split: { maxShardChars: 10_000 }, findingScope: { enabled: false } },
        },
        null,
        2,
      )}\n`;
      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
        ],
        { cwd, configText },
      );

      expect(run.status).toBe(0);
      // stdout 契约零改动
      const outcome = JSON.parse(run.stdout) as Record<string, unknown> & {
        findings: { id: string }[];
        runId: string;
      };
      expect(Object.keys(outcome)).toEqual(REVIEW_OUTCOME_KEYS);
      // 两片各产同一条候选（同 file/line/title）→ 合并为一条
      expect(outcome.findings).toHaveLength(1);

      // stderr：片数提示 + 两片的事件行都有前缀
      expect(run.stderr).toContain("review-pi: 分片检视 2 片（单片上限 10000 字符）");
      expect(run.stderr).toContain("[s1/2] ▶ phase 1/6 Change Understanding (round 1)");
      expect(run.stderr).toContain("[s2/2] ▶ phase 1/6 Change Understanding (round 1)");
      expect(run.stderr).not.toContain("\r");

      // run.json：聚合记录带 shards[]，每片转录文件存在
      const runsDir = cliRunsDir(outDir);
      const record = JSON.parse(readFileSync(path.join(runsDir, "run.json"), "utf8")) as {
        shards: { index: number; runId: string; transcriptFile: string }[];
      };
      expect(record.shards.map((shard) => shard.index)).toEqual([1, 2]);
      for (const shard of record.shards) {
        expect(existsSync(path.join(runsDir, shard.transcriptFile))).toBe(true);
      }

      // session 索引 v2：两条主转录（按片序），无 skill
      const index = JSON.parse(readFileSync(path.join(cwd, ".review-pi-session.json"), "utf8")) as {
        version: number;
        mains: string[];
        skills: string[];
      };
      expect(index.version).toBe(2);
      expect(index.mains).toHaveLength(2);
      expect(index.skills).toEqual([]);

      // export（不读配置）：按片序打印两条主转录（单行、逗号 + 空格分隔）。
      // ADR-0072：缺省 = OpenCode 兼容版（各片 runs/shards/…/opencode/）。
      const exportRun = await runBin(["export"], {
        cwd,
        appendConfigArg: false,
        configPath: path.join(cwd, "absent.jsonc"),
        timeoutMs: 30_000,
      });
      expect(exportRun.status).toBe(0);
      const compatMains = index.mains.map((file: string) =>
        path.join(path.dirname(file), "opencode", path.basename(file)),
      );
      expect(exportRun.stdout).toBe(`${compatMains.join(", ")}\n`);

      // 生命周期聚合会话（ADR-0073）：opencode/lifecycle-<runId>.json 存在，
      // 各 shard 主会话的 parentID 指向它（成为其子会话）。
      const lifecycleFile = path.join(runsDir, "opencode", `session-${outcome.runId}-lifecycle.json`);
      expect(existsSync(lifecycleFile)).toBe(true);
      for (const main of index.mains) {
        const compat = JSON.parse(
          readFileSync(path.join(path.dirname(main), "opencode", path.basename(main)), "utf8"),
        ) as { info: { parentID?: string } };
        expect(compat.info.parentID).toBe(`session-${outcome.runId}-lifecycle`);
      }

      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
        { label: "export stdout", text: exportRun.stdout },
      ]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- MCP 业务 tool（ADR-0045）：任务生命周期 + 片级结果 + 总结 ----

/** MCP stub 收到的 tools/call 记录 */
interface McpToolCall {
  readonly name: string;
  readonly args: Record<string, unknown>;
}

interface McpStub {
  /** JSON-RPC 端点 URL（写进配置 `mcp.servers.<name>.url`） */
  readonly url: string;
  readonly toolCalls: () => readonly McpToolCall[];
  readonly close: () => Promise<void>;
}

/**
 * 回环 MCP stub：initialize → 结果；notifications（无 id）→ 202；
 * tools/call → 记录 + 成功（`failTools` 里的名字回 isError）。
 * 事件批量通道（report_events）与业务 tool 同一服务端。
 *
 * `options.initializeStatus` 可让 stub 对 `initialize` 回非 2xx——模拟「只实现
 * tools/call 的定制服务端」（Postman 单发能通、握手不通），验证无状态降级。
 */
function startMcpStub(
  failTools: readonly string[] = [],
  options: { readonly initializeStatus?: number } = {},
): Promise<McpStub> {
  const calls: McpToolCall[] = [];
  const server = http.createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => {
      chunks.push(chunk);
    });
    request.on("end", () => {
      const message = JSON.parse(Buffer.concat(chunks).toString("utf8")) as {
        id?: number;
        method?: string;
        params?: { name?: unknown; arguments?: unknown };
      };
      if (message.id === undefined) {
        response.writeHead(202);
        response.end();
        return;
      }
      if (message.method === "initialize" && options.initializeStatus !== undefined) {
        response.writeHead(options.initializeStatus);
        response.end();
        return;
      }
      let result: unknown;
      if (message.method === "initialize") {
        result = { protocolVersion: "2025-06-18", serverInfo: { name: "stub", version: "1" } };
      } else if (message.method === "tools/call") {
        const name = String(message.params?.name ?? "");
        calls.push({
          name,
          args: (message.params?.arguments ?? {}) as Record<string, unknown>,
        });
        result = failTools.includes(name)
          ? { content: [{ type: "text", text: "tool rejected" }], isError: true }
          : { content: [{ type: "text", text: "ok" }] };
      } else {
        response.writeHead(404, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: { message: `unexpected ${message.method}` } }));
        return;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
  });
  return new Promise<McpStub>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        url: `http://127.0.0.1:${port}/mcp`,
        toolCalls: () => calls.map((call) => ({ ...call, args: { ...call.args } })),
        close: () =>
          new Promise<void>((closed) => {
            server.closeAllConnections?.();
            server.close(() => closed());
          }),
      });
    });
  });
}

const ZERO_USAGE_REPLY = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;

/**
 * 报文回复（ADR-0045 决策 4 修订）：模型只出**语义字段**（按 finding id 对齐）；
 * code / filePath / lineNum / level / ruleId 由 CLI 确定性组装。
 */
function payloadReplyForSentinelFinding(): string {
  return payloadReplyForFinding("F100");
}

/** 同一份语义回复，按 finding id 指定（ADR-0058 分批重试时每批只含自己的 id） */
function payloadReplyForFinding(id: string): string {
  return JSON.stringify({
    tips: [
      {
        id,
        category: "可靠性",
        subcategory: "测试桩",
        review: "[可靠性] 测试桩意见。影响评估：仅测试。",
        suggestion: "[重构思路] 无。代码示例：```无```",
      },
    ],
  });
}

/** 非流式一次性模型调用（报文 / 总结）计数 */
function countOneShotGatewayCalls(stub: LoopbackStub): number {
  return stub
    .requests()
    .filter(
      (record) =>
        record.method === "POST" &&
        record.url === "/v1/chat/completions" &&
        (record.body as { stream?: boolean } | undefined)?.stream === false,
    ).length;
}

test(
  "MCP 业务 tool：startTask → mrReviewResult → saveReviewSummary → endTask 按序上报，exit 0",
  async () => {
    const stub = await startLoopbackStub([
      ...oneFindingCorpusForReport(),
      { text: payloadReplyForSentinelFinding(), usage: ZERO_USAGE_REPLY },
      { text: "# 检视总结\n\n测试桩总结。", usage: ZERO_USAGE_REPLY },
    ]);
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runCliReview(outDir, mrFile, {
        gatewayBaseUrl: stub.baseUrl,
        mcpServerUrl: mcp.url,
        mcpEventTool: "report_events",
        // 用 30ms 覆盖测试缺省的 0：验证两段沉降的日志点确实在
        // mrReviewResult→summary 与 summary→endTask 之间触发。
        env: { PIAGENT_TEST_TASK_TOOL_SETTLE_MS: "30" },
      });

      // 旁路纪律：exit 0，stdout 键集不受影响
      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as Record<string, unknown>;
      expect("findings" in outcome).toBe(true);

      // 顺序契约（ADR-0045 决策 2）：start → mrReviewResult（有意见的文件）→
      // mrReviewResult（本片其余文件，reviewTips: []）→ saveReviewSummary → end
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);

      // 参数形状：平铺、taskId 同值直传；结构字段由代码组装（真源行 / P2→Minor）
      expect(business[0]?.args).toEqual({ taskId: CLI_TASK_ID });
      expect(business[1]?.args).toMatchObject({ taskId: CLI_TASK_ID, filePath: "README.md" });
      const tips = (business[1]?.args.reviewTips ?? []) as Record<string, unknown>[];
      expect(tips).toHaveLength(1);
      expect(tips[0]).toMatchObject({
        code: "Sample repository for Zone B tests.", // CLI 按 --repo 抽的 README.md:1
        category: "可靠性",
        level: "Minor", // severity P2 → Minor（Q18 四档映射）
        ruleId: null, // id 无 RULE-CHECK@ 前缀 = 非规则会话产出
        lineNum: "1",
      });
      // 本片 diff 里的另一个文件没有意见 → 也按文件上报，reviewTips 为空
      expect(business[2]?.args).toEqual({
        taskId: CLI_TASK_ID,
        filePath: "src/main/java/com/alibaba/fastjson/serializer/ObjectArrayCodec.java",
        reviewTips: [],
      });
      expect(business[3]?.args).toMatchObject({ taskId: CLI_TASK_ID });
      expect(String(business[3]?.args.markdownContent)).toContain("# 检视总结");
      expect(business[4]?.args).toEqual({ taskId: CLI_TASK_ID });

      // 业务调用留痕（mcp.json）：与 session 转录同目录，四个 tool 的输入 /
      // 输出 / 调用时间齐备；mrReviewResult 按实际调用次数逐条记录。
      const mcpLogPath = path.join(cliRunsDir(outDir), "mcp.json");
      expect(existsSync(mcpLogPath)).toBe(true);
      const mcpLog = JSON.parse(readFileSync(mcpLogPath, "utf8")) as {
        version: number;
        taskId: string;
        calls: {
          tool: string;
          startedAt: string;
          durationMs: number;
          ok: boolean;
          input: Record<string, unknown>;
          output: { ok: boolean; reason?: string; response?: string };
        }[];
      };
      expect(mcpLog.version).toBe(1);
      expect(mcpLog.taskId).toBe(CLI_TASK_ID);
      expect(mcpLog.calls.map((call) => call.tool)).toEqual([
        "startTask",
        "mrReviewResult",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(mcpLog.calls[0]?.input).toEqual({ taskId: CLI_TASK_ID });
      expect(mcpLog.calls[1]?.input).toMatchObject({
        taskId: CLI_TASK_ID,
        filePath: "README.md",
      });
      expect(mcpLog.calls.every((call) => call.ok)).toBe(true);
      expect(mcpLog.calls.every((call) => Number.isFinite(call.durationMs) && call.durationMs >= 0)).toBe(true);
      expect(
        mcpLog.calls.every((call) => !Number.isNaN(Date.parse(call.startedAt))),
      ).toBe(true);
      // 服务端回包原文一并留痕（stub 统一回 ok 文本）
      expect(mcpLog.calls[0]?.output.response).toBeTypeOf("string");

      // 批量事件通道照常（run.start / run.end 至少一批）
      const eventBatches = mcp.toolCalls().filter((call) => call.name === "report_events");
      expect(eventBatches.length).toBeGreaterThanOrEqual(1);

      // stderr 可见性：片级上报一行（2 文件：1 个有意见 + 1 个空 tips）+
      // saveReviewSummary 心跳
      expect(run.stderr).toContain("MCP mrReviewResult 已上报 2 文件 / 1 条意见");
      expect(run.stderr).toContain("MCP saveReviewSummary 生成中");
      // 两段固定沉降（ADR-0053）都在 stderr 可见：片级结果 → 总结 → endTask
      expect(run.stderr).toContain("MCP 固定等待 30ms（mrReviewResult → saveReviewSummary）");
      expect(run.stderr).toContain("MCP 固定等待 30ms（saveReviewSummary → endTask）");

      // 一次性模型调用走同一网关（非流式）：报文 + 总结各一条
      expect(countOneShotGatewayCalls(stub)).toBe(2);

      // 统一 tips（ADR-0045）：无 engine 也产出 reviews_tips_zh.json（12 键，
      // 与 mrReviewResult 同一份生成）；cwd 副本 review-result.json 逐字节相同
      const tipsPath = path.join(outDir, CLI_TASK_ID, "runs", "reviews_tips_zh.json");
      expect(existsSync(tipsPath)).toBe(true);
      const tipsDoc = JSON.parse(readFileSync(tipsPath, "utf8")) as {
        filePath: string;
        reviewTips: Record<string, unknown>[];
      }[];
      expect(tipsDoc).toHaveLength(1);
      expect(tipsDoc[0]?.filePath).toBe("README.md");
      const tip = tipsDoc[0]?.reviewTips[0];
      expect(tip).toMatchObject({
        id: "F100", // 单遍路径不重编号
        code: "Sample repository for Zone B tests.",
        review: "[可靠性] 测试桩意见。影响评估：仅测试。",
        suggestion: "[重构思路] 无。代码示例：```无```",
        category: "可靠性",
        subcategory: "测试桩",
        severity: "Minor", // P2 → Minor（ADR-0052 四档，与 level 同值）
        level: "Minor", // P2 → 四档（Q18）
        ruleId: "",
        lineNum: 1,
        source: "common-reviewer",
        confidence: "Medium", // 0.5
      });
      // 只增不删：12 键
      expect(Object.keys(tip ?? {}).sort()).toEqual(
        [
          "category",
          "code",
          "confidence",
          "id",
          "level",
          "lineNum",
          "review",
          "ruleId",
          "source",
          "severity",
          "subcategory",
          "suggestion",
        ].sort(),
      );
      const cwdCopy = path.join(run.cwd, "review-result.json");
      expect(existsSync(cwdCopy)).toBe(true);
      expect(readFileSync(cwdCopy, "utf8")).toBe(readFileSync(tipsPath, "utf8"));

      // 置信度过滤留痕（ADR-0052）：阈值恒写，丢弃 0 条（0.5 = 阈值，保留）
      const auditDir = path.join(outDir, CLI_TASK_ID, "audit");
      const auditFile = readdirSync(auditDir)[0] as string;
      const audit = JSON.parse(readFileSync(path.join(auditDir, auditFile), "utf8")) as {
        tipsFilter?: unknown;
        severityFilter?: unknown;
      };
      expect(audit.tipsFilter).toEqual({ minConfidence: 0.5, droppedTips: 0 });
      expect(audit.severityFilter).toEqual({ minSeverity: "P3", droppedTips: 0 });
      const record = JSON.parse(
        readFileSync(path.join(outDir, CLI_TASK_ID, "runs", "run.json"), "utf8"),
      ) as { baseline: { audit: { tipsFilter?: unknown; severityFilter?: unknown } } };
      expect(record.baseline.audit.tipsFilter).toEqual({ minConfidence: 0.5, droppedTips: 0 });
      expect(record.baseline.audit.severityFilter).toEqual({ minSeverity: "P3", droppedTips: 0 });

      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
      ]);
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "ADR-0078：全部变更文件被预过滤剔除 → 跳过检视（一次空意见 + 固定总结），exit 0",
  async () => {
    const stub = await startLoopbackStub(noFindingCorpus());
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = writeMr(
        [
          "diff --git a/src/test/java/FooTest.java b/src/test/java/FooTest.java",
          "--- a/src/test/java/FooTest.java",
          "+++ b/src/test/java/FooTest.java",
          "@@ -1 +1 @@",
          "-class FooTest {}",
          "+class FooTest { }",
        ].join("\n"),
      );

      const run = await runCliReview(outDir, mrFile, {
        ...stubEnv(stub.baseUrl),
        mcpServerUrl: mcp.url,
      });

      expect(run.status).toBe(0);
      // 过滤后无可检视文件：不跑检视，只保证四个业务工具齐全（ADR-0078 对齐 ADR-0075）
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(business[1]?.args).toEqual({
        taskId: CLI_TASK_ID,
        filePath: "src/test/java/FooTest.java",
        reviewTips: [],
      });
      expect(business[2]?.args.markdownContent).toContain("无可检视文件");
      expect(run.stderr).toContain("跳过检视");
      expect(stub.requests()).toHaveLength(0);

      // 跳过路径不写 run 产物
      expect(existsSync(path.join(cliRunsDir(outDir), "reviews_tips_zh.json"))).toBe(false);
      const outcome = JSON.parse(run.stdout) as { skipped?: string; findings: unknown[] };
      expect(outcome.skipped).toBe("no-reviewable-files");
      expect(outcome.findings).toEqual([]);
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "limits.mrFilter.excludeGlobs（ADR-0069）：命中 glob 的文件不进检视、仍补报空意见，exit 0",
  async () => {
    const stub = await startLoopbackStub(noFindingCorpus());
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const keep = "src/main/java/Keep.java";
      const mrFile = writeMr(
        [
          `diff --git a/${keep} b/${keep}`,
          `--- a/${keep}`,
          `+++ b/${keep}`,
          "@@ -1 +1 @@",
          "-class Keep {}",
          "+class Keep { }",
          "diff --git a/docs/guide.md b/docs/guide.md",
          "--- a/docs/guide.md",
          "+++ b/docs/guide.md",
          "@@ -1 +1 @@",
          "-old",
          "+new",
        ].join("\n"),
      );

      const run = await runCliReview(outDir, mrFile, {
        gatewayBaseUrl: stub.baseUrl,
        configText: JSON.stringify({
          version: 1,
          reviewer: { apiKey: SENTINEL_KEY, baseUrl: stub.baseUrl },
          limits: { findingScope: { enabled: false }, mrFilter: { excludeGlobs: ["**/*.md"] } },
          mcp: {
            servers: {
              stub: { transport: "http", url: mcp.url, headers: {}, timeoutMs: 10_000 },
            },
            report: { server: "stub" },
          },
        }),
        mcpServerUrl: mcp.url,
      });

      expect(run.status).toBe(0);
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(business[1]?.args).toEqual({
        taskId: CLI_TASK_ID,
        filePath: keep,
        reviewTips: [],
      });
      expect(business[2]?.args).toEqual({
        taskId: CLI_TASK_ID,
        filePath: "docs/guide.md",
        reviewTips: [],
      });
      expect(run.stderr).toContain("exclude=1");
      expect(run.stderr).toContain("已补报 1 个变更文件 / 0 条意见");

      const tipsPath = path.join(cliRunsDir(outDir), "reviews_tips_zh.json");
      expect(JSON.parse(readFileSync(tipsPath, "utf8"))).toEqual([]);
      const outcome = JSON.parse(run.stdout) as { findings: unknown[] };
      expect(outcome.findings).toEqual([]);
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "MCP 变更文件全覆盖（ADR-0068）：被过滤文件补报一次、已检视文件不重复上报",
  async () => {
    const stub = await startLoopbackStub(noFindingCorpus());
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const keep = "src/main/java/Keep.java";
      const drop = "src/test/java/DropTest.java";
      const mrFile = writeMr(
        [
          `diff --git a/${keep} b/${keep}`,
          `--- a/${keep}`,
          `+++ b/${keep}`,
          "@@ -1 +1 @@",
          "-class Keep {}",
          "+class Keep { }",
          `diff --git a/${drop} b/${drop}`,
          `--- a/${drop}`,
          `+++ b/${drop}`,
          "@@ -1 +1 @@",
          "-class DropTest {}",
          "+class DropTest { }",
        ].join("\n"),
      );

      const run = await runCliReview(outDir, mrFile, {
        ...stubEnv(stub.baseUrl),
        mcpServerUrl: mcp.url,
      });

      expect(run.status).toBe(0);
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      // 每个变更文件恰好一条：先片级（被检视的 Keep），再收尾补报（被过滤的 DropTest）
      expect(business.filter((call) => call.name === "mrReviewResult").map((call) => call.args.filePath)).toEqual([
        keep,
        drop,
      ]);
      expect(business[1]?.args).toEqual({ taskId: CLI_TASK_ID, filePath: keep, reviewTips: [] });
      expect(business[2]?.args).toEqual({ taskId: CLI_TASK_ID, filePath: drop, reviewTips: [] });
      expect(run.stderr).toContain("已上报 1 文件 / 0 条意见");
      expect(run.stderr).toContain("已补报 1 个变更文件 / 0 条意见");
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "报文生成失败后按条数二分重试：两批都成功 → 两个文件都上报（ADR-0058）",
  async () => {
    const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
    const alpha = "src/main/java/com/example/Alpha.java";
    const beta = "src/main/java/com/example/Beta.java";
    const candidates = [alpha, beta].map((file, index) => ({
      id: `F10${String(index)}`,
      severity: "P2",
      category: "correctness",
      file,
      line: 3,
      title: `Sentinel finding in ${file}`,
      description: "Sentinel finding description",
      evidence: [`${file}:3`],
      rule: "sentinel-rule",
      confidence: 0.5,
    }));
    const stub = await startLoopbackStub([
      ...oneFindingCorpusForReport().map((reply, index) =>
        // 前 4 个相位回复沿用单 finding 语料；第 5/6 条换成两文件候选与裁决
        index < 4
          ? reply
          : index === 4
            ? { text: JSON.stringify({ candidates }), usage: ZERO }
            : {
                text: JSON.stringify({
                  verdicts: candidates.map((candidate) => ({
                    id: candidate.id,
                    pass: true,
                    reason: "stub verdict",
                  })),
                  complete: true,
                }),
                usage: ZERO,
              },
      ),
      // 全量报文：非法 JSON（非重试类失败）→ 触发二分
      { text: "这不是 JSON", usage: ZERO },
      { text: payloadReplyForFinding("F100"), usage: ZERO },
      { text: payloadReplyForFinding("F101"), usage: ZERO },
      { text: "# 检视总结", usage: ZERO },
    ]);
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = writeMr(goldenFixture("two-file-shard.diff"));

      const run = await runCliReview(outDir, mrFile, {
        gatewayBaseUrl: stub.baseUrl,
        mcpServerUrl: mcp.url,
      });

      expect(run.status).toBe(0);
      // 拆分留痕：两批都成功，两个文件各自上报（按文件粒度不变）
      expect(run.stderr).toContain(
        "MCP mrReviewResult 报文生成失败，已拆分为 2 批重试（2 批成功）",
      );
      expect(run.stderr).toContain("MCP mrReviewResult 已上报 2 文件 / 2 条意见");
      expect(run.stderr).not.toContain("跳过本片有意见文件");
      // ADR-0057：两条都成功上报，总结不再报「未上报」
      expect(run.stderr).not.toContain("未上报");

      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(business[1]?.args).toMatchObject({
        taskId: CLI_TASK_ID,
        filePath: alpha,
      });
      expect(business[2]?.args).toMatchObject({
        taskId: CLI_TASK_ID,
        filePath: beta,
      });
      expect((business[1]?.args.reviewTips as unknown[]).length).toBe(1);
      expect((business[2]?.args.reviewTips as unknown[]).length).toBe(1);

      // 中文 tips 同源：两个文件组都落盘（统一生成，不是引擎回落）
      const tipsPath = path.join(cliRunsDir(outDir), "reviews_tips_zh.json");
      const tipsDoc = JSON.parse(readFileSync(tipsPath, "utf8")) as {
        filePath: string;
        reviewTips: { id: string; lineNum: number }[];
      }[];
      expect(tipsDoc.map((entry) => entry.filePath)).toEqual([alpha, beta]);
      expect(tipsDoc.flatMap((entry) => entry.reviewTips).map((tip) => tip.id)).toEqual([
        "F100",
        "F101",
      ]);

      // 一次性调用：失败的全量 1 + 两个半批 2 + 总结 1
      expect(countOneShotGatewayCalls(stub)).toBe(4);
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "mcp.report.task = false：四个业务 tool 一个都不调（只发进度事件）",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runCliReview(outDir, mrFile, {
        gatewayBaseUrl: stub.baseUrl,
        mcpServerUrl: mcp.url,
        mcpEventTool: "report_events",
        mcpTask: false,
      });

      expect(run.status).toBe(0);
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business).toEqual([]);
      // 事件通道照常；业务 tool 全关，但本地统一 tips 仍会做一次语义生成（ADR-0065）
      expect(mcp.toolCalls().some((call) => call.name === "report_events")).toBe(true);
      expect(countOneShotGatewayCalls(stub)).toBe(1);
      expect(existsSync(path.join(cliRunsDir(outDir), "reviews_tips_zh.json"))).toBe(true);
      expect(run.stderr).not.toContain("mrReviewResult");
      expect(run.stderr).not.toContain("saveReviewSummary");
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "startTask 失败（isError）：旁路继续、exit 0，endTask 不补发（Q4：只在成功发出过时）",
  async () => {
    const stub = await startLoopbackStub([
      ...oneFindingCorpusForReport(),
      { text: payloadReplyForSentinelFinding(), usage: ZERO_USAGE_REPLY },
      { text: "# 检视总结", usage: ZERO_USAGE_REPLY },
    ]);
    const mcp = await startMcpStub(["startTask"]);
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runCliReview(outDir, mrFile, {
        gatewayBaseUrl: stub.baseUrl,
        mcpServerUrl: mcp.url,
      });

      expect(run.status).toBe(0);
      expect(run.stderr).toContain("MCP startTask 失败");
      const names = mcp
        .toolCalls()
        .filter((call) => call.name !== "report_events")
        .map((call) => call.name);
      // startTask 失败了，但后续业务调用照常尝试（旁路不级联压制）；
      // endTask 不补发（没有「结束一个从未开始的 task」）
      expect(names).toEqual([
        "startTask",
        "mrReviewResult",
        "mrReviewResult",
        "saveReviewSummary",
      ]);
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "MCP 建连前移到读 diff 之前（ADR-0045 Q2）：预检失败也先见到 MCP 行",
  async () => {
    // MCP 指向不存在的端口：建连失败要降级为一行 stderr，而不是让检视起不来
    const run = await runBin(
      [
        "review",
        "--repo",
        repoFixturePath("sample"),
        "--mr-diff",
        path.join(makeTempDir("review-pi-cli-mr-"), "absent.diff"),
        "--taskId",
        CLI_TASK_ID,
        "--tasks-dir",
        makeTempDir("review-pi-cli-out-"),
      ],
      { mcpServerUrl: "http://127.0.0.1:1/mcp" },
    );

    // diff 缺失 → exit 1；但 MCP 建连失败的提示必须已经打出来（顺序：建连 → 读 diff）
    expect(run.status).toBe(1);
    expect(run.stderr).toContain("MCP 上报不可用");
    expect(run.stderr).toContain("ENOENT");
    // 建连失败 ⇒ 没有业务调用、没有 startTask 提示
    expect(run.stderr).not.toContain("startTask");
  },
  60_000,
);

// ---- 统一 tips（ADR-0045 Q21-Q26）：mrReviewResult 与 reviews_tips_zh.json 同源复用 ----

/** 单片六相位语料：Phase 5 出一条指向真实文件的候选（code 有真源行） */
function shardCorpusWithFinding(id: string, file: string): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const candidate = {
    id,
    severity: "P2",
    category: "correctness",
    file,
    line: 3,
    title: `Sentinel finding in ${file}`,
    description: "Sentinel finding description",
    evidence: [`${file}:3`],
    rule: "sentinel-rule",
    confidence: 0.5,
  };
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [candidate] }), usage: ZERO },
    {
      text: JSON.stringify({ verdicts: [{ id, pass: true, reason: "stub verdict" }], complete: true }),
      usage: ZERO,
    },
  ];
}

const ALPHA = "src/main/java/com/example/Alpha.java";
const BETA = "src/main/java/com/example/Beta.java";

test(
  "统一 tips 尽力而为（Q26b）：s02 生成失败 → tips 只含 s01 文件组，mrReviewResult 覆盖两片（s02 补空包，ADR-0061）",
  async () => {
    // 片间串行 await：语料顺序 = s01 六相位 → s01 报文 → s02 六相位 → s02 报文（垃圾）→ 总结
    const stub = await startLoopbackStub([
      ...shardCorpusWithFinding("F100", ALPHA),
      { text: payloadReplyForSentinelFinding(), usage: ZERO_USAGE_REPLY },
      ...shardCorpusWithFinding("F100", BETA),
      { text: "这不是 JSON", usage: ZERO_USAGE_REPLY },
      { text: "# 检视总结", usage: ZERO_USAGE_REPLY },
    ]);
    const mcp = await startMcpStub();
    try {
      const cwd = makeTempDir("review-pi-cli-cwd-");
      const outDir = makeTempDir("review-pi-cli-out-");
      const configText = `${JSON.stringify(
        {
          version: 1,
          reviewer: { apiKey: SENTINEL_KEY, baseUrl: stub.baseUrl },
          limits: { split: { maxShardChars: 10_000 }, findingScope: { enabled: false } },
          mcp: {
            servers: { stub: { transport: "http", url: mcp.url, headers: {}, timeoutMs: 10_000 } },
            report: { server: "stub", tool: "report_events" },
          },
        },
        null,
        2,
      )}\n`;
      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          writeMr(twoFileDiffForSharding()),
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
        ],
        { cwd, configText },
      );

      expect(run.status).toBe(0);
      // ADR-0061：每文件必报——s01（Alpha）带意见，s02（Beta）生成失败也补空列表
      const reportedCalls = mcp
        .toolCalls()
        .filter((call) => call.name === "mrReviewResult");
      expect(reportedCalls.map((call) => call.args.filePath)).toEqual([ALPHA, BETA]);
      expect((reportedCalls[0]?.args.reviewTips as unknown[]).length).toBe(1);
      expect(reportedCalls[1]?.args.reviewTips).toEqual([]);
      // s02 生成失败留痕（有意见文件改报空列表，覆盖率优先）
      expect(run.stderr).toContain("有意见文件改报空列表");
      // ADR-0057：总结只覆盖已上报的 s01 意见，s02 那条平台没收到、不进总结
      expect(run.stderr).toContain("检视总结只覆盖已上报的 1 条意见（1 条未上报，未计入）");
      // 直接看总结请求体：tips / findings 只含 Alpha，Beta 仅作为「已上报文件
      // （空 tips）」出现，它的 finding 不进总结
      const oneShotBodies = stub
        .requests()
        .filter(
          (record) =>
            record.method === "POST" &&
            record.url === "/v1/chat/completions" &&
            (record.body as { stream?: boolean } | undefined)?.stream === false,
        )
        .map((record) => JSON.stringify(record.body));
      const summaryBody = oneShotBodies[oneShotBodies.length - 1] ?? "";
      expect(summaryBody).toContain(ALPHA);
      expect(summaryBody).not.toContain(`Sentinel finding in ${BETA}`);
      // 逐条原因：该片每条 finding 都带「片级语义生成失败」原文，而不是只留一行
      expect(run.stderr).toContain("tips 缺席该条：片级语义生成失败");

      // tips：尽力而为——只有 Alpha 组；聚合重编号后 id = F001
      const tipsPath = path.join(outDir, CLI_TASK_ID, "runs", "reviews_tips_zh.json");
      expect(existsSync(tipsPath)).toBe(true);
      const tipsDoc = JSON.parse(readFileSync(tipsPath, "utf8")) as {
        filePath: string;
        reviewTips: { id: string; code: string }[];
      }[];
      expect(tipsDoc.map((group) => group.filePath)).toEqual([ALPHA]);
      expect(tipsDoc[0]?.reviewTips[0]?.id).toBe("F001");
      expect(tipsDoc[0]?.reviewTips[0]?.code).toBe("public class Alpha {");
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  240_000,
);

test(
  "统一 tips 全灭（ADR-0065）：不回落引擎、本次不产分组意见、清陈旧，检视照常 exit 0",
  async () => {
    const stub = await startLoopbackStub([
      ...oneFindingCorpusForReport(),
      { text: "这不是 JSON", usage: ZERO_USAGE_REPLY }, // 报文生成失败 → 全灭
      { text: "# 检视总结", usage: ZERO_USAGE_REPLY },
    ]);
    const mcp = await startMcpStub();
    try {
      const cwd = makeTempDir("review-pi-cli-cwd-");
      const outDir = makeTempDir("review-pi-cli-out-");
      // 预置陈旧 tips（本次不产时必须清掉，否则读者分不清是不是本次的）
      const runsDir = path.join(outDir, CLI_TASK_ID, "runs");
      mkdirSync(runsDir, { recursive: true });
      writeFileSync(path.join(runsDir, "reviews_tips_zh.json"), '{"stale":true}', "utf8");
      writeFileSync(path.join(cwd, "review-result.json"), '{"stale":true}', "utf8");

      const run = await runCliReview(
        outDir,
        writeMr(goldenFixture("vul4j-1.diff")),
        {
          gatewayBaseUrl: stub.baseUrl,
          mcpServerUrl: mcp.url,
        },
        { cwd },
      );

      expect(run.status).toBe(0);
      expect(run.stderr).toContain("统一生成未覆盖任何意见，本次不产分组意见");
      expect(run.stderr).toContain("tips 缺席该条：片级语义生成失败");
      // 陈旧清理：run 目录与 cwd 副本都不留
      expect(existsSync(path.join(runsDir, "reviews_tips_zh.json"))).toBe(false);
      expect(existsSync(path.join(cwd, "review-result.json"))).toBe(false);
      // mrReviewResult / endTask 语义不变
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      // ADR-0061：有意见文件（README.md）生成失败时，本片 diff 文件
      // （ObjectArrayCodec.java）照报空包——覆盖率优先。
      expect(business[1]?.args).toEqual({
        taskId: CLI_TASK_ID,
        filePath: "src/main/java/com/alibaba/fastjson/serializer/ObjectArrayCodec.java",
        reviewTips: [],
      });
      // ADR-0057：平台只收到空 tips，总结不得声称「未发现缺陷」
      expect(business[2]?.args).toEqual({
        taskId: CLI_TASK_ID,
        markdownContent: "# 检视总结\n\n本次检视未向平台上报任何检视意见。",
      });
      expect(run.stderr).toContain("检视总结只覆盖已上报的 0 条意见（1 条未上报，未计入）");
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "reviewer.stripModelPrefix：wire 的 model 字段剥掉最后一个 / 前的所有（--model pan/test-model → test-model）",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const configText = `${JSON.stringify(
        {
          version: 1,
          reviewer: { apiKey: SENTINEL_KEY, baseUrl: stub.baseUrl, stripModelPrefix: true },
        },
        null,
        2,
      )}\n`;
      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          writeMr(goldenFixture("vul4j-1.diff")),
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--model",
          "pan/test-model",
        ],
        { configText },
      );

      expect(run.status).toBe(0);
      // 全部检视请求的 wire model = 剥前缀后的 id；生效值全面一致
      // （参数回显 / 审计 / wire 都只见 test-model，前缀不出现在任何面）
      const models = stub
        .requests()
        .filter((record) => record.method === "POST")
        .map((record) => (record.body as { model?: unknown } | undefined)?.model);
      expect(models.length).toBeGreaterThanOrEqual(6);
      expect(new Set(models)).toEqual(new Set(["test-model"]));
      expect(run.stderr).toContain("test-model");
      expect(run.stderr).not.toContain("pan/");
      // 审计记生效值（发出的就是它）
      const outcome = JSON.parse(run.stdout) as { auditPath: string };
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as { model: string };
      expect(audit.model).toBe("test-model");
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "reviewer.modelFallback=on-model-not-found：--model 404 → 改用 model.default 并全程生效，审计/run.json 留痕",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus(), { missingModels: ["ep-missing"] });
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          writeMr(goldenFixture("vul4j-1.diff")),
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--model",
          "ep-missing",
        ],
        {
          configText: `${JSON.stringify(
            {
              version: 1,
              reviewer: {
                apiKey: SENTINEL_KEY,
                baseUrl: stub.baseUrl,
                modelFallback: "on-model-not-found",
              },
            },
            null,
            2,
          )}\n`,
        },
      );

      expect(run.status).toBe(0);
      // stderr：人话一行（保留原 --model，点名生效的 model.default）
      expect(run.stderr).toContain('--model "ep-missing" 不可用（model not found）');
      expect(run.stderr).toContain(`已改用配置文件 model.default "${REVIEW_MODEL_ID}"`);

      const posts = stub.requests().filter((record) => record.method === "POST");
      const modelOf = (record: StubRequestRecord): unknown =>
        (record.body as { model?: unknown } | undefined)?.model;
      const probeModels = posts
        .filter((record) => (record.body as { max_tokens?: unknown } | undefined)?.max_tokens === 1)
        .map(modelOf);
      // 两条探针：先主模型（404），再默认模型（可用）
      expect(probeModels).toEqual(["ep-missing", REVIEW_MODEL_ID]);
      // 真实检视 / 一次性调用全部用生效模型，不再出现被替换的 id
      const reviewModels = posts
        .filter((record) => (record.body as { max_tokens?: unknown } | undefined)?.max_tokens !== 1)
        .map(modelOf);
      expect(reviewModels.length).toBeGreaterThan(0);
      expect(new Set(reviewModels)).toEqual(new Set([REVIEW_MODEL_ID]));

      const outcome = JSON.parse(run.stdout) as { auditPath: string };
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        model: string;
        modelFallback?: unknown;
      };
      expect(audit.model).toBe(REVIEW_MODEL_ID);
      expect(audit.modelFallback).toEqual({
        requested: "ep-missing",
        used: REVIEW_MODEL_ID,
        reason: "model-not-found",
      });

      const record = JSON.parse(
        readFileSync(path.join(cliRunsDir(outDir), "run.json"), "utf8"),
      ) as { model: string; modelFallback?: unknown };
      expect(record.model).toBe(REVIEW_MODEL_ID);
      expect(record.modelFallback).toEqual({
        requested: "ep-missing",
        used: REVIEW_MODEL_ID,
        reason: "model-not-found",
      });
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "reviewer.modelFallback：两边都 model-not-found → exit 1 双诊断、stdout 干净、不发真实检视请求",
  async () => {
    const stub = await startLoopbackStub([], {
      missingModels: ["ep-missing", REVIEW_MODEL_ID],
    });
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          writeMr(goldenFixture("vul4j-1.diff")),
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--model",
          "ep-missing",
        ],
        {
          configText: `${JSON.stringify(
            {
              version: 1,
              reviewer: {
                apiKey: SENTINEL_KEY,
                baseUrl: stub.baseUrl,
                modelFallback: "on-model-not-found",
              },
            },
            null,
            2,
          )}\n`,
        },
      );

      expect(run.status).toBe(1);
      expect(run.stdout.trim()).toBe("");
      expect(run.stderr).toContain("ep-missing");
      expect(run.stderr).toContain(REVIEW_MODEL_ID);
      expect(run.stderr).toContain("已中止");
      // 只发了两条探针（主 + 默认），没有任何流式检视请求
      const posts = stub.requests().filter((record) => record.method === "POST");
      expect(posts).toHaveLength(2);
      expect(posts.every((record) => (record.body as { stream?: unknown }).stream !== true)).toBe(true);
      // 没跑检视 = 没有审计文件
      expect(existsSync(path.join(outDir, CLI_TASK_ID, "audit"))).toBe(false);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "reviewer.modelFallback 缺省 off：一次探针都不发，审计无 modelFallback 键（零漂移）",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          writeMr(goldenFixture("vul4j-1.diff")),
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--model",
          "test-model",
        ],
        { ...stubEnv(stub.baseUrl) },
      );

      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain("已改用配置文件 model.default");
      const posts = stub.requests().filter((record) => record.method === "POST");
      expect(posts.some((record) => (record.body as { max_tokens?: unknown }).max_tokens === 1)).toBe(false);
      const outcome = JSON.parse(run.stdout) as { auditPath: string };
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as Record<string, unknown>;
      expect("modelFallback" in audit).toBe(false);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "reviewer.modelFallback 顾问原则：主模型探针 429 → 不替换，照常开跑（主模型仍是生效值）",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus(), {
      probeRateLimitedModels: ["ep-flaky"],
    });
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          writeMr(goldenFixture("vul4j-1.diff")),
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--model",
          "ep-flaky",
        ],
        {
          configText: `${JSON.stringify(
            {
              version: 1,
              reviewer: {
                apiKey: SENTINEL_KEY,
                baseUrl: stub.baseUrl,
                modelFallback: "on-model-not-found",
              },
            },
            null,
            2,
          )}\n`,
        },
      );

      expect(run.status).toBe(0);
      expect(run.stderr).not.toContain("已改用配置文件 model.default");
      const outcome = JSON.parse(run.stdout) as { auditPath: string };
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        model: string;
        modelFallback?: unknown;
      };
      expect(audit.model).toBe("ep-flaky");
      expect(audit.modelFallback).toBeUndefined();
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "reviewer.modelFallback：两边 404 中止时 MCP 仍有始有终（startTask → endTask，无总结）",
  async () => {
    const stub = await startLoopbackStub([], {
      missingModels: ["ep-missing", REVIEW_MODEL_ID],
    });
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          writeMr(goldenFixture("vul4j-1.diff")),
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--model",
          "ep-missing",
        ],
        {
          configText: `${JSON.stringify(
            {
              version: 1,
              reviewer: {
                apiKey: SENTINEL_KEY,
                baseUrl: stub.baseUrl,
                modelFallback: "on-model-not-found",
              },
              mcp: {
                servers: {
                  stub: { transport: "http", url: mcp.url, headers: {}, timeoutMs: 10_000 },
                },
                report: { server: "stub" },
              },
            },
            null,
            2,
          )}\n`,
        },
      );

      expect(run.status).toBe(1);
      expect(run.stderr).toContain("已中止");
      // ADR-0045 决策 2：startTask 已发出 → 中止路径仍必须 endTask，且没有总结
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual(["startTask", "endTask"]);
    } finally {
      await mcp.close();
      await stub.close();
    }
  },
  180_000,
);

test(
  "reviewer.modelFallback：降级时平台总结追加一行说明（MCP saveReviewSummary 可见）",
  async () => {
    const stub = await startLoopbackStub(
      [
        ...oneFindingCorpusForReport(),
        { text: payloadReplyForSentinelFinding(), usage: ZERO_USAGE_REPLY },
        { text: "# 检视总结\n\n测试桩总结。", usage: ZERO_USAGE_REPLY },
      ],
      { missingModels: ["ep-missing"] },
    );
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          writeMr(goldenFixture("vul4j-1.diff")),
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--model",
          "ep-missing",
        ],
        {
          configText: `${JSON.stringify(
            {
              version: 1,
              reviewer: {
                apiKey: SENTINEL_KEY,
                baseUrl: stub.baseUrl,
                modelFallback: "on-model-not-found",
              },
              limits: { findingScope: { enabled: false } },
              mcp: {
                servers: {
                  stub: { transport: "http", url: mcp.url, headers: {}, timeoutMs: 10_000 },
                },
                report: { server: "stub" },
              },
            },
            null,
            2,
          )}\n`,
        },
      );

      expect(run.status).toBe(0);
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      const summary = business.find((call) => call.name === "saveReviewSummary");
      expect(String(summary?.args.markdownContent)).toContain("# 检视总结");
      expect(String(summary?.args.markdownContent)).toContain("模型降级说明");
      expect(String(summary?.args.markdownContent)).toContain("ep-missing");
      expect(String(summary?.args.markdownContent)).toContain(REVIEW_MODEL_ID);
    } finally {
      await mcp.close();
      await stub.close();
    }
  },
  180_000,
);

test(
  "服务端不认 initialize（404）→ 自动降级无状态直调，四个业务 tool 照常送达，exit 0",
  async () => {
    const stub = await startLoopbackStub([
      ...oneFindingCorpusForReport(),
      { text: payloadReplyForSentinelFinding(), usage: ZERO_USAGE_REPLY },
      { text: "# 检视总结", usage: ZERO_USAGE_REPLY },
    ]);
    // 只实现 tools/call 的定制服务端：initialize 回 404（与用户 Postman 场景同形）
    const mcp = await startMcpStub([], { initializeStatus: 404 });
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runCliReview(outDir, mrFile, {
        gatewayBaseUrl: stub.baseUrl,
        mcpServerUrl: mcp.url,
      });

      expect(run.status).toBe(0);
      // 降级说明只落一行 stderr，绝不改变结果
      expect(run.stderr).toContain("未接受 initialize");
      expect(mcp.toolCalls().map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
      ]);
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "没有检视意见：mrReviewResult 仍按文件调用、reviewTips: []，saveReviewSummary / endTask 照常",
  async () => {
    const stub = await startLoopbackStub(noFindingCorpus());
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runCliReview(outDir, mrFile, {
        gatewayBaseUrl: stub.baseUrl,
        mcpServerUrl: mcp.url,
      });

      expect(run.status).toBe(0);
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      // 零意见也要让平台知道「这些文件检视过了」：每个 diff 文件一条空 tips
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(business[1]?.args).toEqual({
        taskId: CLI_TASK_ID,
        filePath: "src/main/java/com/alibaba/fastjson/serializer/ObjectArrayCodec.java",
        reviewTips: [],
      });
      expect(run.stderr).toContain("MCP mrReviewResult 已上报 1 文件 / 0 条意见");
      // 零意见：saveReviewSummary 发固定「未发现缺陷」文案，不触发一次性模型调用
      expect(business[2]?.args).toEqual({
        taskId: CLI_TASK_ID,
        markdownContent: "# 检视总结\n\n本次检视未发现缺陷。",
      });
      expect(countOneShotGatewayCalls(stub)).toBe(0);
      expect(run.stderr).toContain("未发现检视意见，发送固定总结");

      // 空 tips 文档照样落盘（本次 run 的中文产物只有一个空数组）
      const tipsPath = path.join(outDir, CLI_TASK_ID, "runs", "reviews_tips_zh.json");
      expect(existsSync(tipsPath)).toBe(true);
      expect(JSON.parse(readFileSync(tipsPath, "utf8"))).toEqual([]);
      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
      ]);
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "全部候选被置信度过滤：无意见文件仍按文件调用 mrReviewResult、reviewTips: []（ADR-0056）",
  async () => {
    const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
    const diffPath = "src/main/java/com/alibaba/fastjson/serializer/ObjectArrayCodec.java";
    const candidate = {
      id: "F100",
      severity: "P2",
      category: "correctness",
      file: diffPath,
      line: 174,
      title: "Sentinel finding title",
      description: "Sentinel finding description",
      evidence: [`${diffPath}:174`],
      rule: "sentinel-rule",
      confidence: 0.5,
    };
    const stub = await startLoopbackStub([
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: JSON.stringify({ candidates: [candidate] }), usage: ZERO },
      {
        text: JSON.stringify({
          verdicts: [{ id: "F100", pass: true, reason: "stub verdict: evidence holds" }],
          complete: true,
        }),
        usage: ZERO,
      },
      // 有 finding（过滤只作用于中文 tips / 上报）；全部被过滤 ⇒ 没有可上报意见
      // ⇒ 总结按 ADR-0057 走固定文案，不再调用模型
      { text: "# 检视总结", usage: ZERO },
    ]);
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      // min=0.99：唯一候选（0.5）被置信度过滤 ⇒ 本片没有任何可发的中文意见
      const configText = `${JSON.stringify(
        {
          version: 1,
          reviewer: { apiKey: SENTINEL_KEY, baseUrl: stub.baseUrl },
          limits: { confidence: { min: 0.99 } },
          mcp: {
            servers: { stub: { transport: "http", url: mcp.url, headers: {}, timeoutMs: 10_000 } },
            report: { server: "stub" },
          },
        },
        null,
        2,
      )}\n`;
      const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), {
        configText,
      });

      expect(run.status).toBe(0);
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(business[1]?.args).toEqual({
        taskId: CLI_TASK_ID,
        filePath: diffPath,
        reviewTips: [],
      });
      expect(run.stderr).toContain("MCP mrReviewResult 已上报 1 文件 / 0 条意见");
      expect(business[2]?.args).toEqual({
        taskId: CLI_TASK_ID,
        markdownContent: "# 检视总结\n\n本次检视未向平台上报任何检视意见。",
      });
      // 留痕同样要能证明「文件被检视过」
      const mcpLog = JSON.parse(
        readFileSync(path.join(cliRunsDir(outDir), "mcp.json"), "utf8"),
      ) as { calls: { tool: string; ok: boolean }[] };
      expect(mcpLog.calls.map((call) => call.tool)).toEqual([
        "startTask",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(mcpLog.calls.every((call) => call.ok)).toBe(true);
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "有 finding 但源码行读不到（tips 全部被校验跳过）：该文件仍发 reviewTips: []（ADR-0061）",
  async () => {
    const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
    const diffPath = "src/main/java/com/alibaba/fastjson/serializer/ObjectArrayCodec.java";
    const candidate = {
      id: "F100",
      severity: "P2",
      category: "correctness",
      file: diffPath,
      // 越界行号：`--repo` 抽不到源码行 → 报文按纪律跳过该条（绝不编 code）
      line: 9999,
      title: "Sentinel finding title",
      description: "Sentinel finding description",
      evidence: [`${diffPath}:9999`],
      rule: "sentinel-rule",
      confidence: 0.5,
    };
    const stub = await startLoopbackStub([
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: "ok", usage: ZERO },
      { text: JSON.stringify({ candidates: [candidate] }), usage: ZERO },
      {
        text: JSON.stringify({
          verdicts: [{ id: "F100", pass: true, reason: "stub verdict: evidence holds" }],
          complete: true,
        }),
        usage: ZERO,
      },
      // 语义输出照常（category 可归一），但 code 取不到 → skippedTips
      { text: payloadReplyForSentinelFinding(), usage: ZERO },
    ]);
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), {
        gatewayBaseUrl: stub.baseUrl,
        mcpServerUrl: mcp.url,
      });

      expect(run.status).toBe(0);
      // ADR-0061：报文里没有该条 tip，但文件仍必须有「已检视」登记 → 空列表
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(business[1]?.args).toEqual({
        taskId: CLI_TASK_ID,
        filePath: diffPath,
        reviewTips: [],
      });
      expect(run.stderr).toContain("跳过单条意见");
      expect(run.stderr).toContain("已上报 1 文件 / 0 条意见");
      // ADR-0057：空包不登记 finding，总结仍按「0 条已上报」生成
      expect(business[2]?.args).toEqual({
        taskId: CLI_TASK_ID,
        markdownContent: "# 检视总结\n\n本次检视未向平台上报任何检视意见。",
      });
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "中文产物落盘失败：仍发 saveReviewSummary 与 endTask，随后 exit 1（上报不被产物 IO 吞掉）",
  async () => {
    const stub = await startLoopbackStub(noFindingCorpus());
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");
      // 让 writeReviewsTipsZh 必失败：把目标路径预先建成**目录**（写文件即报错）
      mkdirSync(path.join(outDir, CLI_TASK_ID, "runs", "reviews_tips_zh.json"), {
        recursive: true,
      });

      const run = await runCliReview(outDir, mrFile, {
        gatewayBaseUrl: stub.baseUrl,
        mcpServerUrl: mcp.url,
      });

      // 产物即契约：落盘失败仍是运行失败
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("中文产物落盘失败");
      expect(run.stderr).toContain("failed to persist grouped review export");
      // 但检视已经跑完：总结与 endTask 必须照发，不能留一条「有始无终」的任务
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(business[2]?.args).toEqual({
        taskId: CLI_TASK_ID,
        markdownContent: "# 检视总结\n\n本次检视未发现缺陷。",
      });
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "默认形态（不配 tool，ADR-0045 后）：只调四个业务 tool，零事件调用、无统计行、tips 照常产出",
  async () => {
    const stub = await startLoopbackStub([
      ...oneFindingCorpusForReport(),
      { text: payloadReplyForSentinelFinding(), usage: ZERO_USAGE_REPLY },
      { text: "# 检视总结", usage: ZERO_USAGE_REPLY },
    ]);
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      // 只给 mcpServerUrl：配置里没有 tool / include / task——最小默认形态
      const run = await runCliReview(outDir, mrFile, {
        gatewayBaseUrl: stub.baseUrl,
        mcpServerUrl: mcp.url,
      });

      expect(run.status).toBe(0);
      // 服务端收到的就是业务 tool（顺序契约）：有意见的文件 + 本片其余文件
      // （reviewTips: []）各一条 mrReviewResult，一个事件都没有
      expect(mcp.toolCalls().map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      // 事件通道关闭：不打印事件统计行
      expect(run.stderr).not.toContain("MCP 上报 sent");
      // 统一 tips 照常产出（与业务调用无关的事件面缺席不影响）
      const tipsPath = path.join(outDir, CLI_TASK_ID, "runs", "reviews_tips_zh.json");
      expect(existsSync(tipsPath)).toBe(true);
      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
      ]);
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "ADR-0078：--include 未命中任何变更文件 → 跳过检视：四工具齐全 + 固定总结 + exit 0",
  async () => {
    const stub = await startLoopbackStub(noFindingCorpus());
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = writeMr(
        [
          "diff --git a/src/main/java/Keep.java b/src/main/java/Keep.java",
          "--- a/src/main/java/Keep.java",
          "+++ b/src/main/java/Keep.java",
          "@@ -1 +1 @@",
          "-class Keep {}",
          "+class Keep { }",
        ].join("\n"),
      );

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--include",
          "^no-such-dir/",
        ],
        { ...stubEnv(stub.baseUrl), mcpServerUrl: mcp.url },
      );

      expect(run.status).toBe(0);
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(business[1]?.args).toEqual({
        taskId: CLI_TASK_ID,
        filePath: "src/main/java/Keep.java",
        reviewTips: [],
      });
      expect(business[2]?.args.markdownContent).toContain("无可检视文件");
      const outcome = JSON.parse(run.stdout) as { skipped?: string; findings: unknown[] };
      expect(outcome.skipped).toBe("no-reviewable-files");
      expect(outcome.findings).toEqual([]);
      // 跳过路径不调模型、不写 run 产物
      expect(stub.requests()).toHaveLength(0);
      expect(existsSync(path.join(cliRunsDir(outDir), "reviews_tips_zh.json"))).toBe(false);
      expect(run.stderr).toContain("跳过检视");
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);

test(
  "ADR-0078：--include + --exclude 联动——白名单先选、黑名单后剔，仍照常检视并补报被剔文件",
  async () => {
    const stub = await startLoopbackStub(noFindingCorpus());
    const mcp = await startMcpStub();
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const keep = "src/main/java/Keep.java";
      const droppedByExclude = "src/main/java/Keep.test.java";
      const droppedByInclude = "docs/guide.md";
      const droppedByGenerated = "src/generated/Api.java";
      const fileBlock = (file: string) =>
        [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, "@@ -1 +1 @@", "-a", "+b"];
      const mrFile = writeMr(
        [
          ...fileBlock(keep),
          ...fileBlock(droppedByExclude),
          ...fileBlock(droppedByInclude),
          ...fileBlock(droppedByGenerated),
        ].join("\n"),
      );

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--taskId",
          CLI_TASK_ID,
          "--tasks-dir",
          outDir,
          "--include",
          "^src/",
          "--exclude",
          "\\.test\\.java$",
          "--exclude",
          "^src/generated/",
        ],
        { ...stubEnv(stub.baseUrl), mcpServerUrl: mcp.url },
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as { skipped?: string; findings: unknown[] };
      expect(outcome.skipped).toBeUndefined();
      expect(outcome.findings).toEqual([]);

      // 过滤发生了且只调了一次检视（六相位；请求数 > 0 即可，不锁 one-shot 生成细节）
      expect(stub.requests().length).toBeGreaterThan(0);
      expect(run.stderr).toContain("not-included=1");
      expect(run.stderr).toContain("regex-exclude=2");

      // 片级上报只覆盖 Keep；其余三个按 ADR-0068 在收尾补报空意见
      const business = mcp.toolCalls().filter((call) => call.name !== "report_events");
      expect(business.map((call) => call.name)).toEqual([
        "startTask",
        "mrReviewResult",
        "mrReviewResult",
        "mrReviewResult",
        "mrReviewResult",
        "saveReviewSummary",
        "endTask",
      ]);
      expect(
        business.filter((call) => call.name === "mrReviewResult").map((call) => call.args.filePath),
      ).toEqual([keep, droppedByExclude, droppedByInclude, droppedByGenerated]);
      expect(run.stderr).toContain("已补报 3 个变更文件 / 0 条意见");
    } finally {
      await stub.close();
      await mcp.close();
    }
  },
  180_000,
);
