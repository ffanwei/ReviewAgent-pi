import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import type { Finding } from "../contracts/finding.js";
import type { ToolCallRecord } from "../contracts/run.js";
import {
  applyPresentationProjection,
  isPresentationProjectionConfigured,
  type PresentationRuntime,
  type PresentationSource,
  type ProjectionOptions,
} from "./presentation-projection.js";

// 呈现投影注入缝单测（ADR-0010 消费端接线）：三态结局——identity（未配置，
// 现状形态）/ projected（投影成功）/ degraded（引擎任何失败，检视产物不丢）。
// 引擎模块是动态 import 的外部 ESM——fixture 在 tmp 目录现场写 .mjs
// （成功 / 抛错 / 协议违规 / 超时各一档，坏引擎不进仓库 fixtures）。

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 写一个 fake 引擎模块到 tmp，返回绝对路径 */
function writeEngineModule(name: string, body: string): string {
  const dir = makeTempDir("review-pi-projection-engine-");
  const file = path.join(dir, name);
  writeFileSync(file, body, "utf8");
  return file;
}

/** 交付一个 finding 的呈现源（结构化字段 + 自然语言字段各就各位） */
function sampleSource(): PresentationSource {
  const finding: Finding = {
    id: "F100",
    severity: "P2",
    category: "CORRECTNESS",
    file: "src/Main.java",
    line: 42,
    title: "Sentinel finding title",
    description: "Sentinel finding description",
    evidence: ["src/Main.java:42"],
    rule: "CORRECTNESS-001",
    confidence: 0.5,
  };
  const toolCallLog: ToolCallRecord[] = [
    { name: "review.readFile", argumentsJson: "{}", resultSummary: "read 3 lines" },
  ];
  return { findings: [finding], toolCallLog };
}

/** 呈现运行时（ADR-0025：显式穿参；seam 单测不读 env） */
const TEST_RUNTIME: PresentationRuntime = {
  apiKey: "sk-seam-sentinel",
  baseUrl: "https://gw.example.com/v1",
  modelId: "test-presentation-model",
  concurrency: 4,
  requestTimeoutMs: 90_000,
};

/** 统一入口：自动补齐 runtime（引擎用例只关心 enginePath / 超时） */
function project(source: PresentationSource, options: ProjectionOptions = {}) {
  return applyPresentationProjection(source, { runtime: TEST_RUNTIME, ...options });
}

/** 成功引擎：只译 title/description，结构化字段与 toolCallLog 原样直通 */
const OK_ENGINE = `
export default async (source) => ({
  provenance: {
    language: "zh",
    terminologyVersion: 1,
    findingLinks: source.findings.map((finding) => ({
      sourceFindingId: finding.id,
      projectedFindingId: finding.id,
    })),
  },
  findings: source.findings.map((finding) => ({
    ...finding,
    title: "[zh] " + finding.title,
    description: "[zh] " + finding.description,
  })),
  toolCallLog: source.toolCallLog,
});
`;

test("未配置引擎（presentation.engine = null）→ identity：恒等直通，无投影", async () => {
  const outcome = await project(sampleSource(), { enginePath: null });
  expect(outcome).toEqual({ kind: "identity" });
});

test("引擎路径为空白 → identity（空值 = 显式未配置，对齐配置 null 语义）", async () => {
  const outcome = await project(sampleSource(), {
    enginePath: "   ",
  });
  expect(outcome).toEqual({ kind: "identity" });
});

test("引擎已配置但 runtime 缺席 → degraded（呈现接入点缺失，人话；不炸 CLI）", async () => {
  const enginePath = writeEngineModule("needs-runtime.mjs", OK_ENGINE);
  const outcome = await applyPresentationProjection(sampleSource(), { enginePath });
  expect(outcome.kind).toBe("degraded");
  if (outcome.kind === "degraded") {
    expect(outcome.reason).toContain("presentation runtime is not configured");
  }
});

test("isPresentationProjectionConfigured：null/空白 false、非空 true（main 心跳与缝读同一配置项）", () => {
  expect(isPresentationProjectionConfigured(undefined)).toBe(false);
  expect(isPresentationProjectionConfigured(null)).toBe(false);
  expect(isPresentationProjectionConfigured("   ")).toBe(false);
  expect(isPresentationProjectionConfigured("./engine.mjs")).toBe(true);
});

test("引擎成功 → projected：findings 换投影版（title/description 已译）+ provenance 透传", async () => {
  const enginePath = writeEngineModule("ok-engine.mjs", OK_ENGINE);
  const outcome = await project(sampleSource(), {
    enginePath: enginePath,
  });
  expect(outcome.kind).toBe("projected");
  if (outcome.kind !== "projected") {
    return;
  }
  // 自然语言字段已译；结构化字段字节直通（引擎只改 title/description）
  expect(outcome.findings).toHaveLength(1);
  expect(outcome.findings[0]).toMatchObject({
    id: "F100",
    severity: "P2",
    file: "src/Main.java",
    line: 42,
    title: "[zh] Sentinel finding title",
    description: "[zh] Sentinel finding description",
    evidence: ["src/Main.java:42"],
    rule: "CORRECTNESS-001",
    confidence: 0.5,
  });
  expect(outcome.provenance).toEqual({
    language: "zh",
    terminologyVersion: 1,
    findingLinks: [{ sourceFindingId: "F100", projectedFindingId: "F100" }],
  });
});

test("相对路径（相对进程 cwd）→ 同样可加载（配置里写相对引擎路径的形态）", async () => {
  const absolute = writeEngineModule("relative-engine.mjs", OK_ENGINE);
  const relative = path.relative(process.cwd(), absolute);
  const outcome = await project(sampleSource(), {
    enginePath: relative,
  });
  expect(outcome.kind).toBe("projected");
});

test("引擎抛错 → degraded：人话 reason 含引擎错误信息（检视产物不丢）", async () => {
  const enginePath = writeEngineModule(
    "throwing-engine.mjs",
    `export default async () => { throw new Error("gateway 503"); };`,
  );
  const outcome = await project(sampleSource(), {
    enginePath: enginePath,
  });
  expect(outcome.kind).toBe("degraded");
  if (outcome.kind === "degraded") {
    expect(outcome.reason).toContain("presentation engine failed");
    expect(outcome.reason).toContain("gateway 503");
  }
});

test("模块文件不存在 → degraded：加载失败人话（不炸 CLI）", async () => {
  const outcome = await project(sampleSource(), {
    enginePath: path.join(makeTempDir("no-such-"), "missing-engine.mjs"),
  });
  expect(outcome.kind).toBe("degraded");
  if (outcome.kind === "degraded") {
    expect(outcome.reason).toContain("failed to load presentation engine module");
  }
});

test("default 非函数 → degraded：协议违规人话", async () => {
  const enginePath = writeEngineModule("not-a-function.mjs", `export default 42;`);
  const outcome = await project(sampleSource(), {
    enginePath: enginePath,
  });
  expect(outcome.kind).toBe("degraded");
  if (outcome.kind === "degraded") {
    expect(outcome.reason).toContain("no default function export");
  }
});

test("返回形状坏（findings 非数组）→ degraded：协议违规人话", async () => {
  const enginePath = writeEngineModule(
    "bad-shape.mjs",
    `export default async () => ({ provenance: { language: "zh", terminologyVersion: 1, findingLinks: [] }, findings: "nope" });`,
  );
  const outcome = await project(sampleSource(), {
    enginePath: enginePath,
  });
  expect(outcome.kind).toBe("degraded");
  if (outcome.kind === "degraded") {
    expect(outcome.reason).toContain("invalid document");
    expect(outcome.reason).toContain("findings must be an array");
  }
});

test("同步 throw 的引擎（非 async 工厂）→ degraded：不向上炸（回归锁——检视成功后 stdout 不能整丢）", async () => {
  const enginePath = writeEngineModule(
    "sync-throw-engine.mjs",
    `export default () => { throw new Error("sync boom"); };`,
  );
  const outcome = await project(sampleSource(), {
    enginePath: enginePath,
  });
  expect(outcome.kind).toBe("degraded");
  if (outcome.kind === "degraded") {
    expect(outcome.reason).toContain("failed to start");
    expect(outcome.reason).toContain("sync boom");
  }
});

test("同步返回非 Promise 的引擎 → 照常投影（协议不强制 async，Promise 化兜住）", async () => {
  const enginePath = writeEngineModule(
    "sync-return-engine.mjs",
    `export default (source) => ({
      provenance: {
        language: "zh",
        terminologyVersion: 1,
        findingLinks: source.findings.map((finding) => ({
          sourceFindingId: finding.id,
          projectedFindingId: finding.id,
        })),
      },
      findings: source.findings.map((finding) => ({
        ...finding,
        title: "[zh] " + finding.title,
        description: "[zh] " + finding.description,
      })),
      toolCallLog: source.toolCallLog,
    });`,
  );
  const outcome = await project(sampleSource(), {
    enginePath: enginePath,
  });
  expect(outcome.kind).toBe("projected");
  if (outcome.kind === "projected") {
    expect(outcome.findings[0]?.title).toBe("[zh] Sentinel finding title");
  }
});

test.each([
  {
    label: "投影整体为 null（引擎忘返回）",
    body: `export default async () => null;`,
    reason: "projection must be an object",
  },
  {
    label: "finding 条目非对象",
    body: `export default async () => ({
      provenance: { language: "zh", terminologyVersion: 1, findingLinks: [{ sourceFindingId: "F100", projectedFindingId: "F100" }] },
      findings: [null],
      toolCallLog: [],
    });`,
    reason: "each finding must be an object",
  },
  {
    label: "toolCallLog 非数组",
    body: `export default async (source) => ({
      provenance: { language: "zh", terminologyVersion: 1, findingLinks: [] },
      findings: source.findings,
      toolCallLog: "nope",
    });`,
    reason: "toolCallLog must be an array",
  },
  {
    label: "findingLinks 与 findings 长度不一致（留痕一比一纪律）",
    body: `export default async (source) => ({
      provenance: { language: "zh", terminologyVersion: 1, findingLinks: [] },
      findings: source.findings,
      toolCallLog: source.toolCallLog,
    });`,
    reason: "must match findings one-to-one",
  },
  {
    label: "terminologyVersion 为 NaN",
    body: `export default async (source) => ({
      provenance: {
        language: "zh",
        terminologyVersion: Number.NaN,
        findingLinks: source.findings.map((finding) => ({
          sourceFindingId: finding.id,
          projectedFindingId: finding.id,
        })),
      },
      findings: source.findings,
      toolCallLog: source.toolCallLog,
    });`,
    reason: "terminologyVersion must be a finite number",
  },
])("返回形状坏（$label）→ degraded：$reason", async ({ body, reason }) => {
  const enginePath = writeEngineModule("bad-shape.mjs", body);
  const outcome = await project(sampleSource(), {
    enginePath: enginePath,
  });
  expect(outcome.kind).toBe("degraded");
  if (outcome.kind === "degraded") {
    expect(outcome.reason).toContain("invalid document");
    expect(outcome.reason).toContain(reason);
  }
});

test("引擎超时 → degraded：总超时兜底（引擎迟到结果丢弃，进程不炸）", async () => {
  const enginePath = writeEngineModule(
    "slow-engine.mjs",
    `export default async (source) => {
      await new Promise((resolve) => setTimeout(resolve, 5_000));
      return {
        provenance: { language: "zh", terminologyVersion: 1, findingLinks: [] },
        findings: source.findings,
        toolCallLog: source.toolCallLog,
      };
    };`,
  );
  const outcome = await project(sampleSource(), {
    enginePath: enginePath,
    timeoutMs: 100,
  });
  expect(outcome.kind).toBe("degraded");
  if (outcome.kind === "degraded") {
    expect(outcome.reason).toContain("did not finish within 100ms");
  }
  // 落败引擎的迟到 rejection 已被兜住：等一小段确认无 unhandled rejection 崩进程
  await new Promise((resolved) => setTimeout(resolved, 150));
});

// ---- 分组式检视意见（ADR-0017）：与 zh 弱耦合 —— tips 坏只折损这一份产物 ----

/** 合法 tips 文档（10 键封闭，逐键值域合规） */
const TIP_OBJECT = `{
  code: "int x = 1;",
  review: "此处取值可能为空。",
  suggestion: "改为先判空。",
  category: "CORRECTNESS",
  subcategory: "",
  severity: "Minor",
  ruleId: "",
  lineNum: 42,
  source: "common-reviewer",
  confidence: "Medium",
}`;

/** 成功引擎 + 合法 tips 文档 */
const OK_TIPS_ENGINE = `
const tip = ${TIP_OBJECT};
export default async (source) => ({
  provenance: {
    language: "zh",
    terminologyVersion: 1,
    findingLinks: source.findings.map((finding) => ({
      sourceFindingId: finding.id,
      projectedFindingId: finding.id,
    })),
  },
  findings: source.findings.map((finding) => ({
    ...finding,
    title: "[zh] " + finding.title,
    description: "[zh] " + finding.description,
  })),
  toolCallLog: source.toolCallLog,
  tips: { files: [{ filePath: "src/Main.java", reviewTips: [tip] }] },
});
`;

test("合法 tips → projected 携带 tips（顶层严格 { files }，键集原样透传）", async () => {
  const enginePath = writeEngineModule("tips-ok-engine.mjs", OK_TIPS_ENGINE);
  const outcome = await project(sampleSource(), {
    enginePath: enginePath,
  });
  expect(outcome.kind).toBe("projected");
  if (outcome.kind !== "projected") {
    return;
  }
  expect(outcome.tipsProblem).toBeUndefined();
  expect(outcome.tips).toEqual({
    files: [
      {
        filePath: "src/Main.java",
        reviewTips: [
          {
            code: "int x = 1;",
            review: "此处取值可能为空。",
            suggestion: "改为先判空。",
            category: "CORRECTNESS",
            subcategory: "",
            severity: "Minor",
            ruleId: "",
            lineNum: 42,
            source: "common-reviewer",
            confidence: "Medium",
          },
        ],
      },
    ],
  });
});

test.each([
  {
    label: "缺 tips 文档",
    body: OK_ENGINE,
    reason: "no grouped tips document",
  },
  {
    label: "files 非数组",
    body: `export default async (source) => ({
      provenance: { language: "zh", terminologyVersion: 1, findingLinks: source.findings.map((f) => ({ sourceFindingId: f.id, projectedFindingId: f.id })) },
      findings: source.findings.map((f) => ({ ...f, title: "[zh] " + f.title, description: "[zh] " + f.description })),
      toolCallLog: source.toolCallLog,
      tips: { files: "nope" },
    });`,
    reason: "tips.files must be an array",
  },
  {
    label: "tip 多一个键（严格封闭）",
    body: `export default async (source) => ({
      provenance: { language: "zh", terminologyVersion: 1, findingLinks: source.findings.map((f) => ({ sourceFindingId: f.id, projectedFindingId: f.id })) },
      findings: source.findings.map((f) => ({ ...f, title: "[zh] " + f.title, description: "[zh] " + f.description })),
      toolCallLog: source.toolCallLog,
      tips: { files: [{ filePath: "src/Main.java", reviewTips: [{ ...${TIP_OBJECT}, extra: 1 }] }] },
    });`,
    reason: "exactly these keys",
  },
  {
    label: "severity 越界（Critical 不在三档内）",
    body: `export default async (source) => ({
      provenance: { language: "zh", terminologyVersion: 1, findingLinks: source.findings.map((f) => ({ sourceFindingId: f.id, projectedFindingId: f.id })) },
      findings: source.findings.map((f) => ({ ...f, title: "[zh] " + f.title, description: "[zh] " + f.description })),
      toolCallLog: source.toolCallLog,
      tips: { files: [{ filePath: "src/Main.java", reviewTips: [{ ...${TIP_OBJECT}, severity: "Critical" }] }] },
    });`,
    reason: 'severity must be one of "Fatal", "Major", "Minor"',
  },
])("tips 形状坏（$label）→ 仍是 projected + tipsProblem（zh 不受牵连）", async ({ body, reason }) => {
  const enginePath = writeEngineModule("tips-bad-engine.mjs", body);
  const outcome = await project(sampleSource(), {
    enginePath: enginePath,
  });
  expect(outcome.kind).toBe("projected");
  if (outcome.kind !== "projected") {
    return;
  }
  // zh 侧投影仍成立（findings 已译、provenance 在）
  expect(outcome.findings[0]?.title).toBe("[zh] Sentinel finding title");
  expect(outcome.provenance.language).toBe("zh");
  expect(outcome.tips).toBeUndefined();
  expect(outcome.tipsProblem).toContain(reason);
});
