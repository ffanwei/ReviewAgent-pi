import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { checkRuntimeArtifacts } from "../../bin/lib/cli-runtime.js";
import { CLI_EXPERIMENT_ID } from "./args.js";
import { eRunRecordJson } from "../disposition/run-record-fixture.js";
import { sseBody, type FakeReply } from "../provider/fake-fetch.js";
import { REVIEW_MODEL_ID } from "../provider/pi-client.js";
import { goldenFixture } from "../testing/golden.js";
import { repoFixturePath } from "../testing/repos.js";

// #7 P3b 进程级烟测：spawn 真 bin（bin/review-pi.js → spawn dist/cli/main.js），
// loopback stub 服务器在真 HTTP 传输层上回放 fake 适配器同款 wire——SSE 渲染
// 单源 sseBody（stub 与 fake 适配器逐字节同格式）。这是真适配器路径的唯一
// 离线覆盖：真 OpenAI SDK 序列化 + globalThis.fetch + 真套接字 + 真进程边界。
//
// 哨兵纪律（票面验收）：key 只允许出现在 Authorization 头（stub 侧断言已
// 收到 Bearer <sentinel>）；绝不出现在 stdout/stderr/审计/运行记录（进程
// 输出面与 --out 落盘面全量扫描）。.env.local 装载摘要只报键名（单测面
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
  // 腿间有依赖序：vendored pi 四包（root 脚本按依赖序）→ review-llm → 本包
  const buildOrder = [
    "pnpm build:pi",
    "pnpm --filter review-llm build",
    "pnpm --filter review-pi build",
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
function startLoopbackStub(replies: readonly FakeReply[]): Promise<LoopbackStub> {
  const queue = [...replies];
  const requests: StubRequestRecord[] = [];
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
        const wantsStream = (body as { stream?: unknown } | undefined)?.stream === true;
        if (!wantsStream) {
          // 模型探针（max_tokens:1 的非流式 ping）：回显模型 + 合法 usage
          response.writeHead(200, { "content-type": "application/json" });
          response.end(
            JSON.stringify({
              model: (body as { model?: unknown } | undefined)?.model ?? REVIEW_MODEL_ID,
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
}

interface RunBinOptions {
  /** 显式注入子进程的环境变量（覆盖本机残留；REVIEWER_* 必须显式给） */
  readonly env?: Record<string, string>;
  /** 预写进子进程 cwd 的 .env.local 内容（.env.local 语义面；不写则无该文件） */
  readonly seedEnvLocal?: string;
  /** 预置到子进程 cwd 的文件名（内容固定 `{"stale":true}`；ADR-0017 副本清理用） */
  readonly seedCwdFiles?: readonly string[];
  /** 预置到子进程 cwd 的**目录名**（占位模拟不可写；ADR-0017 副本失败语义用） */
  readonly seedCwdDirs?: readonly string[];
  readonly timeoutMs?: number;
}

/**
 * spawn 真 bin（cwd = 干净 tmpdir——不捡到仓库根的 .env.local，本机注入面
 * 确定性）。退出码/stdout/stderr 全捕获；超时即杀（status null）。
 *
 * 必须异步 spawn（不能 spawnSync）：stub 服务器活在本进程——spawnSync 会
 * 冻结事件循环，子进程的 HTTP 请求永远等不到 accept（子等响应、亲等退出，
 * 活锁成对超时）。异步 spawn 让事件循环在 await 间隙继续伺服 stub。
 */
function runBin(args: readonly string[], options: RunBinOptions = {}): Promise<CliRunResult> {
  const cwd = makeTempDir("review-pi-cli-cwd-");
  if (options.seedEnvLocal !== undefined) {
    writeFileSync(path.join(cwd, ".env.local"), options.seedEnvLocal, "utf8");
  }
  for (const name of options.seedCwdFiles ?? []) {
    writeFileSync(path.join(cwd, name), '{"stale":true}\n', "utf8");
  }
  for (const name of options.seedCwdDirs ?? []) {
    mkdirSync(path.join(cwd, name), { recursive: true });
  }
  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd,
      env: { ...process.env, ...options.env },
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
        resolve({ status: code, stdout, stderr, cwd });
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

/** 哨兵泄漏断言：进程输出面 + --out 落盘面全量不含 key */
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
  ];
}

/** MAX_ROUNDS 截断脚本：5 轮 × 6 相位，phase-6 恒 complete:false */
function truncationCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  const replies: FakeReply[] = [];
  for (let round = 0; round < 5; round++) {
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

/** 子进程环境（哨兵网关显式注入；REVIEWER_* 优先序压过本机 DEEPSEEK_* 残留） */
function stubEnv(stubBaseUrl: string): Record<string, string> {
  return { REVIEWER_URL: stubBaseUrl, REVIEWER_API_KEY: SENTINEL_KEY };
}

// ---- 检视命令面 ----

test(
  "单 MR 检视（config B 显式——缺省已切流 E，ADR-0011；B 形态进程面回放资产保留）：exit 0 + stdout 单 JSON + 候选存活成 finding + 落盘 + 凭据哨兵",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr", mrFile, "--out", outDir, "--config", "B"],
        {
          env: stubEnv(stub.baseUrl),
          // .env.local 诱饵：显式环境变量必须胜出（诱饵 URL 是死端口，诱饵 key 不入传输层）
          seedEnvLocal: `REVIEWER_URL=http://127.0.0.1:9/v1\nREVIEWER_API_KEY=${DECOY_KEY}\n`,
        },
      );

      expect(run.status).toBe(0);
      // stdout 契约：单个 JSON 文档（尾随换行；多余字节即 JSON.parse 失败）
      const outcome = JSON.parse(run.stdout) as {
        ok: boolean;
        caseId: string;
        configId: string;
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
        configId: "B",
        truncated: false,
        rounds: 1,
        toolCalls: 0,
      });
      expect(outcome.runId).toMatch(/^\d{8}T\d{6}\.\d{3}-B-VUL4J-1$/);
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

      // 传输层：恰好六回合（检视命令不发探针）；全部带哨兵 Authorization 头
      const requests = stub.requests();
      expect(requests).toHaveLength(6);
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
      // .env.local 装载摘要只报键名（值绝不回显）
      expect(run.stderr).toContain("skipped");
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "截断路径：phase-6 恒 complete:false → exit 0 + truncated=true + rounds=5（诚实截断不是失败）",
  async () => {
    const stub = await startLoopbackStub(truncationCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr", mrFile, "--out", outDir],
        { env: stubEnv(stub.baseUrl) },
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as {
        truncated: boolean;
        rounds: number;
        findings: unknown[];
      };
      expect(outcome.truncated).toBe(true);
      expect(outcome.rounds).toBe(5);
      expect(outcome.findings).toEqual([]);
      // 5 轮 × 6 相位 = 30 回合全走真 HTTP
      expect(stub.requests()).toHaveLength(30);
      expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- 凭据文件显式路径（ADR-0019：--env） ----

test(
  "--env：只读指定凭据文件（cwd 之外），cwd 的 .env.local 不被读取；摘要报显式路径",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");
      const envFile = path.join(makeTempDir("review-pi-cli-env-"), "team.env.local");
      writeFileSync(
        envFile,
        `REVIEWER_URL=${stub.baseUrl}\nREVIEWER_API_KEY=${SENTINEL_KEY}\n`,
        "utf8",
      );

      const run = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr",
          mrFile,
          "--out",
          outDir,
          "--config",
          "B",
          "--env",
          envFile,
        ],
        {
          // 显式置空 = 未设置（.env.local 语义：空值不注入，文件可补缺）
          env: { REVIEWER_URL: "", REVIEWER_API_KEY: "", DEEPSEEK_API_KEY: "" },
          // cwd 诱饵：若实现退回 cwd 的 .env.local，请求会打向死端口并带上诱饵 key
          seedEnvLocal: `REVIEWER_URL=http://127.0.0.1:9/v1\nREVIEWER_API_KEY=${DECOY_KEY}\n`,
        },
      );

      expect(run.status).toBe(0);
      const requests = stub.requests();
      expect(requests).toHaveLength(6);
      for (const request of requests) {
        expect(request.authorization).toBe(`Bearer ${SENTINEL_KEY}`);
      }
      // 摘要：报显式路径，且只报键名（值绝不回显）
      expect(run.stderr).toContain(envFile);
      expect(run.stderr).toContain("found — injected REVIEWER_URL, REVIEWER_API_KEY");
      expect(run.stdout).not.toContain(SENTINEL_KEY);
      expect(run.stderr).not.toContain(SENTINEL_KEY);
      expect(run.stderr).not.toContain(DECOY_KEY);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test("--env 指向不存在的文件 → exit 1 + 人话错误含路径 + stdout 干净（不静默 no-op）", async () => {
  const missing = path.join(makeTempDir("review-pi-cli-env-"), "no-such.env.local");
  const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");

  const run = await runBin([
    "review",
    "--repo",
    repoFixturePath("sample"),
    "--mr",
    mrFile,
    "--env",
    missing,
  ]);

  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("--env 指定的文件不存在");
  expect(run.stderr).toContain(missing);
});

test("--env 指向目录（读失败）→ exit 1 + 人话错误，不抛堆栈", async () => {
  const dir = makeTempDir("review-pi-cli-env-");
  const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");

  const run = await runBin([
    "review",
    "--repo",
    repoFixturePath("sample"),
    "--mr",
    mrFile,
    "--env",
    dir,
  ]);

  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("无法读取 --env 指定的文件");
  expect(run.stderr).not.toContain("    at ");
});

// ---- 呈现投影注入缝（ADR-0010 消费端接线）：引擎注入 → stdout 中文呈现档 ----
// 引擎模块是外部 ESM（翻译算法/网络/密钥全在核外）——fixture 现场 tmp .mjs。

/** 成功引擎 fixture：只译 title/description，结构化字段与 toolCallLog 直通 */
function writeProjectionEngineFixture(name: string, body: string): string {
  const enginePath = path.join(makeTempDir("review-pi-projection-engine-"), name);
  writeFileSync(enginePath, body, "utf8");
  return enginePath;
}

test(
  "呈现投影：引擎注入 → stdout findings 已译呈现档 + presentation 留痕 + 审计恒英文 + 请求面零影响",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const enginePath = writeProjectionEngineFixture(
        "engine.mjs",
        `export default async (source) => ({
          provenance: {
            language: "zh",
            terminologyVersion: 1,
            findingLinks: source.findings.map((finding) => ({
              sourceFindingId: finding.id,
              projectedFindingId: finding.id,
            })),
          },
          findings: source.findings.map((finding) => ({
            ...finding,
            title: "[zh] " + finding.title,
            description: "[zh] " + finding.description,
          })),
          toolCallLog: source.toolCallLog,
        });\n`,
      );
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr", mrFile, "--out", outDir, "--config", "B"],
        { env: { ...stubEnv(stub.baseUrl), REVIEW_PI_PRESENTATION_ENGINE: enginePath } },
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as {
        findings: { id: string; severity: string; title: string; description: string; file: string; line: number }[];
        presentation?: { language: string; terminologyVersion: number; degraded?: boolean };
        auditPath: string;
      };
      // stdout = 已译呈现档：自然语言字段经引擎投影，结构化字段字节直通
      expect(outcome.findings).toHaveLength(1);
      expect(outcome.findings[0]).toMatchObject({
        id: "F100",
        severity: "P2",
        title: "[zh] Sentinel finding title",
        description: "[zh] Sentinel finding description",
        file: "sample.txt",
        line: 1,
      });
      // presentation 留痕在场（引擎 provenance 透传）
      expect(outcome.presentation).toEqual({
        language: "zh",
        terminologyVersion: 1,
        findingLinks: [{ sourceFindingId: "F100", projectedFindingId: "F100" }],
      });
      // 审计落盘恒英文（ADR-0010：检视审计零改动——投影只发生在 stdout 呈现面）
      const audit = JSON.parse(readFileSync(outcome.auditPath, "utf8")) as {
        findings: { title: string }[];
      };
      expect(audit.findings[0]?.title).toBe("Sentinel finding title");
      // 检视请求面零影响：仍然恰好六回合（投影不发检视请求）
      expect(stub.requests()).toHaveLength(6);
      expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "呈现投影：引擎失败 → stdout 降级英文源档 + presentation.degraded + stderr 人话 + 退出码不受影响",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const enginePath = writeProjectionEngineFixture(
        "broken.mjs",
        `export default async () => { throw new Error("translation gateway down"); };\n`,
      );
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr", mrFile, "--out", outDir, "--config", "B"],
        { env: { ...stubEnv(stub.baseUrl), REVIEW_PI_PRESENTATION_ENGINE: enginePath } },
      );

      // 呈现降级不是运行失败（对齐诚实截断哲学）：exit 0，检视产物完好
      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as {
        findings: { title: string }[];
        presentation?: { language: string; degraded?: boolean };
      };
      expect(outcome.findings[0]?.title).toBe("Sentinel finding title");
      expect(outcome.presentation).toEqual({ language: "en", degraded: true });
      // 人话降级原因走 stderr（stdout 只报事实）
      expect(run.stderr).toContain("呈现投影降级");
      expect(run.stderr).toContain("translation gateway down");
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- 检视意见中文导出（ADR-0013 Step B）：zh 生命周期矩阵 ----
// zh 由核外 CLI 缝编排（复用同一次投影结果，绝不额外调网关），与 en 同 rep 目录。
// 路径基线：<out>/review-pi-cli/runs/vul4j/VUL4J-1/<config>/rep-1/

const ZH_ENGINE_BODY = `const tipOf = (source) => ({
  code: source.codeByFinding?.F100 ?? "",
  review: "[zh] Sentinel finding title。[zh] Sentinel finding description",
  suggestion: "改为判空后再取值。",
  category: "correctness",
  subcategory: "",
  severity: "Minor",
  ruleId: "",
  lineNum: 1,
  source: "common-reviewer",
  confidence: "Medium",
});
export default async (source) => ({
  provenance: {
    language: "zh",
    terminologyVersion: 1,
    findingLinks: source.findings.map((finding) => ({
      sourceFindingId: finding.id,
      projectedFindingId: finding.id,
    })),
  },
  findings: source.findings.map((finding) => ({
    ...finding,
    title: "[zh] " + finding.title,
    description: "[zh] " + finding.description,
  })),
  toolCallLog: source.toolCallLog,
  tips: { files: [{ filePath: "sample.txt", reviewTips: [tipOf(source)] }] },
});\n`;

/** 本次 run 的 rep-1 产物目录（reviews_en.json / reviews_zh.json 同层） */
function cliRepDir(outDir: string, configId = "B"): string {
  return path.join(outDir, CLI_EXPERIMENT_ID, "runs", "vul4j", "VUL4J-1", configId, "rep-1");
}

/** 单 MR 检视调用（config B；可选注入呈现引擎与 cwd 预置文件） */
function runCliReview(
  outDir: string,
  mrFile: string,
  env: Record<string, string>,
  options: RunBinOptions = {},
): Promise<CliRunResult> {
  return runBin(
    ["review", "--repo", repoFixturePath("sample"), "--mr", mrFile, "--out", outDir, "--config", "B"],
    { ...options, env },
  );
}

function writeMr(diff: string): string {
  const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
  writeFileSync(mrFile, diff, "utf8");
  return mrFile;
}

test(
  "中文导出：引擎注入 → reviews_zh.json 落盘 + 投影留痕 + 中文自然语言字段 + 无额外网关请求",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const enginePath = writeProjectionEngineFixture("engine.mjs", ZH_ENGINE_BODY);
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), {
        ...stubEnv(stub.baseUrl),
        REVIEW_PI_PRESENTATION_ENGINE: enginePath,
      });

      expect(run.status).toBe(0);
      const repDir = cliRepDir(outDir);
      const enPath = path.join(repDir, "reviews_en.json");
      const zhPath = path.join(repDir, "reviews_zh.json");
      expect(existsSync(enPath)).toBe(true);
      expect(existsSync(zhPath)).toBe(true);

      const en = JSON.parse(readFileSync(enPath, "utf8")) as Record<string, unknown>;
      const zh = JSON.parse(readFileSync(zhPath, "utf8")) as Record<string, unknown>;
      // 信封 = en 信封 + 投影留痕三键（降级标注永不落盘）
      expect(Object.keys(zh).sort()).toEqual(
        [...Object.keys(en), "language", "terminologyVersion", "findingLinks"].sort(),
      );
      expect(zh["language"]).toBe("zh");
      expect(zh["terminologyVersion"]).toBe(1);
      expect(zh["findingLinks"]).toEqual([{ sourceFindingId: "F100", projectedFindingId: "F100" }]);
      expect("degraded" in zh).toBe(false);
      // 配对键：与 en 同 runId（同一 run）
      expect(zh["runId"]).toBe(en["runId"]);
      expect(zh["configId"]).toBe("B");
      // 自然语言字段已译、结构化字段字节直通
      const findings = zh["findings"] as {
        id: string;
        severity: string;
        title: string;
        description: string;
        file: string;
        line: number;
      }[];
      expect(findings[0]).toMatchObject({
        id: "F100",
        severity: "P2",
        title: "[zh] Sentinel finding title",
        description: "[zh] Sentinel finding description",
        file: "sample.txt",
        line: 1,
      });
      // 复用同一次投影结果：不发额外检视请求（仍恰好六回合）
      expect(stub.requests()).toHaveLength(6);
      // 分组意见（ADR-0017）：与 zh 同目录，顶层严格 { files }
      const tipsPath = path.join(repDir, "reviews_tips_zh.json");
      expect(existsSync(tipsPath)).toBe(true);
      const tips = JSON.parse(readFileSync(tipsPath, "utf8")) as Record<string, unknown>;
      expect(Object.keys(tips)).toEqual(["files"]);
      expect(tips["files"]).toEqual([
        {
          filePath: "sample.txt",
          reviewTips: [
            {
              code: "",
              review: "[zh] Sentinel finding title。[zh] Sentinel finding description",
              suggestion: "改为判空后再取值。",
              category: "correctness",
              subcategory: "",
              severity: "Minor",
              ruleId: "",
              lineNum: 1,
              source: "common-reviewer",
              confidence: "Medium",
            },
          ],
        },
      ]);
      // 执行目录副本（ADR-0017 决策 14）：cwd 里同名双写，内容与 rep-1 那份逐字节相同
      const cwdTipsPath = path.join(run.cwd, "reviews_tips_zh.json");
      const cwdResultPath = path.join(run.cwd, "review-result.json");
      expect(existsSync(cwdTipsPath)).toBe(true);
      expect(existsSync(cwdResultPath)).toBe(true);
      const repTipsText = readFileSync(tipsPath, "utf8");
      expect(readFileSync(cwdTipsPath, "utf8")).toBe(repTipsText);
      expect(readFileSync(cwdResultPath, "utf8")).toBe(repTipsText);
      expectNoKeyLeak([
        { label: "stdout", text: run.stdout },
        { label: "stderr", text: run.stderr },
        { label: "reviews_zh.json", text: readFileSync(zhPath, "utf8") },
        { label: "reviews_tips_zh.json", text: repTipsText },
        { label: "cwd review-result.json", text: readFileSync(cwdResultPath, "utf8") },
      ]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test("中文导出：未配置引擎 → reviews_zh.json 缺席 + exit 0（en 仍在，无陈旧清除噪声）", async () => {
  const stub = await startLoopbackStub(oneFindingCorpus());
  try {
    const outDir = makeTempDir("review-pi-cli-out-");
    const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), stubEnv(stub.baseUrl));

    expect(run.status).toBe(0);
    const repDir = cliRepDir(outDir);
    expect(existsSync(path.join(repDir, "reviews_en.json"))).toBe(true);
    expect(existsSync(path.join(repDir, "reviews_zh.json"))).toBe(false);
    // 本次 run 无陈旧 zh ⇒ 无「已清除陈旧」噪声
    expect(run.stderr).not.toContain("已清除陈旧");
  } finally {
    await stub.close();
  }
}, 180_000);

test("中文导出：引擎降级 → reviews_zh.json 缺席 + exit 0 + stderr 人话（不复用降级档）", async () => {
  const stub = await startLoopbackStub(oneFindingCorpus());
  try {
    const enginePath = writeProjectionEngineFixture(
      "broken.mjs",
      `export default async () => { throw new Error("translation gateway down"); };\n`,
    );
    const outDir = makeTempDir("review-pi-cli-out-");
    const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), {
      ...stubEnv(stub.baseUrl),
      REVIEW_PI_PRESENTATION_ENGINE: enginePath,
    });

    expect(run.status).toBe(0);
    const repDir = cliRepDir(outDir);
    expect(existsSync(path.join(repDir, "reviews_en.json"))).toBe(true);
    expect(existsSync(path.join(repDir, "reviews_zh.json"))).toBe(false);
    expect(run.stderr).toContain("呈现投影降级");
    expect(run.stderr).toContain("translation gateway down");
  } finally {
    await stub.close();
  }
}, 180_000);

test("中文导出：陈旧 zh（引擎未配置）→ 本次 run 的 rep-1/ 内被清除 + stderr 留痕", async () => {
  const stub = await startLoopbackStub(oneFindingCorpus());
  try {
    const outDir = makeTempDir("review-pi-cli-out-");
    // 预置陈旧 zh 与分组意见（上一 run 遗留；本次未配置引擎 ⇒ 都应被清除）
    const repDir = cliRepDir(outDir);
    mkdirSync(repDir, { recursive: true });
    const stalePath = path.join(repDir, "reviews_zh.json");
    writeFileSync(stalePath, '{"stale":true}\n', "utf8");
    const staleTipsPath = path.join(repDir, "reviews_tips_zh.json");
    writeFileSync(staleTipsPath, '{"stale":true}\n', "utf8");

    const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), stubEnv(stub.baseUrl), {
      // 陈旧执行目录副本（ADR-0017 决策 14：本次不产 ⇒ 一并清除）
      seedCwdFiles: ["reviews_tips_zh.json", "review-result.json"],
    });

    expect(run.status).toBe(0);
    expect(existsSync(stalePath)).toBe(false);
    expect(existsSync(staleTipsPath)).toBe(false);
    expect(existsSync(path.join(repDir, "reviews_en.json"))).toBe(true);
    // cwd 里上次留下的两份副本也必须清掉——「有就是本次的」
    expect(existsSync(path.join(run.cwd, "reviews_tips_zh.json"))).toBe(false);
    expect(existsSync(path.join(run.cwd, "review-result.json"))).toBe(false);
    expect(run.stderr).toContain("已清除陈旧");
  } finally {
    await stub.close();
  }
}, 180_000);

test(
  "分组意见：tips 形状非法 → 只有 tips 缺席（zh 仍在、exit 0、stderr 说明），ADR-0017 弱耦合",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const enginePath = writeProjectionEngineFixture(
        "bad-tips.mjs",
        `export default async (source) => ({
          provenance: { language: "zh", terminologyVersion: 1, findingLinks: source.findings.map((f) => ({ sourceFindingId: f.id, projectedFindingId: f.id })) },
          findings: source.findings.map((f) => ({ ...f, title: "[zh] " + f.title, description: "[zh] " + f.description })),
          toolCallLog: source.toolCallLog,
          tips: { files: [{ filePath: "sample.txt", reviewTips: [{ code: "", review: "x", suggestion: "", category: "c", subcategory: "", severity: "Critical", ruleId: "", lineNum: 1, source: "common-reviewer", confidence: "High" }] }] },
        });\n`,
      );
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), {
        ...stubEnv(stub.baseUrl),
        REVIEW_PI_PRESENTATION_ENGINE: enginePath,
      });

      expect(run.status).toBe(0);
      const repDir = cliRepDir(outDir);
      expect(existsSync(path.join(repDir, "reviews_zh.json"))).toBe(true);
      expect(existsSync(path.join(repDir, "reviews_tips_zh.json"))).toBe(false);
      // cwd 副本同理不产（使「有就是本次的」成立）
      expect(existsSync(path.join(run.cwd, "reviews_tips_zh.json"))).toBe(false);
      expect(existsSync(path.join(run.cwd, "review-result.json"))).toBe(false);
      expect(run.stderr).toContain("本次未产分组意见");
      expect(run.stderr).toContain("severity must be one of");
      // stdout 仍是中文呈现档（tips 坏不拖累 zh）
      const outcome = JSON.parse(run.stdout) as { findings: { title: string }[] };
      expect(outcome.findings[0]?.title).toBe("[zh] Sentinel finding title");
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "分组意见：执行目录副本写不进（cwd 两份目标名被占成目录）→ stderr 警告 + exit 0 + rep-1 那份照产",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const enginePath = writeProjectionEngineFixture("zh-engine.mjs", ZH_ENGINE_BODY);
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runCliReview(
        outDir,
        writeMr(goldenFixture("vul4j-1.diff")),
        { ...stubEnv(stub.baseUrl), REVIEW_PI_PRESENTATION_ENGINE: enginePath },
        // cwd 里两个目标名都被目录占住 ⇒ 写文件必然失败
        { seedCwdDirs: ["reviews_tips_zh.json", "review-result.json"] },
      );

      // 便捷副本不配把检视判失败：exit 0
      expect(run.status).toBe(0);
      expect(run.stderr).toContain("执行目录副本写入失败");
      expect(run.stderr).toContain("review-result.json");
      // run 产物目录那份不受牵连
      expect(existsSync(path.join(cliRepDir(outDir), "reviews_tips_zh.json"))).toBe(true);
      // stdout 仍是完整 JSON 文档（未被 stderr 污染）
      expect(() => JSON.parse(run.stdout)).not.toThrow();
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test("中文导出：写盘失败（zh 路径预占为目录）→ exit 1 + 错误人话 + stdout 干净", async () => {
  const stub = await startLoopbackStub(oneFindingCorpus());
  try {
    const enginePath = writeProjectionEngineFixture("engine.mjs", ZH_ENGINE_BODY);
    const outDir = makeTempDir("review-pi-cli-out-");
    // 预占 zh 路径为目录 ⇒ writeFile 失败（EISDIR）⇒ 显式抛错 ⇒ exit 1
    const repDir = cliRepDir(outDir);
    mkdirSync(path.join(repDir, "reviews_zh.json"), { recursive: true });

    const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), {
      ...stubEnv(stub.baseUrl),
      REVIEW_PI_PRESENTATION_ENGINE: enginePath,
    });

    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("failed to persist review export");
    expect(run.stderr).toContain("reviews_zh.json");
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
    const run = await runBin(["review", "--repo", repoFixturePath("sample"), "--mr", "x.diff"], {
      env: stubEnv("http://127.0.0.1:9/v1"),
      timeoutMs: 30_000,
    });
    expect(run.status).toBe(1);
    expect(run.stdout).toBe("");
    expect(run.stderr).toContain("拒跑");
    expect(run.stderr).toContain("产物过期");
    expect(run.stderr).toContain("pnpm --filter review-pi build");
  } finally {
    utimesSync(entry, original, original);
  }
});

test("用法错误：缺 --mr → exit 1 + 人话错误 + usage 文案 + stdout 干净", async () => {
  const run = await runBin(["review", "--repo", repoFixturePath("sample")], {
    env: stubEnv("http://127.0.0.1:9/v1"),
    timeoutMs: 30_000,
  });
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("review-pi:");
  expect(run.stderr).toContain("usage:");
});

test("运行失败：--repo 指向文件（非目录）→ exit 1 + 错误人话 + stdout 干净", async () => {
  const notADir = path.join(makeTempDir("review-pi-cli-repo-"), "plain.txt");
  writeFileSync(notADir, "not a directory", "utf8");
  const run = await runBin(
    ["review", "--repo", notADir, "--mr", path.join(path.dirname(notADir), "x.diff")],
    { env: stubEnv("http://127.0.0.1:9/v1"), timeoutMs: 30_000 },
  );
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("--repo is not a directory");
});

// ---- smoke 命令面 ----

test("smoke 子命令：双探针通过 → exit 0 + stdout 人话报告；哨兵只进 Authorization 头", async () => {
  const stub = await startLoopbackStub([]);
  try {
    const run = await runBin(["smoke"], { env: stubEnv(stub.baseUrl) });

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
  const run = await runBin(["smoke"], { env: stubEnv("http://127.0.0.1:9/v1"), timeoutMs: 60_000 });

  expect(run.status).toBe(1);
  expect(run.stdout).toContain("FAILED");
  expect(run.stdout).toContain("gateway unreachable at http://127.0.0.1:9/v1");
  expect(run.stdout).toContain("skipped: the gateway is unreachable");
});

// ---- 规则 Skill 目录形态（ADR-0018：--rule-skill） ----

/** config F 零候选脚本：4 相位 OK + Phase-5 空候选 + skill 会话空候选 + Phase-6 空裁决 */
function ruleSkillDirCorpus(): FakeReply[] {
  const ZERO = { promptTokens: 0, completionTokens: 0, cacheReadTokens: 0 } as const;
  return [
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: "ok", usage: ZERO },
    { text: JSON.stringify({ candidates: [] }), usage: ZERO },
    { text: JSON.stringify({ candidates: [] }), usage: ZERO },
    { text: JSON.stringify({ verdicts: [], complete: true }), usage: ZERO },
  ];
}

test(
  "--rule-skill：已解压目录装载（config F），审计标 kind = dir，副本落 run 缓存而非原地",
  async () => {
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
          "--mr",
          mrFile,
          "--out",
          outDir,
          "--config",
          "F",
          "--rule-skill",
          skillDir,
          "--strict-rule-skill",
        ],
        { env: stubEnv(stub.baseUrl) },
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
        "review-pi-cli",
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

// ---- disposition 命令面（#15：本地数据面，无网络、不碰 .env.local） ----
// 夹具与 command.test.ts 共享单源（run-record-fixture.ts，E 形态生产入口锚）。

test(
  "disposition 记录 + KPI（进程面）：无凭据可跑、.env.local 在场也不装载（无网络命令）、落库可回溯",
  async () => {
    const dir = makeTempDir("review-pi-disposition-");
    const runRecordPath = path.join(dir, "rep-1.json");
    writeFileSync(runRecordPath, eRunRecordJson(), "utf8");
    const storePath = path.join(dir, "dispositions.json");

    // 记录处置：cwd 里种了 .env.local 诱饵——disposition 无网络，绝不装载（stderr 必须干净）
    const record = await runBin(
      [
        "disposition",
        "--run",
        runRecordPath,
        "--finding",
        "F100",
        "--decision",
        "accept",
        "--note",
        "真实缺陷，接受",
        "--store",
        storePath,
      ],
      { seedEnvLocal: `REVIEWER_URL=http://127.0.0.1:9/v1\nREVIEWER_API_KEY=${DECOY_KEY}\n` },
    );
    expect(record.status).toBe(0);
    expect(record.stderr).toBe("");
    const recordOutcome = JSON.parse(record.stdout) as {
      ok: boolean;
      store: string;
      recordCount: number;
      disposition: { findingId: string; disposition: string; caseId: string; configId: string; note: string };
    };
    expect(recordOutcome).toMatchObject({
      ok: true,
      store: storePath,
      recordCount: 1,
      disposition: {
        findingId: "F100",
        disposition: "accept",
        caseId: "VUL4J-1",
        configId: "E",
        note: "真实缺陷，接受",
      },
    });
    // 落库面：处置记录在库中（回溯锚齐备）；key 纪律全输出面扫描
    const store = JSON.parse(readFileSync(storePath, "utf8")) as unknown[];
    expect(store).toHaveLength(1);
    expectNoKeyLeak([
      { label: "stdout", text: record.stdout },
      { label: "stderr", text: record.stderr },
      { label: "store", text: JSON.stringify(store) },
    ]);

    // KPI 面：绝对口径直出单 JSON 文档
    const stats = await runBin(["disposition", "--stats", "--store", storePath], {});
    expect(stats.status).toBe(0);
    expect(JSON.parse(stats.stdout)).toEqual({
      ok: true,
      store: storePath,
      accepted: 1,
      rejected: 0,
      falsePositive: 0,
      total: 1,
      acceptanceRate: 1,
    });
  },
  180_000,
);

// ---- 运行进度投影（ADR-0016）进程面 ----

/** stdout 的键集（`ok` + ReviewOutcome）：进度绝不能新增键 */
const REVIEW_OUTCOME_KEYS = [
  "ok",
  "caseId",
  "configId",
  "runId",
  "truncated",
  "rounds",
  "toolCalls",
  "findings",
  "auditPath",
];

test(
  "--progress（非 TTY）：stderr 逐行投影阶段/请求/收尾摘要，stdout 仍是单 JSON 文档、键集不变",
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
          "--mr",
          mrFile,
          "--out",
          outDir,
          "--config",
          "B",
          "--progress",
        ],
        { env: stubEnv(stub.baseUrl) },
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
      expect(run.stderr).toMatch(/✓ done · req 6 · tools 0 · \d+\.\ds · cache [\d.]+% · \$\d+\.\d{4}/);
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
  "进度缺省静默（非 TTY）与 --no-progress 同；--progress 与 --no-progress 同给 = 用法错误 exit 1",
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
        "--mr",
        mrFile,
        "--out",
        outDir,
        "--config",
        "B",
      ];

      const auto = await runBin(baseArgs, { env: stubEnv(quietStub.baseUrl) });
      expect(auto.status).toBe(0);
      expect(auto.stderr).not.toContain("▶ phase");
      expect(auto.stderr).not.toContain("✓ done");

      const explicitOff = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr",
          mrFile,
          "--out",
          outDir2,
          "--config",
          "B",
          "--no-progress",
        ],
        { env: stubEnv(quietStub.baseUrl) },
      );
      expect(explicitOff.status).toBe(0);
      expect(explicitOff.stderr).not.toContain("▶ phase");
      expect(explicitOff.stderr).not.toContain("✓ done");

      const conflict = await runBin([...baseArgs, "--progress", "--no-progress"], {
        env: stubEnv(quietStub.baseUrl),
        timeoutMs: 30_000,
      });
      expect(conflict.status).toBe(1);
      expect(conflict.stdout).toBe("");
      expect(conflict.stderr).toContain("conflicting flags --progress and --no-progress");
      expect(conflict.stderr).toContain("usage:");
    } finally {
      await quietStub.close();
    }
  },
  240_000,
);

test("disposition 用法错误（非法 --decision）：exit 1 + 人话错误 + usage 文案 + stdout 干净", async () => {
  const run = await runBin(
    ["disposition", "--run", "x.json", "--finding", "F1", "--decision", "maybe"],
    { timeoutMs: 30_000 },
  );
  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain('invalid --decision "maybe"');
  expect(run.stderr).toContain("usage:");
});
