import { basename } from "node:path";

import { checkTaskId, DEFAULT_TASKS_ROOT_LABEL } from "../shared/tasks-dir.js";

/**
 * #7 review-pi CLI 参数解析（进程内主缝第一层）：`review-pi review` 与
 * `review-pi smoke` 两个子命令的用法契约。
 * 形态对齐 DSH 线 review-agent args.ts（union 结果、不抛异常——用户输入
 * 错误是预期路径，不是完整性事故）。
 *
 * pi 线差异（自立决策，不从 DSH 仓导入）：
 * - 检视形态唯一（ADR-0024：A–E 配置矩阵删除，规则 Skill 是唯一形态）；
 * - `--config` 指向用户级 JSONC 配置（ADR-0025）；规则 Skill 由 `--rule-skill-zip` / `--rule-skill` /
 *   `--skill` / `--strict-rule-skill` 显式给出（ADR-0027：仓库内约定目录不再自动扫描；ADR-0034：一次可传多个包，
 *   一个包就是一个 skill，包内消歧用的 `--rule-skill-name` 已移除）；
 * - 无 --language 旗标（输出语言是 DSH 线后分家决策，pi 线自立 ADR 前不实装）；
 * - smoke 只认 --model（双探针自检不跑检视，参数面自然更窄）。
 *
 * model 是实验数据（#45 语义）：自由 id 透传，缺省单源 = 配置文件 `model.default`
 * （再缺省回落钉住的评审模型，ADR-0025），无 model 环境变量。与 DSH 线 review bin 的
 * 「flash/pro 别名 + 退役 id 拒绝」口径有意分家（ADR-0008 别名面属核外
 * 实验 CLI；pi 内核 reviewModelOf 对目录外 id 一律以钉住画像透传，无别名目录）。
 */

/** review 子命令的已知旗标（未知旗标 = 用法错误；无值布尔旗标 `--strict-rule-skill` / `--no-progress` 进旗标循环前剥离） */
const KNOWN_REVIEW_FLAGS: readonly string[] = [
  "--repo",
  "--mr-diff",
  "--mr-json",
  "--issue",
  "--taskId",
  "--tasks-dir",
  "--model",
  "--config",
  "--rule-skill-zip",
  "--rule-skill",
  "--skill",
  "--include",
  "--exclude",
];

/** review 面可重复旗标（ADR-0014：多规则包按 CLI 顺序叠加；ADR-0018：目录同款；
 * ADR-0078：检视范围正则一条一个 argv，不做逗号列表） */
const REPEATABLE_REVIEW_FLAGS: readonly string[] = [
  "--rule-skill-zip",
  "--rule-skill",
  "--skill",
  "--include",
  "--exclude",
];

/** 检视范围正则旗标（ADR-0078）：空值 = 清空该维度（可见留痕，不静默） */
const PATH_FILTER_FLAGS: readonly string[] = ["--include", "--exclude"];

/** 逗号列表旗标（ADR-0034：一次可传多个 skill 包，`--rule-skill-zip a.zip,b.zip`） */
const COMMA_LIST_FLAGS: readonly string[] = ["--rule-skill-zip", "--rule-skill", "--skill"];

/** smoke 子命令的已知旗标 */
const KNOWN_SMOKE_FLAGS: readonly string[] = ["--model", "--config"];

/** config 子命令的已知旗标（init/show 共用；无用组合各自拒绝） */
const KNOWN_CONFIG_FLAGS: readonly string[] = ["--config", "--force", "--from-env", "--json"];

/** export 子命令的已知旗标（ADR-0036 只寻址与复制 + ADR-0072 `--native` 表示切换 + ADR-0074 `--trace`，不碰配置） */
const KNOWN_EXPORT_FLAGS: readonly string[] = ["--taskId", "--tasks-dir", "--path", "--trace"];

/** 用法文案（stderr 错误路径的同款文案，单一来源） */
export const USAGE_TEXT = `usage: review-pi review --repo <path> (--mr-diff <diff-file> | --mr-json <files-json>) --taskId <id> [--issue <text>] [--tasks-dir <dir>] [--model <id>] [--config <path>] [--rule-skill-zip <path>[,<path>…]]... [--rule-skill <dir>[,<dir>…]]... [--skill <dir>[,<dir>…]]... [--include <regex>]... [--exclude <regex>]... [--strict-rule-skill] [--no-progress]
       review-pi smoke [--model <id>] [--config <path>]
       review-pi config <init|show> [--config <path>] [--force] [--from-env <file>] [--json]
       review-pi export [--taskId <id>] [--tasks-dir <dir>] [--path <dir>] [--native] [--trace <dir>]
       review-pi version [--json]
       review-pi --version
  （smoke = 网关冒烟自检，双探针：网关健康 + 模型可达，输出人话诊断）
  （config init = 写缺省 JSONC；config show = 脱敏打印生效配置与来源）
  （export = 单行打印主 / skill session 的绝对路径，逗号分隔、主在前；缺省 OpenCode 兼容版、--native 原生；--path 复制到目录）
  （version = 产品版本单行；--json 额外给出 Node 与内核四包实际版本，不加载配置）

配置（ADR-0025）：~/.PiAgent/PiAgent.jsonc（Linux $HOME / Windows %USERPROFILE%），JSONC。
环境变量不再被读取；--env 已移除（改用 --config）。

review 旗标：
  --repo    <path>       仓库快照根目录（必需）
  --mr-diff <file>       MR diff 文件路径（统一 diff 文本；caseId = 文件名去扩展名）
  --mr-json <file>       GitCode/GitLab 文件变更 JSON（数组，或 {diffs:[…]}）。路径取
                         new_path → filename → file_path → path、正文取 diff → patch（diff
                         为对象时取内层 diff.diff）；其余字段忽略，装载期补文件头转统一 diff。
                         与 --mr-diff 二选一
  --issue   <text>       MR 议题描述（缺省空）
  --taskId  <id>         任务 id（必需）。产物落到 <tasks 根>/<id>/ 下（runs/ + audit/）；
                         只允许单段目录名：不能含路径分隔符、盘符、<>:"|?* 或前导点，
                         Windows 保留设备名（CON / NUL / COM1…）与尾随点同样拒绝
  --tasks-dir <dir>      tasks 根目录覆盖（缺省 ${DEFAULT_TASKS_ROOT_LABEL}；测试 / CI / 沙箱用），
                         相对路径按 cwd 解析
  --model   <id>         评审模型 id（缺省取配置文件 model.default；自由 id 透传）
  --config  <path>       配置文件显式路径（相对路径按 cwd 解析；缺省用户级路径）
  --rule-skill-zip  <path[,path…]>  规则 Skill zip 显式路径，一次可传多个（逗号分隔，或重复旗标；
                                    顺序 = 执行顺序）。不自动扫描仓库内目录——不传就不装载规则包，ADR-0027
  --rule-skill      <dir[,dir…]>    规则 Skill 已解压目录，一次可传多个；排在全部
                                    --rule-skill-zip 之后；目录先审计再按内容哈希复制进 run 缓存，
                                    符号链接/越界一律拒绝。一个包就是一个 skill（ADR-0034）
  --skill           <dir[,dir…]>    与 --rule-skill 同义（当前视为同一类 Skill）；一次可传多个，
                                    装载时排在全部 --rule-skill 之后
  --include         <regex>          检视范围白名单（可重复，OR；大小写敏感）。命中者越过
                                    test / lockfile / generated / 配置 excludeGlobs 等启发式，
                                    binary 恒剔。CLI 出现即整体替换配置
                                    limits.mrFilter.includeRegex；传空值 = 本次清空该维度
  --exclude         <regex>          检视范围黑名单（可重复，OR）。命中即剔除，优先于 --include。
                                    CLI 出现即整体替换配置 limits.mrFilter.excludeRegex；
                                    传空值 = 本次清空该维度。正则匹配前做 git 引号归一化
  --strict-rule-skill       规则 Skill 装载失败即报错（缺省降级、run 照常）
  --no-progress             关闭运行进度事件行（缺省打印：阶段 / 模型请求 / 工具调用 /
                            skill 会话；批跑收日志时显式静音）。
                            收尾的一行运行总结恒打印，不受此旗标影响

smoke 旗标：
  --model   <id>         冒烟模型 id（同缺省与校验；端点/key 取配置文件，绝不回显）
  --config  <path>       配置文件显式路径

config 旗标：
  init                   写缺省配置模板（已存在需 --force；POSIX 0600）
  show                   逐键打印生效值与来源（reviewer.apiKey 只显示 set/missing）
  --from-env <file>      init 时从 .env 文件一次性迁移（key / url / 呈现配置）
  --json                 show 输出机器可读 JSON（与审计 config 同形）

export 旗标：
  --taskId  <id>         指定任务 id（缺省读 cwd 的 .review-pi-session.json）
  --tasks-dir <dir>      任务根覆盖（cwd 有索引时以索引里的 tasksDir 为准；否则本旗标 → 缺省根）
  --path    <dir>        把本次 run 的 session 复制到该目录，返回复制后的绝对路径
  --native               返回 pi 原生转录（缺省返回 OpenCode 兼容版，见 ADR-0072）
  --trace   <dir>        导出 opencode-trace 兼容 bundle（manifest.json + sessions/，见 ADR-0074）

version 旗标：
  --json                 输出机器可读快照（产品 / Node / 内核四包实际解析版本）`;

/** 解析后的 review 命令参数（caseId 由 --mr-diff / --mr-json 派生） */
export interface ReviewCliArgs {
  readonly repo: string;
  /** MR 输入路径：`--mr-diff` 的 diff 文件，或 `--mr-json` 的文件变更 JSON */
  readonly mr: string;
  /**
   * 输入形态（省键 = 统一 diff 文本；ADR-0029）。`"json"` 时装载期经
   * `mrJsonToUnifiedDiff` 补文件头，之后与 `--mr-diff` 同一条解析路径。
   */
  readonly mrFormat?: "json";
  /** 检视单元身份：--mr-diff / --mr-json 的文件名去扩展名（一案一 MR 文件约定） */
  readonly caseId: string;
  readonly issue: string;
  /**
   * 任务 id（ADR-0033，必需）：一次 `--taskId` 就是一次 run 的输出目录名，
   * 产物落在 `<tasks 根>/<taskId>/{runs,audit}/`。
   */
  readonly taskId: string;
  /** tasks 根目录显式覆盖（`--tasks-dir`；缺席 = `~/.PiAgent/tasks`，按 cwd 解析相对路径） */
  readonly tasksDir?: string;
  /** 评审模型：缺省取配置 model.default（空串/空白 = 用法错误） */
  readonly model?: string;
  /** 配置文件显式路径（`--config`）；缺席 = 用户级缺省路径 */
  readonly configPath?: string;
  /** 规则 Skill zip 显式路径列表（`--rule-skill-zip`；逗号列表或重复旗标，顺序 = 执行顺序；缺席省键） */
  readonly ruleSkillZips?: readonly string[];
  /** 规则 Skill 已解压目录列表（`--rule-skill`；排在全部 zip 之后；缺席省键） */
  readonly ruleSkillDirs?: readonly string[];
  /**
   * `--skill` 已解压目录列表：当前与 `--rule-skill` 视为同一类 Skill，
   * 共用同一装载链路；装载时排在全部 `--rule-skill` 之后（缺席省键）。
   */
  readonly skillDirs?: readonly string[];
  /**
   * 检视范围白名单正则（`--include`，ADR-0078）。缺席省键 = 用配置
   * `limits.mrFilter.includeRegex`；出现且为空数组 = 本次清空该维度
   * （空值旗标在 `emptyPathFilterFlags` 留痕，CLI 打一行提示）。
   */
  readonly includePatterns?: readonly string[];
  /** 检视范围黑名单正则（`--exclude`，ADR-0078）；缺席/空数组语义同上 */
  readonly excludePatterns?: readonly string[];
  /**
   * 传了但**没有值**（或值为空串/纯空白）的 `--include` / `--exclude`
   * （缺席省键）。按「清空该维度」处理，由 CLI 打一行提示（零静默）。
   */
  readonly emptyPathFilterFlags?: readonly string[];
  /**
   * 传了但**没有值**的规则包旗标（`--rule-skill` / `--rule-skill-zip` / `--skill`；缺席省键）。
   *
   * 缺值按「未传」处理（不报用法错误），由 CLI 打一行提示——规则包旗标常由脚本
   * 按变量拼出来，PowerShell 在变量为空时会把这个参数整个丢掉，那种「机器上变量
   * 没设」不该让整条命令起不来。零静默：忽略必须可见，故本字段回传给调用方。
   */
  readonly emptyRuleSkillFlags?: readonly string[];
  /** 规则 Skill 严格模式（--strict-rule-skill；缺席省键） */
  readonly strictRuleSkill?: boolean;
  /**
   * 运行进度投影开关（ADR-0055，取代 ADR-0016 的 TTY 自动档）：`--no-progress`
   * → false、缺席省键 = 缺省打印（不再区分 TTY）。
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

/** 解析后的 `version` 子命令参数（ADR-0079）：只有 `--json` 一个机器可读开关 */
export interface VersionCliArgs {
  /** 输出结构化版本快照（产品 / Node / 内核四包实际解析版本） */
  readonly json?: boolean;
}

/** 解析后的 export 子命令参数（ADR-0036 / ADR-0072） */
export interface ExportCliArgs {
  /** 指定任务 id；缺席 = 读 cwd 的 `.review-pi-session.json` */
  readonly taskId?: string;
  /** tasks 根覆盖（cwd 有索引时不生效） */
  readonly tasksDir?: string;
  /** 复制目标目录（相对 cwd） */
  readonly destPath?: string;
  /**
   * 切换表示（ADR-0072）：缺省返回 OpenCode 兼容版转录（`opencode/` 子目录），
   * `--native` 切回 pi 原生转录。
   */
  readonly native?: boolean;
  /** opencode-trace 导出目标目录（ADR-0074）；出席 = 走 trace bundle 模式 */
  readonly traceDir?: string;
}

/** 解析结果：子命令 + 参数，或用法错误消息（调用方负责呈现与退出码） */
export type ParseCliArgsResult =
  | { readonly ok: true; readonly command: "review"; readonly args: ReviewCliArgs }
  | { readonly ok: true; readonly command: "smoke"; readonly args: SmokeCliArgs }
  | { readonly ok: true; readonly command: "config"; readonly args: ConfigCliArgs }
  | { readonly ok: true; readonly command: "export"; readonly args: ExportCliArgs }
  | { readonly ok: true; readonly command: "version"; readonly args: VersionCliArgs }
  | { readonly ok: false; readonly message: string };

/** 旗标循环（两子命令共用）：未知旗标 / 重复旗标 / 值缺席（含值吞旗标）都是用法错误。
 * **唯一例外**是逗号列表旗标（`--rule-skill` / `--rule-skill-zip`）：无值的那种在
 * `joinCommaListTokens` 里已被摘成「未传」，走不到这里（缺值不报错，由 CLI 提示一行）。
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
    // 值以 -- 开头 = 相邻旗标被吞（如 `--issue --taskId x`）——fail fast 不静默
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

/**
 * 逗号列表旗标的**多 token 归并**（ADR-0034）：`--rule-skill-zip r1.zip, r2.zip, r3.zip`
 * 在 shell 里会被按空白切成多个 argv——bash 留下尾逗号（`r1.zip,`），
 * PowerShell 连逗号都吃掉（`r1.zip`）。所以列表旗标的值位置**连续的非旗标 token
 * 全部计入列表**，用 `,` 拼成一个值，再由 `parseRuleSkillList` 拆开。
 *
 * 本命令没有位置参数，所有值都必须挂在旗标名下，所以贪心吃非旗标 token 不产生歧义。
 *
 * 缺值（argv 结束，或下一个 token 就是旗标）**不报用法错误**：该旗标被摘掉、
 * 等价于未传，并登记进 `emptyFlags` 交给调用方喊一声。规则包旗标几乎总是由脚本
 * 按变量拼出来（`--rule-skill $dir`），PowerShell 在变量为空时会把这个参数整个
 * 丢掉——「机器上变量没设」不该让整条命令起不来，但也不能悄悄少装载一个 skill。
 *
 * 值位置给了 token 但**没有任何有效路径**（`--skill ""` / `--rule-skill " , "`）同样
 * 按「未传」处理：bash 里 `--skill "$dirs"` 在变量为空时就是这样（空串参数确实会
 * 传进来），与 PowerShell 的「整个参数被丢掉」是同一件事，口径必须一致。
 */
function joinCommaListTokens(tokens: readonly string[]): {
  readonly tokens: readonly string[];
  readonly emptyFlags: readonly string[];
} {
  const out: string[] = [];
  const emptyFlags: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!COMMA_LIST_FLAGS.includes(token)) {
      out.push(token);
      continue;
    }
    const items: string[] = [];
    let cursor = index + 1;
    for (let next = tokens[cursor]; next !== undefined && !next.startsWith("--"); next = tokens[cursor]) {
      items.push(next);
      cursor += 1;
    }
    // 没给 token，或给的只是空串 / 纯空白 / 纯逗号（`--skill ""`、`--rule-skill " , "`）：
    // 都按「未传」处理——它们与「变量展开成空」不可区分，不该让整条命令起不来（ADR-0044）。
    const value = items.join(",");
    const usable = value.split(",").some((part) => part.trim().length > 0);
    if (!usable) {
      emptyFlags.push(token);
      index = cursor - 1; // 值 token 已被上面的向后看吃掉，别让它落到旗标循环里
      continue;
    }
    out.push(token, value);
    index = cursor - 1;
  }
  return { tokens: out, emptyFlags };
}

/**
 * 检视范围正则旗标的**空值剔除**（ADR-0078）：`--include` / `--exclude`
 * 没有值（argv 结束、下一个 token 是旗标）或值为空串/纯空白时，按「本次
 * 清空该维度」处理——摘掉整对 token，登记进 `emptyFlags` 由 CLI 喊一声。
 *
 * 与 `joinCommaListTokens` 分开：正则**不能**做逗号归并（`{m,n}`、`[,;]`
 * 都会被切坏），所以这里只做单条 k-v 识别，绝不吞并后续 token。
 */
function stripEmptyPathFilterFlags(tokens: readonly string[]): {
  readonly tokens: readonly string[];
  readonly emptyFlags: readonly string[];
} {
  const out: string[] = [];
  const emptyFlags: string[] = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index] as string;
    if (!PATH_FILTER_FLAGS.includes(token)) {
      out.push(token);
      continue;
    }
    const next = tokens[index + 1];
    if (next === undefined || next.startsWith("--")) {
      emptyFlags.push(token);
      continue;
    }
    if (next.trim() === "") {
      emptyFlags.push(token);
      index += 1;
      continue;
    }
    out.push(token, next);
    index += 1;
  }
  return { tokens: out, emptyFlags };
}

/**
 * 正则列表解析（ADR-0078）：重复旗标收集，逐条试编译（fail fast），
 * 去重保序。**不 trim**——首尾空格可能是正则语义的一部分。
 */
function parseRegexPatterns(
  flag: string,
  raw: readonly string[] | undefined,
): { readonly ok: true; readonly items?: readonly string[] } | { readonly ok: false; readonly message: string } {
  if (raw === undefined) {
    return { ok: true };
  }
  const items: string[] = [];
  for (const value of raw) {
    if (value.trim() === "") {
      continue; // stripEmptyPathFilterFlags 已摘；这里只作防御
    }
    try {
      new RegExp(value);
    } catch (error) {
      return {
        ok: false,
        message: `invalid ${flag} ${JSON.stringify(value)}: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!items.includes(value)) {
      items.push(value);
    }
  }
  return { ok: true, items };
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
      return "--env 已移除（配置见 --config <file> 或 ~/.PiAgent/PiAgent.jsonc）";
    }
  }
  return undefined;
}

/** `--mr` 已拆成 `--mr-diff` / `--mr-json`（ADR-0029）：给专用迁移提示，而不是裸 unknown flag */
function legacyMrFlagError(argv: readonly string[]): string | undefined {
  for (const token of argv) {
    if (token === "--mr" || token.startsWith("--mr=")) {
      return "--mr 已改名（ADR-0029）：统一 diff 文件用 --mr-diff，接口 JSON 用 --mr-json";
    }
  }
  return undefined;
}

/** `--out` 已由 `--taskId` 取代（ADR-0033）：给专用迁移提示，而不是裸 unknown flag */
function legacyOutFlagError(argv: readonly string[]): string | undefined {
  for (const token of argv) {
    if (token === "--out" || token.startsWith("--out=")) {
      return `--out 已移除（ADR-0033）：产物改落 ${DEFAULT_TASKS_ROOT_LABEL}/<taskId>/，改用 --taskId <id>（--tasks-dir <dir> 只覆盖 tasks 根目录）`;
    }
  }
  return undefined;
}

/** `--rule-skill-name` 已移除（ADR-0034：一个包就是一个 skill）：给专用迁移提示 */
function legacyRuleSkillNameFlagError(argv: readonly string[]): string | undefined {
  for (const token of argv) {
    if (token === "--rule-skill-name" || token.startsWith("--rule-skill-name=")) {
      return "--rule-skill-name 已移除（ADR-0034）：一个规则包就是一个 skill；多个包用 --rule-skill-zip a.zip,b.zip（或重复旗标）一次传入";
    }
  }
  return undefined;
}

/** `--progress` 已移除（ADR-0055：进度缺省打印）：给专用迁移提示，而不是裸 unknown flag */
function legacyProgressFlagError(argv: readonly string[]): string | undefined {
  for (const token of argv) {
    if (token === "--progress" || token.startsWith("--progress=")) {
      return "--progress 已移除（ADR-0055）：进度事件行缺省打印；不需要时传 --no-progress";
    }
  }
  return undefined;
}

/**
 * 规则包列表旗标的值解析（ADR-0034）：逗号列表与重复旗标等价，逐项 trim、
 * 空项丢弃（`a.zip,,b.zip` 仍取两项）。
 *
 * 「整值无有效项」在 CLI 侧已由 `joinCommaListTokens` 提前按「未传」摘除
 * （ADR-0044 后续修订），所以这里的拒绝分支只作内部防御：任何调用方绕过
 * 归并层直接传空列表，仍得到显式错误而不是静默的 0 个包。
 */
function parseRuleSkillList(
  flag: string,
  raw: readonly string[] | undefined,
): { readonly ok: true; readonly items?: readonly string[] } | { readonly ok: false; readonly message: string } {
  if (raw === undefined) {
    return { ok: true };
  }
  const items = raw
    .flatMap((value) => value.split(","))
    .map((item) => item.trim())
    .filter((item) => item.length > 0);
  if (items.length === 0) {
    return {
      ok: false,
      message: `invalid ${flag} ${JSON.stringify(raw.join(","))}: must be a non-empty path list`,
    };
  }
  return { ok: true, items };
}

export function parseCliArgs(argv: readonly string[]): ParseCliArgsResult {
  const [command, ...rest] = argv;
  const envError = envFlagError(rest);
  if (envError !== undefined) {
    return { ok: false, message: envError };
  }
  if (command === "review") {
    const mrError = legacyMrFlagError(rest);
    if (mrError !== undefined) {
      return { ok: false, message: mrError };
    }
    const outError = legacyOutFlagError(rest);
    if (outError !== undefined) {
      return { ok: false, message: outError };
    }
    const ruleSkillNameError = legacyRuleSkillNameFlagError(rest);
    if (ruleSkillNameError !== undefined) {
      return { ok: false, message: ruleSkillNameError };
    }
    const progressError = legacyProgressFlagError(rest);
    if (progressError !== undefined) {
      return { ok: false, message: progressError };
    }
  }
  if (command === "config") {
    return parseConfigCommand(rest);
  }
  if (command === "export") {
    return parseExportCommand(rest);
  }
  // 版本面（ADR-0079）：`version` 子命令与顶层 `--version` / `-v` 同义。
  // 放在配置装载之前（main 里直接返回），所以这里只认 `--json`，不接受
  // `--config`——版本命令不读配置，给了配置旗标是用法错误而不是静默忽略。
  if (command === "version" || command === "--version" || command === "-v") {
    return parseVersionCommand(rest);
  }
  if (command !== "review" && command !== "smoke") {
    return {
      ok: false,
      message:
        argv.length === 0
          ? "missing command (expected `review`, `smoke`, `config`, `export` or `version`)"
          : `unknown command ${JSON.stringify(command)} (expected \`review\`, \`smoke\`, \`config\`, \`export\` or \`version\`)`,
    };
  }
  const booleanFlags = command === "review" ? stripReviewBooleanFlags(rest) : undefined;
  if (booleanFlags !== undefined && !booleanFlags.ok) {
    return { ok: false, message: booleanFlags.message };
  }
  const flagTokens = booleanFlags !== undefined && booleanFlags.ok ? booleanFlags.tokens : rest;
  const pathFilterStripped =
    command === "review" ? stripEmptyPathFilterFlags(flagTokens) : undefined;
  const afterPathFilters =
    pathFilterStripped !== undefined ? pathFilterStripped.tokens : flagTokens;
  const joined = command === "review" ? joinCommaListTokens(afterPathFilters) : undefined;
  const listTokens = joined !== undefined ? joined.tokens : afterPathFilters;
  const flags = parseFlags(
    listTokens,
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
    joined !== undefined ? joined.emptyFlags : [],
    pathFilterStripped !== undefined ? pathFilterStripped.emptyFlags : [],
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
 * 剥离 review 的无值布尔旗标（`--strict-rule-skill` / `--no-progress`；
 * 旗标循环是 k-v 成对，无值旗标必须先摘除）。单趟计数：
 * 重复出现 = 重复旗标（`--progress` 已移除，见 `legacyProgressFlagError`）。
 */
function stripReviewBooleanFlags(rest: readonly string[]): {
  readonly ok: true;
  readonly tokens: readonly string[];
  readonly strict: boolean;
  readonly progress?: boolean;
} | { readonly ok: false; readonly message: string } {
  const known = new Set(["--strict-rule-skill", "--no-progress"]);
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
  return {
    ok: true,
    tokens,
    strict: counts.has("--strict-rule-skill"),
    ...(counts.has("--no-progress") ? { progress: false } : {}),
  };
}

/**
 * export 子命令（ADR-0036 / ADR-0072）：三个有值旗标 + 一个布尔旗标
 * `--native`（表示切换）。`--taskId` 与 `review` 同口径校验（单段目录名）；
 * `--path` / `--tasks-dir` 只要求非空（相对路径按 cwd 解析，交给执行层）。
 */
function parseExportCommand(rest: readonly string[]): ParseCliArgsResult {
  const stripped = stripExportNativeFlag(rest);
  if (!stripped.ok) {
    return stripped;
  }
  const flags = parseFlags(stripped.tokens, KNOWN_EXPORT_FLAGS);
  if (!flags.ok) {
    return flags;
  }
  const taskIdRaw = flags.values.get("--taskId");
  let taskId: string | undefined;
  if (taskIdRaw !== undefined) {
    const checked = checkTaskId(taskIdRaw);
    if (!checked.ok) {
      return checked;
    }
    taskId = checked.taskId;
  }
  const tasksDir = flags.values.get("--tasks-dir");
  if (tasksDir !== undefined && tasksDir.trim().length === 0) {
    return {
      ok: false,
      message: `invalid --tasks-dir ${JSON.stringify(tasksDir)}: must be a non-empty directory path`,
    };
  }
  const destPath = flags.values.get("--path");
  if (destPath !== undefined && destPath.trim().length === 0) {
    return {
      ok: false,
      message: `invalid --path ${JSON.stringify(destPath)}: must be a non-empty directory path`,
    };
  }
  const traceDir = flags.values.get("--trace");
  if (traceDir !== undefined && traceDir.trim().length === 0) {
    return {
      ok: false,
      message: `invalid --trace ${JSON.stringify(traceDir)}: must be a non-empty directory path`,
    };
  }
  return {
    ok: true,
    command: "export",
    args: {
      ...(taskId !== undefined ? { taskId } : {}),
      ...(tasksDir !== undefined ? { tasksDir } : {}),
      ...(destPath !== undefined ? { destPath } : {}),
      ...(stripped.native ? { native: true } : {}),
      ...(traceDir !== undefined ? { traceDir } : {}),
    },
  };
}

/** 剥离 export 的无值布尔旗标 `--native`（旗标循环是 k-v 成对，布尔必须先摘除） */
function stripExportNativeFlag(rest: readonly string[]): {
  readonly ok: true;
  readonly tokens: readonly string[];
  readonly native: boolean;
} | { readonly ok: false; readonly message: string } {
  let native = false;
  const tokens: string[] = [];
  for (const token of rest) {
    if (token === "--native") {
      if (native) {
        return { ok: false, message: "duplicate flag --native" };
      }
      native = true;
    } else {
      tokens.push(token);
    }
  }
  return { ok: true, tokens, native };
}

/**
 * version 子命令（ADR-0079）：只认无值布尔旗标 `--json`。
 * 版本命令要在任何配置装载之前完成，所以参数面刻意窄到不能再窄——
 * 未知旗标是用法错误（打印 usage + exit 1），不静默忽略。
 */
function parseVersionCommand(rest: readonly string[]): ParseCliArgsResult {
  let json = false;
  for (const flag of rest) {
    if (flag !== "--json") {
      return { ok: false, message: `unknown flag ${JSON.stringify(flag)}` };
    }
    if (json) {
      return { ok: false, message: "duplicate flag --json" };
    }
    json = true;
  }
  return { ok: true, command: "version", args: json ? { json: true } : {} };
}

/** review 面必填与缺省：--repo / （--mr-diff | --mr-json）（caseId = 文件名去扩展名）、--issue 缺省空 */
function parseReviewArgs(
  values: Map<string, string>,
  repeated: ReadonlyMap<string, readonly string[]>,
  model: string | undefined,
  strict: boolean,
  progress: boolean | undefined,
  emptyRuleSkillFlags: readonly string[],
  emptyPathFilterFlags: readonly string[],
): { readonly ok: true; readonly command: "review"; readonly args: ReviewCliArgs } | { readonly ok: false; readonly message: string } {
  const repo = values.get("--repo");
  if (repo === undefined) {
    return { ok: false, message: "missing required flag --repo" };
  }
  // 输入形态二选一（ADR-0029）：都省略或都给都是用法错误——不静默取其一
  const mrDiff = values.get("--mr-diff");
  const mrJson = values.get("--mr-json");
  if (mrDiff !== undefined && mrJson !== undefined) {
    return {
      ok: false,
      message: "conflicting flags --mr-diff and --mr-json (give exactly one)",
    };
  }
  const mr = mrDiff ?? mrJson;
  if (mr === undefined) {
    return { ok: false, message: "missing required flag --mr-diff (or --mr-json)" };
  }
  const mrFormat = mrJson !== undefined ? ("json" as const) : undefined;
  // 任务 id 必需（ADR-0033）：落盘位置由它决定，不设缺省——漏传是用法错误，不静默兜底
  const taskIdRaw = values.get("--taskId");
  if (taskIdRaw === undefined) {
    return { ok: false, message: "missing required flag --taskId (output goes to <tasks root>/<taskId>)" };
  }
  const taskId = checkTaskId(taskIdRaw);
  if (!taskId.ok) {
    return taskId;
  }
  const tasksDirRaw = values.get("--tasks-dir");
  if (tasksDirRaw !== undefined && tasksDirRaw.trim().length === 0) {
    return {
      ok: false,
      message: `invalid --tasks-dir ${JSON.stringify(tasksDirRaw)}: must be a non-empty directory path`,
    };
  }
  const ruleSkillZips = parseRuleSkillList("--rule-skill-zip", repeated.get("--rule-skill-zip"));
  if (!ruleSkillZips.ok) {
    return ruleSkillZips;
  }
  const ruleSkillDirs = parseRuleSkillList("--rule-skill", repeated.get("--rule-skill"));
  if (!ruleSkillDirs.ok) {
    return ruleSkillDirs;
  }
  const skillDirs = parseRuleSkillList("--skill", repeated.get("--skill"));
  if (!skillDirs.ok) {
    return skillDirs;
  }
  // 检视范围正则（ADR-0078）：缺席 = 用配置；出现且空 = 本次清空该维度。
  const includeRaw = repeated.get("--include");
  const excludeRaw = repeated.get("--exclude");
  const includeParsed = parseRegexPatterns("--include", includeRaw);
  if (!includeParsed.ok) {
    return includeParsed;
  }
  const excludeParsed = parseRegexPatterns("--exclude", excludeRaw);
  if (!excludeParsed.ok) {
    return excludeParsed;
  }
  const includePatterns =
    includeRaw !== undefined || emptyPathFilterFlags.includes("--include")
      ? (includeParsed.items ?? [])
      : undefined;
  const excludePatterns =
    excludeRaw !== undefined || emptyPathFilterFlags.includes("--exclude")
      ? (excludeParsed.items ?? [])
      : undefined;
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
      ...(mrFormat !== undefined ? { mrFormat } : {}),
      caseId: basename(mr).replace(/\.[^.]*$/, ""),
      issue: values.get("--issue") ?? "",
      taskId: taskId.taskId,
      ...(tasksDirRaw !== undefined ? { tasksDir: tasksDirRaw } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(config.configPath !== undefined ? { configPath: config.configPath } : {}),
      ...(ruleSkillZips.items !== undefined ? { ruleSkillZips: ruleSkillZips.items } : {}),
      ...(ruleSkillDirs.items !== undefined ? { ruleSkillDirs: ruleSkillDirs.items } : {}),
      ...(skillDirs.items !== undefined ? { skillDirs: skillDirs.items } : {}),
      ...(includePatterns !== undefined ? { includePatterns } : {}),
      ...(excludePatterns !== undefined ? { excludePatterns } : {}),
      ...(emptyPathFilterFlags.length > 0
        ? { emptyPathFilterFlags: [...emptyPathFilterFlags] }
        : {}),
      ...(emptyRuleSkillFlags.length > 0 ? { emptyRuleSkillFlags: [...emptyRuleSkillFlags] } : {}),
      ...(strict ? { strictRuleSkill: true } : {}),
      ...(progress !== undefined ? { progress } : {}),
    },
  };
}
