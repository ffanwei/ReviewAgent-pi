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
 *   [--progress | --no-progress]
 *   review-pi smoke [--model <id>] [--config <path>]
 *   review-pi config <init|show> [--config <path>] [--force] [--from-env <file>] [--json]
 */

import { existsSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { calculateCost } from "@earendil-works/pi-ai";

import type { Finding } from "../contracts/finding.js";
import type { RunProgressSink } from "../contracts/progress.js";
import { runDirPath } from "../experiment/run-record.js";
import { SESSION_INDEX_VERSION, writeSessionIndex } from "../export/session-index.js";
import { createMcpReporter, resolveReportConfig, type McpReporter } from "../mcp/index.js";
import { formatSmokeDiagnostics, runSmokeProbes } from "../provider/gateway-probe.js";
import { reviewModelOf } from "../provider/pi-client.js";
import { resolveReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { llmUsageToPiUsage } from "../provider/usage-map.js";
import { runReview } from "../run/review-run.js";
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
import { reviewRuntimeOf } from "../shared/review-runtime.js";
import { resolveTasksRoot, taskDirPath } from "../shared/tasks-dir.js";
import { REVIEW_PI_VERSION } from "../shared/version.js";
import { mrJsonToUnifiedDiff } from "../zoneb/mr-json.js";
import { parseCliArgs, USAGE_TEXT, type ReviewCliArgs, type SmokeCliArgs } from "./args.js";
import { formatReviewArgs } from "./args-echo.js";
import { runConfigCommand } from "./config-command.js";
import { buildShardReport, type ReportLlmRuntime, type SemanticTipEntry } from "./report-payload.js";
import { buildReviewSummary } from "./review-summary.js";
import {
  assembleUnifiedTips,
  countTips,
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
  type ProgressRenderer,
  type ProgressSummary,
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
async function runReviewCommand(args: ReviewCliArgs, config: ResolvedConfig): Promise<number> {
  // 缺值的规则包旗标（B 档：按未传处理，但不静默）：先喊一声再往下走，保证即使
  // 后面因别的错误早退，用户也能看到「规则包根本没装载」这个原因。
  for (const flag of args.emptyRuleSkillFlags ?? []) {
    process.stderr.write(`review-pi: ${flag} 缺少值，已忽略（本轮不装载该包）\n`);
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
  // 落盘根（ADR-0033）：tasks 根（`--tasks-dir` 或 ~/.PiAgent/tasks）+ 任务 id；
  // 其下仍是 runs/ + audit/ + .cache/（ADR-0032 的目录内形态不变）。
  const tasksRoot = resolveTasksRoot({
    ...(args.tasksDir !== undefined ? { tasksDir: args.tasksDir } : {}),
  });
  const runsRoot = taskDirPath(tasksRoot, args.taskId);

  // 传入参数回显（stderr，ADR-0043）：开跑前先报一遍本次生效参数——相对路径已按
  // cwd 解析，缺省值（model / config / tasks 根 / progress）已落成生效值并标注来源。
  // 打印点必须早于进度投影，否则事件行会把这一块打散；stdout 是单 JSON 文档契约，
  // 故这一路只走 stderr；只碰参数面，不含 apiKey / baseUrl 等秘密。
  const stderrIsTty = process.stderr.isTTY === true;
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
      progressOn: args.progress ?? stderrIsTty,
      progressExplicit: args.progress !== undefined,
      stderrIsTty,
    })}\n`,
  );

  // MCP 上报（ADR-0037 事件面 + ADR-0045 业务面）：建连点在**读 diff 之前**
  // （ADR-0045 决策 2：`startTask` 的价值就是「远端先知道任务存在」，预检失败
  // 也要有始有终）。配置非法 = 装载期已 fail fast；建连 / 握手失败 = 降级
  // （不建 sink，照常检视）。上报是旁路：任何失败都不改变退出码，也不进审计。
  const reportConfig = resolveReportConfig(config);
  let reporter: McpReporter | null = null;
  if (reportConfig !== null) {
    try {
      reporter = await createMcpReporter({
        config: reportConfig,
        clientVersion: REVIEW_PI_VERSION,
      });
    } catch (error) {
      process.stderr.write(
        `review-pi: MCP 上报不可用（${describeReportFailure(error)}），继续检视\n`,
      );
    }
  }
  const activeReporter = reporter;
  // 业务 tool（ADR-0045）：单次尝试、旁路（失败只落 stderr 一行，不改退出码）。
  const taskToolsOn = activeReporter !== null && reportConfig !== null && reportConfig.task;
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
  // 运行时档与呈现投影同档（model.presentation 优先 + presentationRequestMs）。
  const reportRuntime = {
    apiKey: endpoint.apiKey,
    baseUrl: endpoint.baseUrl,
    modelId: gatewayPresentationModelId(config, modelId),
    timeoutMs: config.limits.timeouts.presentationRequestMs,
  };
  const reportedFiles: string[] = [];
  // 语义登记的并集（ADR-0045 统一 tips）：键 = 合并键；片间首见优先。
  // 聚合重编号（F001…）后 source/ruleId 无法从 merged finding 重推，必须在片级捕获。
  const semanticByMergeKey = new Map<string, SemanticTipEntry>();
  const onShardFindings =
    taskToolsOn && activeReporter !== null
      ? (
          label: { readonly index: number; readonly total: number },
          findings: readonly Finding[],
        ) =>
          reportShardFindings({
            label,
            findings,
            taskId: args.taskId,
            repoPath,
            reporter: activeReporter,
            runtime: reportRuntime,
            reportedFiles,
            semanticByMergeKey,
          })
      : undefined;

  try {
    // 输入形态（ADR-0029）：JSON 在装载期补文件头转成统一 diff，之后与 --mr-diff 同一条路径
    const mrText = await readFile(mrPath, "utf8");
    const diff = args.mrFormat === "json" ? mrJsonToUnifiedDiff(mrText, "--mr-json") : mrText;

    // 运行进度投影（ADR-0016）：stderr 是 TTY 时缺省开（人手敲看得见），重定向
    // 收日志时缺省关；--progress / --no-progress 覆盖。缺省关时只保留收尾摘要
    // 一行（stderr，可 grep），不出现阶段/请求/工具事件行。
    const progress = startProgress(args, modelId);
    const onProgress: RunProgressSink = (event) => {
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
      throw error;
    }
    const { record, runId, auditPath, reviewsPath, transcriptPaths } = reviewed;
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
    const codeByFinding = await readCodeLines(repoPath, record.baseline.findings);
    // 统一 tips 组装（ADR-0045）：先于引擎调用——引擎是否跳过 tips 取决于
    // 统一覆盖面。尽力而为（Q26b）：未覆盖的 finding 缺席 tips 并逐条留痕。
    let unifiedTips: UnifiedTipsOutcome | undefined;
    if (taskToolsOn) {
      unifiedTips = assembleUnifiedTips({
        mergedFindings: record.baseline.findings,
        semanticByMergeKey,
        codeByFinding,
      });
      for (const missed of unifiedTips.uncovered) {
        process.stderr.write(
          `review-pi: 检视意见未获统一生成覆盖（${missed}），tips 缺席该条\n`,
        );
      }
    }
    // 全灭回落判定（Q24a）：有 findings 但统一 tips 零覆盖 ⇒ 引擎按全量模式
    // 调用（不带 skipTips），其 tips 作回落源；否则业务开启时引擎只做 stdout
    // 呈现档（Q22a：省掉 suggestion 并发生成）。
    const engineTipsFallback =
      taskToolsOn &&
      unifiedTips !== undefined &&
      countTips(unifiedTips.tips) === 0 &&
      record.baseline.findings.length > 0;
    if (engineTipsFallback) {
      process.stderr.write("review-pi: 统一 tips 全灭，呈现引擎按全量模式回落……\n");
    }
    const rulePackDirs = rulePackDirsOf(record.baseline.audit, runsRoot);
    const projection = await applyPresentationProjection(
      {
        findings: record.baseline.findings,
        toolCallLog: [],
        ...(Object.keys(codeByFinding).length > 0 ? { codeByFinding } : {}),
        ...(rulePackDirs.length > 0 ? { rulePackDirs } : {}),
        ...(taskToolsOn && !engineTipsFallback ? { skipTips: true } : {}),
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
        },
        perFieldTimeoutMs: config.limits.timeouts.presentationRequestMs,
        timeoutBufferMs: config.limits.timeouts.presentationBufferMs,
        suggestionConcurrency: config.limits.concurrency.suggestion,
      },
    );
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

    // tips 选源（ADR-0045 统一 tips）：业务开启 = 统一生成（尽力而为），
    // 全灭才回落引擎（并按 12 键对齐）；业务关闭 = 引擎照旧（逐字节现状）。
    let tipsDoc: ReviewTipsDocumentLike | undefined;
    if (taskToolsOn && unifiedTips !== undefined) {
      if (countTips(unifiedTips.tips) > 0 || record.baseline.findings.length === 0) {
        tipsDoc = unifiedTips.tips;
      } else if (projection.kind === "projected" && projection.tips !== undefined) {
        tipsDoc = withUnifiedKeys(projection.tips, record.baseline.findings);
        process.stderr.write("review-pi: 分组意见回落呈现引擎（统一生成全灭）\n");
      } else {
        process.stderr.write("review-pi: 统一 tips 全灭且无可回落引擎，本次不产分组意见\n");
      }
    } else {
      tipsDoc = projection.kind === "projected" ? projection.tips : undefined;
    }

    // 中文产物只留分组意见（ADR-0022）：`reviews_zh.json` 不再是交付物——投影结果
    // 仍服务 stdout 与 `reviews_tips_zh.json`（同一次投影，不额外调网关）。历史上
    // 产过的 zh 一律视为陈旧并清除，使「磁盘上的中文产物 = 本次 run」成立；作用域
    // = `<out>/runs/`（ADR-0032：一个 `--out` 即一次 run 的输出目录）。
    // en/session 已在内核落盘（先于本步）。
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

    // 检视总结上报（ADR-0045 决策 2）：中文 tips 落盘之后（发出去的内容与
    // `reviews_tips_zh.json` 同源同版本）、session 索引之前（索引失败不该影响
    // 上报时机）。顺序契约：mrReviewResult（片级，已发完）→ saveReviewSummary
    // → endTask（finally）。统一生成全灭且无回落时输入退为英文 findings，模型
    // 调用失败再降级确定性模板——saveReviewSummary 一定会被调用。
    if (taskToolsOn && activeReporter !== null) {
      process.stderr.write("review-pi: MCP saveReviewSummary 生成中（检视总结）……\n");
      const summaryReport = await buildReviewSummary({
        ...(tipsDoc !== undefined ? { tips: tipsDoc } : {}),
        findings,
        ...(reportedFiles.length > 0 ? { reportedFiles: [...reportedFiles] } : {}),
        runtime: reportRuntime,
      });
      if (summaryReport.degradedReason !== undefined) {
        process.stderr.write(
          `review-pi: 检视总结降级为模板（${summaryReport.degradedReason}）\n`,
        );
      }
      const outcome = await activeReporter.task.saveReviewSummary({
        taskId: args.taskId,
        description: summaryReport.markdown,
      });
      if (!outcome.ok) {
        process.stderr.write(
          `review-pi: MCP saveReviewSummary 失败（${outcome.reason}），检视结果不受影响\n`,
        );
      }
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
      const outcome = await activeReporter.task.endTask({ taskId: args.taskId });
      if (!outcome.ok) {
        process.stderr.write(`review-pi: MCP endTask 失败（${outcome.reason}）\n`);
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
  }
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
 * 片级上报编排（ADR-0045）：该片 findings 定型 → 读源码行 → 统一生成调用 →
 * 逐文件 `mrReviewResult` + 语义登记入 run 级集合（tips 复用）。**绝不抛错**
 * （旁路纪律的最外层闸）：任何失败只落 stderr，检视与退出码不受影响。
 * 零 finding 的片直接返回（不发空包）。
 */
async function reportShardFindings(input: {
  readonly label: { readonly index: number; readonly total: number };
  readonly findings: readonly Finding[];
  readonly taskId: string;
  readonly repoPath: string;
  readonly reporter: McpReporter;
  readonly runtime: ReportLlmRuntime;
  /** 跨片累积已上报文件（收尾总结的 reportedFiles 输入；按片序追加） */
  readonly reportedFiles: string[];
  /** 语义登记的 run 级并集（键 = 合并键；首见优先——tips 复用的数据面） */
  readonly semanticByMergeKey: Map<string, SemanticTipEntry>;
}): Promise<void> {
  const label = input.label.total > 1 ? ` [s${pad2(input.label.index)}/${pad2(input.label.total)}]` : "";
  try {
    if (input.findings.length === 0) {
      return;
    }
    const codeByFinding = await readCodeLines(input.repoPath, input.findings);
    const outcome = await buildShardReport({
      findings: input.findings,
      codeByFinding,
      runtime: input.runtime,
    });
    if (outcome.kind === "failed") {
      process.stderr.write(
        `review-pi: MCP mrReviewResult${label} 跳过本片（报文生成失败：${outcome.reason}）\n`,
      );
      return;
    }
    // 语义登记并入 run 级集合（首见优先：跨片同合并键 = 同一问题的重复条目）
    for (const [key, entry] of outcome.semanticByKey) {
      if (!input.semanticByMergeKey.has(key)) {
        input.semanticByMergeKey.set(key, entry);
      }
    }
    for (const problem of outcome.skippedFiles) {
      process.stderr.write(`review-pi: MCP mrReviewResult${label} 跳过文件组（${problem}）\n`);
    }
    for (const problem of outcome.skippedTips) {
      process.stderr.write(`review-pi: MCP mrReviewResult${label} 跳过单条意见（${problem}）\n`);
    }
    let sent = 0;
    let tips = 0;
    for (const file of outcome.files) {
      const result = await input.reporter.task.reportFileResult({
        taskId: input.taskId,
        filePath: file.filePath,
        reviewTips: file.reviewTips,
      });
      if (result.ok) {
        sent += 1;
        tips += file.reviewTips.length;
        input.reportedFiles.push(file.filePath);
      } else {
        process.stderr.write(
          `review-pi: MCP mrReviewResult${label} ${file.filePath} 失败（${result.reason}）\n`,
        );
      }
    }
    if (sent > 0) {
      process.stderr.write(
        `review-pi: MCP mrReviewResult${label} 已上报 ${String(sent)} 文件 / ${String(tips)} 条意见\n`,
      );
    }
  } catch {
    // 旁路（ADR-0045 决策 3）：绝不把上报失败变成检视失败；具体原因已在上面逐行留痕
  }
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

/**
 * 运行进度投影的开关与构造（ADR-0016）：`--progress` / `--no-progress` 显式覆盖，
 * 缺省跟随 `stderr` 是否 TTY。返回 undefined = 本 run 不显示任何进度（现状形态）。
 */
function startProgress(args: ReviewCliArgs, modelId: string): ProgressRenderer | undefined {
  const isTty = process.stderr.isTTY === true;
  if (!(args.progress ?? isTty)) {
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
}

main();
