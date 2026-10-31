import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, test } from "vitest";

import { checkRuntimeArtifacts } from "../../bin/lib/cli-runtime.js";

// `review-pi config` 进程面（ADR-0025）：init / show / init --from-env。
//
// 每个用例都在隔离沙箱里跑真进程：cwd 是干净 tmpdir，HOME / USERPROFILE 指向
// 另一个空 tmpdir —— 用户级 `~/.PiAgent/PiAgent.json` 与真实 home 绝不参与。
// 秘密纪律：任何输出面都不允许出现 apiKey 值（只允许 `set|missing`）。

const packageDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = path.resolve(packageDir, "..", "..");
const BIN_PATH = path.join(packageDir, "bin", "review-pi.js");

const SENTINEL_KEY = "sk-config-process-sentinel-91c2";

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

beforeAll(async () => {
  const check = checkRuntimeArtifacts();
  if (check.ok) {
    return;
  }
  const staleCommands = new Set(check.refusals.map((refusal) => refusal.buildCommand));
  for (const command of [
    "pnpm build:pi",
    "pnpm --filter review-llm build",
    "pnpm --filter review-pi build",
  ]) {
    if (!staleCommands.has(command)) {
      continue;
    }
    const run = spawnSync(command, { cwd: repoRoot, shell: true, encoding: "utf8", timeout: 480_000 });
    if (run.status !== 0) {
      throw new Error(
        `self-heal build failed (${command}, exit ${run.status}):\n${run.stdout ?? ""}${run.stderr ?? ""}`,
      );
    }
  }
}, 600_000);

interface CliRunResult {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly cwd: string;
  readonly home: string;
}

function runCli(
  args: readonly string[],
  options: { readonly cwd?: string; readonly seedFiles?: Readonly<Record<string, string>> } = {},
): Promise<CliRunResult> {
  const cwd = options.cwd ?? makeTempDir("review-pi-config-cwd-");
  const home = makeTempDir("review-pi-config-home-");
  for (const [name, content] of Object.entries(options.seedFiles ?? {})) {
    writeFileSync(path.join(cwd, name), content, "utf8");
  }
  return new Promise<CliRunResult>((resolve, reject) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd,
      env: { ...process.env, HOME: home, USERPROFILE: home },
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => child.kill(), 60_000);
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
        resolve({ status: code, stdout, stderr, cwd, home });
      }
    });
  });
}

function homeConfigPath(home: string): string {
  return path.join(home, ".PiAgent", "PiAgent.json");
}

test("config init：写到沙箱 home 的 ~/.PiAgent/PiAgent.json，JSONC 模板可被 show 读回", async () => {
  const init = await runCli(["config", "init"]);
  expect(init.status).toBe(0);
  expect(init.stdout).toContain("已写入配置文件");
  expect(init.stderr).toBe("");
  expect(init.stdout).not.toContain(SENTINEL_KEY);

  const filePath = homeConfigPath(init.home);
  expect(existsSync(filePath)).toBe(true);
  const text = readFileSync(filePath, "utf8");
  // JSONC：注释 + 全部键（与运行期缺省同源）
  expect(text).toContain("// PiAgent 运行配置");
  expect(text).toContain('"version": 1');
  expect(text).toContain('"callChainHops": 2');

  // 写出来就能读回去：初始态 apiKey 为空 = missing，show 不炸
  const show = await runCli(["config", "show", "--config", filePath, "--json"]);
  expect(show.status).toBe(0);
  const snapshot = JSON.parse(show.stdout) as {
    path: string;
    secret: Record<string, string>;
    values: Record<string, unknown>;
  };
  expect(snapshot.path).toBe(filePath);
  expect(snapshot.secret).toEqual({ "reviewer.apiKey": "missing" });
  expect(snapshot.values["model.default"]).toBe("deepseek-v4-flash");

  // POSIX 权限 0600（Windows 无此语义）
  if (process.platform !== "win32") {
    expect(statSync(filePath).mode & 0o777).toBe(0o600);
  }
});

test("config init 二次执行：拒绝覆盖 exit 1（人话指出 --force）；--force 覆盖 exit 0", async () => {
  const first = await runCli(["config", "init"]);
  expect(first.status).toBe(0);
  const filePath = homeConfigPath(first.home);

  const again = await runCli(["config", "init", "--config", filePath]);
  expect(again.status).toBe(1);
  expect(again.stderr).toContain("配置文件已存在");
  expect(again.stderr).toContain("--force");

  const forced = await runCli(["config", "init", "--config", filePath, "--force"]);
  expect(forced.status).toBe(0);
  expect(forced.stdout).toContain(filePath);
});

test("config init --config <path>：相对路径按 cwd 解析，目录自动创建", async () => {
  const result = await runCli(["config", "init", "--config", "nested/PiAgent.json"]);
  expect(result.status).toBe(0);
  const written = path.join(result.cwd, "nested", "PiAgent.json");
  expect(existsSync(written)).toBe(true);
  expect(readFileSync(written, "utf8")).toContain('"version": 1');
});

test("config init --from-env：迁移键名回显、秘密不回显、未知键丢弃、相对引擎路径绝对化", async () => {
  const envLocal = [
    "REVIEWER_API_KEY=" + SENTINEL_KEY,
    "REVIEWER_URL=https://ark.example.com/api/coding/v3/",
    "REVIEWER_MAX_TOKENS=4096",
    "REVIEW_PI_PRESENTATION_ENGINE=./engine/engine-zh.js",
    "REVIEW_PI_PRESENTATION_MODEL=deepseek-v4-flash",
    "SOME_UNKNOWN_KEY=keep-out",
    "",
  ].join("\n");

  const result = await runCli(["config", "init", "--from-env", ".env.local"], {
    seedFiles: { ".env.local": envLocal },
  });
  expect(result.status).toBe(0);
  // 只回显键名：值（尤其 key）绝不出现
  for (const name of [
    "REVIEWER_API_KEY",
    "REVIEWER_URL",
    "REVIEWER_MAX_TOKENS",
    "REVIEW_PI_PRESENTATION_ENGINE",
    "REVIEW_PI_PRESENTATION_MODEL",
  ]) {
    expect(result.stdout).toContain(name);
  }
  expect(result.stdout).not.toContain(SENTINEL_KEY);
  expect(result.stdout).not.toContain("ark.example.com");
  expect(result.stdout).toContain("已丢弃未识别键");
  expect(result.stdout).toContain("SOME_UNKNOWN_KEY");
  expect(result.stderr).toBe("");

  const written = homeConfigPath(result.home);
  const text = readFileSync(written, "utf8");
  expect(text).toContain(`"apiKey": ${JSON.stringify(SENTINEL_KEY)}`);
  // baseUrl 尾斜杠归一；引擎相对路径按写入时 cwd 绝对化（之后换 cwd 不失效）
  expect(text).toContain('"baseUrl": "https://ark.example.com/api/coding/v3"');
  expect(text).toContain('"maxOutputTokens": 4096');
  expect(text).toContain('"presentation": "deepseek-v4-flash"');
  expect(text).toContain(JSON.stringify(path.join(result.cwd, "engine", "engine-zh.js")));

  // 迁移产物仍可读回：key 记 set，值不回显
  const show = await runCli(["config", "show", "--config", written]);
  expect(show.status).toBe(0);
  expect(show.stdout).toContain("reviewer.apiKey");
  expect(show.stdout).toContain("set");
  expect(show.stdout).not.toContain(SENTINEL_KEY);
  expect(show.stdout).toContain("https://ark.example.com/api/coding/v3");
  // 迁移产物把全部键落成显式值（模板形状）：全部标 file
  expect(show.stdout).toContain("(file)");
});

test("config init --from-env：源文件不存在 / 缺值 = 人话错误 exit 1", async () => {
  const missing = await runCli(["config", "init", "--from-env", "nope.env"]);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("--from-env");
  expect(missing.stderr).toContain("不存在");

  const badTokens = await runCli(["config", "init", "--from-env", ".env.local"], {
    seedFiles: { ".env.local": "REVIEWER_MAX_TOKENS=1.5\n" },
  });
  expect(badTokens.status).toBe(1);
  expect(badTokens.stderr).toContain("REVIEWER_MAX_TOKENS");
});

test("config show：逐键值 + 来源 + digest 末行；秘密只报 set", async () => {
  const configPath = path.join(makeTempDir("review-pi-config-file-"), "PiAgent.json");
  writeFileSync(
    configPath,
    `{
      // 注释不影响解析
      "version": 1,
      "reviewer": { "apiKey": ${JSON.stringify(SENTINEL_KEY)}, "baseUrl": "https://gw.example.com/v1" },
      "limits": { "boundary": { "maxFiles": null } },
    }\n`,
    "utf8",
  );

  const show = await runCli(["config", "show", "--config", configPath]);
  expect(show.status).toBe(0);
  expect(show.stdout).toContain(`review-pi config: ${configPath}（found）`);
  expect(show.stdout).toMatch(/reviewer\.apiKey\s+set/);
  expect(show.stdout).toContain("https://gw.example.com/v1  (file)");
  expect(show.stdout).toContain("limits.boundary.maxFiles");
  // 未写进文件的键 = 缺省来源
  expect(show.stdout).toContain("(default)");
  expect(show.stdout).toMatch(/digest\s+[0-9a-f]{12}/);
  expect(show.stdout).not.toContain(SENTINEL_KEY);
});

test("config show --json：快照形状固定，秘密只记 set，键值不出现在任何输出", async () => {
  const configPath = path.join(makeTempDir("review-pi-config-file-"), "PiAgent.json");
  writeFileSync(
    configPath,
    `${JSON.stringify({ version: 1, reviewer: { apiKey: SENTINEL_KEY } })}\n`,
    "utf8",
  );
  const show = await runCli(["config", "show", "--config", configPath, "--json"]);
  expect(show.status).toBe(0);
  expect(show.stderr).toBe("");
  const snapshot = JSON.parse(show.stdout) as Record<string, unknown>;
  expect(Object.keys(snapshot)).toEqual(["path", "version", "digest", "values", "overridden", "secret"]);
  expect(snapshot["secret"]).toEqual({ "reviewer.apiKey": "set" });
  expect(snapshot["overridden"]).toContain("reviewer.apiKey");
  expect(show.stdout).not.toContain(SENTINEL_KEY);
});

test("config show：--config 指向不存在文件 = exit 1 人话；坏 JSONC = exit 1 带行列", async () => {
  const missingPath = path.join(makeTempDir("review-pi-config-file-"), "nope.json");
  const missing = await runCli(["config", "show", "--config", missingPath]);
  expect(missing.status).toBe(1);
  expect(missing.stderr).toContain("--config");
  expect(missing.stderr).toContain(missingPath);
  expect(missing.stdout).toBe("");

  const broken = await runCli(["config", "show", "--config", "broken.json"], {
    seedFiles: { "broken.json": `{\n  "version": 1,\n  "reviewer": { "apiKey": "sk-x" }\n` },
  });
  expect(broken.status).toBe(1);
  expect(broken.stderr).toMatch(/parse error at line \d+, column \d+/);
  expect(broken.stdout).toBe("");
});
