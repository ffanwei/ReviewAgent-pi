# ReviewAgent-pi 上手指南

> 图谱新鲜度：已检查。图谱提交 `fef8d5c` = 当前 `HEAD`，已提交/暂存区无差异。工作区新增了未跟踪的 `.opencode/*.json` 与本文件（`docs/UA_ONBOARDING.md`），未纳入图谱；其余源码与图谱一致。
>
> 数据来源：`.ua/knowledge-graph.json`（3816 节点 / 7966 边，核心 `src`、`packages/review-pi`、`packages/review-llm` 为 LLM 语义分析）。

## 1. 项目总览

- **名称**：`review-agent-pi`（pi 内核线）
- **定位**：在 pi 内核（vendored `ai` / `agent` / `chord` / `telemetry`）上从 0 重写 Review Runtime，并与 DSH 兄弟仓 `MustacheXb/ReviewAgent` 在同一评测集、同一冻结判定链上做**内核无关性对照**。
- **语言**：TypeScript 为主（924 文件），另有 Markdown、JSON/YAML、少量 Java/diff 夹具。
- **框架/工具**：Node ≥22、pnpm workspace、Vitest、TypeScript、tree-sitter。
- **规模**：1142 个受分析文件（941 code / 123 docs / 77 config / 1 infra），图谱 3816 节点、7966 边、10 层、8 步导览。

## 2. 架构分层

| 层 | 职责 | 关键文件 |
|---|---|---|
| **Review Agent 应用层** (100) | 实验编排、数据集、采样、判定、指标、门禁、报告 | `src/experiment/cli.ts`、`src/experiment/runner.ts`、`src/experiment/plan.ts`、`src/judge/orchestrate.ts`、`src/metrics/aggregate.ts`、`src/sampling/sampler.ts` |
| **Review Runtime（pi 内核）** (95) | 基于 pi 重写的运行时：bytegate、disposition、loop、tools、zoneb | `packages/review-pi/src/run/review-run.ts`、`packages/review-pi/src/disposition/record.ts`、`packages/review-pi/src/zoneb/symbols.ts`、`packages/review-pi/src/tools/toolkit.ts` |
| **LLM 抽象层** (9) | review-llm：模型解析、profile、DeepSeek 适配 | `packages/review-llm/src/resolver.ts`、`profile.ts`、`deepseek.ts`、`reviewer.ts` |
| **pi 内核（vendored）** (369) | pi-ai 模型接入、pi-agent-core 代理循环、chord 编排、telemetry 遥测 | `packages/ai/src/types.ts`、`packages/ai/src/models.ts`、`packages/agent/src/harness/session/session.ts`、`packages/chord/src/delta/index.ts` |
| **测试与验证** (406) | 单元、e2e、pi 接缝矩阵、golden 夹具 | `tests/e2e/pi-seam-matrix.e2e.ts`、`tests/experiment/runner-pi-offline.test.ts`、`packages/review-pi/src/bytegate/semantic-parity.test.ts` |
| **文档与 ADR** (97) | 项目说明、决策记录、设计/报告、交接文档 | `README.md`、`CONTEXT.md`、`AGENTS.md`、`docs/adr/0009-*`、`docs/design/基于 Pi 内核的 Review Agent 总体架构设计方案.md` |
| **构建与配置** (11) | workspace、TS、Vitest、包配置 | `package.json`、`pnpm-workspace.yaml`、`tsconfig*.json`、`vitest.config.ts` |
| **CI 流水线** (1) | GitHub Actions | `.github/workflows/ci.yml` |
| **实验与运维脚本** (13) | 数据采集/物化、阶段分析、门禁 | `scripts/collect-clean-mrs.ts`、`scripts/materialize-vul4j.ts`、`scripts/run-alignment-gate.ts`、`scripts/analyze-phase2.ts` |
| **数据与夹具** (41) | Golden 响应、样本 Java 仓库、benchmark | `packages/review-pi/testdata/golden/*`、`testdata/repos/sample/**`、`packages/agent/benchmark/session/*` |

## 3. 关键概念

- **双内核对照**：本仓是 pi 线，DSH 线是兄弟仓；ADR 引用必须带「DSH 线」限定语（见 `AGENTS.md`）。
- **冻结判定链**：换内核不换尺子。`src/metrics/alignment-gate.ts`、`src/gate/migration-gate.ts` 负责对齐/迁移闸门；指标与判定口径冻结在同一套契约上。
- **实验矩阵**：`src/experiment/plan.ts` 定义「五配置 × 数据源 × 重复」；`runner.ts` 逐单元执行、隔离失败并支持断点续跑；`cli.ts` 负责参数、环境预检与报告落盘。
- **内核适配缝**：`src/experiment/pi-kernel.ts` 把 `UnitReviewRequest` 装配成 review-pi 的 `ReviewRunInput`，再把 pi `RunRecord` 映射回根仓 `RunResult`，并保证 runner 是记录的唯一写者。
- **数据集家族**：clean-MR（阴性对照）、Defects4J、Multi-SWE-bench Java、Vul4J；adapter/sampling 位于 `src/dataset/**`，`mr-boundary-filter.ts` 执行 ≤10 文件 / ≤2K 变更行口径。
- **diff 工具链**：`src/dataset/diff/*` 解析/反转/序列化 unified diff；`inverse-patch.ts`、`verify-inverse.ts` 验证补丁可逆。
- **判定链**：`src/judge/orchestrate.ts` 先跑 T10 规则粗筛，再交给异构 LLM judge 做语义复核，输出规则口径与 judge 口径双份计数/PRF/效率；包含 clean MR 与零 finding 捷径、失败回退与密钥脱敏。
- **指标口径**：`src/metrics/aggregate.ts` 按 config 拆分 rep1 冷启动与 rep2+ 热稳定，跨 case 等权聚合，并生成预热曲线。
- **Runtime 阶段机**：`review-run.ts` 在入口做 MR 边界护栏，按 config 分派零工具六阶段循环（A/B）或工具驱动 `agentLoop`（C/D/E）。
- **静态上下文（Zone B）**：`zoneb/symbols.ts` 用 web-tree-sitter 建 Java 签名级符号索引（类/接口/枚举/record、成员修饰符/返回类型/参数），保证上下文渲染确定性。
- **语义对齐门（bytegate）**：`semantic-parity.ts` 把 DSH 与 pi 的 wire 请求体按已登记方言归一化后深比较，死登记会触发红门。
- **LLM 解析**：`review-llm/src/resolver.ts` 按「显式选项 → 环境变量别名序列 → 缺省值」三层回退解析 key/URL/数值，且 key 不进入错误消息。
- **中文呈现**：检视语言固定英文，展示层做受控翻译（`src/presentation/engine-zh.ts`、`terminology.ts`，对应 ADR-0010）。
- **vendored 边界**：`packages/ai|agent|chord|telemetry` 是上游 vendored 代码，改动需评估上游漂移；应用逻辑不要写进这里。

## 4. 导览（8 步）

1. **项目总览** — `README.md`、`CONTEXT.md`、`AGENTS.md`
2. **实验编排入口** — `src/experiment/cli.ts` → `plan.ts` → `runner.ts`
3. **pi 内核接入** — `src/experiment/pi-kernel.ts`、`packages/review-pi/src/index.ts`、`tools/registry.ts`
4. **数据集、差分与采样** — `src/dataset/index.ts`、`dataset/diff/parse-unified-diff.ts`、`src/sampling/sampler.ts`
5. **评审判定链** — `src/judge/orchestrate.ts` → `prompt.ts` → `parse.ts`
6. **指标、门禁与对齐** — `src/metrics/aggregate.ts`、`verdict.ts`、`alignment-gate.ts`、`src/gate/migration-gate.ts`
7. **报告与中文呈现** — `src/experiment/report.ts`、`src/presentation/engine-zh.ts`、`terminology.ts`
8. **验证与回归** — `tests/e2e/pi-seam-matrix.e2e.ts`、`tests/experiment/runner-pi-offline.test.ts`、`runner-kernel.test.ts`

## 5. 文件地图（按层，精选）

### 应用层

- `src/experiment/`
  - `cli.ts`：解析参数生成 `ExperimentPlan`，装载 `.env.local` 并做环境/judge 预检，执行矩阵或仅重建报告，落盘 `report.json` 与 `dashboard.md`。
  - `plan.ts`：五配置 × 数据源 × 重复的计划契约与校验，展开为运行单元并记录跳过原因。
  - `runner.ts`：逐单元执行、失败隔离、断点续跑、计划/内核兼容校验。
  - `pi-kernel.ts`：根仓请求 ↔ review-pi 运行记录的适配层（唯一记录写者约束）。
  - `run-store.ts` / `report.ts`：运行快照、审计与报告生成。
- `src/dataset/`：`index.ts`（出口）、`mr-boundary-filter.ts`（边界口径）、`clean-mr/*`、`defects4j/*`、`msb-java/*`、`vul4j/*`、`diff/*`。
- `src/judge/`：`prompt.ts`、`gpt-judge-client.ts`、`gpt-request-mapper.ts`、`gpt-response-mapper.ts`、`orchestrate.ts`、`resolve.ts`。
- `src/metrics/`：`quality.ts`、`efficiency.ts`、`tokens.ts`、`screening.ts`、`stats.ts`、`verdict.ts`、`alignment-gate.ts`。
- `src/instrument/`：`contracts/*`（MRCase/Run/Finding/Ledger 等）、`cli-args.ts`、`env-local.ts`、`openai-http-kernel.ts`、`report-io.ts`。
- `src/gate/`：`candidate-gate.ts`、`migration-gate.ts`。
- `src/calibration/`：`mcr-bench.ts`、`agreement.ts`。
- `src/reference/`：Claude Code 参考实现（client/runner/normalize/report）。
- `src/presentation/`：中文引擎与术语表。

### Review Runtime

- `run/review-run.ts`：单案评审全链入口，MR 边界护栏 + 配置分派（A/B 零工具、C/D/E 工具驱动）。
- `loop/phases.ts`：六阶段循环实现；`disposition/*`：Finding 处置记录与回溯锚。
- `bytegate/*`：语义/字节门与 wire 对齐；`zoneb/*`：符号索引与仓库上下文。
- `tools/*`：工具注册/结果预算/搜索工具；`provider/pi-client.ts`：模型客户端；`testing/golden.ts`：golden 断言。

### LLM 抽象

- `resolver.ts`（key/URL/数值三层回退）、`profile.ts`（完成参数）、`deepseek.ts`（后端）、`reviewer.ts`（评审封装）、`index.ts`（导出）。

### vendored pi 内核

- `packages/ai`：`types.ts`（契约）、`models.ts`（目录/分发）、`api/*`（provider 协议）、`providers/*`、`auth/*`。
- `packages/agent`：`harness/context.ts`、`harness/session/*`、`harness/runtime/*`、`harness/compaction/*`。
- `packages/chord`：`src/delta/*`、`src/facets/*`。
- `packages/telemetry`：`src/index.ts`。

## 6. 复杂度热点（谨慎修改）

按图谱度数排序的重点复杂文件：

1. `packages/ai/src/types.ts`（度 221）— 全局类型契约，改动波及所有 provider。
2. `packages/ai/src/compat.ts`（152）— 旧 API 兼容层，删除/改签名风险高。
3. `packages/ai/src/models.ts`（101）— provider 注册与请求分发核心。
4. `packages/agent/src/harness/session/session.ts`（101）、`session/types.ts`（96）、`memory.ts`（88）— 会话状态机。
5. `packages/agent/src/harness/compaction/compaction.ts`（74）、`runtime/lane.ts`（72）— 压缩与并发通道。
6. `packages/ai/src/api/openai-completions.ts`（69）、`anthropic-messages.ts`（61）、`bedrock-converse-stream.ts`（56）— 流式协议适配。
7. `packages/chord/src/delta/index.ts`（50）、`facets/host.ts`（48）— 编排核心。
8. `src/experiment/report.ts`（49）、`run-store.ts`（41）、`cli.ts`（37）、`plan.ts`（36）— 实验主链路，改一处要回归整条判定链。

**上手建议**：先读 `README.md`/`CONTEXT.md`/ADR-0009，再按导览跑一遍 `src/experiment`，重点理解 `pi-kernel.ts` 的适配缝与 `judge/orchestrate.ts` 的双口径判定，最后用 `tests/e2e/pi-seam-matrix.e2e.ts` 与 `tests/experiment/runner-pi-offline.test.ts` 验证理解。
