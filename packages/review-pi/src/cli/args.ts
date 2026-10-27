import { basename } from "node:path";
import { CONFIGS, type ConfigId } from "../contracts/config.js";
import { dispositionStorePath } from "../disposition/store.js";
import { DISPOSITION_DECISIONS, type DispositionDecision } from "../disposition/record.js";
import { REVIEW_MODEL_ID } from "../provider/pi-client.js";

/**
 * #7 review-pi CLI 参数解析（进程内主缝第一层）：`review-pi review`、
 * `review-pi smoke` 与 `review-pi disposition` 三个子命令的用法契约。
 * 形态对齐 DSH 线 review-agent args.ts（union 结果、不抛异常——用户输入
 * 错误是预期路径，不是完整性事故）；config 合法性对照 CONFIGS 注册表
 * （A–E 矩阵真源）。
 *
 * pi 线差异（自立决策，不从 DSH 仓导入）：
 * - 缺省 config = E（生产入口切流，ADR-0011：自主拉取 + Context Ledger；
 *   2026-10-19 决策前曾为 B——P3b 时代「生产形态」口径已随选型死亡；
 *   DSH 线缺省 A）；
 * - 无 --language 旗标（输出语言是 DSH 线后分家决策，pi 线自立 ADR 前不实装）；
 * - smoke 只认 --model（双探针自检不跑检视，参数面自然更窄）；
 * - disposition（#15）本地数据面：无网络无凭据；--decision 三值枚举在
 *   parse 层校验；处置库 --store 显式与 --out 派生根互斥，缺省派生
 *   <out>/<CLI_EXPERIMENT_ID>/dispositions.json（与 review 落盘的 runs/
 *   同层）。
 *
 * model 是实验数据（#45 语义）：自由 id 透传，缺省单源 = 钉住的评审模型
 * （REVIEW_MODEL_ID），无 model 环境变量。与 DSH 线 review bin 的
 * 「flash/pro 别名 + 退役 id 拒绝」口径有意分家（ADR-0008 别名面属核外
 * 实验 CLI；pi 内核 reviewModelOf 对目录外 id 一律以钉住画像透传，无别名目录）。
 */

/** CLI 运行留痕的实验目录名（<out>/<experimentId>/runs|audit|dispositions.json——处置库与 runs/ 同层） */
export const CLI_EXPERIMENT_ID = "review-pi-cli";

/** --out 缺省（review 落盘根与 disposition 处置库派生根共用同一约定） */
const DEFAULT_OUT_DIR = "review-pi-output";

/** review 子命令的已知旗标（未知旗标 = 用法错误；`--strict-rule-skill` 无值，进旗标循环前剥离） */
const KNOWN_REVIEW_FLAGS: readonly string[] = [
  "--repo",
  "--mr",
  "--config",
  "--issue",
  "--out",
  "--model",
  "--rule-skill-zip",
  "--rule-skill-name",
];

/** review 面可重复旗标（ADR-0014：多规则包按 CLI 顺序叠加） */
const REPEATABLE_REVIEW_FLAGS: readonly string[] = ["--rule-skill-zip"];

/** smoke 子命令的已知旗标 */
const KNOWN_SMOKE_FLAGS: readonly string[] = ["--model"];

/** disposition 子命令（记录处置面）的已知旗标 */
const KNOWN_DISPOSITION_FLAGS: readonly string[] = [
  "--run",
  "--finding",
  "--decision",
  "--note",
  "--store",
  "--out",
];

/** disposition 子命令（KPI 面）的已知旗标（--stats 本身无值，进入旗标循环前剥离） */
const KNOWN_DISPOSITION_STATS_FLAGS: readonly string[] = ["--store", "--out"];

/** 用法文案（stderr 错误路径的同款文案，单一来源） */
export const USAGE_TEXT = `usage: review-pi review --repo <path> --mr <diff-file> [--config A-F] [--issue <text>] [--out <dir>] [--model <id>] [--rule-skill-zip <path>]... [--rule-skill-name <name>] [--strict-rule-skill]
       review-pi smoke [--model <id>]
       review-pi disposition --run <run-record.json> --finding <id> --decision accept|reject|false-positive [--note <text>] ([--store <file>] | [--out <dir>])
       review-pi disposition --stats ([--store <file>] | [--out <dir>])
  （smoke = 网关冒烟自检，P1b 双探针：网关健康 + 模型可达，输出人话诊断）
  （disposition = Finding 人工处置落库 + 接受率 KPI：本地数据面，无网络、不碰凭据与 .env.local）

review 旗标：
  --repo    <path>       仓库快照根目录（必需）
  --mr      <diff-file>  MR diff 文件路径（必需；caseId = 文件名去扩展名）
  --config  <A-F>        配置形态（缺省 E = 生产入口：自主拉取 + Context Ledger，ADR-0011 切流；
                         F = E + 规则 Skill，须在仓库 .review-rules/ 投放 zip）
  --issue   <text>       MR 议题描述（缺省空）
  --out     <dir>        输出目录（审计与运行记录落盘；缺省 ${DEFAULT_OUT_DIR}）
  --model   <id>         评审模型 id（缺省 ${REVIEW_MODEL_ID}；自由 id 透传）
  --rule-skill-zip  <path>  规则 Skill zip 显式路径（config F；可重复，顺序 = 执行顺序；
                            缺省扫 <repo>/.review-rules/*.zip 全部装载）
  --rule-skill-name <name>  指定装载的规则 Skill 名（包内多 skill 消歧，逐包生效）
  --strict-rule-skill       规则 Skill 装载失败即报错（缺省降级、run 照常）

smoke 旗标：
  --model   <id>         冒烟模型 id（同缺省与校验；端点/key 走 REVIEWER_* 环境变量或 .env.local，绝不回显）

disposition 旗标（记录处置）：
  --run      <file>      产生该 finding 的 run record JSON 文件（必需；回溯锚与 finding 校验都以它为准）
  --finding  <id>        被处置的 finding id（必需；必须存在于该 run record 的 baseline.findings）
  --decision <kind>      处置决定（必需）：accept 接受 / reject 拒绝 / false-positive 误报
  --note     <text>      人工备注（可选；空白 = 用法错误）
  --store    <file>      处置库文件（与 --out 互斥）
  --out      <dir>       处置库派生根（缺省 ${DEFAULT_OUT_DIR}；库 = <out>/${CLI_EXPERIMENT_ID}/dispositions.json，
                         与 review 命令落盘的 runs/ 同层）

disposition 旗标（KPI）：
  --stats                从处置库聚合人工接受率（绝对口径：accepted/total；total=0 → null）
  --store    <file>      处置库文件（与 --out 互斥；派生规则同上）
  --out      <dir>       处置库派生根（同上）`;

/** 解析后的 review 命令参数（config 已收窄为 A–F；caseId 由 --mr 派生） */
export interface ReviewCliArgs {
  readonly repo: string;
  readonly mr: string;
  /** 检视单元身份：--mr 文件名去扩展名（一案一 diff 文件约定） */
  readonly caseId: string;
  readonly config: ConfigId;
  readonly issue: string;
  readonly out: string;
  /** 评审模型：缺省 REVIEW_MODEL_ID；自由 id 透传（空串/空白 = 用法错误） */
  readonly model: string;
  /** 规则 Skill zip 显式路径列表（--rule-skill-zip 可重复；顺序 = 执行顺序；缺席省键） */
  readonly ruleSkillZips?: readonly string[];
  /** 规则 Skill 指定名（--rule-skill-name；缺席省键） */
  readonly ruleSkillName?: string;
  /** 规则 Skill 严格模式（--strict-rule-skill；缺席省键） */
  readonly strictRuleSkill?: boolean;
}

/** 解析后的 smoke 命令参数 */
export interface SmokeCliArgs {
  readonly model: string;
}

/** 解析后的 disposition 记录面参数（store 已解析：--store 显式或 --out 派生） */
export interface DispositionRecordArgs {
  /** 产生该 finding 的 run record JSON 文件路径（必需） */
  readonly run: string;
  readonly finding: string;
  readonly decision: DispositionDecision;
  /** 人工备注（缺席省键） */
  readonly note?: string;
  readonly store: string;
}

/** 解析后的 disposition KPI 面参数 */
export interface DispositionStatsArgs {
  readonly store: string;
}

/** disposition 命令的两用法面（mode 判别式） */
export type DispositionCliArgs =
  | { readonly mode: "record"; readonly args: DispositionRecordArgs }
  | { readonly mode: "stats"; readonly args: DispositionStatsArgs };

/** 解析结果：子命令 + 参数，或用法错误消息（调用方负责呈现与退出码） */
export type ParseCliArgsResult =
  | { readonly ok: true; readonly command: "review"; readonly args: ReviewCliArgs }
  | { readonly ok: true; readonly command: "smoke"; readonly args: SmokeCliArgs }
  | { readonly ok: true; readonly command: "disposition"; readonly args: DispositionCliArgs }
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

/** --model 的缺省与校验（两子命令同口径） */
function parseModelFlag(
  values: Map<string, string>,
): { readonly ok: true; readonly model: string } | { readonly ok: false; readonly message: string } {
  const modelRaw = values.get("--model") ?? REVIEW_MODEL_ID;
  if (modelRaw.trim().length === 0) {
    return {
      ok: false,
      message: `invalid --model ${JSON.stringify(modelRaw)}: must be a non-empty model id (free ids accepted)`,
    };
  }
  return { ok: true, model: modelRaw };
}

/** 首个空白值旗标（disposition 面值校验：空串/全空白都 fail fast，不给库文件/路径埋雷） */
function findBlankFlagValue(values: Map<string, string>): string | undefined {
  for (const [flag, value] of values) {
    if (value.trim().length === 0) {
      return flag;
    }
  }
  return undefined;
}

/** 解析结果的私有形态（disposition 两面共用：ok 面 / 错误消息面） */
type DispositionParseResult =
  | { readonly ok: true; readonly args: DispositionCliArgs }
  | { readonly ok: false; readonly message: string };

/** 记录面参数的私有解析结果 */
type RecordParseResult =
  | { readonly ok: true; readonly args: DispositionRecordArgs }
  | { readonly ok: false; readonly message: string };

/**
 * disposition 子命令解析（两用法面共用旗标循环）：
 * --stats 无值，进入 parseFlags 前剥离；出现多次 = 重复旗标。
 * 旗标循环后按面分流：记录面 → parseDispositionRecordArgs，KPI 面 → 直接成参。
 */
function parseDispositionArgs(rest: readonly string[]): DispositionParseResult {
  const statsTokens = rest.filter((token) => token === "--stats");
  if (statsTokens.length > 1) {
    return { ok: false, message: "duplicate flag --stats" };
  }
  const isStats = statsTokens.length === 1;
  const remaining = rest.filter((token) => token !== "--stats");
  const flags = parseFlags(remaining, isStats ? KNOWN_DISPOSITION_STATS_FLAGS : KNOWN_DISPOSITION_FLAGS);
  if (!flags.ok) {
    // stats 面下记录面旗标是「模式不匹配」而非单纯未知——错误里点名可用集
    return isStats
      ? { ok: false, message: `${flags.message} (with --stats, accepted flags: --store, --out)` }
      : flags;
  }
  const blankFlag = findBlankFlagValue(flags.values);
  if (blankFlag !== undefined) {
    return { ok: false, message: `flag ${blankFlag} requires a non-empty value` };
  }
  const store = resolveDispositionStore(flags.values);
  if (!store.ok) {
    return store;
  }
  if (isStats) {
    return { ok: true, args: { mode: "stats", args: { store: store.store } } };
  }
  const record = parseDispositionRecordArgs(flags.values, store.store);
  return record.ok ? { ok: true, args: { mode: "record", args: record.args } } : record;
}

/** 处置库解析：--store 显式与 --out 派生根互斥（二义性 fail fast）；缺省派生 <out>/<CLI_EXPERIMENT_ID>/dispositions.json */
function resolveDispositionStore(
  values: Map<string, string>,
): { readonly ok: true; readonly store: string } | { readonly ok: false; readonly message: string } {
  const store = values.get("--store");
  const out = values.get("--out");
  if (store !== undefined && out !== undefined) {
    return {
      ok: false,
      message:
        "flags --store and --out are mutually exclusive: pass --store <file> explicitly, or let the store derive from --out",
    };
  }
  return { ok: true, store: store ?? dispositionStorePath(out ?? DEFAULT_OUT_DIR, CLI_EXPERIMENT_ID) };
}

/** 记录面必填与枚举：--run / --finding / --decision（三值枚举 parse 层校验）；--note 可选透传 */
function parseDispositionRecordArgs(values: Map<string, string>, store: string): RecordParseResult {
  const run = values.get("--run");
  if (run === undefined) {
    return { ok: false, message: "missing required flag --run" };
  }
  const finding = values.get("--finding");
  if (finding === undefined) {
    return { ok: false, message: "missing required flag --finding" };
  }
  const decisionRaw = values.get("--decision");
  if (decisionRaw === undefined) {
    return { ok: false, message: "missing required flag --decision" };
  }
  if (!DISPOSITION_DECISIONS.includes(decisionRaw as DispositionDecision)) {
    return {
      ok: false,
      message: `invalid --decision ${JSON.stringify(decisionRaw)}: expected one of ${DISPOSITION_DECISIONS.join(", ")}`,
    };
  }
  const note = values.get("--note");
  return {
    ok: true,
    args: {
      run,
      finding,
      decision: decisionRaw as DispositionDecision,
      store,
      ...(note !== undefined ? { note } : {}),
    },
  };
}

export function parseCliArgs(argv: readonly string[]): ParseCliArgsResult {
  const [command, ...rest] = argv;
  if (command !== "review" && command !== "smoke" && command !== "disposition") {
    return {
      ok: false,
      message:
        argv.length === 0
          ? "missing command (expected `review`, `smoke` or `disposition`)"
          : `unknown command ${JSON.stringify(command)} (expected \`review\`, \`smoke\` or \`disposition\`)`,
    };
  }
  if (command === "disposition") {
    const disposition = parseDispositionArgs(rest);
    return disposition.ok ? { ok: true, command: "disposition", args: disposition.args } : disposition;
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
  if (command === "smoke") {
    return { ok: true, command: "smoke", args: { model: model.model } };
  }
  return parseReviewArgs(
    flags.values,
    flags.repeated,
    model.model,
    booleanFlags !== undefined && booleanFlags.ok ? booleanFlags.strict : false,
  );
}

/**
 * 剥离 review 的无值布尔旗标（`--strict-rule-skill`；照 disposition `--stats`
 * 先例——旗标循环是 k-v 成对，无值旗标必须先摘除）。重复出现 = 重复旗标。
 */
function stripReviewBooleanFlags(rest: readonly string[]):
  | { readonly ok: true; readonly tokens: readonly string[]; readonly strict: boolean }
  | { readonly ok: false; readonly message: string } {
  const occurrences = rest.filter((token) => token === "--strict-rule-skill");
  if (occurrences.length > 1) {
    return { ok: false, message: "duplicate flag --strict-rule-skill" };
  }
  return {
    ok: true,
    tokens: rest.filter((token) => token !== "--strict-rule-skill"),
    strict: occurrences.length === 1,
  };
}

/** review 面必填与缺省：--repo / --mr（caseId = 文件名去扩展名）、--config 缺省 E（ADR-0011 切流）、--issue 缺省空 */
function parseReviewArgs(
  values: Map<string, string>,
  repeated: ReadonlyMap<string, readonly string[]>,
  model: string,
  strict: boolean,
): { readonly ok: true; readonly command: "review"; readonly args: ReviewCliArgs } | { readonly ok: false; readonly message: string } {
  const repo = values.get("--repo");
  if (repo === undefined) {
    return { ok: false, message: "missing required flag --repo" };
  }
  const mr = values.get("--mr");
  if (mr === undefined) {
    return { ok: false, message: "missing required flag --mr" };
  }
  const configRaw = values.get("--config") ?? "E";
  if (!(configRaw in CONFIGS)) {
    return { ok: false, message: `invalid --config ${JSON.stringify(configRaw)}: expected one of A, B, C, D, E, F` };
  }
  const ruleSkillZips = repeated.get("--rule-skill-zip");
  const ruleSkillName = values.get("--rule-skill-name");

  return {
    ok: true,
    command: "review",
    args: {
      repo,
      mr,
      caseId: basename(mr).replace(/\.[^.]*$/, ""),
      config: configRaw as ConfigId,
      issue: values.get("--issue") ?? "",
      out: values.get("--out") ?? DEFAULT_OUT_DIR,
      model,
      ...(ruleSkillZips !== undefined ? { ruleSkillZips } : {}),
      ...(ruleSkillName !== undefined ? { ruleSkillName } : {}),
      ...(strict ? { strictRuleSkill: true } : {}),
    },
  };
}
