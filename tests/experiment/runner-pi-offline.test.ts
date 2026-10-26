import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ConfigId } from "../../src/instrument/contracts/config.js";
import type { MRCase } from "../../src/instrument/contracts/mr-case.js";
import type { ExperimentOutcome } from "../../src/experiment/runner.js";
import { piKernel } from "../../src/experiment/pi-kernel.js";
import { FAILURES_FILE, PLAN_FILE, runExperiment } from "../../src/experiment/runner.js";
import { SAMPLE_MR_CASE } from "../fixtures/sample-mr-case.js";
import { type SseStep, type SseFetchScript, sixPhaseNoToolSteps, sseFetchScript } from "../helpers/pi-sse-fetch.js";
import { experimentPlan } from "./helpers.js";

/**
 * #8 P4a 执行缝离线集成 / #9 P4b 单一内核：真 pi 内核（非桩 runReviewFn）经
 * runExperiment 全链 × A–E 全配置。piKernel 只注入 SSE fake 传输层——pi 内核从
 * 请求参数装配、六相位协议、Zone B/C 上下文构建（真仓库扫描 + tree-sitter）、
 * 审计落盘、记录映射全部真跑；root 侧断言缝的两端契约：
 * - 记录完整：5 条 RunRecord 经 RunStore 布局落盘，usage 逐请求对账（6 × 脚本值）；
 * - pi 审计布局：<root>/audit/vul4j/<case>/<config>/rep-N/audit/<runId>.json，
 *   requests[].wireBody 在位且携带计划模型 id（重放字节真源）；
 * - 断点续跑协议复用：已完成单元重跑全跳过（零网络）；
 * - 失败单元隔离：4xx 不可重试单发即抛，其余单元照常完成，续跑只补失败单元。
 * 「runner 是记录唯一写者（persistRecord: false 防双写/孤儿记录）」的内核侧
 * 证明在 pi 包 review-run.test；此处证明记录经 runner 单写者路径完整落盘。
 * 真实 vul4j 案例 + 真网关的经缝小样见 tests/e2e/pi-seam-matrix.e2e.ts。
 */

/**
 * vul4j 口径样例：SAMPLE_MR_CASE 的仓库/diff/真值不动，labels.source 改挂
 * "vul4j"——pi 记录的 source 硬编码 vul4j（pi 内核是 vul4j 线，他源 fail fast）。
 */
const VUL4J_SAMPLE_CASE: MRCase = {
  ...SAMPLE_MR_CASE,
  labels: { ...SAMPLE_MR_CASE.labels, source: "vul4j" },
};

const CONFIGS: readonly ConfigId[] = ["A", "B", "C", "D", "E"];

/** 每请求脚本 usage：11/2/0 → 单元六请求对账 {inputTokens: 66, outputTokens: 12} */
const REPLY_USAGE = { promptTokens: 11, completionTokens: 2, cacheReadTokens: 0 } as const;
const UNIT_USAGE = { inputTokens: 66, outputTokens: 12, cacheReadTokens: 0 } as const;

let workDir: string;

beforeAll(async () => {
  workDir = await mkdtemp(path.join(tmpdir(), "review-agent-pi-seam-"));
});

afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

function rootOf(id: string): { readonly experimentRoot: string } {
  return { experimentRoot: path.join(workDir, id) };
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await readFile(filePath, "utf8")) as unknown;
}

/** happy 脚本 × units 单元（零工具六相位） */
function happySteps(units: number): SseStep[] {
  return Array.from({ length: units }, () => sixPhaseNoToolSteps(REPLY_USAGE)).flat();
}

/** 真 pi 内核 + SSE fake 经缝跑一轮（同 root 复用同一 experimentId 与计划形态） */
async function runOfflinePiExperiment(
  experimentRoot: string,
  options: { readonly steps?: readonly SseStep[] } = {},
): Promise<{ readonly outcome: ExperimentOutcome; readonly script: SseFetchScript }> {
  const plan = experimentPlan({
    experimentId: "pi-seam-offline",
    sources: ["vul4j"],
    configs: [...CONFIGS],
    reps: 1,
    kernel: "pi",
  });
  const script = sseFetchScript(options.steps ?? []);
  const outcome = await runExperiment(
    plan,
    [VUL4J_SAMPLE_CASE],
    {
      // legacy 运行时已随 #9 退役删除：deps 上已无 legacy 客户端注入位（零触达由类型系统钉死）
      kernel: piKernel({ apiKey: "offline-test-key", fetch: script.fetch }),
    },
    { experimentRoot },
  );
  return { outcome, script };
}

describe("runExperiment × pi 内核执行缝（离线 A–E 全链）", () => {
  it("A–E 全配置经缝真跑：5 记录完整落盘 + usage 对账 + pi 审计布局", async () => {
    const { experimentRoot } = rootOf("offline-ae");
    const { outcome, script } = await runOfflinePiExperiment(experimentRoot, { steps: happySteps(5) });

    expect(outcome.executed).toBe(5);
    expect(outcome.resumed).toBe(0);
    expect(outcome.failures).toEqual([]);
    expect(outcome.records).toHaveLength(5);
    // 真 pi 内核执行：每单元六请求（六相位零工具协议），5 配置 × 6
    expect(script.requests).toHaveLength(30);

    const caseId = SAMPLE_MR_CASE.caseId;
    const byConfig = new Map(outcome.records.map((record) => [record.configId, record]));
    for (const configId of CONFIGS) {
      const record = byConfig.get(configId);
      expect(record, `config ${configId} record`).toBeDefined();
      expect(record).toMatchObject({
        source: "vul4j",
        caseId,
        configId,
        rep: 1,
        model: "deepseek-v4-flash",
        verifier: "off",
      });
      // usage 对账：六请求 × 脚本值（pi-ai 口径 input = prompt − cache hit）
      expect(record?.baseline.usage).toEqual(UNIT_USAGE);
      expect(record?.baseline.rounds).toBe(1);
      expect(record?.baseline.toolCalls).toBe(0);
      expect(record?.effective).toBeNull();
      expect(record?.verifierPass).toBeNull();

      // RunStore 布局（runner 单写者路径）：runs/vul4j/<case>/<config>/rep-1.json
      const recordPath = path.join(experimentRoot, "runs", "vul4j", caseId, configId, "rep-1.json");
      const onDisk = (await readJson(recordPath)) as { readonly model: string; readonly baseline: { readonly usage: unknown } };
      expect(onDisk.model).toBe("deepseek-v4-flash");
      expect(onDisk.baseline.usage).toEqual(UNIT_USAGE);

      // pi 审计布局：审计文件在 pi 内核的落盘位形，wireBody 携带计划模型 id
      const auditPath = record?.baseline.auditPath ?? "";
      expect(path.dirname(auditPath)).toBe(
        path.join(experimentRoot, "audit", "vul4j", caseId, configId, "rep-1", "audit"),
      );
      const audit = (await readJson(auditPath)) as {
        readonly requests: readonly { readonly wireBody: string }[];
      };
      expect(audit.requests).toHaveLength(6);
      for (const request of audit.requests) {
        const wire = JSON.parse(request.wireBody) as { readonly model: string };
        expect(wire.model).toBe("deepseek-v4-flash");
      }
    }

    // 经缝透传的配置特有审计键（B 预取 / C 全仓 / D 双缺省 / E 恒投影台账）
    expect(byConfig.get("B")?.baseline.audit.prefetch).toBeDefined();
    expect(byConfig.get("C")?.baseline.audit.fullRepo).toBeDefined();
    expect(byConfig.get("D")?.baseline.audit.fullRepo).toBeUndefined();
    expect(byConfig.get("D")?.baseline.audit.ledger).toBeUndefined();
    expect(byConfig.get("E")?.baseline.audit.ledger).toEqual([]);

    // 检视产物经 runner 缝（ADR-0013）：reviews_en.json 全配置；session 仅 C/D/E；
    // runner 无呈现投影缝 ⇒ 永不产 reviews_zh.json（zh 只由 CLI 缝编排）。
    for (const configId of CONFIGS) {
      const configDir = path.join(experimentRoot, "runs", "vul4j", caseId, configId);
      expect(existsSync(path.join(configDir, "rep-1", "reviews_en.json"))).toBe(true);
      const sessions = readdirSync(configDir).filter(
        (name) => name.startsWith("session-") && name.endsWith(".json"),
      );
      expect(sessions, `config ${configId} session files`).toHaveLength(
        configId === "A" || configId === "B" ? 0 : 1,
      );
      // 转录形状（C/D/E）：{ info, messages, view } 顶层三键 + view 首条为合成 system
      if (sessions.length === 1) {
        const transcript = (await readJson(path.join(configDir, sessions[0] ?? ""))) as {
          readonly view: { readonly messages: readonly { readonly type: string }[] };
        };
        expect(Object.keys(transcript).sort()).toEqual(["info", "messages", "view"]);
        expect(transcript.view.messages[0]?.type).toBe("system");
      }
    }
    const configFiles = readdirSync(path.join(experimentRoot, "runs", "vul4j", caseId), {
      recursive: true,
    });
    expect(configFiles.some((name) => String(name).endsWith("reviews_zh.json"))).toBe(false);
  });

  it("断点续跑协议复用（pi 内核路径）：已完成 5 单元重跑全跳过、零网络", async () => {
    const { experimentRoot } = rootOf("offline-resume");
    const first = await runOfflinePiExperiment(experimentRoot, { steps: happySteps(5) });
    expect(first.outcome.executed).toBe(5);
    expect(first.outcome.failures).toEqual([]);

    // plan.json 携带 kernel 键（续跑一致性检测的数据源）
    const planOnDisk = (await readJson(path.join(experimentRoot, PLAN_FILE))) as { readonly kernel?: string };
    expect(planOnDisk.kernel).toBe("pi");

    // 零脚本重跑：任何网络请求都会炸（no scripted step）——全跳过才是唯一出路
    const second = await runOfflinePiExperiment(experimentRoot);
    expect(second.outcome.resumed).toBe(5);
    expect(second.outcome.executed).toBe(0);
    expect(second.outcome.failures).toEqual([]);
    expect(second.outcome.records).toHaveLength(5);
    expect(second.script.requests).toHaveLength(0);
  });

  it("失败单元隔离 + 续跑补投：C 单元网关 4xx 单发即抛，A/B/D/E 照常完成；重跑同根只补 C", async () => {
    const { experimentRoot } = rootOf("offline-isolation");
    // A、B 各六步 → C 第 1 步 400（pi-ai 对 4xx 不重试）→ D、E 各六步
    const steps: SseStep[] = [...happySteps(2), { httpStatus: 400 }, ...happySteps(2)];
    const first = await runOfflinePiExperiment(experimentRoot, { steps });

    expect(first.outcome.executed).toBe(4);
    expect(first.outcome.resumed).toBe(0);
    expect(first.outcome.failures).toHaveLength(1);
    expect(first.outcome.failures[0]).toMatchObject({
      source: "vul4j",
      caseId: SAMPLE_MR_CASE.caseId,
      configId: "C",
      rep: 1,
    });
    // 失败留痕携带网关拒绝痕迹（4xx 不可重试：单发即抛）
    expect(first.outcome.failures[0]?.message).toMatch(/400/);
    // 记录完整可回读：4 条，C 缺席
    expect(first.outcome.records.map((record) => record.configId)).toEqual(["A", "B", "D", "E"]);

    // 续跑补投：只补 C（六步），其余 4 单元零网络跳过
    const second = await runOfflinePiExperiment(experimentRoot, { steps: sixPhaseNoToolSteps(REPLY_USAGE) });
    expect(second.outcome.resumed).toBe(4);
    expect(second.outcome.executed).toBe(1);
    expect(second.outcome.failures).toEqual([]);
    expect(second.outcome.records).toHaveLength(5);
    expect(second.script.requests).toHaveLength(6);

    // failures.json 覆盖为空（此前失败、现已补投成功的单元不再计入）
    const failuresOnDisk = await readJson(path.join(experimentRoot, FAILURES_FILE));
    expect(failuresOnDisk).toEqual([]);
  });
});
