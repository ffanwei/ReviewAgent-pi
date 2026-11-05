import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, test } from "vitest";

import {
  BUILTIN_ENGINE_SENTINEL,
  CONFIG_VERSION,
  ConfigError,
  DEFAULT_CODEINTEL,
  DEFAULT_CONFIG_TEMPLATE,
  DEFAULT_GATEWAY_MAX_TOKENS,
  DEFAULT_LIMITS,
  DEFAULT_MODEL_ID,
  OFFICIAL_REVIEWER_BASE_URL,
  builtinPresentationEnginePath,
  configSnapshot,
  isOfficialReviewerBaseUrl,
  loadConfig,
  requireApiKey,
  resolveConfigPath,
  resolvePresentationEnginePath,
  writeConfigFile,
} from "./config.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "piagent-config-"));
  temps.push(dir);
  return dir;
}

function writeConfig(text: string): string {
  const path = join(tempDir(), "PiAgent.jsonc");
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
    ).toBe("C:\\Users\\Li\\.PiAgent\\PiAgent.jsonc");
    expect(
      resolveConfigPath({ env: { USERPROFILE: "C:\\Users\\Li", HOME: "/home/li" }, platform: "linux" }),
    ).toBe("/home/li/.PiAgent/PiAgent.jsonc");
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

describe("loadConfig：边界", () => {
  test("boundary 的 null = 显式关闭（与「没写」可区分）", () => {
    const path = writeConfig(
      minimalConfig(`,"limits":{"boundary":{"maxFiles":null,"maxDiffLines":50}}`),
    );
    const { config } = loadConfig({ configPath: path });
    expect(config.limits.boundary).toEqual({
      maxFiles: null,
      maxDiffLines: 50,
      maxDiffChars: DEFAULT_LIMITS.boundary.maxDiffChars,
    });
    expect(config.overridden).toContain("limits.boundary.maxFiles");
  });

  test("maxDiffChars：缺省 / null 关闭 / 越界拒绝", () => {
    const defaults = loadConfig({ configPath: writeConfig(minimalConfig("")) });
    expect(defaults.config.limits.boundary.maxDiffChars).toBe(1_500_000);

    const disabled = loadConfig({
      configPath: writeConfig(minimalConfig(`,"limits":{"boundary":{"maxDiffChars":null}}`)),
    });
    expect(disabled.config.limits.boundary.maxDiffChars).toBe(null);
    expect(disabled.config.overridden).toContain("limits.boundary.maxDiffChars");

    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"limits":{"boundary":{"maxDiffChars":999}}`)) }),
    ).toThrow(/maxDiffChars/);
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

describe("loadConfig：limits.split（大 MR 分片，ADR-0039）", () => {
  test("缺省值：enabled=true / 400000 / 12 / 8000", () => {
    const { config, warnings } = loadConfig({ configPath: writeConfig(minimalConfig("")) });
    expect(config.limits.split).toEqual({
      enabled: true,
      maxShardChars: 400_000,
      maxShards: 12,
      contextSummaryChars: 8_000,
    });
    expect(warnings.join("\n")).not.toContain("limits.split");
  });

  test("逐键覆盖生效并记入 overridden", () => {
    const { config } = loadConfig({
      configPath: writeConfig(
        minimalConfig(
          `,"limits":{"split":{"enabled":false,"maxShardChars":10000,"maxShards":1,"contextSummaryChars":1000}}`,
        ),
      ),
    });
    expect(config.limits.split).toEqual({
      enabled: false,
      maxShardChars: 10_000,
      maxShards: 1,
      contextSummaryChars: 1_000,
    });
    expect(config.overridden).toContain("limits.split.enabled");
    expect(config.overridden).toContain("limits.split.maxShards");
  });

  test("enabled 必须是布尔值（不把字符串 \"false\" 当 false）", () => {
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"limits":{"split":{"enabled":"false"}}`)) }),
    ).toThrow(/limits\.split\.enabled must be true or false/);
  });

  test("数值越界 fail fast（maxShardChars < 10000 / maxShards > 64 / contextSummaryChars < 1000）", () => {
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"limits":{"split":{"maxShardChars":9999}}`)) }),
    ).toThrow(/limits\.split\.maxShardChars/);
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"limits":{"split":{"maxShards":65}}`)) }),
    ).toThrow(/limits\.split\.maxShards/);
    expect(() =>
      loadConfig({
        configPath: writeConfig(minimalConfig(`,"limits":{"split":{"contextSummaryChars":999}}`)),
      }),
    ).toThrow(/limits\.split\.contextSummaryChars/);
  });

  test("未知键只警告不改行为", () => {
    const { config, warnings } = loadConfig({
      configPath: writeConfig(minimalConfig(`,"limits":{"split":{"maxShard":10000}}`)),
    });
    expect(config.limits.split).toEqual(DEFAULT_LIMITS.split);
    expect(warnings.some((line) => line.includes("limits.split.maxShard"))).toBe(true);
  });
});

describe("loadConfig：codeintel.languages（语言开关，ADR-0040）", () => {
  test("缺省 auto = 跟随已实现语言；不进 overridden", () => {
    const { config, warnings } = loadConfig({ configPath: writeConfig(minimalConfig("")) });
    expect(config.codeintel).toEqual(DEFAULT_CODEINTEL);
    expect(config.codeintel.languages).toBe("auto");
    expect(config.overridden).not.toContain("codeintel.languages");
    expect(warnings.join("\n")).not.toContain("codeintel");
    expect(configSnapshot(config).values["codeintel.languages"]).toBe("auto");
  });

  test("数组 = 只启用列出语言；大小写/空白归一 + 去重保序", () => {
    const { config, warnings } = loadConfig({
      configPath: writeConfig(
        minimalConfig(`,"codeintel":{"languages":[" Java ","java","JAVA"]}`),
      ),
    });
    expect(config.codeintel.languages).toEqual(["java"]);
    expect(config.overridden).toContain("codeintel.languages");
    expect(warnings.join("\n")).not.toContain("未实现");
  });

  test("未实现语言：装载期告警并丢弃（不静默）", () => {
    const { config, warnings } = loadConfig({
      configPath: writeConfig(minimalConfig(`,"codeintel":{"languages":["kotlin","java"]}`)),
    });
    expect(config.codeintel.languages).toEqual(["java"]);
    expect(warnings.some((line) => line.includes('"kotlin"') && line.includes("未实现"))).toBe(true);
    expect(warnings.some((line) => line.includes("已实现：java"))).toBe(true);
  });

  test("空数组 = 显式关闭（保留为空，不退化成 auto）", () => {
    const { config } = loadConfig({
      configPath: writeConfig(minimalConfig(`,"codeintel":{"languages":[]}`)),
    });
    expect(config.codeintel.languages).toEqual([]);
  });

  test("非法取值 fail fast：非 auto 字符串 / 非字符串条目", () => {
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"codeintel":{"languages":"all"}`)) }),
    ).toThrow(/codeintel\.languages must be "auto" or an array/);
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"codeintel":{"languages":[""]}`)) }),
    ).toThrow(/codeintel\.languages entries must be non-empty strings/);
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"codeintel":{"languages":[1]}`)) }),
    ).toThrow(/codeintel\.languages entries must be non-empty strings/);
  });

  test("未知键只警告不改行为", () => {
    const { config, warnings } = loadConfig({
      configPath: writeConfig(minimalConfig(`,"codeintel":{"langs":["java"]}`)),
    });
    expect(config.codeintel.languages).toBe("auto");
    expect(warnings.some((line) => line.includes("unknown key codeintel.langs"))).toBe(true);
  });
});

describe("loadConfig：codeintel.excludeGlobs（扫描排除，ADR-0041）", () => {
  test("缺省 = 内置非源码目录清单；不进 overridden，但进快照", () => {
    const { config, warnings } = loadConfig({ configPath: writeConfig(minimalConfig("")) });
    expect(config.codeintel.excludeGlobs).toEqual(DEFAULT_CODEINTEL.excludeGlobs);
    expect(config.overridden).not.toContain("codeintel.excludeGlobs");
    expect(warnings.join("\n")).not.toContain("excludeGlobs");
    expect(configSnapshot(config).values["codeintel.excludeGlobs"]).toEqual(
      DEFAULT_CODEINTEL.excludeGlobs,
    );
  });

  test("自定义数组：trim + 去重保序；空数组 = 不排除任何东西", () => {
    const custom = loadConfig({
      configPath: writeConfig(
        minimalConfig(`,"codeintel":{"excludeGlobs":[" **/dist/** ","**/dist/**","**/vendor/**"]}`),
      ),
    });
    expect(custom.config.codeintel.excludeGlobs).toEqual(["**/dist/**", "**/vendor/**"]);
    expect(custom.config.overridden).toContain("codeintel.excludeGlobs");

    const none = loadConfig({
      configPath: writeConfig(minimalConfig(`,"codeintel":{"excludeGlobs":[]}`)),
    });
    expect(none.config.codeintel.excludeGlobs).toEqual([]);
  });

  test("非法取值 fail fast：非数组 / 空字符串条目", () => {
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"codeintel":{"excludeGlobs":"dist"}`)) }),
    ).toThrow(/codeintel\.excludeGlobs must be an array of glob patterns/);
    expect(() =>
      loadConfig({ configPath: writeConfig(minimalConfig(`,"codeintel":{"excludeGlobs":[""]}`)) }),
    ).toThrow(/codeintel\.excludeGlobs\[0\] must be a non-empty string/);
  });
});

describe("writeConfigFile", () => {
  test("写盘：目录自动创建 + 拒绝覆盖 + --force", () => {
    const path = join(tempDir(), "nested", "PiAgent.jsonc");
    writeConfigFile({ path });
    const text = readFileSync(path, "utf8");
    expect(text).toContain('"version": 1');
    expect(text).toContain("reviewer");
    expect(() => writeConfigFile({ path })).toThrow(/已存在/);
    writeConfigFile({ path, force: true, content: '{"version":1}' });
    expect(readFileSync(path, "utf8")).toBe('{"version":1}');
    if (process.platform !== "win32") {
      expect(statSync(path).mode & 0o077).toBe(0);
      // 目录同样不放行：装着秘密的目录对同机其他用户也要不可见（0700）
      expect(statSync(dirname(path)).mode & 0o077).toBe(0);
    }
  });

  test("--force 覆盖既有 0644 文件后权限回到 0600（writeFileSync 的 mode 只在创建时生效）", () => {
    if (process.platform === "win32") {
      return;
    }
    const path = join(tempDir(), "PiAgent.jsonc");
    writeFileSync(path, "{}", { encoding: "utf8" });
    chmodSync(path, 0o644);
    expect(statSync(path).mode & 0o077).not.toBe(0);

    writeConfigFile({ path, force: true, content: '{"version":1}' });

    expect(statSync(path).mode & 0o077).toBe(0);
  });

  test("模板本身可被解析（写出来就能读回去）", () => {
    const path = join(tempDir(), "PiAgent.jsonc");
    writeConfigFile({ path });
    const { config } = loadConfig({ configPath: path });
    expect(config.version).toBe(CONFIG_VERSION);
    expect(config.limits).toEqual(DEFAULT_LIMITS);
  });
});

describe("常量对齐", () => {
  test("缺省模板与运行期缺省同源（防漂移）", () => {
    const dir = tempDir();
    const path = join(dir, "PiAgent.jsonc");
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

  test("模板不含 $schema（ADR-0026：没有发布过的 schema，写一个 example.invalid 只是噪声；读取侧仍容忍旧文件的 $schema）", () => {
    expect(DEFAULT_CONFIG_TEMPLATE).not.toContain("$schema");
    // 旧配置文件带着 $schema 也能读：不报错、也不冒未知键警告
    const path = writeConfig(
      `{\n  "$schema": "https://example.invalid/piagent.schema.json",\n  "version": 1,\n  "reviewer": { "apiKey": "sk-x" }\n}`,
    );
    const { warnings } = loadConfig({ configPath: path });
    expect(warnings.join("\n")).not.toContain("$schema");
  });
});

describe("presentation.engine 解析（ADR-0026）", () => {
  test("null / 空白 ⇒ null（恒等直通）", () => {
    expect(resolvePresentationEnginePath(null, "/etc/pi/PiAgent.jsonc")).toBeNull();
    expect(resolvePresentationEnginePath("   ", "/etc/pi/PiAgent.jsonc")).toBeNull();
  });

  test("\"builtin\" ⇒ 制品内引擎（<pkg>/presentation/engine-zh.js）", () => {
    const resolved = resolvePresentationEnginePath(BUILTIN_ENGINE_SENTINEL, "/etc/pi/PiAgent.jsonc");
    expect(resolved).toBe(builtinPresentationEnginePath());
    expect(resolved?.endsWith(join("presentation", "engine-zh.js"))).toBe(true);
  });

  test("相对路径按**配置文件所在目录**解析（不是 cwd）", () => {
    const configPath = join(tempDir(), "nested", "PiAgent.jsonc");
    expect(resolvePresentationEnginePath("engines/zh.mjs", configPath)).toBe(
      join(dirname(configPath), "engines", "zh.mjs"),
    );
  });

  test("绝对路径原样透传", () => {
    const absolute = join(tempDir(), "zh.mjs");
    expect(resolvePresentationEnginePath(absolute, "/etc/pi/PiAgent.jsonc")).toBe(absolute);
  });
});

describe("base URL 判档（ADR-0026 单源）", () => {
  test("官方缺省的等价写法都算官方：大小写、尾斜杠、空白", () => {
    for (const value of [
      undefined,
      null,
      "",
      OFFICIAL_REVIEWER_BASE_URL,
      `${OFFICIAL_REVIEWER_BASE_URL}/`,
      "  https://api.deepseek.com  ",
      "HTTPS://API.DEEPSEEK.COM",
    ]) {
      expect(isOfficialReviewerBaseUrl(value)).toBe(true);
    }
  });

  test("网关档：不同 host / 不同路径都不是官方（/v1 不是同一端点）", () => {
    for (const value of [
      "https://gw.example.com/v1",
      "https://api.deepseek.com/v1",
      "http://api.deepseek.com",
    ]) {
      expect(isOfficialReviewerBaseUrl(value)).toBe(false);
    }
  });
});

describe("configSnapshot 家目录归一化（ADR-0027）", () => {
  test("不给 home：路径原样（config show 看到的永远是真实路径）", () => {
    const home = tempDir();
    const path = join(home, ".PiAgent", "PiAgent.jsonc");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{"version":1,"reviewer":{"apiKey":"sk-x"}}`, "utf8");
    const { config } = loadConfig({ configPath: path });
    expect(configSnapshot(config).path).toBe(path);
  });

  test("给 home：path 与绝对路径值折叠成 ~/...（POSIX 分隔符）", () => {
    const home = tempDir();
    const path = join(home, ".PiAgent", "PiAgent.jsonc");
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      `{"version":1,"reviewer":{"apiKey":"sk-x"},"presentation":{"engine":${JSON.stringify(join(home, "bin", "zh.mjs"))}}}`,
      "utf8",
    );
    const { config } = loadConfig({ configPath: path });
    const snapshot = configSnapshot(config, { home });
    expect(snapshot.path).toBe("~/.PiAgent/PiAgent.jsonc");
    expect(snapshot.values["presentation.engine"]).toBe("~/bin/zh.mjs");
    // 秘密面纪律不变
    expect(snapshot.secret).toEqual({ "reviewer.apiKey": "set" });
    expect(JSON.stringify(snapshot)).not.toContain("sk-x");
  });
});

describe("mcp 配置块（ADR-0037）", () => {
  function withMcp(mcp: string): string {
    return `{
      "version": 1,
      "reviewer": { "apiKey": "sk-sentinel", "baseUrl": "https://gw.example.com/v1" },
      "mcp": ${mcp}
    }`;
  }

  const VALID = `{
    "servers": {
      "ops": {
        "transport": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "Bearer top-secret-token" },
        "timeoutMs": 1234
      }
    },
    "report": { "server": "ops", "tool": "report_events" }
  }`;

  test("未配置 mcp → null，扁平值里不出现 mcp.*", () => {
    const { config } = loadConfig({ configPath: writeConfig(minimalConfig()) });
    expect(config.mcp).toBeNull();
    const snapshot = configSnapshot(config);
    expect(Object.keys(snapshot.values).some((key) => key.startsWith("mcp."))).toBe(false);
    expect(snapshot.secret).toEqual({ "reviewer.apiKey": "set" });
  });

  test("有效配置：缺省值补齐，headers 只进 secret，值里不含秘密", () => {
    const { config } = loadConfig({ configPath: writeConfig(withMcp(VALID)) });
    expect(config.mcp).not.toBeNull();
    expect(config.mcp?.report).toEqual({
      server: "ops",
      tool: "report_events",
      include: ["run.start", "run.end", "phase", "request.end"],
      batch: { maxEvents: 50, maxDelayMs: 2_000 },
      queue: { maxEvents: 1_000 },
      flushTimeoutMs: 5_000,
      findings: "summary",
    });
    expect(config.mcp?.servers.ops).toMatchObject({
      transport: "http",
      url: "https://mcp.example.com/mcp",
      timeoutMs: 1_234,
    });

    const snapshot = configSnapshot(config);
    expect(snapshot.secret["mcp.servers.ops.headers"]).toBe("set");
    expect(snapshot.values["mcp.report.tool"]).toBe("report_events");
    expect(snapshot.values["mcp.servers.ops.url"]).toBe("https://mcp.example.com/mcp");
    // 秘密面纪律：值、长度、header 名都不出现在快照里
    expect(JSON.stringify(snapshot)).not.toContain("top-secret-token");
    expect(snapshot.overridden).toContain("mcp.report.tool");
    expect(snapshot.overridden).toContain("mcp.servers.ops.headers");
  });

  test("只有 servers 没有 report → null（配置了但不上报）", () => {
    const { config } = loadConfig({
      configPath: writeConfig(withMcp(`{ "servers": { "ops": { "url": "https://x.example.com/mcp" } } }`)),
    });
    expect(config.mcp).toBeNull();
  });

  test("report.server 指向不存在的服务端 → ConfigError", () => {
    expect(() =>
      loadConfig({
        configPath: writeConfig(
          withMcp(`{
            "servers": { "ops": { "url": "https://x.example.com/mcp" } },
            "report": { "server": "nope", "tool": "report_events" }
          }`),
        ),
      }),
    ).toThrow(/mcp\.report\.server must name a configured server/);
  });

  test("include 里的未知类型 → ConfigError（fail fast，不静默忽略）", () => {
    expect(() =>
      loadConfig({
        configPath: writeConfig(
          withMcp(`{
            "servers": { "ops": { "url": "https://x.example.com/mcp" } },
            "report": { "server": "ops", "tool": "report_events", "include": ["run.starts"] }
          }`),
        ),
      }),
    ).toThrow(/mcp\.report\.include\[0\]/);
  });

  test("transport 只允许 http（stdio 不在 v1 范围内）", () => {
    expect(() =>
      loadConfig({
        configPath: writeConfig(
          withMcp(`{
            "servers": { "ops": { "transport": "stdio", "url": "https://x.example.com/mcp" } },
            "report": { "server": "ops", "tool": "report_events" }
          }`),
        ),
      }),
    ).toThrow(/transport must be "http"/);
  });

  test("findings 不支持 full（正文永不出进程）", () => {
    expect(() =>
      loadConfig({
        configPath: writeConfig(
          withMcp(`{
            "servers": { "ops": { "url": "https://x.example.com/mcp" } },
            "report": { "server": "ops", "tool": "report_events", "findings": "full" }
          }`),
        ),
      }),
    ).toThrow(/findings must be "none" or "summary"/);
  });

  test("内置模板里 mcp 整块是注释：解析结果仍是 null", () => {
    const { config } = loadConfig({ configPath: writeConfig(DEFAULT_CONFIG_TEMPLATE) });
    expect(config.mcp).toBeNull();
  });
});
