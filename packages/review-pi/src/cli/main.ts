/**
 * #7 review-pi CLI wrapper 主缝（进程内）：子命令分发 + 参数透传 + 结果
 * 呈现 only。本文件是胶水：解析（args.ts，已测）→ .env.local 装载
 * （shared/env-local，已测）→ 命令执行 → stdout/stderr 呈现 → 退出码。
 * 检视行为本体全部留在内核（runReview / P1b 双探针）。
 *
 * 命令面：
 * - review：凭据 fail fast（resolveReviewerEndpoint 构造期）→ config B 全链
 *   （缺省；--config A-E 透传内核配置矩阵）→ 审计/记录落盘（--out）→
 *   呈现投影（ADR-0010：REVIEW_PI_PRESENTATION_ENGINE 注入引擎时 stdout
 *   呈现档译中文，失败降级英文源；未配置恒等直通）→ stdout 单 JSON 文档
 *   （render.ts，已测）；
 * - smoke：双探针（网关健康 + 模型可达，gateway-probe.ts 已测）→ stdout
 *   人话报告；
 * - disposition（#15）：Finding 人工处置落库 + 接受率 KPI，编排全在
 *   disposition/command.ts（已测）——本地数据面：无网络、不解析凭据、
 *   不碰 .env.local（与 review/smoke 的实质差异，分发在装载面之前）。
 *
 * 退出码契约（票面三态）：成功（含诚实截断——防御性失败不是运行失败）0 /
 * 其余中止或错误 1；截断信号由 stdout JSON 的 truncated=true 携带。
 * smoke 按诊断结论给码（通过 0 / 任何失败诊断 1）。disposition 成功 0 /
 * 用法与校验错误 1。退出一律走 exitGracefully（exitCode + 自然排干）：
 * 立即 process.exit 在 Windows 上与 undici/AbortSignal 句柄清理竞态，
 * 退出码被吞成 0xC0000409。
 *
 * stdout 纪律：review 与 disposition 的 stdout 契约都是单个 JSON 文档——
 * .env.local 摘要与一切诊断走 stderr。凭据经 REVIEWER_*（> 旧
 * DEEPSEEK_* 别名）环境变量或进程 cwd 的 .env.local（已有环境变量优先），
 * key 绝不回显。
 *
 * 进程调用形态：review-pi review --repo <path> --mr <diff-file>
 *   [--config A-E] [--issue <text>] [--out <dir>] [--model <id>]
 *   review-pi smoke [--model <id>]
 *   review-pi disposition --run <run-record.json> --finding <id>
 *   --decision accept|reject|false-positive [--note <text>] ([--store <file>] | [--out <dir>])
 *   review-pi disposition --stats ([--store <file>] | [--out <dir>])
 */

import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { runDispositionCommand } from "../disposition/command.js";
import { buildReviewsExport } from "../export/reviews.js";
import { formatSmokeDiagnostics, runSmokeProbes } from "../provider/gateway-probe.js";
import { resolveReviewerEndpoint } from "../provider/reviewer-endpoint.js";
import { runReview } from "../run/review-run.js";
import { formatEnvLocalSummary, loadEnvLocalFile } from "../shared/env-local.js";
import { CLI_EXPERIMENT_ID, parseCliArgs, USAGE_TEXT, type ReviewCliArgs, type SmokeCliArgs } from "./args.js";
import { applyPresentationProjection, isPresentationProjectionConfigured } from "./presentation-projection.js";
import { renderReviewOutcome } from "./render.js";
import { buildReviewsZhExport, removeStaleReviewsZh, writeReviewsZh } from "./reviews-zh.js";

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

  const { record, runId, auditPath, reviewsPath } = await runReview({
    caseId: args.caseId,
    repoPath,
    diff,
    issueDescription: args.issue,
    apiKey: endpoint.apiKey,
    baseUrl: endpoint.baseUrl,
    modelId: args.model,
    configId: args.config,
    fetch: globalThis.fetch,
    runsRoot,
    experimentId: CLI_EXPERIMENT_ID,
    rep: 1,
    ...(args.ruleSkillZips !== undefined ? { ruleSkillZips: args.ruleSkillZips } : {}),
    ...(args.ruleSkillName !== undefined ? { ruleSkillName: args.ruleSkillName } : {}),
    ...(args.strictRuleSkill !== undefined ? { strictRuleSkill: args.strictRuleSkill } : {}),
  });

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
  const projection = await applyPresentationProjection({
    findings: record.baseline.findings,
    toolCallLog: [],
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

  // 检视意见中文导出（ADR-0013 Step B）：复用**同一次**投影结果（不额外调网关）。
  // 投影成功 ⇒ 写 reviews_zh.json（写失败抛错）；未配置引擎 / 降级 ⇒ 不产 +
  // 主动清除**本次 run 的 rep-<N>/** 陈旧 zh（绝不跨 rep）。核外缝：根侧 runner
  // 无投影缝，永不产 zh。en/session 已在内核落盘（先于本步）。
  if (reviewsPath !== undefined) {
    const zhDir = dirname(reviewsPath);
    if (projection.kind === "projected") {
      await writeReviewsZh(
        zhDir,
        buildReviewsZhExport({
          envelope: buildReviewsExport({
            generatedAt: new Date(),
            runId,
            source: "vul4j",
            caseId: record.caseId,
            configId: record.configId,
            rep: record.rep,
            model: record.model,
            findings: projection.findings,
          }),
          provenance: projection.provenance,
        }),
      );
    } else {
      const removed = await removeStaleReviewsZh(zhDir);
      if (removed !== undefined) {
        process.stderr.write(`review-pi: 本次未产中文导出，已清除陈旧 ${removed}\n`);
      }
    }
  }

  await writeStdout(
    renderReviewOutcome({
      caseId: record.caseId,
      configId: record.configId,
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

/** .env.local 装载摘要行（stderr；措辞单源 formatEnvLocalSummary——只报键名与行号，值绝不回显） */
function envLocalSummaryLine(loadedKeysText: string): string {
  return `review-pi: env: .env.local found — ${loadedKeysText}\n`;
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

  // disposition 无网络：不解析凭据、不碰 .env.local——在装载面之前分流
  if (parsed.command === "disposition") {
    runDispositionCommand(parsed.args)
      .then((document) => writeStdout(document).then(() => exitGracefully(0)))
      .catch(reportErrorAndExit);
    return;
  }

  // .env.local：用法解析成功后才触碰文件系统；必须在凭据解析前。
  // 读失败（非缺失，如 EACCES/EISDIR）→ 干净人话错误 + exit 1（不留未捕获堆栈）。
  try {
    const envResult = loadEnvLocalFile(resolve(".env.local"));
    if (envResult.exists) {
      process.stderr.write(envLocalSummaryLine(formatEnvLocalSummary(envResult)));
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(
      `review-pi: 无法读取 .env.local（${message}）——本机注入面中止\n`,
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
