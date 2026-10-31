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
  /** 网关 base URL（写进本 run 的最小配置文件；缺省不写 baseUrl = 官方缺省） */
  readonly gatewayBaseUrl?: string;
  /** 呈现引擎模块路径（写进配置 `presentation.engine`） */
  readonly presentationEngine?: string;
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
  readonly timeoutMs?: number;
}

/** 最小配置（version + reviewer；可选 baseUrl / 呈现引擎） */
function minimalConfigText(options: RunBinOptions): string {
  const reviewer: Record<string, unknown> = { apiKey: SENTINEL_KEY };
  if (options.gatewayBaseUrl !== undefined) {
    reviewer["baseUrl"] = options.gatewayBaseUrl;
  }
  return `${JSON.stringify(
    {
      version: 1,
      reviewer,
      ...(options.presentationEngine !== undefined
        ? { presentation: { engine: options.presentationEngine } }
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
  const cwd = makeTempDir("review-pi-cli-cwd-");
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
      env: { ...process.env, HOME: sandboxHome, USERPROFILE: sandboxHome, ...options.env },
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

/** 子进程网关覆盖（写入本 run 的最小配置文件；不再经环境变量） */
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
        ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--out", outDir],
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
      expect(outcome.runId).toMatch(/^\d{8}T\d{6}\.\d{3}-VUL4J-1$/);
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
      // .env.local 残留提示：只声明「不再读取」，绝不回显文件内容
      expect(run.stderr).toContain("已不再读取 .env.local");
      expect(run.stderr).not.toContain(DECOY_KEY);
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
      // 接口原样形状：每项只有 new_path 与 diff（从 @@ 开始，无文件头）
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
            // 额外字段一概忽略（只读 new_path / diff）
            old_path: "ignored/old.ts",
            new_file: true,
            sha: "deadbeef",
          },
        ]),
        "utf8",
      );

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr-json", jsonFile, "--out", outDir],
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
      // 产物落在 mr 形态段下，路径不因输入是 JSON 而变化
      expect(existsSync(path.join(outDir, "runs", "mr", "MR-1234", "rep-1", "reviews_en.json"))).toBe(true);
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
    ["review", "--repo", repoFixturePath("sample"), "--mr-json", broken],
    env,
  );
  expect(bad.status).toBe(1);
  expect(bad.stdout).toBe("");
  expect(bad.stderr).toContain("--mr-json: 不是合法 JSON");

  const empty = path.join(dir, "empty.json");
  writeFileSync(empty, JSON.stringify([{ new_path: "a/b.png", diff: "" }]), "utf8");
  const nothing = await runBin(
    ["review", "--repo", repoFixturePath("sample"), "--mr-json", empty],
    env,
  );
  expect(nothing.status).toBe(1);
  expect(nothing.stderr).toContain("没有可转换的文本 diff");
});

test(
  "截断路径：phase-6 恒 complete:false → exit 0 + truncated=true + rounds=5（诚实截断不是失败）",
  async () => {
    const stub = await startLoopbackStub(truncationCorpus());
    try {
      const outDir = makeTempDir("review-pi-cli-out-");
      const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
      writeFileSync(mrFile, goldenFixture("vul4j-1.diff"), "utf8");

      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--out", outDir],
        stubEnv(stub.baseUrl),
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
          "--out",
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
    ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--config", missing],
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
    ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--config", dir],
    { appendConfigArg: false },
  );

  expect(run.status).toBe(1);
  expect(run.stdout).toBe("");
  expect(run.stderr).toContain("无法读取配置文件");
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
        ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--out", outDir],
        { gatewayBaseUrl: stub.baseUrl, presentationEngine: enginePath },
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
        ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--out", outDir],
        { gatewayBaseUrl: stub.baseUrl, presentationEngine: enginePath },
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

test(
  "呈现投影：引擎路径指向不存在的模块 → 装载期按未配置引擎处理（exit 0 + 一行 stderr + 无 presentation 键）",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const missingEngine = path.join(makeTempDir("review-pi-cli-missing-engine-"), "nope.mjs");
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), {
        gatewayBaseUrl: stub.baseUrl,
        presentationEngine: missingEngine,
      });

      // ADR-0026：缺模块 = 本次「未配置引擎」，不是运行失败
      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as {
        findings: { title: string }[];
        presentation?: unknown;
      };
      // 恒等直通：英文源档 + 无 presentation 键（与「从未配置引擎」同一形态）
      expect(outcome.findings[0]?.title).toBe("Sentinel finding title");
      expect(outcome.presentation).toBeUndefined();
      // 装载期就报，而不是先喊「投影进行中」再在几十秒后降级
      expect(run.stderr).toContain("presentation.engine 指向的模块不存在");
      expect(run.stderr).toContain("nope.mjs");
      expect(run.stderr).not.toContain("呈现投影进行中");
      // 检视请求面零影响
      expect(stub.requests()).toHaveLength(6);
      expectNoKeyLeak([{ label: "stdout", text: run.stdout }, { label: "stderr", text: run.stderr }]);
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "呈现投影：引擎相对路径按**配置文件所在目录**解析（从别的 cwd 启动也是同一结果，ADR-0026）",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      // 引擎落在配置文件旁的 engines/ 子目录；配置里只写相对路径
      const configDir = makeTempDir("review-pi-cli-config-dir-");
      const engineDir = path.join(configDir, "engines");
      mkdirSync(engineDir, { recursive: true });
      writeFileSync(
        path.join(engineDir, "zh-engine.mjs"),
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
        "utf8",
      );
      const configPath = path.join(configDir, "PiAgent.jsonc");
      const configText = `${JSON.stringify(
        {
          version: 1,
          reviewer: { apiKey: SENTINEL_KEY, baseUrl: stub.baseUrl },
          presentation: { engine: "engines/zh-engine.mjs" },
        },
        null,
        2,
      )}\n`;
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runBin(
        ["review", "--repo", repoFixturePath("sample"), "--mr-diff", writeMr(goldenFixture("vul4j-1.diff")), "--out", outDir],
        { configPath, configText },
      );

      expect(run.status).toBe(0);
      const outcome = JSON.parse(run.stdout) as {
        findings: { title: string }[];
        presentation?: { language: string };
      };
      // 子进程 cwd 与 configDir 是两个不同目录：只有按配置文件目录解析才会命中
      expect(run.cwd).not.toBe(configDir);
      expect(outcome.findings[0]?.title).toBe("[zh] Sentinel finding title");
      expect(outcome.presentation?.language).toBe("zh");
      expect(run.stderr).not.toContain("指向的模块不存在");
    } finally {
      await stub.close();
    }
  },
  180_000,
);

// ---- 检视意见中文导出（ADR-0013 Step B）：zh 生命周期矩阵 ----
// zh 由核外 CLI 缝编排（复用同一次投影结果，绝不额外调网关），与 en 同 rep 目录。
// 路径基线：<out>/runs/mr/VUL4J-1/rep-1/（ADR-0027：无 experimentId 层）

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

/** 本次 run 的 rep-1 产物目录（reviews_en.json / reviews_tips_zh.json 同层） */
function cliRepDir(outDir: string): string {
  return path.join(outDir, "runs", "mr", "VUL4J-1", "rep-1");
}

/** 单 MR 检视调用（唯一形态；可选注入呈现引擎与 cwd 预置文件） */
function runCliReview(
  outDir: string,
  mrFile: string,
  config: RunBinOptions,
  options: RunBinOptions = {},
): Promise<CliRunResult> {
  return runBin(
    ["review", "--repo", repoFixturePath("sample"), "--mr-diff", mrFile, "--out", outDir],
    { ...options, ...config },
  );
}

function writeMr(diff: string): string {
  const mrFile = path.join(makeTempDir("review-pi-cli-mr-"), "VUL4J-1.diff");
  writeFileSync(mrFile, diff, "utf8");
  return mrFile;
}

test(
  "中文产物：引擎注入 → stdout 中文 + reviews_tips_zh.json 落盘（不再产 reviews_zh.json，ADR-0022）+ 无额外网关请求",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const enginePath = writeProjectionEngineFixture("engine.mjs", ZH_ENGINE_BODY);
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), {
        gatewayBaseUrl: stub.baseUrl,
        presentationEngine: enginePath,
      });

      expect(run.status).toBe(0);
      const repDir = cliRepDir(outDir);
      expect(existsSync(path.join(repDir, "reviews_en.json"))).toBe(true);
      // ADR-0022：zh 文件停产——中文交付物只有 tips；投影留痕改由 stdout 承担
      expect(existsSync(path.join(repDir, "reviews_zh.json"))).toBe(false);

      const outcome = JSON.parse(run.stdout) as {
        findings: { id: string; severity: string; title: string; description: string; file: string; line: number }[];
        presentation: { language: string; terminologyVersion: number; findingLinks: unknown };
      };
      expect(outcome.presentation.language).toBe("zh");
      expect(outcome.presentation.terminologyVersion).toBe(1);
      expect(outcome.presentation.findingLinks).toEqual([
        { sourceFindingId: "F100", projectedFindingId: "F100" },
      ]);
      // 自然语言字段已译、结构化字段字节直通
      expect(outcome.findings[0]).toMatchObject({
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
      // 执行目录副本（ADR-0017 决策 14 / ADR-0027）：cwd 只放 review-result.json，
      // 内容与 rep-1 那份逐字节相同；真源永远在 run 目录里，cwd 不再写原名副本
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

test("中文产物：未配置引擎 → reviews_tips_zh.json / reviews_zh.json 都缺席 + exit 0（en 仍在，无陈旧清除噪声）", async () => {
  const stub = await startLoopbackStub(oneFindingCorpus());
  try {
    const outDir = makeTempDir("review-pi-cli-out-");
    const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), stubEnv(stub.baseUrl));

    expect(run.status).toBe(0);
    const repDir = cliRepDir(outDir);
    expect(existsSync(path.join(repDir, "reviews_en.json"))).toBe(true);
    expect(existsSync(path.join(repDir, "reviews_zh.json"))).toBe(false);
    expect(existsSync(path.join(repDir, "reviews_tips_zh.json"))).toBe(false);
    // 本次 run 无陈旧 zh / tips ⇒ 无「已清除陈旧」噪声
    expect(run.stderr).not.toContain("已清除陈旧");
  } finally {
    await stub.close();
  }
}, 180_000);

test("中文产物：引擎降级 → 两份中文产物都缺席 + exit 0 + stderr 人话（不复用降级档）", async () => {
  const stub = await startLoopbackStub(oneFindingCorpus());
  try {
    const enginePath = writeProjectionEngineFixture(
      "broken.mjs",
      `export default async () => { throw new Error("translation gateway down"); };\n`,
    );
    const outDir = makeTempDir("review-pi-cli-out-");
    const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), {
      gatewayBaseUrl: stub.baseUrl,
      presentationEngine: enginePath,
    });

    expect(run.status).toBe(0);
    const repDir = cliRepDir(outDir);
    expect(existsSync(path.join(repDir, "reviews_en.json"))).toBe(true);
    expect(existsSync(path.join(repDir, "reviews_zh.json"))).toBe(false);
    expect(existsSync(path.join(repDir, "reviews_tips_zh.json"))).toBe(false);
    expect(run.stderr).toContain("呈现投影降级");
    expect(run.stderr).toContain("translation gateway down");
  } finally {
    await stub.close();
  }
}, 180_000);

test("中文产物：陈旧 zh + tips（引擎未配置）→ 本次 run 的 rep-1/ 内被清除 + stderr 留痕", async () => {
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
  "分组意见：tips 形状非法 → 只有 tips 缺席（stdout 中文、exit 0、stderr 说明），ADR-0017 弱耦合",
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
        gatewayBaseUrl: stub.baseUrl,
        presentationEngine: enginePath,
      });

      expect(run.status).toBe(0);
      const repDir = cliRepDir(outDir);
      expect(existsSync(path.join(repDir, "reviews_zh.json"))).toBe(false);
      expect(existsSync(path.join(repDir, "reviews_tips_zh.json"))).toBe(false);
      // cwd 副本同理不产（使「有就是本次的」成立）
      expect(existsSync(path.join(run.cwd, "reviews_tips_zh.json"))).toBe(false);
      expect(existsSync(path.join(run.cwd, "review-result.json"))).toBe(false);
      expect(run.stderr).toContain("本次未产分组意见");
      expect(run.stderr).toContain("severity must be one of");
      // stdout 仍是中文呈现档（tips 坏不拖累 stdout 与 en）
      const outcome = JSON.parse(run.stdout) as { findings: { title: string }[] };
      expect(outcome.findings[0]?.title).toBe("[zh] Sentinel finding title");
    } finally {
      await stub.close();
    }
  },
  180_000,
);

test(
  "分组意见：执行目录副本写不进（cwd 的 review-result.json 被占成目录）→ stderr 警告 + exit 0 + rep-1 那份照产",
  async () => {
    const stub = await startLoopbackStub(oneFindingCorpus());
    try {
      const enginePath = writeProjectionEngineFixture("zh-engine.mjs", ZH_ENGINE_BODY);
      const outDir = makeTempDir("review-pi-cli-out-");
      const run = await runCliReview(
        outDir,
        writeMr(goldenFixture("vul4j-1.diff")),
        { gatewayBaseUrl: stub.baseUrl, presentationEngine: enginePath },
        // cwd 的目标名被目录占住 ⇒ 写文件必然失败
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

test("中文产物：写盘失败（tips 路径预占为目录）→ exit 1 + 错误人话 + stdout 干净", async () => {
  const stub = await startLoopbackStub(oneFindingCorpus());
  try {
    const enginePath = writeProjectionEngineFixture("engine.mjs", ZH_ENGINE_BODY);
    const outDir = makeTempDir("review-pi-cli-out-");
    // 预占 tips 路径为目录 ⇒ writeFile 失败（EISDIR）⇒ 显式抛错 ⇒ exit 1
    const repDir = cliRepDir(outDir);
    mkdirSync(path.join(repDir, "reviews_tips_zh.json"), { recursive: true });

    const run = await runCliReview(outDir, writeMr(goldenFixture("vul4j-1.diff")), {
      gatewayBaseUrl: stub.baseUrl,
      presentationEngine: enginePath,
    });

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
    expect(run.stderr).toContain("pnpm --filter review-pi build");
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

test("运行失败：--repo 指向文件（非目录）→ exit 1 + 错误人话 + stdout 干净", async () => {
  const notADir = path.join(makeTempDir("review-pi-cli-repo-"), "plain.txt");
  writeFileSync(notADir, "not a directory", "utf8");
  const run = await runBin(
    ["review", "--repo", notADir, "--mr-diff", path.join(path.dirname(notADir), "x.diff")],
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

/** 规则 Skill 目录形态零候选脚本：4 相位 OK + Phase-5 空候选 + skill 会话空候选 + Phase-6 空裁决 */
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
  "--rule-skill：已解压目录装载，审计标 kind = dir，副本落 run 缓存而非原地",
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
          "--mr-diff",
          mrFile,
          "--out",
          outDir,
          "--rule-skill",
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
          "--mr-diff",
          mrFile,
          "--out",
          outDir,
          "--progress",
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
  "进度事件行缺省静默（非 TTY）与 --no-progress 同，但收尾摘要仍恒打一行；--progress 与 --no-progress 同给 = 用法错误 exit 1",
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
        "--out",
        outDir,
      ];

      const auto = await runBin(baseArgs, stubEnv(quietStub.baseUrl));
      expect(auto.status).toBe(0);
      expect(auto.stderr).not.toContain("▶ phase");
      expect(auto.stderr).not.toContain("req 1 ");
      // 进度关闭 ≠ 零输出：收尾摘要恒定打印（一行，避免「跑完什么都没说」）
      expect(auto.stderr).toContain("✓ 完成 · 耗时 ");

      const explicitOff = await runBin(
        [
          "review",
          "--repo",
          repoFixturePath("sample"),
          "--mr-diff",
          mrFile,
          "--out",
          outDir2,
          "--no-progress",
        ],
        stubEnv(quietStub.baseUrl),
      );
      expect(explicitOff.status).toBe(0);
      expect(explicitOff.stderr).not.toContain("▶ phase");
      expect(explicitOff.stderr).toContain("✓ 完成 · 耗时 ");

      const conflict = await runBin([...baseArgs, "--progress", "--no-progress"], {
        ...stubEnv(quietStub.baseUrl),
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
