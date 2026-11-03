import { DEFAULT_TASKS_ROOT_LABEL } from "../shared/tasks-dir.js";
import type { ReviewCliArgs } from "./args.js";

/**
 * review 命令的传入参数回显（stderr）。
 *
 * 目的：一次检视跑完后，让人/日志能直接看到**这次到底收到了什么参数**——
 * 相对路径已按 cwd 解析成绝对路径，缺省值（model / config / issue / tasks 根）
 * 已落成生效值并标注来源。stdout 是单 JSON 文档契约，故这一路只走 stderr。
 *
 * 纪律：
 * - 只回显**参数面**，不含 apiKey / baseUrl 等配置秘密；
 * - `--issue` 用 `JSON.stringify` 转义，保证多行文本不会把一条参数拆成多行；
 * - 可重复旗标（`--rule-skill-zip` / `--rule-skill`）按传入顺序全列；逗号列表
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
  /** 生效评审模型 id（显式 `--model` 或配置 `model.default`） */
  readonly modelId: string;
  /** `--model` 是否显式传入 */
  readonly modelFromFlag: boolean;
  /** `--config` 是否显式传入 */
  readonly configFromFlag: boolean;
  /** 本次进度事件行是否实际开启（`--progress` / `--no-progress` / TTY 自动） */
  readonly progressOn: boolean;
  /** `--progress` / `--no-progress` 是否显式传入 */
  readonly progressExplicit: boolean;
  /** stderr 是否 TTY（仅用于「自动」来源说明） */
  readonly stderrIsTty: boolean;
}

/** 参数名列宽（最长的 `--strict-rule-skill` 也能对齐） */
const FLAG_WIDTH = 20;

function row(label: string, value: string): string {
  return `  ${label.padEnd(FLAG_WIDTH)}${value}`;
}

function listOf(values: readonly string[] | undefined): string {
  return values === undefined || values.length === 0 ? "(未传)" : values.join(", ");
}

/** 多行回显（不含尾换行；调用方决定写入 stderr） */
export function formatReviewArgs(args: ReviewCliArgs, echo: ReviewArgsEcho): string {
  const modelSuffix = echo.modelFromFlag ? "" : "（缺省：配置文件 model.default）";
  const configSuffix = echo.configFromFlag ? "" : "（缺省用户级路径）";
  const tasksDirSuffix = echo.tasksDirFromFlag ? "" : `（缺省：${DEFAULT_TASKS_ROOT_LABEL}）`;
  const progressSuffix = echo.progressExplicit
    ? ""
    : `（缺省自动：stderr ${echo.stderrIsTty ? "是" : "非"} TTY）`;
  return [
    "review-pi: 本次 review 传入参数",
    row("--repo", echo.repoPath),
    row(args.mrFormat === "json" ? "--mr-json" : "--mr-diff", echo.mrPath),
    row("caseId", args.caseId),
    row("--issue", args.issue === "" ? "(未传)" : JSON.stringify(args.issue)),
    row("--taskId", echo.taskId),
    row("--tasks-dir", `${echo.tasksRoot}${tasksDirSuffix}`),
    row("--model", `${echo.modelId}${modelSuffix}`),
    row("--config", `${echo.configPath}${configSuffix}`),
    row("--rule-skill-zip", listOf(args.ruleSkillZips)),
    row("--rule-skill", listOf(args.ruleSkillDirs)),
    row("--strict-rule-skill", args.strictRuleSkill === true ? "已启用" : "未启用"),
    row("--progress", `${echo.progressOn ? "开" : "关"}${progressSuffix}`),
  ].join("\n");
}
