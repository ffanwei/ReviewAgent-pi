import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import path from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import { applyLineBudget, DEFAULT_TOOL_RESULT_BUDGET_CHARS } from "./result-budget.js";

/**
 * skill 会话专用 bash 工具（ADR-0014 决策 6/7）。
 *
 * 边界（核内常量，**不接受 pack 声明**——被检视项目自带内容不得扩大安全边界）：
 * - 只允许 `python` / `python3` 作为 argv[0]（白名单常量）；
 * - 子进程 env 只保留白名单键（不透传宿主全量环境）；
 * - `cwd` 恒为 pack 根（SKILL.md 用相对路径）；跨目录时调用方在 argv 里自行
 *   透传绝对路径，不做解析改写；
 * - 绝不经过 shell：命令串先按引号规则切成 argv，**引号外**出现
 *   `& | ; < > $ \`` 或换行才拒绝；引号内一律按字面透传——`python -c
 *   "import os; print(os.getcwd())"` 里的 `;` 是 Python 语句分隔符，不是
 *   shell 语法（`shell: false` 下参数不经任何解释器）。引号与反斜杠按字面
 *   保留（Windows 绝对路径需要反斜杠）。
 *
 * 资源上限：单条命令 120s；输出走既有结果预算层（`applyLineBudget`）。
 * 白名单拒绝**不是**失败（返回正常工具文本，skill 会话照常进行）。
 */

/** 工具名（skill 会话的第八只工具；不进 A–E 测量档工具面） */
export const SKILL_BASH_TOOL_NAME = "bash";

/** 单条命令超时（毫秒） */
export const SKILL_BASH_TIMEOUT_MS = 2 * 60_000;

/** 允许的解释器（常量白名单；不接受 pack 声明） */
export const SKILL_BASH_ALLOWED_COMMANDS = ["python", "python3"] as const;

/**
 * 子进程环境白名单。解释器定位需要 PATH / PATHEXT；Windows 上 SYSTEMROOT
 * 与 TEMP 是运行时必需；其余只保留与输出编码、家目录相关的最小集合。
 */
export const SKILL_BASH_ENV_ALLOWLIST = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "SYSTEMDRIVE",
  "WINDIR",
  "TEMP",
  "TMP",
  "HOME",
  "USERPROFILE",
  "LANG",
  "LC_ALL",
  "PYTHONIOENCODING",
  "PYTHONUTF8",
] as const;

/** 输出原始字符上限（预算层之前的第一道闸；防止无界缓冲） */
export const SKILL_BASH_MAX_OUTPUT_CHARS = 256_000;

/** 引号**外**的 shell 元字符（出现即拒绝；引号内按字面透传，不做任何解释） */
const SHELL_METACHARACTERS = /[&|;<>$`\r\n]/;

/** NUL 进不了 argv（spawn 会拒绝），引号内外都不接受 */
const NUL_CHARACTER = "\0";

/**
 * 找出**引号外**的 shell 元字符，返回命中的字符（无命中返回 `undefined`）。
 *
 * 引号内不检查：`python -c "import os; print(os.getcwd())"` 的分号属于
 * Python 语法，本工具 `shell: false`、参数原样交给子进程，没有可被 shell
 * 解释的路径；按字面拒绝会让「一行 Python」这种正当用法不可用。
 * 引号规则与 `splitSkillCommand` 一致（同类引号闭合、反斜杠不转义）。
 */
export function findUnquotedShellMetacharacter(command: string): string | undefined {
  let quote: '"' | "'" | undefined;
  for (const char of command) {
    if (char === NUL_CHARACTER) {
      return NUL_CHARACTER;
    }
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (SHELL_METACHARACTERS.test(char)) {
      return char;
    }
  }
  return undefined;
}

/** 禁止执行时的结果文本前缀（与工具错误前缀 "Error: " 对齐，便于模型理解） */
const REJECTION_PREFIX = "Error: ";

export interface SkillBashOptions {
  /** pack 根（子进程 cwd） */
  readonly packRoot: string;
  /** 单条命令超时（缺省 SKILL_BASH_TIMEOUT_MS） */
  readonly timeoutMs?: number;
  /** 结果字符预算（缺省 DEFAULT_TOOL_RESULT_BUDGET_CHARS） */
  readonly resultBudgetChars?: number;
  /** 环境来源（缺省 process.env；测试注入） */
  readonly env?: NodeJS.ProcessEnv;
  /** 子进程执行缝（缺省真实 spawn；单测注入 canned 结果） */
  readonly runner?: SkillBashRunner;
}

/** 子进程执行缝的输入（cwd / env / argv 已由本模块裁定） */
export interface SkillBashProcessOptions {
  readonly cwd: string;
  readonly env: Record<string, string>;
  readonly timeoutMs: number;
}

export interface SkillBashProcessOutcome {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number;
  readonly timedOut: boolean;
}

export type SkillBashRunner = (
  command: string,
  args: readonly string[],
  options: SkillBashProcessOptions,
) => Promise<SkillBashProcessOutcome>;

/** 把命令串切成 argv：单/双引号分组，反斜杠字面保留，不解释变量与通配符 */
export function splitSkillCommand(command: string): readonly string[] {
  const tokens: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let started = false;
  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  if (quote !== undefined) {
    throw new Error(`unterminated ${quote} quote in command`);
  }
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/** 白名单里是否含该解释器（比较 stem：允许带 .exe 后缀的调用） */
function isAllowedCommand(argv0: string): boolean {
  const stem = argv0.replace(/\.exe$/i, "").toLowerCase();
  return (SKILL_BASH_ALLOWED_COMMANDS as readonly string[]).includes(stem);
}

/**
 * 解析白名单解释器的**绝对路径**：只搜 `env.PATH` 里的绝对目录，绝不搜 cwd。
 *
 * 为什么必须显式解析（ADR-0014 决策 7「白名单不接受 pack 声明」）：Windows 的
 * CreateProcess 在给定裸名时会先搜调用方的当前目录，POSIX 的 execvp 也接受
 * PATH 里的相对条目——两者都可能让一个不在 PATH 上的可执行文件顶替 `python`。
 * 这里把「哪个 python」的裁定权收进核内：裸名 + 绝对 PATH 目录 + `.exe`
 * （Windows）/ 可执行文件（POSIX），解释器脚本（`.cmd`/`.bat`）不认——那等于
 * 重新打开一个 shell。
 */
export function resolveAllowedInterpreter(
  command: string,
  env: Record<string, string>,
  platform: NodeJS.Platform = process.platform,
): string | undefined {
  if (!isAllowedCommand(command)) {
    return undefined;
  }
  // 只接受裸名（`python` / `python.exe`）：带目录的 argv[0] 会绕过 PATH 裁定
  if (command !== path.basename(command)) {
    return undefined;
  }
  const stem = command.replace(/\.exe$/i, "");
  const separator = platform === "win32" ? ";" : ":";
  const suffixes = platform === "win32" ? [".exe", ""] : [""];
  const dirs = (env.PATH ?? "").split(separator).filter((dir) => path.isAbsolute(dir));
  for (const dir of dirs) {
    for (const suffix of suffixes) {
      const candidate = path.join(dir, `${stem}${suffix}`);
      if (isRegularFile(candidate)) {
        return candidate;
      }
    }
  }
  return undefined;
}

function isRegularFile(target: string): boolean {
  try {
    return statSync(target).isFile();
  } catch {
    return false;
  }
}

/** 白名单 env 投影（值缺失则缺席；显式钉 UTF-8 输出） */
function allowlistedEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of SKILL_BASH_ENV_ALLOWLIST) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  env.PYTHONIOENCODING = "utf-8";
  return env;
}

/** 输出按行拆分（保留空行——行号对账需要确定性） */
function toLines(text: string): readonly string[] {
  if (text.length === 0) {
    return [];
  }
  const normalized = text.replace(/\r\n/g, "\n");
  const lines = normalized.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines;
}

function budgetNotice(shown: number, total: number, budgetChars: number): string {
  return `... output truncated: ${shown}/${total} lines shown (budget ${budgetChars} chars)`;
}

/**
 * 执行一条 skill 命令。返回工具结果文本（永不 reject——拒绝/超时/非零退出
 * 都成为有界的工具文本，便于模型自我纠正，也避免把「白名单拒绝」记成失败）。
 */
export async function runSkillBashCommand(
  command: string,
  options: SkillBashOptions,
): Promise<string> {
  if (findUnquotedShellMetacharacter(command) !== undefined) {
    return `${REJECTION_PREFIX}shell metacharacters are not allowed in skill bash commands`;
  }
  let argv: readonly string[];
  try {
    argv = splitSkillCommand(command);
  } catch (error) {
    return `${REJECTION_PREFIX}${error instanceof Error ? error.message : String(error)}`;
  }
  const argv0 = argv[0];
  if (argv0 === undefined) {
    return `${REJECTION_PREFIX}empty command`;
  }
  if (!isAllowedCommand(argv0)) {
    return (
      `${REJECTION_PREFIX}command not allowed: "${argv0}" ` +
      `(allowed: ${SKILL_BASH_ALLOWED_COMMANDS.join(", ")})`
    );
  }

  const budgetChars = options.resultBudgetChars ?? DEFAULT_TOOL_RESULT_BUDGET_CHARS;
  const timeoutMs = options.timeoutMs ?? SKILL_BASH_TIMEOUT_MS;
  const outcome = await (options.runner ?? spawnCapture)(argv0, argv.slice(1), {
    cwd: options.packRoot,
    env: allowlistedEnv(options.env ?? process.env),
    timeoutMs,
  });

  const lines: string[] = [...toLines(outcome.stdout)];
  const stderrLines = toLines(outcome.stderr);
  if (stderrLines.length > 0) {
    lines.push("[stderr]");
    lines.push(...stderrLines);
  }
  if (outcome.timedOut) {
    lines.push(`[timed out after ${timeoutMs} ms]`);
  } else if (outcome.exitCode !== 0) {
    lines.push(`[exit code ${String(outcome.exitCode)}]`);
  }
  if (lines.length === 0) {
    return "(no output)";
  }
  const budgeted = applyLineBudget(lines, budgetChars, (shown, total) =>
    budgetNotice(shown, total, budgetChars),
  );
  return budgeted.lines.join("\n");
}

/** 构造 skill 会话的 bash AgentTool（name 直达 wire function.name） */
export function buildSkillBashTool(options: SkillBashOptions): AgentTool {
  return {
    name: SKILL_BASH_TOOL_NAME,
    label: SKILL_BASH_TOOL_NAME,
    description:
      "Run a read-only Python helper script from this rule pack. Only `python`/`python3` may be invoked; " +
      "the working directory is the pack root, so SKILL.md paths are relative. No shell features " +
      "(pipes, redirection, chaining, substitutions) are available. 120s timeout.",
    parameters: {
      type: "object",
      properties: {
        command: {
          type: "string",
          description: 'Full command line, e.g. "python scripts/filter_rules.py --keyword null".',
        },
      },
      required: ["command"],
      additionalProperties: false,
    } as Record<string, unknown>,
    execute: async (_toolCallId, params) => {
      const args = params as { command?: unknown };
      const command = typeof args.command === "string" ? args.command : "";
      const text = await runSkillBashCommand(command, options);
      return { content: [{ type: "text", text }], details: {} };
    },
  };
}

function spawnCapture(
  command: string,
  args: readonly string[],
  options: SkillBashProcessOptions,
): Promise<SkillBashProcessOutcome> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    // 第三道防线之上再加一层：解释器路径由核内 PATH 裁定（不交给 spawn 的
    // 平台搜索顺序），见 resolveAllowedInterpreter 的注释。
    const executable = resolveAllowedInterpreter(command, options.env);
    if (executable === undefined) {
      resolve({
        stdout: "",
        stderr: `interpreter not found on PATH: ${command}`,
        exitCode: -1,
        timedOut: false,
      });
      return;
    }

    let child: ReturnType<typeof spawn>;
    try {
      // shell: false（默认）——白名单 + 元字符拒绝之外的第三道防线
      child = spawn(executable, [...args], {
        cwd: options.cwd,
        env: options.env,
        shell: false,
        windowsHide: true,
      });
    } catch (error) {
      resolve({
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        exitCode: -1,
        timedOut: false,
      });
      return;
    }

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, options.timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk: string) => {
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({
        stdout,
        stderr: appendBounded(stderr, error.message),
        exitCode: -1,
        timedOut,
      });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code ?? -1, timedOut });
    });
  });
}

function appendBounded(current: string, chunk: string): string {
  if (current.length >= SKILL_BASH_MAX_OUTPUT_CHARS) {
    return current;
  }
  const room = SKILL_BASH_MAX_OUTPUT_CHARS - current.length;
  return current + (chunk.length <= room ? chunk : chunk.slice(0, room));
}
