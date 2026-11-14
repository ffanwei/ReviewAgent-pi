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
 *   stdout 单 JSON 文档（render.ts，已测；恒英文，不做任何呈现翻译——ADR-0065）；
 * - smoke：双探针（网关健康 + 模型可达，gateway-probe.ts 已测）→ stdout
 *   人话报告；
 * - config：`init` 写缺省 JSONC / `show` 脱敏打印生效值（config-command.ts）。
 * - version：产品版本单行（`--json` 含 Node 与内核四包实际版本，ADR-0079；
 *   不加载配置）。
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
 *   [--skill <dir>[,<dir>…]]...
 *   [--strict-rule-skill]
 *   [--no-progress]
 *   review-pi smoke [--model <id>] [--config <path>]
 *   review-pi config <init|show> [--config <path>] [--force] [--from-env <file>] [--json]
 *   review-pi version [--json]
 */

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import { calculateCost } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import type { LlmUsage } from "../contracts/llm.js";
import type { RunProgressSink } from "../contracts/progress.js";
import type { ModelFallbackRecord } from "../contracts/run.js";
import { runDirPath } from "../experiment/run-record.js";
import { LifecycleCollector } from "../export/lifecycle.js";
import {
  createRequestTimelineWriter,
  setRequestTimelineSink,
} from "../observability/request-timeline.js";
import {
  createMcpReporter,
  normalizeReportFilePath,
  resolveReportConfig,
  type McpReporter,
} from "../mcp/index.js";
import {
  createTaskLifecycle,
  resolveTaskToolSettleMs,
} from "../mcp/task-lifecycle.js";
import { formatSmokeDiagnostics, probeModelReachability, runSmokeProbes } from "../provider/gateway-probe.js";
import { resolveReviewModel } from "../provider/model-fallback.js";
import { reviewModelOf } from "../provider/pi-client.js";
import { resolveReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { llmUsageToPiUsage, ZERO_USAGE } from "../provider/usage-map.js";
import { findingMergeKey } from "../run/findings-merge.js";
import { listChangedFilePaths } from "../run/mr-input.js";
import { runReviewOutcome, type ReviewRunOutcome } from "../run/review-run.js";
import { runExportCommand } from "./export-command.js";
import {
  ConfigError,
  configSnapshot,
  homeDirectory,
  loadConfig,
  modelIdForGateway,
  type ResolvedConfig,
} from "../shared/config.js";
import { retryPolicyFor } from "../shared/llm-retry.js";
import { setOneShotUsageSink, setOneShotLifecycleSink } from "../shared/one-shot-llm.js";
import { reviewRuntimeOf } from "../shared/review-runtime.js";
import { isSeverityBelow } from "../shared/severity-filter.js";
import { isConfidenceBelow } from "../shared/tips-filter.js";
import { resolveTasksRoot, taskDirPath } from "../shared/tasks-dir.js";
import { REVIEW_PI_VERSION } from "../shared/version.js";
import { mrJsonToUnifiedDiff } from "../zoneb/mr-json.js";
import { parseCliArgs, USAGE_TEXT, type ReviewCliArgs, type SmokeCliArgs } from "./args.js";
import { formatReviewArgs } from "./args-echo.js";
import { runConfigCommand } from "./config-command.js";
import { runVersionCommand } from "./version-command.js";
import { McpCallLog } from "./mcp-call-log.js";
import { openRunLog, type RunLog } from "./run-log.js";
import { buildShardReport, type SemanticTipEntry } from "./report-payload.js";
import { buildReviewSummary } from "./review-summary.js";
import { readCodeLines } from "./code-lines.js";
import {
  deliverReviewRun,
  deliverSkip,
  finalizeDelivery,
  type DeliveryClock,
  type DeliveryEventsPort,
  type DeliveryOneShotPort,
} from "./delivery.js";
import { describeReportFailure } from "./report-failure.js";
import { reportFilesWithoutTips } from "./report-files.js";
import {
  createProgressRenderer,
  stageBreakdownLines,
  taskUsageLines,
  type ProgressRenderer,
  type StageSpan,
  type TaskUsagePurposeLine,
} from "./progress-render.js";
import {
  createOneShotUsageCollector,
  type OneShotPurposeKey,
  type OneShotUsageCollector,
} from "./task-usage.js";

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
  /** run 层给出的真实结束时刻（分片路径）；缺席 = 沿用事件顺序推断 */
  readonly endedAt?: number;
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
    tipsMs: 0,
    summaryMs: 0,
    settleMs: 0,
    phaseSpans: [],
    skillSpans: [],
    skillStartedAt: undefined,
  };
  // 整任务 LLM 账本（ADR-0066）：Agent 内 usage 由 runReview 返回；Agent 之后的
  // 一次性调用（tips / 总结 / 候选修复）走 one-shot 层的进程级 sink 采集。
  // 只进收尾日志，不改审计 / run.json / stdout。
  const usageCollector = createOneShotUsageCollector();
  let agentUsage: LlmUsage = ZERO_USAGE;
  let agentCalls = 0;
  // 缺值的规则包旗标（B 档：按未传处理，但不静默）：先喊一声再往下走，保证即使
  // 后面因别的错误早退，用户也能看到「规则包根本没装载」这个原因。
  for (const flag of args.emptyRuleSkillFlags ?? []) {
    process.stderr.write(`review-pi: ${flag} 缺少值，已忽略（本轮不装载该包）\n`);
  }
  // 范围正则空值（ADR-0078）：语义是「本次清空该维度」，必须可见（零静默）。
  for (const flag of args.emptyPathFilterFlags ?? []) {
    process.stderr.write(
      `review-pi: ${flag} 传入空值，已清空该维度（本次不按该维度筛选，配置默认不再生效）\n`,
    );
  }
  // 非法范围正则（ADR-0078 后续修订）：只忽略该条，不中断检视；必须可见。
  for (const item of args.ignoredPathFilterPatterns ?? []) {
    process.stderr.write(
      `review-pi: ${item.flag} ${JSON.stringify(item.pattern)} 不是合法正则，已忽略（${item.reason}）\n`,
    );
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
  // 会话生命周期留痕（ADR-0073）：进程级按发生顺序收集 one-shot + MCP 四工具
  const lifecycleCollector = new LifecycleCollector();
  const reportConfig = resolveReportConfig(config);
  let reporter: McpReporter | null = null;
  if (reportConfig !== null) {
    try {
      reporter = await createMcpReporter({
        config: reportConfig,
        clientVersion: REVIEW_PI_VERSION,
        onTaskCall: (trace) => {
          mcpCallLog.record(trace);
          lifecycleCollector.recordTask(trace);
        },
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
  // 业务 tool 的生命周期 facade（ADR-0086）：start/result/summary/finish 的顺序
  // 与两段沉降都在这里，调用方只决定内容。
  const taskLifecycle =
    taskToolsOn && activeReporter !== null
      ? createTaskLifecycle({
          task: activeReporter.task,
          taskId: args.taskId,
          settleMs: taskToolSettleMs,
          now: () => Date.now(),
          sleep: (ms) => delay(ms),
          log: (line) => process.stderr.write(line),
        })
      : undefined;
  if (taskLifecycle !== undefined) {
    const outcome = await taskLifecycle.start();
    if (!outcome.ok) {
      process.stderr.write(
        `review-pi: MCP startTask 失败（${outcome.reason}），继续检视\n`,
      );
    }
  }
  // 模型前置探测（ADR-0080）：顾问而非守门员——只有「--model 确定不存在」才
  // 换成配置文件 model.default；其余探测结论（401 / 429 / 5xx / 网络 / 畸形）
  // 一律照常开跑。缺省开关 off：这里一次网络请求都不发，与旧版逐字节一致。
  //
  // abort（两边都 404）不在这里抛：此点还在下方 try/finally 之外，抛出会跳过
  // `endTask`（ADR-0045 决策 2「有始有终」）。改成先记下、进 try 后再抛。
  const fallbackModelId = modelIdForGateway(
    config.model.default,
    config.reviewer.stripModelPrefix,
  );
  let effectiveModelId = modelId;
  let modelFallback: ModelFallbackRecord | undefined;
  let modelFallbackAbort: string | undefined;
  {
    const decision = await resolveReviewModel({
      mode: config.reviewer.modelFallback,
      modelFromFlag: args.model !== undefined,
      requestedModelId: modelId,
      fallbackModelId,
      probe: (probeModelId) =>
        probeModelReachability({
          baseUrl: endpoint.baseUrl,
          apiKey: endpoint.apiKey,
          modelId: probeModelId,
          fetch: globalThis.fetch,
          modelTimeoutMs: config.limits.timeouts.probeModelMs,
          retry: retryPolicyFor(config.limits.retry, "smoke"),
        }),
    });
    if (decision.kind === "abort") {
      modelFallbackAbort = decision.message;
    } else if (decision.kind === "use-fallback") {
      effectiveModelId = fallbackModelId;
      modelFallback = decision.record;
      process.stderr.write(`review-pi: ${decision.notice}\n`);
    }
  }
  // 片级上报编排（ADR-0045）：每片 findings 定型 → 报文调用 → 逐文件 mrReviewResult。
  // 运行时档（ADR-0045）：`model.presentation` 优先 + oneShotMs；重试次数
  // 来自 limits.retry 的 oneShot 路径（ADR-0051）。业务关闭时这一档也用于
  // 收尾的 tips 语义生成（ADR-0065）。
  const reportRuntime = {
    apiKey: endpoint.apiKey,
    baseUrl: endpoint.baseUrl,
    modelId: gatewayPresentationModelId(config, effectiveModelId),
    timeoutMs: config.limits.timeouts.oneShotMs,
    retry: retryPolicyFor(config.limits.retry, "oneShot"),
  };
  // 事件通道的 flush/close 与业务生命周期分开（业务关闭时仍要跑）。
  const deliveryEvents: DeliveryEventsPort | undefined =
    activeReporter === null
      ? undefined
      : {
          flush: (timeoutMs) => activeReporter.flush(timeoutMs),
          close: () => activeReporter.close(),
        };
  const deliveryOneShot: DeliveryOneShotPort = {
    generateSummary: (input) => buildReviewSummary({ ...input, runtime: reportRuntime }),
  };
  const deliveryClock: DeliveryClock = {
    now: () => Date.now(),
    sleep: (ms) => delay(ms),
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

  // runReview 成功后回填，供 finally 收尾把生命周期步骤写进会话（ADR-0073）
  let lifecycleRun:
    | {
        readonly runId: string;
        readonly transcriptPaths: readonly string[];
        readonly artifacts: readonly {
          readonly transcriptPath: string;
          readonly auditPath: string;
        }[];
      }
    | undefined;
  // 收尾阶段（报文 / 总结）续写同一次 run 的顶层请求时间线（ADR-0076）
  let postPassTimeline: ReturnType<typeof createRequestTimelineWriter> | null = null;

  try {
    // 前置探测的两边都 404 结论在 try 内抛出，保证 finally 的 endTask 仍发（ADR-0045）
    if (modelFallbackAbort !== undefined) {
      throw new Error(modelFallbackAbort);
    }
    setOneShotUsageSink(usageCollector.sink);
    // 生命周期全文留痕（ADR-0073）：one-shot 三目的全文进会话时间线
    setOneShotLifecycleSink((event) => lifecycleCollector.recordOneShot(event));
    // 输入形态（ADR-0029）：JSON 在装载期补文件头转成统一 diff，之后与 --mr-diff 同一条路径
    const mrText = await readFile(mrPath, "utf8");
    const diff = args.mrFormat === "json" ? mrJsonToUnifiedDiff(mrText, "--mr-json") : mrText;
    // 变更文件全集（ADR-0068）：取**过滤前** diff——被预过滤剔除的文件也算变更过，
    // 收尾必须补一条空 tips 的 mrReviewResult（否则平台把「被过滤」读成「未检视」）。
    const changedFiles = listChangedFilePaths(diff);

    // 运行进度投影（ADR-0055，取代 ADR-0016 的 TTY 自动档）：缺省打印事件行；
    // `--no-progress` 显式静音（批跑收日志用）。静音时仍保留收尾摘要一行
    // （stderr，可 grep），不出现阶段/请求/工具事件行。
    const progress = startProgress(args, effectiveModelId);
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
    // 检视范围正则的生效名单（ADR-0078）：CLI 出现即整体替换对应维度的配置；
    // include / exclude 各自独立。空数组 = 本次清空该维度。
    const includeFilter =
      args.includePatterns !== undefined
        ? { source: "cli" as const, patterns: args.includePatterns }
        : config.limits.mrFilter.includeRegex.length > 0
          ? { source: "config" as const, patterns: config.limits.mrFilter.includeRegex }
          : undefined;
    const excludeFilter =
      args.excludePatterns !== undefined
        ? { source: "cli" as const, patterns: args.excludePatterns }
        : config.limits.mrFilter.excludeRegex.length > 0
          ? { source: "config" as const, patterns: config.limits.mrFilter.excludeRegex }
          : undefined;
    const startedAt = Date.now();
    stageClock.runStartedAt = startedAt;
    let outcome: ReviewRunOutcome;
    try {
      outcome = await runReviewOutcome({
        caseId: args.caseId,
        repoPath,
        diff,
        issueDescription: args.issue,
        apiKey: endpoint.apiKey,
        baseUrl: endpoint.baseUrl,
        modelId: effectiveModelId,
        ...(modelFallback !== undefined ? { modelFallback } : {}),
        runtime: reviewRuntimeOf(config),
        config: configSnapshot(config, { home: homeDirectory() }),
        tipsConfidenceMin: config.limits.confidence.min,
        tipsSeverityMin: config.limits.severity.min,
        fetch: globalThis.fetch,
        runsRoot,
        rep: 1,
        ...(args.ruleSkillZips !== undefined ? { ruleSkillZips: args.ruleSkillZips } : {}),
        ...(args.ruleSkillDirs !== undefined || args.skillDirs !== undefined
          ? {
              ruleSkillDirs: [...(args.ruleSkillDirs ?? []), ...(args.skillDirs ?? [])],
            }
          : {}),
        ...(args.strictRuleSkill !== undefined ? { strictRuleSkill: args.strictRuleSkill } : {}),
        ...(includeFilter !== undefined || excludeFilter !== undefined
          ? {
              diffPathFilters: {
                ...(includeFilter !== undefined ? { include: includeFilter } : {}),
                ...(excludeFilter !== undefined ? { exclude: excludeFilter } : {}),
              },
            }
          : {}),
        onProgress,
        ...(onShardFindings !== undefined ? { onShardFindings } : {}),
      });
    } catch (error) {
      // 异常路径也要擦掉状态行：残影会把错误消息顶成半行
      progress?.dispose();
      stageClock.auditMs = Date.now() - startedAt;
      throw error;
    }
    // ADR-0083：预期内跳过以数据返回，交付收口到 deliverSkip。
    // 仍保证平台收到「至少一次空意见上报 + 固定总结」（有始有终）。
    if (outcome.kind === "skipped") {
      progress?.dispose();
      stageClock.auditMs = Date.now() - startedAt;
      process.stderr.write(`review-pi: ${outcome.skip.message}（跳过检视）\n`);
      const delivered = await deliverSkip({
        identity: { caseId: args.caseId, taskId: args.taskId },
        skip: outcome.skip,
        ...(changedFiles[0] !== undefined ? { firstFile: changedFiles[0] } : {}),
        ...(taskLifecycle !== undefined ? { task: taskLifecycle } : {}),
        reportedFiles,
        log: (line) => process.stderr.write(line),
      });
      await writeStdout(delivered.stdoutDocument);
      return 0;
    }
    const reviewed = outcome.result;
    // 请求时间线（ADR-0076）：pass 已写过单片 / 分片文件；收尾的报文与总结
    // 属于同一次 run，续写顶层文件（追加模式，保留 pass 已写的行）。
    const { record, runId, transcriptPaths } = reviewed;
    postPassTimeline = createRequestTimelineWriter(runDirPath(runsRoot), {
      mode: "a",
      runId,
    });
    setRequestTimelineSink(postPassTimeline.sink);
    // ADR-0088：trace 消费写者记录的 转录/审计 对；单遍用 baseline 的记录路径，
    // 分片用 shards[]。不再从转录路径反推审计路径。
    const lifecycleArtifacts =
      record.shards === undefined
        ? [
            {
              transcriptPath:
                record.baseline.transcriptPath ??
                resolve(runDirPath(runsRoot), `session-${runId}.json`),
              auditPath: record.baseline.auditPath,
            },
          ]
        : record.shards.map((shard) => ({
            transcriptPath: resolve(runDirPath(runsRoot), shard.transcriptFile),
            auditPath: resolve(runDirPath(runsRoot), shard.auditFile),
          }));
    lifecycleRun = { runId, transcriptPaths, artifacts: lifecycleArtifacts };
    agentUsage = record.baseline.usage;
    agentCalls = reviewed.modelCalls;
    stageClock.auditMs = (stageClock.auditEndedAt ?? Date.now()) - startedAt;
    const delivery = await deliverReviewRun({
      run: reviewed,
      identity: { caseId: args.caseId, taskId: args.taskId, cwd: process.cwd() },
      paths: { tasksRoot, runsRoot },
      repoPath,
      coverageFiles: changedFiles,
      model: { modelId: effectiveModelId, baseUrl: endpoint.baseUrl },
      limits: {
        confidenceMin: config.limits.confidence.min,
        severityMin: config.limits.severity.min,
      },
      mcp: {
        ...(taskLifecycle !== undefined ? { task: taskLifecycle } : {}),
        ...(deliveryEvents !== undefined ? { events: deliveryEvents } : {}),
        submittedFindingKeys,
        reportedFiles,
        flushTimeoutMs: reportConfig?.flushTimeoutMs ?? 0,
      },
      tips: { semanticByMergeKey, uncoveredReasonByMergeKey },
      timing: { startedAt },
      ...(modelFallback !== undefined ? { modelFallback } : {}),
      ports: {
        oneShot: deliveryOneShot,
        clock: deliveryClock,
        log: (line) => process.stderr.write(line),
        ...(progress !== undefined
          ? { progress: { finish: (summary) => progress.finish(summary) } }
          : {}),
      },
    });
    // 分片路径（ADR-0084）：阶段时间事实由 run 层产出；单遍保持事件时钟，
    // 逐字节不变。审计窗口 = run 起点 → 最后一个请求结束，扣掉片间报文回调。
    if (reviewed.record.shards !== undefined && reviewed.timings !== undefined) {
      const timings = reviewed.timings;
      stageClock.phaseSpans.length = 0;
      for (const span of timings.phaseSpans) {
        stageClock.phaseSpans.push({
          round: span.round,
          index: span.index,
          phase: span.phase,
          start: span.startedAt,
          ...(span.shardIndex !== undefined ? { shardIndex: span.shardIndex } : {}),
          endedAt: span.endedAt,
        });
      }
      stageClock.auditMs = Math.max(
        0,
        timings.auditEndedAt - timings.auditStartedAt - timings.interPassReportMs,
      );
      stageClock.reportMs = timings.reportCallbacksMs;
    }
    stageClock.reportMs += delivery.timings.coverageMs;
    stageClock.tipsMs += delivery.timings.tipsMs;
    stageClock.summaryMs += delivery.timings.summaryMs;
    stageClock.settleMs += delivery.timings.settleMs;
    if (delivery.deferredFailure !== undefined) {
      throw delivery.deferredFailure;
    }

    await writeStdout(delivery.stdoutDocument);
    // 截断 = 完成的一种（票面退出码契约：0 + truncated=true）
    return 0;
  } finally {
    // 收尾（ADR-0081 第 9 步）：第二段沉降 → endTask → mcp.json → lifecycle →
    // trace → flush → close。所有路径都走这里（含 run 前失败），顺序不变。
    const finalized = await finalizeDelivery({
      taskId: args.taskId,
      runsRoot,
      ...(taskLifecycle !== undefined ? { task: taskLifecycle } : {}),
      ...(deliveryEvents !== undefined ? { events: deliveryEvents } : {}),
      flushEnabled: reportConfig !== null && reportConfig.tool !== null,
      flushTimeoutMs: reportConfig?.flushTimeoutMs ?? 0,
      ...(taskToolsOn && mcpCallLog.size > 0
        ? { mcpLog: { document: () => mcpCallLog.document(args.taskId) } }
        : {}),
      ...(lifecycleRun !== undefined
        ? {
            lifecycle: {
              runId: lifecycleRun.runId,
              transcriptPaths: lifecycleRun.transcriptPaths,
              artifacts: lifecycleRun.artifacts,
              events: lifecycleCollector.snapshot(),
              title: args.caseId,
            },
          }
        : {}),
      log: (line) => process.stderr.write(line),
      clock: deliveryClock,
    });
    stageClock.settleMs += finalized.settleMs;
    try {
      // 阶段账本（最后一行输出）：doneLine 只算到「审计 + 报文」，这里补齐全进程
      // 的账——总结 / 两次沉降 / 落盘 / 事件 flush 都计入总墙钟。仅在进行过
      // runReview 时打印（更早的输入错误没有可解释的阶段结构）。
      if (stageClock.runStartedAt !== undefined) {
        for (const line of stageBreakdownLines(buildStageBreakdown(stageClock, Date.now()))) {
          process.stderr.write(`${line}\n`);
        }
        // 整任务 LLM 账本（ADR-0066）：Agent 内 + 一次性调用，只走 stderr（因此
        // 自动进 review-pi.log）；不改审计 / run.json / stdout。
        for (const line of buildTaskUsageLines({
          usageCollector,
          agentUsage,
          agentCalls,
          modelId: effectiveModelId,
          baseUrl: endpoint.baseUrl,
        })) {
          process.stderr.write(`${line}\n`);
        }
      }
    } finally {
      setOneShotUsageSink(null);
      setOneShotLifecycleSink(null);
      setRequestTimelineSink(null);
      postPassTimeline?.close();
    }
  }
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
  /** 中文 tips 置信度过滤阈值（ADR-0052）：先过滤再组装 */
  readonly confidenceMin: number;
  /** 中文 tips / MCP 上报严重级过滤阈值：先过滤再组装 */
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
    reportFilesWithoutTips({
      label,
      taskId: input.taskId,
      reportFileResult: (args) => input.reporter.task.reportFileResult(args),
      files: input.files,
      reportedFiles: input.reportedFiles,
      exclude: attempted,
      attempted,
      log: (line) => process.stderr.write(line),
    });
  try {
    // ADR-0052：置信度过滤先于报文组装——被丢弃的意见不进报文。
    // 严重级过滤同口径（只裁中文 tips / MCP 上报，findings 恒全量）。
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
    // ADR-0090：报文为纯确定性组装（语义字段来自 Finding.tips），无模型调用。
    const outcome = buildShardReport({
      findings: keptFindings,
      codeByFinding,
    });
    if (outcome.kind === "failed") {
      // 纯组装不会失败；防御分支保持覆盖率兜底语义。
      markUncovered(keptFindings, `片级报文组装失败：${outcome.reason}`);
      const sent = await reportRemainingFiles();
      if (sent > 0) {
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} 已上报 ${String(sent)} 文件 / 0 条意见（报文组装失败，全部补空）\n`,
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
    // 逐条被拒的具体原因（tips 缺失等）——与 uncovered 逐条对齐
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
/** 片号两位化（与分片目录名 sNN 同形） */
function pad2(value: number): string {
  return value < 10 ? `0${String(value)}` : String(value);
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

/** 一次性调用分项的展示顺序（`other` 只在异常路径出现，压到最后） */
const ONE_SHOT_PURPOSE_ORDER: readonly OneShotPurposeKey[] = [
  "tips",
  "summary",
  "candidate-repair",
  "other",
];

const ONE_SHOT_PURPOSE_LABEL: Readonly<Record<OneShotPurposeKey, string>> = {
  tips: "中文 tips",
  summary: "收尾总结",
  "candidate-repair": "候选修复",
  other: "其他",
};

/**
 * 整任务 LLM 账本（ADR-0066）：Agent 内 usage + 一次性调用样本。
 *
 * 成本必须按模型分桶：tips / 总结走 `model.presentation`（可能不是检视模型），
 * 候选修复与 Agent 内走检视模型；同一个总 token 套单一单价会算错。
 */
function buildTaskUsageLines(input: {
  readonly usageCollector: OneShotUsageCollector;
  readonly agentUsage: LlmUsage;
  readonly agentCalls: number;
  readonly modelId: string;
  readonly baseUrl: string;
}): string[] {
  const snapshot = input.usageCollector.snapshot();
  const agentUsage = input.agentUsage;
  const agentCost = calculateCost(
    reviewModelOf(input.modelId, input.baseUrl),
    llmUsageToPiUsage(agentUsage),
  ).total;
  let oneShotCost = 0;
  for (const [model, bucket] of snapshot.total.byModel) {
    oneShotCost += calculateCost(
      reviewModelOf(model, input.baseUrl),
      llmUsageToPiUsage(bucket.usage),
    ).total;
  }
  const purposes: TaskUsagePurposeLine[] = [];
  for (const key of ONE_SHOT_PURPOSE_ORDER) {
    const aggregate = snapshot.byPurpose.get(key);
    if (aggregate === undefined || aggregate.calls <= 0) {
      continue;
    }
    purposes.push({
      label: ONE_SHOT_PURPOSE_LABEL[key],
      calls: aggregate.calls,
      usage: aggregate.usage,
      usageMissingCalls: aggregate.usageMissingCalls,
    });
  }
  return taskUsageLines({
    agentCalls: input.agentCalls,
    agentUsage,
    oneShotCalls: snapshot.total.calls,
    oneShotUsage: snapshot.total.usage,
    oneShotMissingUsageCalls: snapshot.total.usageMissingCalls,
    purposes,
    costUsd: agentCost + oneShotCost,
  });
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
    startupMs + auditMs + clock.reportMs + clock.tipsMs + clock.summaryMs + clock.settleMs;
  const totalMs = Math.max(0, now - clock.commandStartedAt);
  const otherMs = Math.max(0, totalMs - knownMs);
  const phases: StageSpan[] = clock.phaseSpans.map((span, index) => {
    const next = clock.phaseSpans[index + 1];
    const endedAt = span.endedAt ?? next?.start ?? auditEndedAt;
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
  // version（ADR-0079）与 export（ADR-0036）例外：纯展示 / 纯文件系统命令，
  // 不加载配置、不碰 key、不做 .env.local 探测——换机器 / CI 里没有配置文件
  // 也应能回答当前是哪个版本。
  if (parsed.command === "version") {
    const code = runVersionCommand(parsed.args);
    exitGracefully(code);
    return;
  }
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
