import { resolve } from "node:path";

import {
  ConfigError,
  configSnapshot,
  configTemplate,
  loadConfig,
  resolveConfigPath,
  writeConfigFile,
  type ConfigTemplateOverrides,
  type ResolvedConfig,
} from "../shared/config.js";
import { parseEnvFile } from "../shared/env-file.js";
import type { ConfigCliArgs } from "./args.js";

/**
 * `review-pi config` 子命令（ADR-0025）：`init` 写模板、`show` 脱敏打印生效值。
 *
 * 纪律：
 * - 秘密只报 `set` / `missing`，绝不打印值或长度；
 * - `init --from-env` 是**一次性迁移**：读文件、不写 `process.env`；
 * - `show` 是诊断命令：文件非法才 exit 1，缺 key 正常显示并 exit 0。
 */

/** 执行 config 子命令；返回进程退出码（错误经异常上抛 → 调用方 exit 1） */
export function runConfigCommand(args: ConfigCliArgs, cwd = process.cwd()): number {
  return args.action === "init" ? initConfig(args, cwd) : showConfig(args, cwd);
}

function initConfig(args: ConfigCliArgs, cwd: string): number {
  const path = resolveConfigPath({
    ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
    cwd,
  });
  const migrated =
    args.fromEnv === undefined ? undefined : migrateEnvFile(resolve(cwd, args.fromEnv), cwd);
  writeConfigFile({
    path,
    force: args.force === true,
    ...(migrated !== undefined ? { content: configTemplate(migrated.overrides) } : {}),
  });
  process.stdout.write(`review-pi: 已写入配置文件 ${path}\n`);
  if (migrated !== undefined) {
    const names = migrated.migratedKeys;
    process.stdout.write(
      names.length > 0
        ? `review-pi: 已迁移 ${names.join(", ")}\n`
        : "review-pi: 源文件没有可迁移的键（写入缺省模板）\n",
    );
    if (migrated.discardedKeys.length > 0) {
      process.stdout.write(`review-pi: 已丢弃未识别键：${migrated.discardedKeys.join(", ")}\n`);
    }
    for (const line of migrated.malformedLines) {
      process.stdout.write(`review-pi: 源文件有无法解析的行（${line}），已跳过\n`);
    }
  }
  return 0;
}

function showConfig(args: ConfigCliArgs, cwd: string): number {
  const { config, warnings } = loadConfig({
    ...(args.configPath !== undefined ? { configPath: args.configPath } : {}),
    cwd,
  });
  if (args.configPath !== undefined && !config.exists) {
    throw new ConfigError(`--config 指定的文件不存在（${config.path}）`);
  }
  for (const warning of warnings) {
    process.stderr.write(`review-pi: ${warning}\n`);
  }
  if (args.json === true) {
    process.stdout.write(`${JSON.stringify(configSnapshot(config), null, 2)}\n`);
    return 0;
  }
  process.stdout.write(renderShow(config));
  return 0;
}

/** 人读形态：逐键 `值  (file|default)`，末行 digest */
function renderShow(config: ResolvedConfig): string {
  const lines: string[] = [];
  lines.push(
    config.exists
      ? `review-pi config: ${config.path}（found）`
      : `review-pi config: ${config.path}（not found — 全缺省；review/smoke 会因缺 reviewer.apiKey 中止）`,
  );
  const values = configSnapshot(config).values;
  lines.push(`reviewer.apiKey${pad("reviewer.apiKey")}${config.reviewer.apiKey === null ? "missing" : "set"}`);
  for (const [key, value] of Object.entries(values)) {
    const source = sourceOf(config, key);
    lines.push(`${key}${pad(key)}${formatValue(value)}  (${source})`);
  }
  lines.push(`digest${pad("digest")}${config.digest}`);
  return `${lines.join("\n")}\n`;
}

function pad(key: string): string {
  const width = 42;
  return key.length >= width ? "  " : " ".repeat(width - key.length);
}

function formatValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "object") {
    return JSON.stringify(value);
  }
  return String(value);
}

/** 来源判定：键本身或其子叶出现在 `overridden` 里 = 来自文件 */
function sourceOf(config: ResolvedConfig, key: string): "file" | "default" {
  return config.overridden.some((entry) => entry === key || entry.startsWith(`${key}.`))
    ? "file"
    : "default";
}

interface MigrationResult {
  readonly overrides: ConfigTemplateOverrides;
  readonly migratedKeys: readonly string[];
  readonly discardedKeys: readonly string[];
  readonly malformedLines: readonly string[];
}

/** `.env.local` → 配置映射（spec §9；环境变量键名只是**源键**，不再是通道） */
function migrateEnvFile(filePath: string, cwd: string): MigrationResult {
  const parsed = parseEnvFile(filePath);
  if (!parsed.exists) {
    throw new ConfigError(`--from-env 指定的文件不存在（${filePath}）`);
  }
  const read = (names: readonly string[]): { readonly name: string; readonly value: string } | undefined => {
    for (const name of names) {
      const value = parsed.values.get(name)?.trim();
      if (value !== undefined && value !== "") {
        return { name, value };
      }
    }
    return undefined;
  };

  const migrated: string[] = [];
  const apiKey = read(["REVIEWER_API_KEY", "DEEPSEEK_API_KEY"]);
  if (apiKey !== undefined) {
    migrated.push(apiKey.name);
  }
  const baseUrl = read(["REVIEWER_URL", "DEEPSEEK_URL"]);
  if (baseUrl !== undefined) {
    if (!/^https?:\/\//.test(baseUrl.value)) {
      throw new ConfigError(
        `源文件中的 base URL 必须是 http(s)（got ${JSON.stringify(baseUrl.value)}）`,
      );
    }
    migrated.push(baseUrl.name);
  }
  const maxTokens = read(["REVIEWER_MAX_TOKENS"]);
  let maxOutputTokens: number | null | undefined;
  if (maxTokens !== undefined) {
    const parsedTokens = Number(maxTokens.value);
    if (!Number.isInteger(parsedTokens) || parsedTokens <= 0) {
      throw new ConfigError(
        `源文件中的 REVIEWER_MAX_TOKENS 必须是正整数（got ${JSON.stringify(maxTokens.value)}）`,
      );
    }
    maxOutputTokens = parsedTokens;
    migrated.push(maxTokens.name);
  }
  const engine = read(["REVIEW_PI_PRESENTATION_ENGINE"]);
  let enginePath: string | null | undefined;
  if (engine !== undefined) {
    // 相对路径按**写入时的 cwd** 解析成绝对路径再写（之后换 cwd 也不失效）
    enginePath = resolve(cwd, engine.value);
    migrated.push(engine.name);
  }
  const presentationModel = read(["REVIEW_PI_PRESENTATION_MODEL"]);
  if (presentationModel !== undefined) {
    migrated.push(presentationModel.name);
  }

  const known = new Set([
    "REVIEWER_API_KEY",
    "DEEPSEEK_API_KEY",
    "REVIEWER_URL",
    "DEEPSEEK_URL",
    "REVIEWER_MAX_TOKENS",
    "REVIEW_PI_PRESENTATION_ENGINE",
    "REVIEW_PI_PRESENTATION_MODEL",
  ]);
  const discardedKeys = [...parsed.values.keys()].filter((key) => !known.has(key));

  return {
    overrides: {
      ...(apiKey !== undefined ? { apiKey: apiKey.value } : {}),
      ...(baseUrl !== undefined ? { baseUrl: baseUrl.value.replace(/\/+$/, "") } : {}),
      ...(maxOutputTokens !== undefined ? { maxOutputTokens } : {}),
      ...(enginePath !== undefined ? { enginePath } : {}),
      ...(presentationModel !== undefined ? { modelPresentation: presentationModel.value } : {}),
    },
    migratedKeys: migrated,
    discardedKeys,
    malformedLines: parsed.malformedLines,
  };
}
