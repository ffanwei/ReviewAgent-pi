// review-pi 公开导出面：root 侧经 workspace 依赖 `review-pi` 消费的最小面——
// 内核入口（runReview）+ 记录类型（RunRecord）+ 共享契约类型（Finding /
// RunResult / ToolCallRecord，供核外中文呈现引擎单源导入）+ 网关解析
// （resolveReviewerEndpoint）+ 网关双探针（前置诊断）。包内其余模块不进公开面：
// fake-fetch / testing 是测试专用，cli 是进程入口，e2e 是本包测试。
//
// 纪律：本文件只做 re-export，零逻辑；新增导出需先过 package.json
// exports map 与 dist 构建验证（types 链到 vendored pi-ai dist d.ts）。

export { runReview, type ReviewRunInput, type ReviewRunResult } from "./run/review-run.js";
export type {
  AuditLight,
  RunRecord,
  RunSnapshot,
  ExperimentSource,
  VerifierMode,
} from "./experiment/run-record.js";
export type { Finding } from "./contracts/finding.js";
export type { RunResult, ToolCallRecord } from "./contracts/run.js";
export { resolveReviewerEndpoint, type ReviewerEndpoint } from "./provider/reviewer-endpoint.js";
export type { PresentationRuntime } from "./cli/presentation-projection.js";
export {
  formatSmokeDiagnostics,
  runSmokeProbes,
  type SmokeProbeInput,
  type SmokeProbesResult,
} from "./provider/gateway-probe.js";
