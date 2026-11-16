import { DEFAULT_TASKS_ROOT_LABEL } from "../shared/tasks-dir.js";
import type { ReviewCliArgs } from "./args.js";

/**
 * review 命令的传入参数回显（stderr）。
 *
 * 目的：一次检视**开跑前**，让人/日志能直接看到**这次到底收到了什么参数**——
 * 相对路径已按 cwd 解析成绝对路径，缺省值（model / config / issue / tasks 根）
 * 已落成生效值并标注来源。stdout 是单 JSON 文档契约，故这一路只走 stderr。
 * 打印点（ADR-0043）：runReview 之前、进度投影之前——提前报参数，失败也能看到输入面。
 *
 * 纪律：
 * - 只回显**参数面**，不含 apiKey / baseUrl 等配置秘密；
 * - `--issue` 用 `JSON.stringify` 转义，保证多行文本不会把一条参数拆成多行；
 * - 可重复旗标（`--rule-skill-zip` / `--rule-skill` / `--skill`）按传入顺序全列；逗号列表
 *   （`a.zip,b.zip`）已在解析期展开成列表，回显与重复旗标同形（ADR-0034）。
 */

/** 调用方解析好的路径与生效值（main.ts 持有，本模块零文件系统） */
export interface ReviewArgsEcho {
  /** `--repo` 解析后的绝对路径 */
  readonly repoPath: string;
  /** `--mr-diff` / `--mr-json` 解析后的绝对路径 */
  readonly mrPath: string;
  /** 本次任务 id（产物落 `<tasksRoot>/<taskId>/`，ADR-0033） */
  readonly taskId: string;
  /** tasks 根目录解析后的绝对路径（`--tasks-dir` 或 `~/.PiAgent/tasks`） */
  readonly tasksRoot: string;
  /** `--tasks-dir` 是否显式传入 */
  readonly tasksDirFromFlag: boolean;
  /** 生效配置文件路径（显式 `--config` 或用户级缺省） */
  readonly configPath: string;
  /** 生效评审模型 id（恒为配置 `model.default`，已按 stripModelPrefix 剥前缀） */
  readonly modelId: string;
  /**
   * 传过的 `--model`（ADR-0093 阶段 1：已废弃并忽略）。缺席 = 未传；
   * `raw` = 首个非空传入值（裸旗标 / 空值缺席）。
   */
  readonly ignoredModel?: { readonly raw?: string };
  /** `--config` 是否显式传入 */
  readonly configFromFlag: boolean;
  /** 本次进度事件行是否实际开启（缺省打印；`--no-progress` → false） */
  readonly progressOn: boolean;
}

/** 参数名列宽（最长的 `--strict-rule-skill` 也能对齐） */
const FLAG_WIDTH = 20;

function row(label: string, value: string): string {
  return `  ${label.padEnd(FLAG_WIDTH)}${value}`;
}

function listOf(values: readonly string[] | undefined): string {
  return values === undefined || values.length === 0 ? "(未传)" : values.join(", ");
}

/** 范围正则的列表回显：缺席与「显式传空」必须可区分（ADR-0078） */
function regexListOf(values: readonly string[] | undefined, clearedLabel: string): string {
  if (values === undefined) {
    return "(未传)";
  }
  if (values.length === 0) {
    return clearedLabel;
  }
  return values.join(", ");
}

/** 多行回显（不含尾换行；调用方决定写入 stderr） */
export function formatReviewArgs(args: ReviewCliArgs, echo: ReviewArgsEcho): string {
  const ignoredModelValue =
    echo.ignoredModel === undefined
      ? "(未传)"
      : `${echo.ignoredModel.raw !== undefined ? echo.ignoredModel.raw : "（未带值）"}（已废弃，已忽略）`;
  const configSuffix = echo.configFromFlag ? "" : "（缺省用户级路径）";
  const tasksDirSuffix = echo.tasksDirFromFlag ? "" : `（缺省：${DEFAULT_TASKS_ROOT_LABEL}）`;
  const progressSuffix = echo.progressOn ? "（缺省打印）" : "";
  return [
    "review-pi: 本次 review 传入参数",
    row("--repo", echo.repoPath),
    row(args.mrFormat === "json" ? "--mr-json" : "--mr-diff", echo.mrPath),
    row("caseId", args.caseId),
    row("--issue", args.issue === "" ? "(未传)" : JSON.stringify(args.issue)),
    row("--taskId", echo.taskId),
    row("--tasks-dir", `${echo.tasksRoot}${tasksDirSuffix}`),
    row("--model", ignoredModelValue),
    row("model.default", `${echo.modelId}（生效值）`),
    row("--config", `${echo.configPath}${configSuffix}`),
    row("--rule-skill-zip", listOf(args.ruleSkillZips)),
    row("--rule-skill", listOf(args.ruleSkillDirs)),
    row("--skill", listOf(args.skillDirs)),
    row("--include", regexListOf(args.includePatterns, "(空：本次清空 include)")),
    row("--exclude", regexListOf(args.excludePatterns, "(空：本次清空 exclude)")),
    row("--strict-rule-skill", args.strictRuleSkill === true ? "已启用" : "未启用"),
    row("--no-progress", echo.progressOn ? `未启用${progressSuffix}` : "已启用（进度事件行静默）"),
  ].join("\n");
}
