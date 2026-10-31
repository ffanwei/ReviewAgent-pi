/**
 * #7 review-pi CLI wrapper 主缝（进程内）：子命令分发 + 参数透传 + 结果
 * 呈现 only。本文件是胶水：解析（args.ts，已测）→ 凭据文件装载
 * （shared/env-local，已测）→ 命令执行 → stdout/stderr 呈现 → 退出码。
 * 检视行为本体全部留在内核（runReview / P1b 双探针）。
 *
 * 命令面：
 * - review：凭据 fail fast（resolveReviewerEndpoint 构造期）→ 单形态检视
 *   （规则 Skill；无规则包照跑并在 stderr 提示）→ 审计/记录落盘（--out）→
 *   呈现投影（ADR-0010：REVIEW_PI_PRESENTATION_ENGINE 注入引擎时 stdout
 *   呈现档译中文，失败降级英文源；未配置恒等直通）→ stdout 单 JSON 文档
 *   （render.ts，已测）；
 * - smoke：双探针（网关健康 + 模型可达，gateway-probe.ts 已测）→ stdout
 *   人话报告。
 *
 * 退出码契约（票面三态）：成功（含诚实截断——防御性失败不是运行失败）0 /
 * 其余中止或错误 1；截断信号由 stdout JSON 的 truncated=true 携带。
 * smoke 按诊断结论给码（通过 0 / 任何失败诊断 1）。退出一律走 exitGracefully
 * （exitCode + 自然排干）：
 * 立即 process.exit 在 Windows 上与 undici/AbortSignal 句柄清理竞态，
 * 退出码被吞成 0xC0000409。
 *
 * stdout 纪律：review 的 stdout 契约是单个 JSON 文档——
 * 凭据文件摘要与一切诊断走 stderr。凭据经 REVIEWER_*（> 旧
 * DEEPSEEK_* 别名）环境变量或凭据文件（缺省 = 进程 cwd 的 `.env.local`；
 * `--env <file>` 可显式指定，ADR-0019；已有环境变量优先），key 绝不回显。
 *
 * 进程调用形态：review-pi review --repo <path> --mr <diff-file>
 *   [--issue <text>] [--out <dir>] [--model <id>] [--env <file>]
 *   [--rule-skill-zip <path>]... [--rule-skill <dir>]...
 *   [--rule-skill-name <name>] [--strict-rule-skill]
 *   [--progress | --no-progress]
 *   review-pi smoke [--model <id>]
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { calculateCost } from "@earendil-works/pi-ai";

import type { LlmUsage } from "../contracts/llm.js";
import { formatSmokeDiagnostics, runSmokeProbes } from "../provider/gateway-probe.js";
import { reviewModelOf } from "../provider/pi-client.js";
import { resolveReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { llmUsageToPiUsage } from "../provider/usage-map.js";
import { runReview } from "../run/review-run.js";
import { formatEnvLocalSummary, loadEnvLocalFile } from "../shared/env-local.js";
import { CLI_EXPERIMENT_ID, parseCliArgs, USAGE_TEXT, type ReviewCliArgs, type SmokeCliArgs } from "./args.js";
import {
  applyPresentationProjection,
  isPresentationProjectionConfigured,
  type ReviewTipsDocumentLike,
} from "./presentation-projection.js";
import {
  createProgressRenderer,
  type ProgressFinishInput,
  type ProgressRenderer,
} from "./progress-render.js";
import { renderReviewOutcome } from "./render.js";
import {
  removeExecDirTipsCopies,
  removeStaleReviewsTipsZh,
  writeExecDirTipsCopies,
  writeReviewsTipsZh,
  type ExecDirTipsOutcome,
} from "./reviews-tips-zh.js";
import { removeStaleReviewsZh } from "./reviews-zh.js";

/** 执行一次 review 命令；返回进程退出码（完成 0——截断同为 0；错误经异常上抛 → 1） */
async function runReviewCommand(args: ReviewCliArgs): Promise<number> {
  // 凭据前置先检（fail fast 早于文件系统触碰；key 缺失抛人话错误）
  const endpoint = resolveReviewerEndpoint();

  const repoPath = resolve(args.repo);
  if (!(await stat(repoPath)).isDirectory()) {
    throw new Error(`--repo is not a directory: ${repoPath}`);
  }
  const diff = await readFile(resolve(args.mr), "utf8");
  const runsRoot = resolve(args.out);

  // 运行进度投影（ADR-0016）：stderr 是 TTY 时缺省开（人手敲看得见），重定向
  // 收日志时缺省关；--progress / --no-progress 覆盖。缺省关时零输出、零行为变化。
  const progress = startProgress(args);
  const startedAt = Date.now();
  let reviewed: Awaited<ReturnType<typeof runReview>>;
  try {
    reviewed = await runReview({
      caseId: args.caseId,
      repoPath,
      diff,
      issueDescription: args.issue,
      apiKey: endpoint.apiKey,
      baseUrl: endpoint.baseUrl,
      modelId: args.model,
      fetch: globalThis.fetch,
      runsRoot,
      experimentId: CLI_EXPERIMENT_ID,
      rep: 1,
      ...(args.ruleSkillZips !== undefined ? { ruleSkillZips: args.ruleSkillZips } : {}),
      ...(args.ruleSkillDirs !== undefined ? { ruleSkillDirs: args.ruleSkillDirs } : {}),
      ...(args.ruleSkillName !== undefined ? { ruleSkillName: args.ruleSkillName } : {}),
      ...(args.strictRuleSkill !== undefined ? { strictRuleSkill: args.strictRuleSkill } : {}),
      ...(progress !== undefined ? { onProgress: progress.onEvent } : {}),
    });
  } catch (error) {
    // 异常路径也要擦掉状态行：残影会把错误消息顶成半行
    progress?.dispose();
    throw error;
  }
  const { record, runId, auditPath, reviewsPath } = reviewed;
  // 无规则包 = 合法降级（ADR-0024）：照常检视，仅 stderr 提示一行
  if ((record.baseline.audit.ruleSkill ?? []).length === 0) {
    process.stderr.write(
      "review-pi: 未装载任何规则包（--rule-skill-zip / --rule-skill / <repo>/.review-rules/*.zip 均未命中），照常检视\n",
    );
  }
  // 收尾摘要先于呈现投影：run 已经结束，之后的数十秒翻译不该再挂「进行中」状态
  progress?.finish(progressFinish(args, endpoint.baseUrl, record.baseline.usage, startedAt));

  // 呈现投影（ADR-0010 消费端接线）：检视产物已落盘落袋，投影只改 stdout
  // 呈现档（title/description 等自然语言字段经注入引擎译中文，结构化字段
  // 直通）。呈现源只含 findings——stdout 呈现面不打印工具摘要（只有计数），
  // resultSummary 不投，省字段数的网关调用（长 description 单字段翻译可达
  // 数十秒）。引擎失败降级英文源——检视产物绝不因呈现层失败丢失，退出码
  // 不受影响；未配置引擎 = 恒等直通（stdout 逐字节同投影缝落地前形态）。
  // 投影可耗时数十秒（逐字段网关翻译，长 description 单字段可达 30s+）：
  // 动手前先给一行 stderr 心跳，免得「检视完成 → 长静默 → stdout」被误读
  // 为挂死。谓词单源 isPresentationProjectionConfigured——与投影缝读同一
  // 环境变量，未配置恒等直通时零输出（现状形态不动）。
  if (isPresentationProjectionConfigured()) {
    process.stderr.write("review-pi: 呈现投影进行中（自然语言字段译中文）……\n");
  }
  // 分组意见的附加输入（ADR-0017）：源码行由 CLI 按 --repo 抽取（引擎保持
  // 零文件系统访问），规则包只给解压目录（真规则 id 白名单由核外建，内核
  // 不解析规则文件）。
  const codeByFinding = await readCodeLines(repoPath, record.baseline.findings);
  const rulePackDirs = rulePackDirsOf(record.baseline.audit, runsRoot);
  const projection = await applyPresentationProjection({
    findings: record.baseline.findings,
    toolCallLog: [],
    // ADR-0021：呈现模型缺省覆盖 = 本次 --model（核外引擎仍可被
    // REVIEW_PI_PRESENTATION_MODEL 显式压过）
    modelId: args.model,
    ...(Object.keys(codeByFinding).length > 0 ? { codeByFinding } : {}),
    ...(rulePackDirs.length > 0 ? { rulePackDirs } : {}),
  });
  const findings =
    projection.kind === "projected" ? projection.findings : record.baseline.findings;
  const presentation =
    projection.kind === "projected"
      ? projection.provenance
      : projection.kind === "degraded"
        ? { language: "en" as const, degraded: true as const }
        : undefined;
  if (projection.kind === "degraded") {
    process.stderr.write(`review-pi: 呈现投影降级为英文源文档（${projection.reason}）\n`);
  }

  // 中文产物只留分组意见（ADR-0022）：`reviews_zh.json` 不再是交付物——投影结果
  // 仍服务 stdout 与 `reviews_tips_zh.json`（同一次投影，不额外调网关）。历史上
  // 产过的 zh 一律视为陈旧并清除，使「磁盘上的中文产物 = 本次 run」成立；只动
  // **本次 run 的 rep-<N>/**，绝不跨 rep。en/session 已在内核落盘（先于本步）。
  if (reviewsPath !== undefined) {
    const removed = await removeStaleReviewsZh(dirname(reviewsPath));
    if (removed !== undefined) {
      process.stderr.write(
        `review-pi: 本次不产 reviews_zh.json（中文产物 = reviews_tips_zh.json），已清除陈旧 ${removed}\n`,
      );
    }
  }

  // 分组式检视意见（ADR-0017 / ADR-0022）：**唯一**中文落盘产物，与 en 同目录、
  // 同生命周期，但**弱耦合**——tips 形状非法/缺席只缺这一份文件（stdout 呈现
  // 照旧，exit 0）。
  if (reviewsPath !== undefined) {
    const tipsDir = dirname(reviewsPath);
    const tips: ReviewTipsDocumentLike | undefined =
      projection.kind === "projected" ? projection.tips : undefined;
    if (tips !== undefined) {
      await writeReviewsTipsZh(tipsDir, tips);
      reportExecDirTips(await writeExecDirTipsCopies(tips, process.cwd()), "写入");
    } else {
      if (projection.kind === "projected" && projection.tipsProblem !== undefined) {
        process.stderr.write(`review-pi: 本次未产分组意见（${projection.tipsProblem}）\n`);
      }
      const removed = await removeStaleReviewsTipsZh(tipsDir);
      if (removed !== undefined) {
        process.stderr.write(`review-pi: 已清除陈旧 ${removed}\n`);
      }
      reportExecDirTips(await removeExecDirTipsCopies(process.cwd()), "清除");
    }
  }

  await writeStdout(
    renderReviewOutcome({
      caseId: record.caseId,
      runId,
      truncated: record.baseline.audit.truncated,
      rounds: record.baseline.rounds,
      toolCalls: record.baseline.toolCalls,
      findings,
      auditPath,
      ...(presentation !== undefined ? { presentation } : {}),
    }),
  );
  // 截断 = 完成的一种（票面退出码契约：0 + truncated=true）
  return 0;
}

/**
 * 执行目录副本的失败留痕（ADR-0017 决策 14）：cwd 属用户目录（可能只读、可能
 * 落在系统目录），写/清失败只警告**不改退出码**——检视本体已成功，一份便捷
 * 副本不配把整次运行判失败。
 */
function reportExecDirTips(outcome: ExecDirTipsOutcome, action: string): void {
  for (const problem of outcome.problems) {
    process.stderr.write(`review-pi: 执行目录副本${action}失败（${problem}）\n`);
  }
}

/**
 * 按 `--repo` + `file:line` 抽源码行（ADR-0017：`code` 的唯一真源）。
 * `Finding.line` = MR 应用后的行号，`--repo` 正是应用后的工作树——两者对齐，
 * 所以取的是原文而不是模型复述。取不到（文件不在仓 / 行号越界 / 读失败）
 * 一律缺席 ⇒ 落盘时为空串，**绝不编**。
 */
async function readCodeLines(
  repoPath: string,
  findings: readonly { readonly id: string; readonly file: string; readonly line: number }[],
): Promise<Record<string, string>> {
  const cache = new Map<string, readonly string[] | undefined>();
  const codeByFinding: Record<string, string> = {};
  for (const finding of findings) {
    if (!cache.has(finding.file)) {
      cache.set(finding.file, await readLinesOf(resolve(repoPath, finding.file)));
    }
    const line = cache.get(finding.file)?.[finding.line - 1];
    if (line !== undefined) {
      codeByFinding[finding.id] = line.trim();
    }
  }
  return codeByFinding;
}

async function readLinesOf(filePath: string): Promise<readonly string[] | undefined> {
  try {
    return (await readFile(filePath, "utf8")).split(/\r?\n/);
  } catch {
    return undefined;
  }
}

/**
 * 本次 run 的规则包解压目录（ADR-0017：核外据此建真规则 id 白名单）。
 * 目录约定单源在 `run/review-run.ts`（`<runsRoot>/<experimentId>/.cache/
 * rule-skills/<digest>/`）；降级包（`degradedReason` 在场）不跑会话，故排除。
 */
function rulePackDirsOf(
  audit: {
    readonly ruleSkill?: readonly {
      readonly name: string;
      readonly digest: string;
      readonly degradedReason?: string;
    }[];
  },
  runsRoot: string,
): readonly string[] {
  const cacheRoot = resolve(runsRoot, CLI_EXPERIMENT_ID, ".cache", "rule-skills");
  const dirs: string[] = [];
  for (const entry of audit.ruleSkill ?? []) {
    if (entry.name === "" || entry.digest === "" || entry.degradedReason !== undefined) {
      continue;
    }
    dirs.push(resolve(cacheRoot, entry.digest));
  }
  return dirs;
}

/** 执行一次 smoke 命令：双探针 → stdout 人话报告；通过 0 / 失败诊断 1 */
async function runSmokeCommand(args: SmokeCliArgs): Promise<number> {
  const endpoint = resolveReviewerEndpoint();
  const probes = await runSmokeProbes({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    modelId: args.model,
    fetch: globalThis.fetch,
  });
  await writeStdout(`${formatSmokeDiagnostics(probes)}\n`);
  return probes.ok ? 0 : 1;
}

/** stdout 整写（flush 后 resolve——退出前保证字节已落地） */
function writeStdout(text: string): Promise<void> {
  return new Promise<void>((flush) => process.stdout.write(text, () => flush()));
}

/**
 * 运行进度投影的开关与构造（ADR-0016）：`--progress` / `--no-progress` 显式覆盖，
 * 缺省跟随 `stderr` 是否 TTY。返回 undefined = 本 run 不显示任何进度（现状形态）。
 */
function startProgress(args: ReviewCliArgs): ProgressRenderer | undefined {
  const isTty = process.stderr.isTTY === true;
  if (!(args.progress ?? isTty)) {
    return undefined;
  }
  process.stderr.write(`review-pi: ${args.caseId} · ${args.model} · progress on\n`);
  const renderer = createProgressRenderer({
    write: (text) => {
      process.stderr.write(text);
    },
    isTty,
  });
  renderer.start();
  return renderer;
}

/**
 * 收尾摘要的数值面：token 取自运行记录（与审计同源），成本用与转录同一份
 * 模型画像 + 同一个 `calculateCost`（不另立公式），耗时由 CLI 自身计时。
 */
function progressFinish(
  args: ReviewCliArgs,
  baseUrl: string,
  usage: LlmUsage,
  startedAt: number,
): ProgressFinishInput {
  const costUsd = calculateCost(reviewModelOf(args.model, baseUrl), llmUsageToPiUsage(usage)).total;
  return {
    durationMs: Date.now() - startedAt,
    usage,
    costUsd,
  };
}

/** 凭据文件装载摘要行（stderr；措辞单源 formatEnvLocalSummary——只报键名与行号，值绝不回显） */
function envLocalSummaryLine(loadedKeysText: string, label = ".env.local"): string {
  return `review-pi: env: ${label} found — ${loadedKeysText}\n`;
}

/** 兜底强退上界（毫秒）：自然排干的正常路径毫秒级完成，此定时器不点火 */
const GRACEFUL_EXIT_FALLBACK_MS = 8_000;

/**
 * 优雅退出：置 exitCode 后等事件循环自然排干再退，而非立刻 process.exit。
 * 为什么：Windows 上立即 process.exit 与 undici socket teardown / 探针
 * AbortSignal 句柄清理竞态——libuv 断言 fail-fast 0xC0000409
 * （`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), src\win\async.c`），
 * 退出码被吞成 3221226505（#7 进程烟测现场：smoke 双探针后立即退出必崩）。
 * 自然排干是因果解：循环空 = 在飞操作全部落定（undici keep-alive socket
 * 与 AbortSignal.timeout 均为 unref 句柄，不保活）。兜底强退定时器 unref：
 * 泄漏句柄时不无限挂起。与 DSH 线 src/process/graceful-exit.ts 同语义
 * （该线 #29 冒烟同断言；本线无协议宿主，无 stdin 停读面）。
 */
function exitGracefully(code: number): void {
  process.exitCode = code;
  setTimeout(() => process.exit(code), GRACEFUL_EXIT_FALLBACK_MS).unref();
}

function main(): void {
  const parsed = parseCliArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`review-pi: ${parsed.message}\n${USAGE_TEXT}\n`, () => exitGracefully(1));
    return;
  }

  // 凭据文件（ADR-0019）：`--env` 指定则**只**读该文件（相对 cwd），否则读进程
  // cwd 的 `.env.local`。用法解析成功后才触碰文件系统；必须在凭据解析前。
  // 读失败（非缺失，如 EACCES/EISDIR）→ 干净人话错误 + exit 1（不留未捕获堆栈）。
  const envFile = parsed.command === "review" ? parsed.args.envFile : undefined;
  const envPath = envFile !== undefined ? resolve(envFile) : resolve(".env.local");
  try {
    const envResult = loadEnvLocalFile(envPath);
    if (envResult.exists) {
      process.stderr.write(
        envLocalSummaryLine(formatEnvLocalSummary(envResult), envFile !== undefined ? envPath : undefined),
      );
    } else if (envFile !== undefined) {
      // 显式指定却缺席 = 路径拼错 / 文件没带上——静默 no-op 会让人以为已注入
      process.stderr.write(
        `review-pi: --env 指定的文件不存在（${envPath}）——本机注入面中止\n`,
        () => exitGracefully(1),
      );
      return;
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const label = envFile !== undefined ? `--env 指定的文件（${envPath}）` : ".env.local";
    process.stderr.write(
      `review-pi: 无法读取 ${label}（${message}）——本机注入面中止\n`,
      () => exitGracefully(1),
    );
    return;
  }

  const command = parsed.command === "smoke" ? runSmokeCommand(parsed.args) : runReviewCommand(parsed.args);
  command.then((code) => exitGracefully(code)).catch(reportErrorAndExit);
}

/** 命令异常 → stderr 人话 + exit 1（不落堆栈：输入/环境错误是预期路径） */
function reportErrorAndExit(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`review-pi: ${message}\n`, () => exitGracefully(1));
}

main();
