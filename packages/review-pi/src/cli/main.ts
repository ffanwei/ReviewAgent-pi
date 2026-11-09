/**
 * #7 review-pi CLI wrapper 主缝（进程内）：子命令分发 + 参数透传 + 结果
 * 呈现 only。本文件是胶水：解析（args.ts，已测）→ **配置装载一次**
 * （shared/config，已测；JSONC 用户级配置文件，ADR-0025）→ 命令执行 →
 * stdout/stderr 呈现 → 退出码。检视行为本体全部留在内核
 * （runReview / P1b 双探针）。
 *
 * 命令面：
 * - review：配置 fail fast（缺 reviewer.apiKey / 坏文件）→ 单形态检视
 *   （规则 Skill；无规则包照跑并在 stderr 提示）→ 审计/记录落盘（--out）→
 *   呈现投影（ADR-0010：presentation.engine 注入引擎时 stdout 呈现档译中文，
 *   失败降级英文源；未配置恒等直通）→ stdout 单 JSON 文档（render.ts，已测）；
 * - smoke：双探针（网关健康 + 模型可达，gateway-probe.ts 已测）→ stdout
 *   人话报告；
 * - config：`init` 写缺省 JSONC / `show` 脱敏打印生效值（config-command.ts）。
 *
 * 退出码契约（票面三态）：成功（含诚实截断——防御性失败不是运行失败）0 /
 * 其余中止或错误 1；截断信号由 stdout JSON 的 truncated=true 携带。
 * smoke 按诊断结论给码（通过 0 / 任何失败诊断 1）。退出一律走 exitGracefully
 * （exitCode + 自然排干）：
 * 立即 process.exit 在 Windows 上与 undici/AbortSignal 句柄清理竞态，
 * 退出码被吞成 0xC0000409。
 *
 * stdout 纪律：review 的 stdout 契约是单个 JSON 文档——配置诊断与一切
 * 告警走 stderr。配置（含秘密）只在启动时读一次进内存，请求期不重读、
 * 不回写 `process.env`；env 层（REVIEWER_* / DEEPSEEK_* / REVIEW_PI_*）
 * 已彻底关闭，key 绝不回显。
 *
 * 进程调用形态：review-pi review --repo <path>
 *   (--mr-diff <diff-file> | --mr-json <files-json>) --taskId <id>
 *   [--issue <text>] [--tasks-dir <dir>] [--model <id>] [--config <path>]
 *   [--rule-skill-zip <path>[,<path>…]]... [--rule-skill <dir>[,<dir>…]]...
 *   [--strict-rule-skill]
 *   [--no-progress]
 *   review-pi smoke [--model <id>] [--config <path>]
 *   review-pi config <init|show> [--config <path>] [--force] [--from-env <file>] [--json]
 */

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { calculateCost } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import type { RunProgressSink } from "../contracts/progress.js";
import type { PhaseRecord } from "../contracts/run.js";
import { runDirPath } from "../experiment/run-record.js";
import { SESSION_INDEX_VERSION, writeSessionIndex } from "../export/session-index.js";
import {
  createMcpReporter,
  normalizeReportFilePath,
  resolveReportConfig,
  resolveTaskToolSettleMs,
  type McpReporter,
} from "../mcp/index.js";
import { PHASE_ORDER } from "../loop/phases.js";
import { formatSmokeDiagnostics, runSmokeProbes } from "../provider/gateway-probe.js";
import { reviewModelOf } from "../provider/pi-client.js";
import { resolveReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { llmUsageToPiUsage } from "../provider/usage-map.js";
import { runReview } from "../run/review-run.js";
import { findingMergeKey } from "../run/findings-merge.js";
import { formatMrFilterNotice } from "../run/mr-input.js";
import { runExportCommand } from "./export-command.js";
import {
  ConfigError,
  configSnapshot,
  homeDirectory,
  loadConfig,
  modelIdForGateway,
  resolvePresentationEnginePath,
  type ResolvedConfig,
} from "../shared/config.js";
import { retryPolicyFor } from "../shared/llm-retry.js";
import { reviewRuntimeOf } from "../shared/review-runtime.js";
import { isSeverityBelow } from "../shared/severity-filter.js";
import { isConfidenceBelow } from "../shared/tips-filter.js";
import { resolveTasksRoot, taskDirPath } from "../shared/tasks-dir.js";
import { REVIEW_PI_VERSION } from "../shared/version.js";
import { mrJsonToUnifiedDiff } from "../zoneb/mr-json.js";
import { parseCliArgs, USAGE_TEXT, type ReviewCliArgs, type SmokeCliArgs } from "./args.js";
import { formatReviewArgs } from "./args-echo.js";
import { runConfigCommand } from "./config-command.js";
import { McpCallLog, writeMcpCallLog } from "./mcp-call-log.js";
import { openRunLog, type RunLog } from "./run-log.js";
import { buildShardReportResilient, type ReportLlmRuntime, type SemanticTipEntry } from "./report-payload.js";
import { buildReviewSummary } from "./review-summary.js";
import {
  assembleUnifiedTips,
  countTips,
  filterTipsDocumentByConfidence,
  filterTipsDocumentBySeverity,
  withUnifiedKeys,
  type UnifiedTipsOutcome,
} from "./unified-tips.js";
import {
  applyPresentationProjection,
  isPresentationProjectionConfigured,
  type ReviewTipsDocumentLike,
} from "./presentation-projection.js";
import {
  createProgressRenderer,
  doneLine,
  stageBreakdownLines,
  type ProgressRenderer,
  type ProgressSummary,
  type StageSpan,
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

/**
 * 本次 review 的运行日志（stderr 镜像 + 未捕获异常堆栈）。
 * 只有 review 命令会打开；config / smoke / export 与打开失败的路径恒为 null。
 */
let activeRunLog: RunLog | null = null;

// 进程退出前恢复 stderr 并关闭日志 fd（写入本就是同步的，这里只做资源回收）。
process.once("exit", () => {
  activeRunLog?.close();
});

/** 审计内的一个阶段分段（收到 `phase` 事件时打点；闭合点 = 下一段或审计结束） */
interface PhaseSpan {
  readonly round: number;
  readonly index: number;
  readonly phase: string;
  readonly start: number;
  readonly shardIndex?: number;
}

/**
 * 进程级阶段账本：只在 CLI 内存里累计，**不落盘、不进审计、不改退出码**。
 * 时间来自 CLI 自身时钟与进度事件；进度关闭（`--no-progress`）时事件仍会
 * 经过 `onProgress`，所以账本照常成立。
 */
interface StageClock {
  readonly commandStartedAt: number;
  runStartedAt?: number;
  auditEndedAt?: number;
  auditMs?: number;
  reportMs: number;
  projectionMs: number;
  tipsMs: number;
  summaryMs: number;
  settleMs: number;
  readonly phaseSpans: PhaseSpan[];
  readonly skillSpans: StageSpan[];
  skillStartedAt: number | undefined;
}

/** 执行一次 review 命令；返回进程退出码（完成 0——截断同为 0；错误经异常上抛 → 1） */
async function runReviewCommand(args: ReviewCliArgs, config: ResolvedConfig): Promise<number> {
  const stageClock: StageClock = {
    // 含 Node 冷启动：uptime 从进程创建算起，比「进入本函数」更接近用户感知的墙钟。
    commandStartedAt: Date.now() - Math.round(process.uptime() * 1000),
    reportMs: 0,
    projectionMs: 0,
    tipsMs: 0,
    summaryMs: 0,
    settleMs: 0,
    phaseSpans: [],
    skillSpans: [],
    skillStartedAt: undefined,
  };
  // 缺值的规则包旗标（B 档：按未传处理，但不静默）：先喊一声再往下走，保证即使
  // 后面因别的错误早退，用户也能看到「规则包根本没装载」这个原因。
  for (const flag of args.emptyRuleSkillFlags ?? []) {
    process.stderr.write(`review-pi: ${flag} 缺少值，已忽略（本轮不装载该包）\n`);
  }
  // 落盘根（ADR-0033）：tasks 根（`--tasks-dir` 或 ~/.PiAgent/tasks）+ 任务 id；
  // 其下仍是 runs/ + audit/ + .cache/（ADR-0032 的目录内形态不变）。
  const tasksRoot = resolveTasksRoot({
    ...(args.tasksDir !== undefined ? { tasksDir: args.tasksDir } : {}),
  });
  const runsRoot = taskDirPath(tasksRoot, args.taskId);
  // 运行日志（与 session 转录同目录）：stderr 全量镜像 + 未捕获异常堆栈，
  // 生产环境拿不到 stderr 时仍可事后排障。旁路：打不开只警告，检视照跑。
  try {
    activeRunLog = openRunLog(runDirPath(runsRoot), { taskId: args.taskId });
  } catch (error) {
    process.stderr.write(
      `review-pi: 运行日志打开失败（${describeReportFailure(error)}），继续检视\n`,
    );
  }
  // 配置前置先检（fail fast 早于文件系统触碰；key 缺失抛人话错误）
  const endpoint = resolveReviewerEndpoint(config);
  // 模型 id → 网关 wire 字段：stripModelPrefix 开启时剥掉最后一个 / 前的所有
  // （pan/deeseek → deeseek）；缺省原样。生效值全面一致——参数回显 / 审计 /
  // wire 记的都是剥后的 id（回显的语义就是「生效值」）；开关本身进审计 config 快照。
  const modelId = modelIdForGateway(
    args.model ?? config.model.default,
    config.reviewer.stripModelPrefix,
  );

  const repoPath = resolve(args.repo);
  if (!(await stat(repoPath)).isDirectory()) {
    throw new Error(`--repo is not a directory: ${repoPath}`);
  }
  const mrPath = resolve(args.mr);

  // 传入参数回显（stderr，ADR-0043）：开跑前先报一遍本次生效参数——相对路径已按
  // cwd 解析，缺省值（model / config / tasks 根 / progress）已落成生效值并标注来源。
  // 打印点必须早于进度投影，否则事件行会把这一块打散；stdout 是单 JSON 文档契约，
  // 故这一路只走 stderr；只碰参数面，不含 apiKey / baseUrl 等秘密。
  process.stderr.write(
    `${formatReviewArgs(args, {
      repoPath,
      mrPath,
      taskId: args.taskId,
      tasksRoot,
      tasksDirFromFlag: args.tasksDir !== undefined,
      configPath: config.path,
      modelId,
      modelFromFlag: args.model !== undefined,
      configFromFlag: args.configPath !== undefined,
      progressOn: args.progress ?? true,
    })}\n`,
  );

  // MCP 上报（ADR-0037 事件面 + ADR-0045 业务面）：建连点在**读 diff 之前**
  // （ADR-0045 决策 2：`startTask` 的价值就是「远端先知道任务存在」，预检失败
  // 也要有始有终）。配置非法 = 装载期已 fail fast；建连 / 握手失败 = 降级
  // （不建 sink，照常检视）。上报是旁路：任何失败都不改变退出码，也不进审计。
  // 业务 tool 调用留痕（mcp.json）：四个业务调用的输入 / 输出 / 时间，与
  // `session-<ts>.json` 转录同目录（`<tasks 根>/<taskId>/runs/`）。旁路：
  // 写盘失败只落 stderr，不改退出码。
  const mcpCallLog = new McpCallLog();
  const reportConfig = resolveReportConfig(config);
  let reporter: McpReporter | null = null;
  if (reportConfig !== null) {
    try {
      reporter = await createMcpReporter({
        config: reportConfig,
        clientVersion: REVIEW_PI_VERSION,
        onTaskCall: (trace) => mcpCallLog.record(trace),
      });
    } catch (error) {
      process.stderr.write(
        `review-pi: MCP 上报不可用（${describeReportFailure(error)}），继续检视\n`,
      );
    }
  }
  const activeReporter = reporter;
  if (activeReporter !== null && activeReporter.handshake === "stateless") {
    process.stderr.write(
      `review-pi: MCP 服务端未接受 initialize，已改为无状态直调（与 Postman 单发同形），继续检视\n`,
    );
  }
  // 业务 tool（ADR-0045；重试口径见 ADR-0050）：旁路（失败只落 stderr 一行，
  // 不改退出码）。
  const taskToolsOn = activeReporter !== null && reportConfig !== null && reportConfig.task;
  // 业务 tool 之间的固定沉降间隔（ADR-0053）：临时措施，不是顺序契约。
  // 仅进程测试用专用 env 压缩为 0（见 docs/待优化维护清单.md）。
  const taskToolSettleMs = resolveTaskToolSettleMs(process.env);
  // `saveReviewSummary` 是否已调用结束：finally 的第二段等待只在总结发完后发生
  // （预检失败 / 检视中途抛错不白等 5 秒）。
  let summaryCallCompleted = false;
  let startTaskSent = false;
  if (taskToolsOn && activeReporter !== null) {
    const outcome = await activeReporter.task.startTask({ taskId: args.taskId });
    if (outcome.ok) {
      startTaskSent = true;
    } else {
      process.stderr.write(
        `review-pi: MCP startTask 失败（${outcome.reason}），继续检视\n`,
      );
    }
  }
  // 片级上报编排（ADR-0045）：每片 findings 定型 → 报文调用 → 逐文件 mrReviewResult。
  // 运行时档与呈现投影同档（model.presentation 优先 + oneShotMs）；重试次数
  // 来自 limits.retry 的 oneShot 路径（ADR-0051）。
  const reportRuntime = {
    apiKey: endpoint.apiKey,
    baseUrl: endpoint.baseUrl,
    modelId: gatewayPresentationModelId(config, modelId),
    timeoutMs: config.limits.timeouts.oneShotMs,
    retry: retryPolicyFor(config.limits.retry, "oneShot"),
  };
  const reportedFiles: string[] = [];
  // 已成功上报的 finding（键 = 合并键；ADR-0057）：只有 `mrReviewResult` 调用
  // 成功、且该条 tip 真的进入报文，才登记。收尾总结据此裁剪口径——平台没收到
  // 的意见不进总结（否则总结与平台明细对不上账）。
  const submittedFindingKeys = new Set<string>();
  // 语义登记的并集（ADR-0045 统一 tips）：键 = 合并键；片间首见优先。
  // 聚合重编号（F001…）后 source/ruleId 无法从 merged finding 重推，必须在片级捕获。
  const semanticByMergeKey = new Map<string, SemanticTipEntry>();
  // 未覆盖原因（ADR-0045 诊断增强）：键 = 合并键；只用于 stderr 逐条留痕，
  // 不改变 tips 形态与退出码。片级 / 逐条失败在 `reportShardFindings` 写入。
  const uncoveredReasonByMergeKey = new Map<string, string>();
  const onShardFindings =
    taskToolsOn && activeReporter !== null
      ? async (
          label: { readonly index: number; readonly total: number },
          findings: readonly Finding[],
          files: readonly string[],
        ) => {
          // 报文生成 + 逐文件上报都在这个回调里；单独计时，便于和审计拆账。
          const startedAt = Date.now();
          try {
            await reportShardFindings({
              label,
              findings,
              files,
              taskId: args.taskId,
              repoPath,
              reporter: activeReporter,
              runtime: reportRuntime,
              reportedFiles,
              submittedFindingKeys,
              semanticByMergeKey,
              uncoveredReasonByMergeKey,
              confidenceMin: config.limits.confidence.min,
              severityMin: config.limits.severity.min,
            });
          } finally {
            stageClock.reportMs += Date.now() - startedAt;
          }
        }
      : undefined;

  try {
    // 输入形态（ADR-0029）：JSON 在装载期补文件头转成统一 diff，之后与 --mr-diff 同一条路径
    const mrText = await readFile(mrPath, "utf8");
    const diff = args.mrFormat === "json" ? mrJsonToUnifiedDiff(mrText, "--mr-json") : mrText;

    // 运行进度投影（ADR-0055，取代 ADR-0016 的 TTY 自动档）：缺省打印事件行；
    // `--no-progress` 显式静音（批跑收日志用）。静音时仍保留收尾摘要一行
    // （stderr，可 grep），不出现阶段/请求/工具事件行。
    const progress = startProgress(args, modelId);
    const onProgress: RunProgressSink = (event) => {
      // 阶段账本打点（收尾打印用）：只读事件与时钟，不改变事件消费顺序。
      if (event.kind === "phase") {
        stageClock.phaseSpans.push({
          round: event.round,
          index: event.index,
          phase: event.phase,
          start: Date.now(),
          ...(event.shard !== undefined ? { shardIndex: event.shard.index } : {}),
        });
      } else if (event.kind === "request" && event.state === "end") {
        // 审计结束点 = 最后一次请求完成；报文生成（one-shot）不发射请求事件，
        // 所以这个点不会被 74s 的报文生成推后。
        stageClock.auditEndedAt = Date.now();
      } else if (event.kind === "skill" && event.state === "start") {
        stageClock.skillStartedAt = Date.now();
      } else if (event.kind === "skill" && event.state === "end") {
        const startedAt = stageClock.skillStartedAt;
        const shardLabel =
          event.shard !== undefined ? `s${String(event.shard.index)}/${String(event.shard.total)} ` : "";
        stageClock.skillSpans.push({
          label: `${event.skill}（${shardLabel}round ${String(event.round)}）`,
          durationMs: startedAt !== undefined ? Date.now() - startedAt : event.durationMs,
        });
        stageClock.skillStartedAt = undefined;
      }
      // 分片（ADR-0039 决策 8）：外层只发一次 run.start；这里报一行片数提示。
      // 单片路径事件不带 shards 键，本行零输出（零字节漂移）。
      if (event.kind === "run" && event.state === "start" && event.shards !== undefined) {
        process.stderr.write(
          `review-pi: 分片检视 ${String(event.shards.total)} 片` +
            `（单片上限 ${String(config.limits.split.maxShardChars)} 字符）\n`,
        );
      }
      progress?.onEvent(event);
      activeReporter?.sink(event);
    };
    const startedAt = Date.now();
    stageClock.runStartedAt = startedAt;
    let reviewed: Awaited<ReturnType<typeof runReview>>;
    try {
      reviewed = await runReview({
        caseId: args.caseId,
        repoPath,
        diff,
        issueDescription: args.issue,
        apiKey: endpoint.apiKey,
        baseUrl: endpoint.baseUrl,
        modelId,
        runtime: reviewRuntimeOf(config),
        config: configSnapshot(config, { home: homeDirectory() }),
        tipsConfidenceMin: config.limits.confidence.min,
        tipsSeverityMin: config.limits.severity.min,
        fetch: globalThis.fetch,
        runsRoot,
        rep: 1,
        ...(args.ruleSkillZips !== undefined ? { ruleSkillZips: args.ruleSkillZips } : {}),
        ...(args.ruleSkillDirs !== undefined ? { ruleSkillDirs: args.ruleSkillDirs } : {}),
        ...(args.strictRuleSkill !== undefined ? { strictRuleSkill: args.strictRuleSkill } : {}),
        onProgress,
        ...(onShardFindings !== undefined ? { onShardFindings } : {}),
      });
    } catch (error) {
      // 异常路径也要擦掉状态行：残影会把错误消息顶成半行
      progress?.dispose();
      stageClock.auditMs = Date.now() - startedAt;
      throw error;
    }
    const { record, runId, auditPath, reviewsPath, transcriptPaths } = reviewed;
    stageClock.auditMs = (stageClock.auditEndedAt ?? Date.now()) - startedAt;
    // 无规则包 = 合法降级（ADR-0024）：照常检视，仅 stderr 提示一行
    if ((record.baseline.audit.ruleSkill ?? []).length === 0) {
      process.stderr.write(
        "review-pi: 未装载任何规则包（--rule-skill-zip / --rule-skill 未传或缺值；ADR-0027 后不再扫描仓库内 .review-rules/），照常检视\n",
      );
    }
    // 输入预过滤（大 diff 第一期）：剔了就必须可见（明细在审计 mrFilter）
    if (reviewed.mrFilter !== undefined) {
      process.stderr.write(`review-pi: ${formatMrFilterNotice(reviewed.mrFilter)}\n`);
    }
    // 收尾摘要先于呈现投影：run 已经结束，之后的数十秒翻译不该再挂「进行中」状态。
    // 摘要与审计同源（usage / 请求 / 工具 / Ledger 命中），所以投影的调用不计入
    // 这一行——否则「耗时」含投影而 token 不含，两个数对不上账。
    const summary = buildSummary({
      modelId,
      baseUrl: endpoint.baseUrl,
      record,
      startedAt,
      ledgerHits: reviewed.ledgerHitCount,
      modelCalls: reviewed.modelCalls,
      skillBashCalls: reviewed.skillBashCalls,
    });
    if (progress !== undefined) {
      progress.finish(summary);
    } else {
      // 进度关闭不是「零输出」：收尾摘要恒定打印（一行，可 grep）
      process.stderr.write(`${doneLine(summary)}\n`);
    }
    // 解析失败可见性（P1）：只在 phaseLog 带 parseFailure 时打印（成功 run 零输出）。
    // 放在收尾摘要之后：进度条（TTY）已擦除，不混行；不改退出码。
    reportPhaseParseFailures(record.baseline.audit.phaseLog);

    // 呈现投影（ADR-0010 消费端接线）：检视产物已落盘落袋，投影只改 stdout
    // 呈现档（title/description 等自然语言字段经注入引擎译中文，结构化字段
    // 直通）。呈现源只含 findings——stdout 呈现面不打印工具摘要（只有计数），
    // resultSummary 不投，省字段数的网关调用（长 description 单字段翻译可达
    // 数十秒）。引擎失败降级英文源——检视产物绝不因呈现层失败丢失，退出码
    // 不受影响；未配置引擎 = 恒等直通（stdout 逐字节同投影缝落地前形态）。
    // 投影可耗时数十秒（逐字段网关翻译，长 description 单字段可达 30s+）：
    // 动手前先给一行 stderr 心跳，免得「检视完成 → 长静默 → stdout」被误读
    // 为挂死。谓词单源 isPresentationProjectionConfigured——与投影缝读同一
    // 配置项，未配置恒等直通时零输出（现状形态不动）。
    //
    // 引擎路径解析 + 装载期校验（ADR-0026）：相对路径按**配置文件所在目录**
    // 解析、`"builtin"` 指制品内引擎（resolvePresentationEnginePath）。模块
    // 不在位 ⇒ 按「未配置引擎」处理（一行 stderr + 本次恒等直通）——否则会
    // 先打印「投影进行中」心跳、再在检视跑完几十秒后降级，等于让人白等。
    const configuredEngine = config.presentation.engine;
    const resolvedEngine = resolvePresentationEnginePath(configuredEngine, config.path);
    const presentationEngine =
      resolvedEngine !== null && existsSync(resolvedEngine) ? resolvedEngine : null;
    if (resolvedEngine !== null && presentationEngine === null) {
      process.stderr.write(
        `review-pi: presentation.engine 指向的模块不存在（${resolvedEngine}），本次按未配置引擎恒等直通\n`,
      );
    }
    if (isPresentationProjectionConfigured(presentationEngine)) {
      process.stderr.write("review-pi: 呈现投影进行中（自然语言字段译中文）……\n");
    }
    // 分组意见的附加输入（ADR-0017）：源码行由 CLI 按 --repo 抽取（引擎保持
    // 零文件系统访问），规则包只给解压目录（真规则 id 白名单由核外建，内核
    // 不解析规则文件）。codeByFinding 同时服务统一 tips（merged findings 键）。
    const tipsAssemblyStartedAt = Date.now();
    const codeByFinding = await readCodeLines(repoPath, record.baseline.findings);
    // 统一 tips 组装（ADR-0045）：先于引擎调用——引擎是否跳过 tips 取决于
    // 统一覆盖面。尽力而为（Q26b）：未覆盖的 finding 缺席 tips 并逐条留痕。
    let unifiedTips: UnifiedTipsOutcome | undefined;
    if (taskToolsOn) {
      unifiedTips = assembleUnifiedTips({
        mergedFindings: record.baseline.findings,
        semanticByMergeKey,
        codeByFinding,
        minConfidence: config.limits.confidence.min,
        minSeverity: config.limits.severity.min,
        uncoveredReasonByMergeKey,
      });
      for (const missed of unifiedTips.uncovered) {
        process.stderr.write(
          `review-pi: 检视意见未获统一生成覆盖（${missed.label}），tips 缺席该条：${missed.reason}\n`,
        );
      }
    }
    // 置信度过滤（ADR-0052）：只作用于中文 tips；英文 findings / stdout 恒全量。
    // 计数口径与审计 `tipsFilter` 一致（过滤前的 merged findings 条数）。
    const minConfidence = config.limits.confidence.min;
    const minSeverity = config.limits.severity.min;
    const droppedByConfidence = record.baseline.findings.filter((finding) =>
      isConfidenceBelow(finding.confidence, minConfidence),
    ).length;
    const droppedBySeverity = record.baseline.findings.filter((finding) =>
      isSeverityBelow(finding.severity, minSeverity),
    ).length;
    const keptAfterFilters = record.baseline.findings.filter(
      (finding) =>
        !isConfidenceBelow(finding.confidence, minConfidence) &&
        !isSeverityBelow(finding.severity, minSeverity),
    ).length;
    const allFindingsFiltered =
      record.baseline.findings.length > 0 && keptAfterFilters === 0;
    // 全灭回落判定（Q24a）：有 findings 但统一 tips 零覆盖 ⇒ 引擎按全量模式
    // 调用（不带 skipTips），其 tips 作回落源；否则业务开启时引擎只做 stdout
    // 呈现档（Q22a：省掉 suggestion 并发生成）。
    // 排除「全部被置信度 / 严重级过滤」：那不是生成失败，引擎同样过滤后无产出，
    // 回落只会白花调用并打出误导性的「全灭」提示。
    const engineTipsFallback =
      taskToolsOn &&
      unifiedTips !== undefined &&
      countTips(unifiedTips.tips) === 0 &&
      record.baseline.findings.length > 0 &&
      !allFindingsFiltered;
    if (engineTipsFallback) {
      process.stderr.write("review-pi: 统一 tips 全灭，呈现引擎按全量模式回落……\n");
    }
    const rulePackDirs = rulePackDirsOf(record.baseline.audit, runsRoot);
    stageClock.tipsMs += Date.now() - tipsAssemblyStartedAt;
    const projectionStartedAt = Date.now();
    const projection = await applyPresentationProjection(
      {
        findings: record.baseline.findings,
        toolCallLog: [],
        ...(Object.keys(codeByFinding).length > 0 ? { codeByFinding } : {}),
        ...(rulePackDirs.length > 0 ? { rulePackDirs } : {}),
        ...(taskToolsOn && !engineTipsFallback ? { skipTips: true } : {}),
        confidenceMin: config.limits.confidence.min,
      },
      {
        enginePath: presentationEngine,
        // ADR-0021：呈现模型缺省跟随本次检视模型；model.presentation 显式压过
        runtime: {
          apiKey: endpoint.apiKey,
          baseUrl: endpoint.baseUrl,
          modelId: gatewayPresentationModelId(config, modelId),
          concurrency: config.limits.concurrency.suggestion,
          requestTimeoutMs: config.limits.timeouts.presentationRequestMs,
          retry: retryPolicyFor(config.limits.retry, "presentation"),
        },
        perFieldTimeoutMs: config.limits.timeouts.presentationRequestMs,
        timeoutBufferMs: config.limits.timeouts.presentationBufferMs,
        suggestionConcurrency: config.limits.concurrency.suggestion,
        retryAttempts: config.limits.retry.presentationAttempts,
      },
    );
    stageClock.projectionMs = Date.now() - projectionStartedAt;
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
    // 部分降级（ADR-0059）：整次投影仍成立，只有个别字段保留英文。留一行
    // stderr 让生产可观测；stdout 的 presentation 键同步携带 degradedFields /
    // degradedReason（机器可读）。
    if (
      projection.kind === "projected" &&
      projection.provenance.degradedFields !== undefined &&
      projection.provenance.degradedFields.length > 0
    ) {
      const fields = projection.provenance.degradedFields;
      const preview = fields.slice(0, 5).join(", ");
      const more = fields.length > 5 ? ` 等 ${String(fields.length)} 个字段` : "";
      const reason =
        projection.provenance.degradedReason !== undefined
          ? `：${projection.provenance.degradedReason}`
          : "";
      process.stderr.write(
        `review-pi: 呈现投影部分降级（${preview}${more} 保留英文）${reason}\n`,
      );
    }

    // tips 选源（ADR-0045 统一 tips）：业务开启 = 统一生成（尽力而为），
    // 全灭才回落引擎（并按 12 键对齐）；业务关闭 = 引擎照旧（逐字节现状）。
    let tipsDoc: ReviewTipsDocumentLike | undefined;
    if (taskToolsOn && unifiedTips !== undefined) {
      if (countTips(unifiedTips.tips) > 0 || record.baseline.findings.length === 0) {
        tipsDoc = unifiedTips.tips;
      } else if (allFindingsFiltered) {
        // 全灭的原因是被置信度 / 严重级过滤，不是生成失败：照产 `[]`，不回落、不报警。
        tipsDoc = [];
      } else if (projection.kind === "projected" && projection.tips !== undefined) {
        tipsDoc = withUnifiedKeys(projection.tips, record.baseline.findings);
        process.stderr.write("review-pi: 分组意见回落呈现引擎（统一生成全灭）\n");
      } else {
        process.stderr.write("review-pi: 统一 tips 全灭且无可回落引擎，本次不产分组意见\n");
      }
    } else {
      tipsDoc = projection.kind === "projected" ? projection.tips : undefined;
    }

    // 兜底过滤（ADR-0052）：统一路径已在组装时过滤，但引擎 / 回落路径由第三方
    // 引擎自产条目，落盘前必须再按同一阈值过一遍（幂等）。
    if (tipsDoc !== undefined) {
      tipsDoc = filterTipsDocumentByConfidence(
        tipsDoc,
        record.baseline.findings,
        minConfidence,
      ).tips;
      tipsDoc = filterTipsDocumentBySeverity(
        tipsDoc,
        record.baseline.findings,
        minSeverity,
      ).tips;
    }

    // 过滤留痕（零静默）：只在真的丢了条数时打一行汇总，避免无谓噪声。
    if (droppedByConfidence > 0) {
      process.stderr.write(
        `review-pi: 置信度过滤丢弃 ${String(droppedByConfidence)} 条检视意见（阈值 ${String(minConfidence)}），仅影响中文 tips\n`,
      );
    }
    if (droppedBySeverity > 0) {
      process.stderr.write(
        `review-pi: 严重级过滤丢弃 ${String(droppedBySeverity)} 条检视意见（阈值 ${minSeverity}），仅影响中文 tips 与 MCP 上报\n`,
      );
    }

    // 中文产物只留分组意见（ADR-0022）：`reviews_zh.json` 不再是交付物——投影结果
    // 仍服务 stdout 与 `reviews_tips_zh.json`（同一次投影，不额外调网关）。历史上
    // 产过的 zh 一律视为陈旧并清除，使「磁盘上的中文产物 = 本次 run」成立；作用域
    // = `<out>/runs/`（ADR-0032：一个 `--out` 即一次 run 的输出目录）。
    // en/session 已在内核落盘（先于本步）。
    //
    // 失败语义（ADR-0045 决策 2 修订）：中文产物是交付物，落盘失败仍是**运行失败**
    // （exit 1）——但不能连累业务上报：检视已跑完，`mrReviewResult` 也发完了，
    // 此时跳过 `saveReviewSummary` 会让平台看到「有始无终」的任务。故这里只**记下**
    // 失败，等总结发完再抛（顺序契约 mrReviewResult → summary → endTask 不变）。
    let tipsPersistFailure: unknown;
    const tipsPersistStartedAt = Date.now();
    try {
      if (reviewsPath !== undefined) {
        const removed = await removeStaleReviewsZh(dirname(reviewsPath));
        if (removed !== undefined) {
          process.stderr.write(
            `review-pi: 本次不产 reviews_zh.json（中文产物 = reviews_tips_zh.json），已清除陈旧 ${removed}\n`,
          );
        }
      }

      // 分组式检视意见（ADR-0017 / ADR-0022 / ADR-0045 统一 tips）：**唯一**中文
      // 落盘产物，与 en 同目录、同生命周期，但**弱耦合**——tips 形状非法/缺席只
      // 缺这一份文件（stdout 呈现照旧，exit 0）。业务开启时来源 = 统一生成
      // （12 键），业务关闭 = 呈现引擎（10 键，逐字节现状）。
      if (reviewsPath !== undefined) {
        const tipsDir = dirname(reviewsPath);
        if (tipsDoc !== undefined) {
          await writeReviewsTipsZh(tipsDir, tipsDoc);
          reportExecDirTips(await writeExecDirTipsCopies(tipsDoc, process.cwd()), "写入");
        } else {
          if (
            !taskToolsOn &&
            projection.kind === "projected" &&
            projection.tipsProblem !== undefined
          ) {
            process.stderr.write(`review-pi: 本次未产分组意见（${projection.tipsProblem}）\n`);
          }
          const removed = await removeStaleReviewsTipsZh(tipsDir);
          if (removed !== undefined) {
            process.stderr.write(`review-pi: 已清除陈旧 ${removed}\n`);
          }
          reportExecDirTips(await removeExecDirTipsCopies(process.cwd()), "清除");
        }
      }
    } catch (error) {
      tipsPersistFailure = error;
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `review-pi: 中文产物落盘失败（${message}）；仍上报检视总结与 endTask，随后以失败退出\n`,
      );
    }
    stageClock.tipsMs += Date.now() - tipsPersistStartedAt;

    // 检视总结上报（ADR-0045 决策 2 / ADR-0057）：中文 tips 落盘之后（发出去的
    // 内容与 `reviews_tips_zh.json` 同源同版本）、session 索引之前（索引失败
    // 不该影响上报时机）。顺序契约：mrReviewResult（片级，已发完）→
    // saveReviewSummary → endTask（finally）。
    //
    // **口径 = 平台最终收到的意见**（ADR-0057）：信源是 `submittedFindingKeys`
    // （每条 `mrReviewResult` 成功后登记），不是本地 findings 全量——片级生成
    // 失败 / 上报失败 / 结构校验跳过 / 置信度过滤的条目平台都没收到，总结里
    // 也不该出现，否则「总结条数」与「平台明细」对不上账。
    if (taskToolsOn && activeReporter !== null) {
      const submittedSourceIds = new Set(
        record.baseline.findings
          .filter((finding) => submittedFindingKeys.has(findingMergeKey(finding)))
          .map((finding) => finding.id),
      );
      // 呈现投影可能换 id（findingLinks 给出映射）；未投影时 id 原样。
      const submittedIds =
        projection.kind === "projected"
          ? new Set(
              projection.provenance.findingLinks
                .filter((link) => submittedSourceIds.has(link.sourceFindingId))
                .map((link) => link.projectedFindingId),
            )
          : submittedSourceIds;
      const summaryFindings = findings.filter((finding) => submittedIds.has(finding.id));
      // tips 侧同口径：统一 tips 的 `id` 是聚合（源）finding id，按源 id 过滤。
      // 归属不到 finding 的引擎自造条目不进总结——平台也没收到过它的报文。
      const summaryTips =
        tipsDoc === undefined
          ? undefined
          : tipsDoc
              .map((file) => ({
                ...file,
                reviewTips: file.reviewTips.filter(
                  (tip) => tip.id !== undefined && submittedSourceIds.has(tip.id),
                ),
              }))
              .filter((file) => file.reviewTips.length > 0);
      const unreported = findings.length - summaryFindings.length;
      if (unreported > 0) {
        process.stderr.write(
          `review-pi: 检视总结只覆盖已上报的 ${String(summaryFindings.length)} 条意见` +
            `（${String(unreported)} 条未上报，未计入）\n`,
        );
      }
      process.stderr.write(
        findings.length === 0
          ? "review-pi: MCP saveReviewSummary 未发现检视意见，发送固定总结（不调用模型）\n"
          : summaryFindings.length === 0
            ? "review-pi: MCP saveReviewSummary 无已上报的检视意见，发送固定总结（不调用模型）\n"
            : "review-pi: MCP saveReviewSummary 生成中（检视总结）……\n",
      );
      const summaryStartedAt = Date.now();
      const summaryReport = await buildReviewSummary({
        ...(summaryTips !== undefined && summaryTips.length > 0 ? { tips: summaryTips } : {}),
        findings: summaryFindings,
        ...(summaryFindings.length === 0 && unreported > 0
          ? { unreportedFindings: unreported }
          : {}),
        ...(reportedFiles.length > 0 ? { reportedFiles: [...reportedFiles] } : {}),
        runtime: reportRuntime,
      });
      stageClock.summaryMs += Date.now() - summaryStartedAt;
      if (summaryReport.degradedReason !== undefined) {
        process.stderr.write(
          `review-pi: 检视总结降级为模板（${summaryReport.degradedReason}）\n`,
        );
      }
      // 第一段沉降（ADR-0053）：最后一条 mrReviewResult 已发完，固定等一段时间
      // 再发总结——服务端异步处理片级结果时，前端回调可能先收到 summary。
      const settleStartedAt = Date.now();
      await waitTaskToolSettle(taskToolSettleMs, "mrReviewResult → saveReviewSummary");
      stageClock.settleMs += Date.now() - settleStartedAt;
      const outcome = await activeReporter.task.saveReviewSummary({
        taskId: args.taskId,
        markdownContent: summaryReport.markdown,
      });
      summaryCallCompleted = true;
      if (!outcome.ok) {
        process.stderr.write(
          `review-pi: MCP saveReviewSummary 失败（${outcome.reason}），检视结果不受影响\n`,
        );
      }
    }

    // 中文产物落盘失败（上一段记下的）：总结与 endTask 都发完了，现在才把这次
    // 运行判失败——产物即契约，失败仍然 exit 1，只是不再吞掉业务上报。
    if (tipsPersistFailure !== undefined) {
      throw tipsPersistFailure;
    }

    // cwd session 索引（ADR-0036）：只记寻址信息，供 `review-pi export` 直接取用。
    // 每次成功 run 整份覆盖；写失败只警告——导出面是便利能力，不配把检视判失败。
    // ADR-0039：分片后一个任务有多份主转录，索引升 v2（`mains[]`）；单遍 = 长度 1。
    const sessionRunsDir = runDirPath(runsRoot);
    const sessionSkills = (record.baseline.audit.skillPassLog ?? [])
      .map((entry) => entry.transcriptFile)
      .filter((file): file is string => typeof file === "string" && file.trim().length > 0)
      // 聚合 skillPassLog 的文件名可能是 runs 目录相对路径（分片：shards/attempt…/sNN/），
      // 旧形态是 basename——resolve 对两者都成立。
      .map((file) => resolve(sessionRunsDir, file));
    try {
      await writeSessionIndex(process.cwd(), {
        version: SESSION_INDEX_VERSION,
        taskId: args.taskId,
        tasksDir: tasksRoot,
        runId,
        repo: repoPath,
        updatedAt: record.completedAt,
        mains: transcriptPaths,
        skills: sessionSkills,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        `review-pi: session 索引写入失败（${message}）；review-pi export 将读不到本次结果\n`,
      );
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
  } finally {
    // 任务生命周期收尾（ADR-0045 决策 2 / Q4）：有始必有终——runReview 抛错、
    // 预检失败、正常收尾都在这里补 endTask（仅在 startTask 成功发出过时），
    // 且**早于 flush**：endTask 是最后一个业务调用，之后远端只应再收到事件流
    // 的收尾批次。旁路：失败只落一行 stderr。
    if (taskToolsOn && startTaskSent && activeReporter !== null) {
      // 第二段沉降（ADR-0053）：总结已发完，再固定等一段时间才发 endTask。
      // 只在真的调过 saveReviewSummary 时等；失败路径（未走到总结）直接收尾。
      if (summaryCallCompleted) {
        const settleStartedAt = Date.now();
        await waitTaskToolSettle(taskToolSettleMs, "saveReviewSummary → endTask");
        stageClock.settleMs += Date.now() - settleStartedAt;
      }
      const outcome = await activeReporter.task.endTask({ taskId: args.taskId });
      if (!outcome.ok) {
        process.stderr.write(`review-pi: MCP endTask 失败（${outcome.reason}）\n`);
      }
    }
    // 业务调用留痕落盘（mcp.json，与 session 转录同目录）：endTask 之后写，
    // 四个调用的最终结果都在内存里。只在业务 tool 开启且确有调用时写；
    // 失败只警告——留痕是排障能力，不配把检视判失败。
    if (taskToolsOn && mcpCallLog.size > 0) {
      try {
        await writeMcpCallLog(runDirPath(runsRoot), mcpCallLog.document(args.taskId));
      } catch (error) {
        process.stderr.write(
          `review-pi: mcp.json 写入失败（${describeReportFailure(error)}），不影响检视结果\n`,
        );
      }
    }
    if (activeReporter !== null && reportConfig !== null && reportConfig.tool !== null) {
      // 收尾尽力发完；失败 / 超时都只落一行 stderr，不影响已产出的结果与退出码
      // （事件通道关闭时队列恒空，这行统计没有信息量，不打印）
      try {
        const stats = await activeReporter.flush(reportConfig.flushTimeoutMs);
        process.stderr.write(
          `review-pi: MCP 上报 sent ${String(stats.sent)} / failed ${String(stats.failed)} / dropped ${String(stats.dropped)}\n`,
        );
      } catch {
        // 旁路：连统计都拿不到也不改变任何结果
      }
    }
    await activeReporter?.close().catch(() => undefined);
    // 阶段账本（最后一行输出）：doneLine 只算到「审计 + 报文」，这里补齐全进程
    // 的账——总结 / 两次沉降 / 落盘 / 事件 flush 都计入总墙钟。仅在进行过
    // runReview 时打印（更早的输入错误没有可解释的阶段结构）。
    if (stageClock.runStartedAt !== undefined) {
      for (const line of stageBreakdownLines(buildStageBreakdown(stageClock, Date.now()))) {
        process.stderr.write(`${line}\n`);
      }
    }
  }
}

/**
 * 业务 tool 之间的固定沉降（ADR-0053）：`ms <= 0`（进程测试）直接返回，
 * 生产路径固定 5 s。这是临时的时间赌注，不是顺序契约；留一行 stderr 让
 * 「这次运行为什么多花了 10 秒」可解释。
 */
async function waitTaskToolSettle(ms: number, boundary: string): Promise<void> {
  if (ms <= 0) {
    return;
  }
  process.stderr.write(`review-pi: MCP 固定等待 ${String(ms)}ms（${boundary}）\n`);
  await delay(ms);
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

/**
 * 片级上报编排（ADR-0045 / ADR-0056 / ADR-0061）：该片 findings 定型 → 读源码行 →
 * 统一生成调用 → 逐文件 `mrReviewResult` + 语义登记入 run 级集合（tips 复用）。
 * **绝不抛错**（旁路纪律的最外层闸）：任何失败只落 stderr，检视与退出码不受影响。
 * 覆盖率优先（ADR-0061）：本片 diff 触及的**每个文件**都必须在
 * `saveReviewSummary` 前拿到一条 `mrReviewResult`——无可发 tips 时发
 * `reviewTips: []`；即使该文件有 finding 但片级报文生成失败，也按空列表上报
 * （宁可少报意见，绝不留「未检视」空洞）。
 */
async function reportShardFindings(input: {
  readonly label: { readonly index: number; readonly total: number };
  readonly findings: readonly Finding[];
  /** 该片 diff 触碰的文件（repo 相对路径）：没有意见的文件也要按文件上报 */
  readonly files: readonly string[];
  readonly taskId: string;
  readonly repoPath: string;
  readonly reporter: McpReporter;
  readonly runtime: ReportLlmRuntime;
  /** 跨片累积已上报文件（收尾总结的 reportedFiles 输入；按片序追加） */
  readonly reportedFiles: string[];
  /**
   * 跨片累积「平台最终收到的意见」（键 = 合并键；ADR-0057）。只在
   * `reportFileResult` 成功、且该条 tip 确实进入报文时登记——收尾总结按此
   * 裁剪口径，与平台明细一致。
   */
  readonly submittedFindingKeys: Set<string>;
  /** 语义登记的 run 级并集（键 = 合并键；首见优先——tips 复用的数据面） */
  readonly semanticByMergeKey: Map<string, SemanticTipEntry>;
  /** 未覆盖原因的 run 级并集（键 = 合并键；首见优先——stderr 逐条留痕用） */
  readonly uncoveredReasonByMergeKey: Map<string, string>;
  /** 中文 tips 置信度过滤阈值（ADR-0052）：先过滤再生成，省掉注定丢弃条目的调用 */
  readonly confidenceMin: number;
  /** 中文 tips / MCP 上报严重级过滤阈值：先过滤再生成 */
  readonly severityMin: Finding["severity"];
}): Promise<void> {
  const label = input.label.total > 1 ? ` [s${pad2(input.label.index)}/${pad2(input.label.total)}]` : "";
  let keptFindings: readonly Finding[] = [];
  // 本片已经尝试过上报的文件（规范化路径）：广播 tips 与空包都按它去重，保证
  // 每个文件只发一条 mrReviewResult（ADR-0061）。
  const attempted = new Set<string>();
  const markUncovered = (findings: readonly Finding[], reason: string): void => {
    for (const finding of findings) {
      const key = findingMergeKey(finding);
      if (!input.uncoveredReasonByMergeKey.has(key)) {
        input.uncoveredReasonByMergeKey.set(key, reason);
      }
    }
  };
  /** 本片剩余文件补空包（ADR-0061）：`attempted` 里的文件已经有过一次上报尝试。 */
  const reportRemainingFiles = async (): Promise<number> =>
    reportFilesWithoutTips({ ...input, label, exclude: attempted, attempted });
  try {
    // ADR-0052：置信度过滤先于报文生成——被丢弃的意见不该花一次模型调用。
    // 严重级过滤同口径（只裁中文 tips / MCP 上报，英文 findings 恒全量）。
    keptFindings = input.findings.filter(
      (finding) =>
        !isConfidenceBelow(finding.confidence, input.confidenceMin) &&
        !isSeverityBelow(finding.severity, input.severityMin),
    );
    if (keptFindings.length === 0) {
      // 零 finding（本来就无）或全部被置信度 / 严重级过滤：本片所有文件都没有可发的
      // 中文意见，按文件逐个上报空 tips（ADR-0056 / ADR-0061）。这两类过滤只
      // 决定「产不产中文意见」，不改变「文件已被检视」这一事实——平台需要每个
      // 文件都有一次登记，否则「检视过、没意见」与「从未检视」在远端无法区分。
      const sent = await reportRemainingFiles();
      if (sent > 0) {
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} 已上报 ${String(sent)} 文件 / 0 条意见\n`,
        );
      } else if (input.files.length === 0) {
        // 零静默：本片拿不到任何文件路径（空 diff / 预过滤后无残留），
        // 没有「已检视」可登记——留一行原因，避免事后误判成调用链断了。
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} 无可上报文件（本片 diff 未解析出文件路径）\n`,
        );
      }
      return;
    }
    const codeByFinding = await readCodeLines(input.repoPath, keptFindings);
    // 片级报文生成：全量一次失败后按条数二分重试（ADR-0058）。正常路径零额外
    // 调用；部分批次成功时照常上报能救回的条目，仍失败的由 uncoveredByKey 留痕。
    const { outcome, split } = await buildShardReportResilient({
      findings: keptFindings,
      codeByFinding,
      runtime: input.runtime,
    });
    if (split !== undefined) {
      process.stderr.write(
        `review-pi: MCP mrReviewResult${label} 报文生成失败，已拆分为 ` +
          `${String(split.batches)} 批重试（${String(split.succeeded)} 批成功）\n`,
      );
    }
    if (outcome.kind === "failed") {
      process.stderr.write(
        `review-pi: MCP mrReviewResult${label} 报文生成失败（${outcome.reason}），` +
          "有意见文件改报空列表（覆盖率优先，ADR-0061）\n",
      );
      markUncovered(keptFindings, `片级语义生成失败：${outcome.reason}`);
      // 覆盖率优先（ADR-0061）：整片生成失败时，本片所有文件仍各发一条
      // `reviewTips: []`。平台宁可看到「无意见」也不能把文件当成「未检视」；
      // 真实失败原因保留在 stderr 与未覆盖登记里。
      const sent = await reportRemainingFiles();
      if (sent > 0) {
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} 已上报 ${String(sent)} 文件 / 0 条意见（报文生成失败，全部补空）\n`,
        );
      }
      return;
    }
    // 语义登记并入 run 级集合（首见优先：跨片同合并键 = 同一问题的重复条目）
    for (const [key, entry] of outcome.semanticByKey) {
      if (!input.semanticByMergeKey.has(key)) {
        input.semanticByMergeKey.set(key, entry);
      }
    }
    // 逐条被拒的具体原因（模型没给条目 / category 不可归一）——与 uncovered 逐条对齐
    for (const [key, reason] of outcome.uncoveredByKey) {
      if (!input.uncoveredReasonByMergeKey.has(key)) {
        input.uncoveredReasonByMergeKey.set(key, reason);
      }
    }
    for (const problem of outcome.skippedFiles) {
      process.stderr.write(`review-pi: MCP mrReviewResult${label} 跳过文件组（${problem}）\n`);
    }
    for (const problem of outcome.skippedTips) {
      process.stderr.write(`review-pi: MCP mrReviewResult${label} 跳过单条意见（${problem}）\n`);
    }
    for (const problem of outcome.degradedTips) {
      process.stderr.write(`review-pi: MCP mrReviewResult${label} 意见字段降级（${problem}）\n`);
    }
    let sent = 0;
    let tips = 0;
    for (const file of outcome.files) {
      const normalized = normalizeReportFilePath(file.filePath);
      if (normalized !== null) {
        attempted.add(normalized);
      }
      const result = await input.reporter.task.reportFileResult({
        taskId: input.taskId,
        filePath: file.filePath,
        reviewTips: file.reviewTips,
      });
      if (result.ok) {
        sent += 1;
        tips += file.reviewTips.length;
        input.reportedFiles.push(file.filePath);
        // 只有真的发出去的意见才进入「已上报集合」（ADR-0057）：上报失败 /
        // 结构校验跳过的条目不登记，收尾总结不会提及平台没收到的内容。
        for (const finding of file.findings) {
          input.submittedFindingKeys.add(findingMergeKey(finding));
        }
      } else {
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} ${file.filePath} 失败（${result.reason}）\n`,
        );
      }
    }
    // 本片其余文件补空包（ADR-0061 覆盖率优先）：排除面只剩「已经有过一次上报
    // 尝试」的文件。有 finding 但 tips 全被校验跳过 / 上报失败的文件也在
    // `attempted` 里已有登记，不重复；从未出现在报文里的文件一律补 `[]`。
    sent += await reportRemainingFiles();
    if (sent > 0) {
      process.stderr.write(
        `review-pi: MCP mrReviewResult${label} 已上报 ${String(sent)} 文件 / ${String(tips)} 条意见\n`,
      );
    }
  } catch (error) {
    // 旁路（ADR-0045 决策 3）：绝不把上报失败变成检视失败；具体原因已在上面逐行留痕。
    // 未走完编排的条目补一条兜底原因，避免聚合侧只剩「原因未知」。
    markUncovered(
      keptFindings,
      `上报编排异常：${describeReportFailure(error)}`,
    );
    // 覆盖率兜底（ADR-0061）：编排异常也不能让剩余文件失去「已检视」登记。
    try {
      const sent = await reportRemainingFiles();
      if (sent > 0) {
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} 已补报 ${String(sent)} 文件 / 0 条意见（编排异常兜底）\n`,
        );
      }
    } catch (fallbackError) {
      process.stderr.write(
        `review-pi: MCP mrReviewResult${label} 兜底补报失败（${describeReportFailure(fallbackError)}）\n`,
      );
    }
  }
}

/**
 * 对「没有检视意见」的文件逐个调用 `mrReviewResult(filePath, reviewTips: [])`。
 *
 * 路径按报文同一规范处理（反斜杠→正斜杠、拒绝对路径/`..`），非法路径跳过
 * 并留痕；`exclude` = 本片已经有过一次上报尝试的文件（ADR-0061：每文件只发
 * 一条，避免与报文重复）。`attempted` 是调用方的尝试集合，本函数把处理过的
 * 规范化路径都登记进去，供后续兜底去重。返回成功发送的文件数。
 */
async function reportFilesWithoutTips(input: {
  readonly label: string;
  readonly taskId: string;
  readonly reporter: McpReporter;
  readonly files: readonly string[];
  readonly reportedFiles: string[];
  readonly exclude?: ReadonlySet<string>;
  /** 出参：本函数处理过（含跳过）的文件路径，供调用方后续兜底去重 */
  readonly attempted?: Set<string>;
}): Promise<number> {
  const seen = new Set<string>();
  let sent = 0;
  for (const raw of input.files) {
    const filePath = normalizeReportFilePath(raw);
    if (filePath === null) {
      process.stderr.write(
        `review-pi: MCP mrReviewResult${input.label} 跳过文件（filePath 非法：${JSON.stringify(raw)}）\n`,
      );
      continue;
    }
    if (seen.has(filePath) || input.exclude?.has(filePath) === true) {
      continue;
    }
    // 注意：`exclude` 与 `attempted` 在调用方常是同一个 Set（本片尝试集合），
    // 因此必须先过排除判断再登记，否则刚加入的路径会把自己排除掉。
    seen.add(filePath);
    input.attempted?.add(filePath);
    const result = await input.reporter.task.reportFileResult({
      taskId: input.taskId,
      filePath,
      reviewTips: [],
    });
    if (result.ok) {
      sent += 1;
      input.reportedFiles.push(filePath);
    } else {
      process.stderr.write(
        `review-pi: MCP mrReviewResult${input.label} ${filePath} 失败（${result.reason}）\n`,
      );
    }
  }
  return sent;
}

/** 片号两位化（与分片目录名 sNN 同形） */
function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
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
 * 目录约定单源在 `run/review-run.ts`（`<runsRoot>/.cache/rule-skills/<digest>/`）；
 * 降级包（`degradedReason` 在场）不跑会话，故排除。
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
  const cacheRoot = resolve(runsRoot, ".cache", "rule-skills");
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
async function runSmokeCommand(args: SmokeCliArgs, config: ResolvedConfig): Promise<number> {
  const endpoint = resolveReviewerEndpoint(config);
  const probes = await runSmokeProbes({
    baseUrl: endpoint.baseUrl,
    apiKey: endpoint.apiKey,
    modelId: modelIdForGateway(args.model ?? config.model.default, config.reviewer.stripModelPrefix),
    fetch: globalThis.fetch,
    healthTimeoutMs: config.limits.timeouts.probeHealthMs,
    modelTimeoutMs: config.limits.timeouts.probeModelMs,
    retry: retryPolicyFor(config.limits.retry, "smoke"),
  });
  await writeStdout(`${formatSmokeDiagnostics(probes)}\n`);
  return probes.ok ? 0 : 1;
}

/**
 * 呈现档模型 id → 网关 wire 字段（`reviewer.stripModelPrefix` 同一开关管全部
 * 模型槽）：`model.presentation` 显式值优先，缺省跟随本次检视模型（已剥过）。
 */
function gatewayPresentationModelId(config: ResolvedConfig, reviewModelId: string): string {
  return config.model.presentation !== null
    ? modelIdForGateway(config.model.presentation, config.reviewer.stripModelPrefix)
    : reviewModelId;
}

/** stdout 整写（flush 后 resolve——退出前保证字节已落地） */
function writeStdout(text: string): Promise<void> {
  return new Promise<void>((flush) => process.stdout.write(text, () => flush()));
}

/**
 * 上报不可用的 stderr 一行：只报事实（协议 / 网络 / 状态码），不回显 headers。
 * 截断到 160 字符，避免服务端把长消息灌进日志。
 */
function describeReportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}

/** PhaseRecord.phase → `phaseN`（1-based）；未知名称回退为原名 */
function phaseLabelOf(phase: PhaseRecord["phase"]): string {
  const index = PHASE_ORDER.indexOf(phase);
  return index >= 0 ? `phase${String(index + 1)}` : phase;
}

/**
 * 阶段回复解析失败的 stderr 一行（P1）：只在 `parseFailure` 在场时输出。
 * 成功 run 零输出（零字节漂移）；失败不改退出码——它只解释「为什么候选是 0」。
 */
function reportPhaseParseFailures(phaseLog: readonly PhaseRecord[]): void {
  for (const entry of phaseLog) {
    const failure = entry.parseFailure;
    if (failure === undefined) {
      continue;
    }
    const expected = failure.expected === "candidates" ? "候选" : "裁决";
    process.stderr.write(
      `review-pi: [r${String(entry.round)} ${phaseLabelOf(entry.phase)}] ${expected}解析失败（${failure.kind}），本轮 0 ${expected}；详见审计 phaseLog\n`,
    );
  }
}

/**
 * 运行进度投影的开关与构造（ADR-0055）：缺省打印，`--no-progress` 显式静音。
 * 返回 undefined = 本 run 不显示任何进度事件行（收尾摘要仍恒打印）。
 */
function startProgress(args: ReviewCliArgs, modelId: string): ProgressRenderer | undefined {
  const isTty = process.stderr.isTTY === true;
  if (!(args.progress ?? true)) {
    return undefined;
  }
  process.stderr.write(`review-pi: ${args.caseId} · ${modelId} · progress on\n`);
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
 * 收尾摘要的数值面：token / 工具数取自运行记录（与审计同源），模型调用数与
 * Ledger 命中由 run 层透传（`requests` 不进 AuditLight/RunRecord 字节，只能在
 * 返回值上取），成本用与转录同一份模型画像 + 同一个 `calculateCost`
 * （不另立公式），耗时由 CLI 自身计时。
 */
function buildSummary(input: {
  readonly modelId: string;
  readonly baseUrl: string;
  readonly record: Awaited<ReturnType<typeof runReview>>["record"];
  readonly startedAt: number;
  readonly ledgerHits: number;
  readonly modelCalls: number;
  readonly skillBashCalls: number;
}): ProgressSummary {
  const { record } = input;
  const skillPassLog = record.baseline.audit.skillPassLog ?? [];
  const skillToolCalls = skillPassLog.reduce((sum, entry) => sum + entry.toolCallCount, 0);
  const usage = record.baseline.usage;
  const costUsd = calculateCost(reviewModelOf(input.modelId, input.baseUrl), llmUsageToPiUsage(usage)).total;
  return {
    durationMs: Date.now() - input.startedAt,
    usage,
    costUsd,
    modelCalls: input.modelCalls,
    toolCalls: record.baseline.toolCalls,
    // 主会话 = 总数 − skill 会话（skillPassLog 把 skill 的逐项工具数记账）
    mainToolCalls: record.baseline.toolCalls - skillToolCalls,
    skillToolCalls,
    skillBashCalls: input.skillBashCalls,
    ledgerHits: input.ledgerHits,
  };
}

/** 把内存账本换算成可打印的阶段账本（纯函数边界：便于单测与口径统一） */
function buildStageBreakdown(clock: StageClock, now: number): {
  readonly totalMs: number;
  readonly stages: readonly StageSpan[];
  readonly phases: readonly StageSpan[];
  readonly nested: readonly StageSpan[];
} {
  const runStartedAt = clock.runStartedAt ?? clock.commandStartedAt;
  const auditMs = clock.auditMs ?? 0;
  const auditEndedAt = runStartedAt + auditMs;
  const startupMs = Math.max(0, runStartedAt - clock.commandStartedAt);
  const knownMs =
    startupMs + auditMs + clock.reportMs + clock.projectionMs + clock.tipsMs + clock.summaryMs + clock.settleMs;
  const totalMs = Math.max(0, now - clock.commandStartedAt);
  const otherMs = Math.max(0, totalMs - knownMs);
  const phases: StageSpan[] = clock.phaseSpans.map((span, index) => {
    const next = clock.phaseSpans[index + 1];
    const endedAt = next?.start ?? auditEndedAt;
    const roundLabel = span.round > 1 ? `R${String(span.round)}` : "";
    const shardLabel = span.shardIndex !== undefined ? `S${String(span.shardIndex)}` : "";
    return { label: `${shardLabel}${roundLabel}P${String(span.index)}`, durationMs: Math.max(0, endedAt - span.start) };
  });
  return {
    totalMs,
    stages: [
      { label: "准备/建连（配置/规则包/MCP）", durationMs: startupMs },
      { label: "六阶段审计", durationMs: auditMs },
      { label: "报文生成+上报", durationMs: clock.reportMs },
      { label: "呈现投影", durationMs: clock.projectionMs },
      { label: "中文 tips 组装/落盘", durationMs: clock.tipsMs },
      { label: "总结生成", durationMs: clock.summaryMs },
      { label: "固定沉降", durationMs: clock.settleMs },
      { label: "其他/收尾（HTTP/落盘/事件 flush）", durationMs: otherMs },
    ],
    phases,
    nested: clock.skillSpans,
  };
}

/** `.env.local` 残留提示（ADR-0025）：只 stat cwd 一个路径，不探测任何环境变量 */
function envLocalNoticeLine(): string {
  return (
    "review-pi: 已不再读取 .env.local（本版配置见 --config 或 ~/.PiAgent/PiAgent.jsonc）；" +
    "迁移：review-pi config init --from-env .env.local\n"
  );
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

  // 配置装载（ADR-0025）：**唯一落点**。读一次 → 不可变快照，之后只读；
  // 不做任何 env 覆盖、不回写 process.env。警告（未知键 / 钉死键 / 权限）
  // 走 stderr，不改退出码。
  //
  // export（ADR-0036）例外：纯文件系统命令，不加载配置、不碰 key、不做
  // .env.local 探测——换机器 / CI 里没有配置文件也应能导出路径。
  if (parsed.command === "export") {
    runExportCommand(parsed.args).then((code) => exitGracefully(code)).catch(reportErrorAndExit);
    return;
  }

  let config: ResolvedConfig;
  try {
    const loaded = loadConfig({
      ...(parsed.args.configPath !== undefined ? { configPath: parsed.args.configPath } : {}),
    });
    for (const warning of loaded.warnings) {
      process.stderr.write(`review-pi: ${warning}\n`);
    }
    config = loaded.config;
    if (parsed.command !== "config" && parsed.args.configPath !== undefined && !config.exists) {
      throw new ConfigError(`--config 指定的文件不存在（${config.path}）`);
    }
    // 缺省路径缺席不是错误（ADR-0025 允许全缺省直跑），但要让人知道"你现在跑的是
    // 内置缺省、而不是配置文件"——否则分发包首跑会在几十秒后才因缺 apiKey 才暴露。
    if (parsed.command !== "config" && parsed.args.configPath === undefined && !config.exists) {
      process.stderr.write(
        `review-pi: 未找到用户级配置文件 ${config.path}（按内置缺省运行；先跑 review-pi config init 生成）\n`,
      );
    }
  } catch (error) {
    reportErrorAndExit(error);
    return;
  }

  // `.env.local` 残留提示：只 stat cwd 一个路径（保持「全禁 env」的字面纪律）
  if (parsed.command !== "config" && existsSync(resolve(".env.local"))) {
    process.stderr.write(envLocalNoticeLine());
  }

  let command: Promise<number>;
  if (parsed.command === "config") {
    command = Promise.resolve().then(() => runConfigCommand(parsed.args));
  } else if (parsed.command === "smoke") {
    command = runSmokeCommand(parsed.args, config);
  } else {
    command = runReviewCommand(parsed.args, config);
  }
  command.then((code) => exitGracefully(code)).catch(reportErrorAndExit);
}

/** 命令异常 → stderr 人话 + exit 1（不落堆栈：输入/环境错误是预期路径） */
function reportErrorAndExit(error: unknown): void {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`review-pi: ${message}\n`, () => exitGracefully(1));
  // 完整堆栈只进运行日志（stderr 仍是一行人话；stdout 契约不变）。
  // 生产上把 `<tasks 根>/<taskId>/runs/review-pi.log` 发回来即可定位。
  if (activeRunLog !== null) {
    const detail =
      error instanceof Error && error.stack !== undefined ? error.stack : message;
    activeRunLog.detail(`\n[uncaught ${new Date().toISOString()}]\n${detail}\n`);
  }
}

main();
