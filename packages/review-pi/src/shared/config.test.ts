import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  CONFIG_VERSION,
  ConfigError,
  DEFAULT_CONFIG_TEMPLATE,
  DEFAULT_GATEWAY_MAX_TOKENS,
  DEFAULT_LIMITS,
  DEFAULT_MODEL_ID,
  OFFICIAL_REVIEWER_BASE_URL,
  configSnapshot,
  loadConfig,
  requireApiKey,
  resolveConfigPath,
  writeConfigFile,
} from "./config.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "piagent-config-"));
  temps.push(dir);
  return dir;
}

function writeConfig(text: string): string {
  const path = join(tempDir(), "PiAgent.json");
  writeFileSync(path, text, "utf8");
  return path;
}

function minimalConfig(extra = ""): string {
  return `{
    "version": 1,
    "reviewer": { "apiKey": "sk-sentinel", "baseUrl": "https://gw.example.com/v1/" }${extra}
  }`;
}

afterEach(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveConfigPath", () => {
  test("--config 相对路径按 cwd 解析，且不碰 home", () => {
    expect(
      resolveConfigPath({
        configPath: "conf/pi.json",
        cwd: "C:\\work",
        env: {},
        platform: "win32",
      }),
    ).toBe("C:\\work\\conf\\pi.json");
  });

  test("Windows 读 USERPROFILE，POSIX 读 HOME", () => {
    expect(
      resolveConfigPath({ env: { USERPROFILE: "C:\\Users\\Li", HOME: "/home/li" }, platform: "win32" }),
    ).toBe("C:\\Users\\Li\\.PiAgent\\PiAgent.json");
    expect(
      resolveConfigPath({ env: { USERPROFILE: "C:\\Users\\Li", HOME: "/home/li" }, platform: "linux" }),
    ).toBe("/home/li/.PiAgent/PiAgent.json");
  });

  test("home 为空 = fail fast（不回落 os.homedir）", () => {
    expect(() => resolveConfigPath({ env: { HOME: "  " }, platform: "linux" })).toThrow(ConfigError);
    expect(() => resolveConfigPath({ env: {}, platform: "win32" })).toThrow(/--config/);
  });
});

describe("loadConfig：缺省与形状", () => {
  test("文件缺失 = 全缺省（不报错）", () => {
    const path = join(tempDir(), "absent.json");
    const { config, warnings } = loadConfig({ configPath: path });
    expect(warnings).toEqual([]);
    expect(config.exists).toBe(false);
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.reviewer).toEqual({
      apiKey: null,
      baseUrl: OFFICIAL_REVIEWER_BASE_URL,
      maxOutputTokens: null,
    });
    expect(config.model).toEqual({ default: DEFAULT_MODEL_ID, presentation: null });
    expect(config.limits).toEqual(DEFAULT_LIMITS);
    expect(config.presentation.engine).toBe(null);
  });

  test("最小文件：reviewer 生效、baseUrl 尾斜杠归一并记录来源", () => {
    const path = writeConfig(minimalConfig());
    const { config } = loadConfig({ configPath: path });
    expect(config.exists).toBe(true);
    expect(config.reviewer.apiKey).toBe("sk-sentinel");
    expect(config.reviewer.baseUrl).toBe("https://gw.example.com/v1");
    expect(config.overridden).toEqual(["reviewer.apiKey", "reviewer.baseUrl"]);
    expect(config.digest).toMatch(/^[0-9a-f]{12}$/);
  });

  test("JSONC：注释 + 尾逗号", () => {
    const path = writeConfig(`{
      // 注释
      "version": 1,
      "reviewer": { "apiKey": "k", /* block */ },
    }`);
    expect(loadConfig({ configPath: path }).config.reviewer.apiKey).toBe("k");
  });

  test("BOM 不炸", () => {
    const path = writeConfig(`\uFEFF{"version":1,"reviewer":{"apiKey":"k"}}`);
    expect(loadConfig({ configPath: path }).config.reviewer.apiKey).toBe("k");
  });

  test("空 apiKey 视同缺失（模板初始态）", () => {
    const path = writeConfig(`{"version":1,"reviewer":{"apiKey":"   "}}`);
    const { config } = loadConfig({ configPath: path });
    expect(config.reviewer.apiKey).toBe(null);
    expect(() => requireApiKey(config)).toThrow(/config init/);
  });

  test("digest 是配置指纹：同值同摘要，改 limit 即变", () => {
    const a = loadConfig({ configPath: writeConfig(minimalConfig()) }).config;
    const b = loadConfig({ configPath: writeConfig(minimalConfig()) }).config;
    expect(a.digest).toBe(b.digest);
    const c = loadConfig({
      configPath: writeConfig(
        minimalConfig(`, "limits": { "timeouts": { "skillBashMs": 60000 } }`),
      ),
    }).config;
    expect(c.digest).not.toBe(a.digest);
    expect(c.overridden).toContain("limits.timeouts.skillBashMs");
  });

  test("全量生效值进 values，secret 只记 set", () => {
    const path = writeConfig(minimalConfig());
    const snapshot = configSnapshot(loadConfig({ configPath: path }).config);
    expect(snapshot.secret).toEqual({ "reviewer.apiKey": "set" });
    expect(snapshot.values["limits.timeouts.skillPassMs"]).toBe(DEFAULT_LIMITS.timeouts.skillPassMs);
    expect(snapshot.values["model.default"]).toBe(DEFAULT_MODEL_ID);
    expect(JSON.stringify(snapshot)).not.toContain("sk-sentinel");
  });
});

describe("loadConfig：失败策略", () => {
  test("version 缺失 / 不等 = fail fast", () => {
    expect(() => loadConfig({ configPath: writeConfig(`{}`) })).toThrow(/version is required/);
    expect(() => loadConfig({ configPath: writeConfig(`{"version":2}`) })).toThrow(/version must be 1/);
  });

  test("类型错与越界都 fail fast，指出键路径", () => {
    expect(() =>
      loadConfig({ configPath: writeConfig(`{"version":1,"limits":{"concurrency":{"suggestion":"4"}}}`) }),
    ).toThrow(/limits.concurrency.suggestion must be an integer/);
    expect(() =>
      loadConfig({ configPath: writeConfig(`{"version":1,"limits":{"concurrency":{"suggestion":0}}}`) }),
    ).toThrow(/must be in 1…16 \(got 0\)/);
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"limits":{"timeouts":{"skillPassMs":0}}`)) }),
    ).toThrow(/skillPassMs must be in 1000…3600000/);
  });

  test("0 对字数上限也非法；缓冲是唯一允许 0 的超时键", () => {
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"limits":{"micro":{"queryEchoChars":0}}`)) }),
    ).toThrow(/queryEchoChars must be in 1…10000/);
    const buffered = loadConfig({
      configPath: writeConfig(
        minimalConfig(`,"limits":{"timeouts":{"presentationBufferMs":0}}`),
      ),
    }).config;
    expect(buffered.limits.timeouts.presentationBufferMs).toBe(0);
  });

  test("未知键 = 警告继续（带最近键提示）", () => {
    const { warnings, config } = loadConfig({
      configPath: writeConfig(minimalConfig(`,"limits":{"boundary":{"maxFile":5}}`)),
    });
    expect(config.limits.boundary.maxFiles).toBe(DEFAULT_LIMITS.boundary.maxFiles);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unknown key limits.boundary.maxFile");
    expect(warnings[0]).toContain("did you mean maxFiles?");
  });

  test("钉死键 = 警告「不会被采用」", () => {
    const { warnings, config } = loadConfig({
      configPath: writeConfig(minimalConfig(`,"limits":{"micro":{"toolResultBudgetChars":100}}`)),
    });
    expect(warnings[0]).toContain("已钉死");
    expect(config).toBeDefined();
  });

  test("models 未知叶子 = fail fast；方言字段 = fail fast", () => {
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"models":{"m":{"contxtWindow":1}}`)) }),
    ).toThrow(/models\.m\.contxtWindow is unknown \(did you mean contextWindow\?\)/);
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"models":{"m":{"compat":{}}}`)) }),
    ).toThrow(/is pinned/);
  });

  test("非法 baseUrl 协议 = fail fast", () => {
    expect(() =>
      loadConfig({ configPath: writeConfig(`{"version":1,"reviewer":{"baseUrl":"ftp://x"}}`) }),
    ).toThrow(/must start with http/);
  });

  test("JSONC 语法错 = 带行列的人话", () => {
    expect(() => loadConfig({ configPath: writeConfig(`{"version": 1,,}`) })).toThrow(/parse error at line/);
  });

  test("不可读文件 = 人话错误", () => {
    const dir = tempDir();
    expect(() => loadConfig({ configPath: dir })).toThrow(/无法读取配置文件/);
  });

  test("POSIX 权限过宽 = 警告继续（Windows 无此语义）", () => {
    if (process.platform === "win32") {
      return;
    }
    const path = writeConfig(minimalConfig());
    chmodSync(path, 0o644);
    const { warnings } = loadConfig({ configPath: path });
    expect(warnings.some((line) => line.includes("宽于 0600"))).toBe(true);
  });
});

describe("loadConfig：模型元数据与边界", () => {
  test("models 深合并：只覆盖写到的叶子", () => {
    const path = writeConfig(
      minimalConfig(
        `,"models":{"deepseek-v4-flash":{"contextWindow":128000,"cost":{"output":1.5}}}`,
      ),
    );
    const { config } = loadConfig({ configPath: path });
    expect(config.models["deepseek-v4-flash"]).toEqual({
      contextWindow: 128000,
      cost: { output: 1.5 },
    });
  });

  test("boundary 的 null = 显式关闭（与「没写」可区分）", () => {
    const path = writeConfig(
      minimalConfig(`,"limits":{"boundary":{"maxFiles":null,"maxDiffLines":50}}`),
    );
    const { config } = loadConfig({ configPath: path });
    expect(config.limits.boundary).toEqual({ maxFiles: null, maxDiffLines: 50 });
    expect(config.overridden).toContain("limits.boundary.maxFiles");
  });

  test("maxOutputTokens=null 保留为自动判档", () => {
    const path = writeConfig(
      `{"version":1,"reviewer":{"apiKey":"k","maxOutputTokens":null}}`,
    );
    const { config } = loadConfig({ configPath: path });
    expect(config.reviewer.maxOutputTokens).toBe(null);
    expect(config.reviewer.maxOutputTokens).not.toBe(DEFAULT_GATEWAY_MAX_TOKENS);
  });
});

describe("writeConfigFile", () => {
  test("写盘：目录自动创建 + 拒绝覆盖 + --force", () => {
    const path = join(tempDir(), "nested", "PiAgent.json");
    writeConfigFile({ path });
    const text = readFileSync(path, "utf8");
    expect(text).toContain('"version": 1');
    expect(text).toContain("reviewer");
    expect(() => writeConfigFile({ path })).toThrow(/已存在/);
    writeConfigFile({ path, force: true, content: '{"version":1}' });
    expect(readFileSync(path, "utf8")).toBe('{"version":1}');
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o077).toBe(0);
    }
  });

  test("模板本身可被解析（写出来就能读回去）", () => {
    const path = join(tempDir(), "PiAgent.json");
    writeConfigFile({ path });
    const { config } = loadConfig({ configPath: path });
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.limits).toEqual(DEFAULT_LIMITS);
  });
});

describe("常量对齐", () => {
  test("缺省模板与运行期缺省同源（防漂移）", () => {
    const dir = tempDir();
    const path = join(dir, "PiAgent.json");
    writeConfigFile({ path });
    const { config } = loadConfig({ configPath: path });
    expect(config.limits.timeouts.skillPassMs).toBe(600_000);
    expect(config.limits.archive.maxTotalUncompressed).toBe(64 * 1024 * 1024);
    mkdirSync(join(dir, "unused"), { recursive: true });
  });

  test("仓库内 PiAgent.example.jsonc 与缺省模板逐字节同源", () => {
    const examplePath = fileURLToPath(
      new URL("../../../../PiAgent.example.jsonc", import.meta.url),
    );
    expect(readFileSync(examplePath, "utf8")).toBe(DEFAULT_CONFIG_TEMPLATE);
  });
});
