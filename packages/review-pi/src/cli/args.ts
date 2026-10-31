import { basename } from "node:path";

/**
 * #7 review-pi CLI 参数解析（进程内主缝第一层）：`review-pi review` 与
 * `review-pi smoke` 两个子命令的用法契约。
 * 形态对齐 DSH 线 review-agent args.ts（union 结果、不抛异常——用户输入
 * 错误是预期路径，不是完整性事故）。
 *
 * pi 线差异（自立决策，不从 DSH 仓导入）：
 * - 检视形态唯一（ADR-0024：A–E 配置矩阵删除，规则 Skill 是唯一形态）；
 * - `--config` 指向用户级 JSONC 配置（ADR-0025）；规则 Skill 由 `--rule-skill-zip` / `--rule-skill` /
 *   `--rule-skill-name` / `--strict-rule-skill` 与 `<repo>/.review-rules/` 约定；
 * - 无 --language 旗标（输出语言是 DSH 线后分家决策，pi 线自立 ADR 前不实装）；
 * - smoke 只认 --model（双探针自检不跑检视，参数面自然更窄）。
 *
 * model 是实验数据（#45 语义）：自由 id 透传，缺省单源 = 配置文件 `model.default`
 * （再缺省回落钉住的评审模型，ADR-0025），无 model 环境变量。与 DSH 线 review bin 的
 * 「flash/pro 别名 + 退役 id 拒绝」口径有意分家（ADR-0008 别名面属核外
 * 实验 CLI；pi 内核 reviewModelOf 对目录外 id 一律以钉住画像透传，无别名目录）。
 */

/** CLI 运行留痕的实验目录名（<out>/<experimentId>/runs|audit） */
export const CLI_EXPERIMENT_ID = "review-pi-cli";

/** --out 缺省（review 落盘根） */
const DEFAULT_OUT_DIR = "review-pi-output";

/** review 子命令的已知旗标（未知旗标 = 用法错误；无值布尔旗标 `--strict-rule-skill` / `--progress` / `--no-progress` 进旗标循环前剥离） */
const KNOWN_REVIEW_FLAGS: readonly string[] = [
  "--repo",
  "--mr",
  "--issue",
  "--out",
  "--model",
  "--config",
  "--rule-skill-zip",
  "--rule-skill",
  "--rule-skill-name",
];

/** review 面可重复旗标（ADR-0014：多规则包按 CLI 顺序叠加；ADR-0018：目录同款） */
const REPEATABLE_REVIEW_FLAGS: readonly string[] = ["--rule-skill-zip", "--rule-skill"];

/** smoke 子命令的已知旗标 */
const KNOWN_SMOKE_FLAGS: readonly string[] = ["--model", "--config"];

/** config 子命令的已知旗标（init/show 共用；无用组合各自拒绝） */
const KNOWN_CONFIG_FLAGS: readonly string[] = ["--config", "--force", "--from-env", "--json"];

/** 用法文案（stderr 错误路径的同款文案，单一来源） */
export const USAGE_TEXT = `usage: review-pi review --repo <path> --mr <diff-file> [--issue <text>] [--out <dir>] [--model <id>] [--config <path>] [--rule-skill-zip <path>]... [--rule-skill <dir>]... [--rule-skill-name <name>] [--strict-rule-skill] [--progress | --no-progress]
       review-pi smoke [--model <id>] [--config <path>]
       review-pi config <init|show> [--config <path>] [--force] [--from-env <file>] [--json]
  （smoke = 网关冒烟自检，P1b 双探针：网关健康 + 模型可达，输出人话诊断）
  （config init = 写缺省 JSONC；config show = 脱敏打印生效配置与来源）

配置（ADR-0025）：~/.PiAgent/PiAgent.json（Linux $HOME / Windows %USERPROFILE%），JSONC。
环境变量不再被读取；--env 以移除（改用 --config）。

review 旗标：
  --repo    <path>       仓库快照根目录（必需）
  --mr      <diff-file>  MR diff 文件路径（必需；caseId = 文件名去扩展名）
  --issue   <text>       MR 议题描述（缺省空）
  --out     <dir>        输出目录（审计与运行记录落盘；缺省 ${DEFAULT_OUT_DIR}）
  --model   <id>         评审模型 id（缺省取配置文件 model.default；自由 id 透传）
  --config  <path>       配置文件显式路径（相对路径按 cwd 解析；缺省用户级路径）
  --rule-skill-zip  <path>  规则 Skill zip 显式路径（可重复，顺序 = 执行顺序；
                            缺省扫 <repo>/.review-rules/*.zip 全部装载）
  --rule-skill      <dir>   规则 Skill **已解压目录**（可重复；排在全部
                            --rule-skill-zip 之后；目录先审计再按内容哈希复制进 run
                            缓存，符号链接/越界一律拒绝）
  --rule-skill-name <name>  指定装载的规则 Skill 名（包内多 skill 消歧，逐包生效）
  --strict-rule-skill       规则 Skill 装载失败即报错（缺省降级、run 照常）
  --progress                显示运行进度（阶段 / 模型请求 / 工具调用 / skill 会话）到 stderr；
                            stderr 是 TTY 时缺省开，重定向收日志时缺省关
  --no-progress             关闭运行进度（批跑收日志时显式静音）

smoke 旗标：
  --model   <id>         冒烟模型 id（同缺省与校验；端点/key 取配置文件，绝不回显）
  --config  <path>       配置文件显式路径

config 旗标：
  init                   写缺省配置模板（已存在需 --force；POSIX 0600）
  show                   逐键打印生效值与来源（reviewer.apiKey 只显示 set/missing）
  --from-env <file>      init 时从 .env 文件一次性迁移（key / url / 呈现配置）
  --json                 show 输出机器可读 JSON（与审计 config 同形）`;

/** 解析后的 review 命令参数（caseId 由 --mr 派生） */
export interface ReviewCliArgs {
  readonly repo: string;
  readonly mr: string;
  /** 检视单元身份：--mr 文件名去扩展名（一案一 diff 文件约定） */
  readonly caseId: string;
  readonly issue: string;
  readonly out: string;
  /** 评审模型：缺省取配置 model.default（空串/空白 = 用法错误） */
  readonly model?: string;
  /** 配置文件显式路径（`--config`）；缺席 = 用户级缺省路径 */
  readonly configPath?: string;
  /** 规则 Skill zip 显式路径列表（--rule-skill-zip 可重复；顺序 = 执行顺序；缺席省键） */
  readonly ruleSkillZips?: readonly string[];
  /** 规则 Skill 已解压目录列表（--rule-skill 可重复；排在全部 zip 之后；缺席省键） */
  readonly ruleSkillDirs?: readonly string[];
  /** 规则 Skill 指定名（--rule-skill-name；缺席省键） */
  readonly ruleSkillName?: string;
  /** 规则 Skill 严格模式（--strict-rule-skill；缺席省键） */
  readonly strictRuleSkill?: boolean;
  /**
   * 运行进度投影开关（ADR-0016）：`--progress` → true、`--no-progress` → false、
   * 缺席省键 = 自动（`stderr` 是 TTY 才开——人手敲看得见，重定向收日志时闭嘴）。
   */
  readonly progress?: boolean;
}

/** 解析后的 smoke 命令参数 */
export interface SmokeCliArgs {
  readonly model?: string;
  readonly configPath?: string;
}

/** 解析后的 config 子命令参数 */
export interface ConfigCliArgs {
  readonly action: "init" | "show";
  readonly configPath?: string;
  readonly force?: boolean;
  /** 一次性迁移源（.env 文件路径；只在 init 有效） */
  readonly fromEnv?: string;
  /** show 的机器可读输出 */
  readonly json?: boolean;
}

/** 解析结果：子命令 + 参数，或用法错误消息（调用方负责呈现与退出码） */
export type ParseCliArgsResult =
  | { readonly ok: true; readonly command: "review"; readonly args: ReviewCliArgs }
  | { readonly ok: true; readonly command: "smoke"; readonly args: SmokeCliArgs }
  | { readonly ok: true; readonly command: "config"; readonly args: ConfigCliArgs }
  | { readonly ok: false; readonly message: string };

/** 旗标循环（两子命令共用）：未知旗标 / 重复旗标 / 值缺席（含值吞旗标）都是用法错误。
 * `repeatableFlags` 中的旗标可重复（只按出现顺序累积进 `repeated`；`values` 不收，
 * 免同一事实两种表示——可重复旗标的调用方一律读 `repeated`）。 */
function parseFlags(
  rest: readonly string[],
  knownFlags: readonly string[],
  repeatableFlags: readonly string[] = [],
): {
  readonly ok: true;
  readonly values: Map<string, string>;
  readonly repeated: ReadonlyMap<string, readonly string[]>;
} | { readonly ok: false; readonly message: string } {
  const values = new Map<string, string>();
  const repeated = new Map<string, string[]>();
  for (let index = 0; index < rest.length; index += 2) {
    const flag = rest[index];
    if (flag === undefined || !knownFlags.includes(flag)) {
      return { ok: false, message: `unknown flag ${JSON.stringify(flag)}` };
    }
    const repeatable = repeatableFlags.includes(flag);
    if (!repeatable && values.has(flag)) {
      return { ok: false, message: `duplicate flag ${flag}` };
    }
    const value = rest[index + 1];
    // 值以 -- 开头 = 相邻旗标被吞（如 `--issue --out x`）——fail fast 不静默
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `flag ${flag} requires a value` };
    }
    if (repeatable) {
      const list = repeated.get(flag);
      if (list === undefined) {
        repeated.set(flag, [value]);
      } else {
        list.push(value);
      }
      continue;
    }
    values.set(flag, value);
  }
  return { ok: true, values, repeated };
}

/** --model 校验（两子命令同口径；缺席 = 取配置 model.default） */
function parseModelFlag(
  values: Map<string, string>,
):
  | { readonly ok: true; readonly model?: string }
  | { readonly ok: false; readonly message: string } {
  const modelRaw = values.get("--model");
  if (modelRaw === undefined) {
    return { ok: true };
  }
  if (modelRaw.trim().length === 0) {
    return {
      ok: false,
      message: `invalid --model ${JSON.stringify(modelRaw)}: must be a non-empty model id (free ids accepted)`,
    };
  }
  return { ok: true, model: modelRaw };
}

/** --config 校验（三子命令同口径） */
function parseConfigFlag(
  values: Map<string, string>,
):
  | { readonly ok: true; readonly configPath?: string }
  | { readonly ok: false; readonly message: string } {
  const raw = values.get("--config");
  if (raw === undefined) {
    return { ok: true };
  }
  if (raw.trim().length === 0) {
    return {
      ok: false,
      message: `invalid --config ${JSON.stringify(raw)}: must be a non-empty file path`,
    };
  }
  return { ok: true, configPath: raw };
}

/** `--env` 已移除（ADR-0025）：给专用迁移提示，而不是裸 unknown flag */
function envFlagError(argv: readonly string[]): string | undefined {
  for (const token of argv) {
    if (token === "--env" || token.startsWith("--env=")) {
      return "--env 已移除（配置见 --config <file> 或 ~/.PiAgent/PiAgent.json）";
    }
  }
  return undefined;
}

export function parseCliArgs(argv: readonly string[]): ParseCliArgsResult {
  const [command, ...rest] = argv;
  const envError = envFlagError(rest);
  if (envError !== undefined) {
    return { ok: false, message: envError };
  }
  if (command === "config") {
    return parseConfigCommand(rest);
  }
  if (command !== "review" && command !== "smoke") {
    return {
      ok: false,
      message:
        argv.length === 0
          ? "missing command (expected `review`, `smoke` or `config`)"
          : `unknown command ${JSON.stringify(command)} (expected \`review\`, \`smoke\` or \`config\`)`,
    };
  }
  const booleanFlags = command === "review" ? stripReviewBooleanFlags(rest) : undefined;
  if (booleanFlags !== undefined && !booleanFlags.ok) {
    return { ok: false, message: booleanFlags.message };
  }
  const flagTokens = booleanFlags !== undefined && booleanFlags.ok ? booleanFlags.tokens : rest;
  const flags = parseFlags(
    flagTokens,
    command === "review" ? KNOWN_REVIEW_FLAGS : KNOWN_SMOKE_FLAGS,
    command === "review" ? REPEATABLE_REVIEW_FLAGS : [],
  );
  if (!flags.ok) {
    return flags;
  }
  const model = parseModelFlag(flags.values);
  if (!model.ok) {
    return model;
  }
  const config = parseConfigFlag(flags.values);
  if (!config.ok) {
    return config;
  }
  if (command === "smoke") {
    return {
      ok: true,
      command: "smoke",
      args: {
        ...(model.model !== undefined ? { model: model.model } : {}),
        ...(config.configPath !== undefined ? { configPath: config.configPath } : {}),
      },
    };
  }
  return parseReviewArgs(
    flags.values,
    flags.repeated,
    model.model,
    booleanFlags !== undefined && booleanFlags.ok ? booleanFlags.strict : false,
    booleanFlags !== undefined && booleanFlags.ok ? booleanFlags.progress : undefined,
  );
}

/** config 子命令：`config <init|show>` + 四个旗标（布尔与有值分开处理） */
function parseConfigCommand(rest: readonly string[]): ParseCliArgsResult {
  const action = rest[0];
  if (action !== "init" && action !== "show") {
    return {
      ok: false,
      message:
        action === undefined
          ? "missing config action (expected `init` or `show`)"
          : `unknown config action ${JSON.stringify(action)} (expected \`init\` or \`show\`)`,
    };
  }
  const values = new Map<string, string>();
  const booleans = new Set<string>();
  for (let index = 1; index < rest.length; index += 1) {
    const flag = rest[index];
    if (flag === undefined || !KNOWN_CONFIG_FLAGS.includes(flag)) {
      return { ok: false, message: `unknown flag ${JSON.stringify(flag)}` };
    }
    if (flag === "--force" || flag === "--json") {
      if (booleans.has(flag)) {
        return { ok: false, message: `duplicate flag ${flag}` };
      }
      booleans.add(flag);
      continue;
    }
    if (values.has(flag)) {
      return { ok: false, message: `duplicate flag ${flag}` };
    }
    const value = rest[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return { ok: false, message: `flag ${flag} requires a value` };
    }
    values.set(flag, value);
    index += 1;
  }
  if (action === "show" && (booleans.has("--force") || values.has("--from-env"))) {
    return {
      ok: false,
      message: "--force / --from-env are only valid with `config init`",
    };
  }
  if (action === "init" && booleans.has("--json")) {
    return { ok: false, message: "--json is only valid with `config show`" };
  }
  const fromEnv = values.get("--from-env");
  if (fromEnv !== undefined && fromEnv.trim().length === 0) {
    return {
      ok: false,
      message: `invalid --from-env ${JSON.stringify(fromEnv)}: must be a non-empty file path`,
    };
  }
  const config = parseConfigFlag(values);
  if (!config.ok) {
    return config;
  }
  return {
    ok: true,
    command: "config",
    args: {
      action,
      ...(config.configPath !== undefined ? { configPath: config.configPath } : {}),
      ...(booleans.has("--force") ? { force: true } : {}),
      ...(booleans.has("--json") ? { json: true } : {}),
      ...(fromEnv !== undefined ? { fromEnv } : {}),
    },
  };
}

/**
 * 剥离 review 的无值布尔旗标（`--strict-rule-skill` / `--progress` /
 * `--no-progress`；旗标循环是 k-v 成对，无值旗标必须先摘除）。单趟计数：
 * 重复出现 = 重复旗标，互斥对同给 = 用法错误。
 */
function stripReviewBooleanFlags(rest: readonly string[]): {
  readonly ok: true;
  readonly tokens: readonly string[];
  readonly strict: boolean;
  readonly progress?: boolean;
} | { readonly ok: false; readonly message: string } {
  const known = new Set(["--strict-rule-skill", "--progress", "--no-progress"]);
  const counts = new Map<string, number>();
  const tokens: string[] = [];
  for (const token of rest) {
    if (known.has(token)) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    } else {
      tokens.push(token);
    }
  }
  for (const flag of known) {
    if ((counts.get(flag) ?? 0) > 1) {
      return { ok: false, message: `duplicate flag ${flag}` };
    }
  }
  const on = counts.has("--progress");
  const off = counts.has("--no-progress");
  if (on && off) {
    return { ok: false, message: "conflicting flags --progress and --no-progress" };
  }
  return {
    ok: true,
    tokens,
    strict: counts.has("--strict-rule-skill"),
    ...(on ? { progress: true } : off ? { progress: false } : {}),
  };
}

/** review 面必填与缺省：--repo / --mr（caseId = 文件名去扩展名）、--issue 缺省空 */
function parseReviewArgs(
  values: Map<string, string>,
  repeated: ReadonlyMap<string, readonly string[]>,
  model: string | undefined,
  strict: boolean,
  progress: boolean | undefined,
): { readonly ok: true; readonly command: "review"; readonly args: ReviewCliArgs } | { readonly ok: false; readonly message: string } {
  const repo = values.get("--repo");
  if (repo === undefined) {
    return { ok: false, message: "missing required flag --repo" };
  }
  const mr = values.get("--mr");
  if (mr === undefined) {
    return { ok: false, message: "missing required flag --mr" };
  }
  const ruleSkillZips = repeated.get("--rule-skill-zip");
  const ruleSkillDirs = repeated.get("--rule-skill");
  const ruleSkillName = values.get("--rule-skill-name");
  const config = parseConfigFlag(values);
  if (!config.ok) {
    return config;
  }

  return {
    ok: true,
    command: "review",
    args: {
      repo,
      mr,
      caseId: basename(mr).replace(/\.[^.]*$/, ""),
      issue: values.get("--issue") ?? "",
      out: values.get("--out") ?? DEFAULT_OUT_DIR,
      ...(model !== undefined ? { model } : {}),
      ...(config.configPath !== undefined ? { configPath: config.configPath } : {}),
      ...(ruleSkillZips !== undefined ? { ruleSkillZips } : {}),
      ...(ruleSkillDirs !== undefined ? { ruleSkillDirs } : {}),
      ...(ruleSkillName !== undefined ? { ruleSkillName } : {}),
      ...(strict ? { strictRuleSkill: true } : {}),
      ...(progress !== undefined ? { progress } : {}),
    },
  };
}
