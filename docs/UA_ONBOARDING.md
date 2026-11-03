# ReviewAgent-pi 上手指南

> 更新说明：本文件按 **ADR-0024 收窄后的仓库形态**（Review CLI 产品仓）重写。此前的上手指南基于一份覆盖「A–E 配置矩阵 + 评测仪器层」的知识图谱（`.ua/knowledge-graph.json`），其中 `src/experiment`、`src/judge`、`src/metrics`、`src/dataset`、`src/gate`、`src/instrument`、`scripts/` 等已全部删除，图谱需重新生成后再作为参照。

## 1. 项目总览

- **名称**：`review-agent-pi`（pi 内核线）
- **定位**：**pi 内核线的 Review CLI 产品仓**。Review Runtime 在 pi 内核的 npm 上游包（`@earendil-works/{pi-ai,pi-agent-core,chord,pi-telemetry}`，精确锁 `0.85.1`，ADR-0035）上从 0 重写，一条命令完成一次检视，产出英文 findings 与中文按行分组建议。规则 Skill 是唯一形态；配置矩阵、`configId` 身份维度与评测仪器层已按 ADR-0024 删除。
- **语言**：TypeScript 为主，另有 Markdown、JSON/YAML、少量 Java/diff 夹具。
- **工具链**：Node ≥22、pnpm workspace、TypeScript（strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`）、Vitest。
- **跨仓关系**：DSH 内核线兄弟仓 `MustacheXb/ReviewAgent`；两仓 ADR 独立编号，引用 DSH 仓决策必须写「DSH 线 ADR-XXXX」（见 `AGENTS.md`）。

## 2. 架构分层

| 层 | 职责 | 关键文件 |
|---|---|---|
| **Review Runtime（pi 内核线）** | 单案全链：MR 边界护栏 → 规则 Skill 装载 → 六阶段 agent-loop（七工具 + Context Ledger）→ 候选门 → 审计/记录/转录/意见导出 | `packages/review-pi/src/run/review-run.ts`、`loop/agent-review-loop.ts`、`tools/toolkit.ts`、`gate/candidate-gate.ts` |
| **CLI 与呈现** | 参数解析、配置装载（`~/.PiAgent/PiAgent.jsonc`）、结果投影、退出码；核外中文呈现注入缝 | `packages/review-pi/src/cli/{args,main,render,config-command}.ts`、`packages/review-pi/src/shared/config.ts`、`src/presentation/{translate-projection,tips,engine-zh}.ts` |
| **pi 内核（npm 依赖）** | pi-ai 模型接入、pi-agent-core 代理循环、chord 编排、telemetry 遥测；上游包，按 `dependencies` 精确锁版 | `node_modules/@earendil-works/*`（源码不在本仓） |
| **测试与夹具** | 内核单测、CLI 进程烟测、golden 常量 | `packages/review-pi/src/cli/bin.process.test.ts`、`packages/review-pi/testdata/golden/*`、`tests/presentation/*` |
| **文档与 ADR** | 项目说明、决策记录、设计方案、历史报告 | `README.md`、`CONTEXT.md`、`AGENTS.md`、`docs/adr/*`、`docs/运行手册-单次检视.md` |
| **构建与 CI** | workspace、TS 配置、Vitest、GitHub Actions | `package.json`、`pnpm-workspace.yaml`、`tsconfig*.json`、`vitest.config.ts`、`.github/workflows/ci.yml` |

## 3. 关键概念

- **唯一形态**：工具驱动六阶段循环 + Context Ledger 恒开 + 规则 Skill 恒装载；没有 A–E 配置分派。运行配置只有一层（`~/.PiAgent/PiAgent.jsonc` 或 `--config`，ADR-0025），env 层已移除。
- **规则 Skill**：只有两种**显式**输入面（`--rule-skill-zip` / `--rule-skill <dir>`，一次可传多个——逗号列表或重复旗标，先 zip 后目录）；不扫描被检视仓库的 `.review-rules/`（ADR-0027）。**一个包就是一个 skill**（ADR-0034：包内 ≥2 个 skill 一律降级，没有包内消歧旗标）。Phase 5 之后为每个包开独立检视会话（ADR-0014），候选按 `(file, line, category)` 合并后交 Phase 6 裁定。没给规则包 = 合法降级（stderr 一行提示、exit 0），`--strict-rule-skill` 才升级为错误。
- **测量常量面**：system prompt、六阶段指令、七工具 schema 的字节真源在 `testdata/golden/*`，由 `loop/phases.test.ts`、`zonea/system-prompt.test.ts` 断言逐字节一致；运行期死钉 5 项（轮次 / 工具调用 / 工具结果预算 / 呈现 temperature / effort）由 ADR-0025 锁定。
- **MR 边界护栏**：`run/mr-boundary-guard.ts` 做纯度量（缺省 ≤10 文件 / ≤2000 变更行，`limits.boundary` 可配、`null` 关闭），超界只标注 `domainWarning` + 审计 `mrBoundary`，不拒检、不改请求字节。
- **审计与记录**：审计落盘 `<tasks 根>/<taskId>/audit/<ts>.json`（requests / toolCallLog / phaseLog / rejections / ledger / ruleSkill / skillPassLog / config 快照）；`RunRecord` 落 `<tasks 根>/<taskId>/runs/run.json`（ADR-0032 定内部形态、ADR-0033 定位置：`--taskId` 必需，一个任务目录一次 run，无 case / rep 层）。`<ts>` = 首次模型请求时刻（`20261031_101010_123`），同时是 `runId`。
- **语言边界**：检视输出恒英文（测量面冻结）；中文只经核外翻译投影（ADR-0010），内核无语言键。
- **中文交付物**：只有 `reviews_tips_zh.json`（ADR-0017 / ADR-0022），按文件分组、同文件同行去重（ADR-0023）；`reviews_zh.json` 已停产。
- **配置解析**：`shared/config.ts` 读一次用户级 JSONC 成不可变快照，全量生效值 + 来源 + digest 进审计；秘密只记 `set|missing`。env 通道已在 ADR-0025 移除；`review-llm` 的 resolver 已随该包一起删除（ADR-0035），当前没有第二套「显式参数 → env → 缺省」回退链。
- **内核依赖边界**：`@earendil-works/*` 是 npm 上游包（ADR-0035），改动需走 `pnpm patch` 或推动上游；应用逻辑不要写进 `node_modules`。

## 4. 导览（7 步）

1. **项目总览** — `README.md`、`CONTEXT.md`、`AGENTS.md`、`docs/adr/0024-*`
2. **CLI 入口** — `packages/review-pi/src/cli/args.ts` → `main.ts` → `render.ts`
3. **全链运行时** — `run/review-run.ts` → `loop/agent-review-loop.ts`（三钩子）→ `tools/toolkit.ts`
4. **规则 Skill** — `knowledge/rule-skill.ts`（定位/审计/解压/装载）→ `knowledge/skill-pass.ts`（独立会话）
5. **候选与审计** — `gate/candidate-gate.ts`、`audit/audit-writer.ts`、`experiment/run-record.ts`
6. **呈现层** — `src/presentation/translate-projection.ts` → `tips.ts` → `engine-zh.ts`
7. **验证与回归** — `pnpm --filter review-pi test`（内核 + 进程烟测）、`pnpm test`（呈现层）

## 5. 文件地图（按层，精选）

### 呈现层（root，核外）

- `src/presentation/translate-projection.ts`：英文产物 → 呈现语言的投影（en 恒等直通 / zh 注入引擎；结构化字段字节直通）。
- `src/presentation/tips.ts`：Finding → `reviews_tips_zh.json` 的 10 键严格封闭映射与分组。
- `src/presentation/engine-zh.ts`：真引擎装配（网关 + 凭据复用配置的 `reviewer.*`，ADR-0025 后不再读 env；`suggestion` 生成）。
- `src/presentation/terminology.ts`：术语表单源（版本号随投影留痕）。

### Review Runtime（`packages/review-pi/src`）

- `run/review-run.ts`：单案全链唯一入口（边界护栏 → 规则 Skill → agent 循环 → 审计/记录/转录/导出）。
- `loop/`：`agent-review-loop.ts`（三钩子骨架）、`phases.ts`（六阶段指令）、`messages.ts`（初始 user 消息）。
- `tools/`：七工具装配、Ledger、结果预算；`zoneb/`：符号索引、仓库上下文、diff 分析。
- `audit/`、`experiment/run-record.ts`、`export/`：留痕与产物投影。
- `cli/`：参数、主缝、stdout 渲染、呈现投影注入、进度投影。
- `provider/`：pi 客户端、网关双探针、fake fetch（离线语料）。

### 内核依赖（`node_modules/@earendil-works/*`）

- `pi-ai`：模型契约、provider 模型数据、`api/*`、`auth/*`。
- `pi-agent-core`：`harness/context`、`harness/session`、`harness/runtime`、`harness/compaction`。
- `chord`：编排原语。
- `pi-telemetry`：遥测桩。

这四包是 npm 上游发行物（tarball 只含 `dist` 与 `.d.ts`），源码不在本仓，也不参与本仓构建（ADR-0035）。

## 6. 复杂度热点（谨慎修改）

1. `@earendil-works/pi-ai` 的 `types`（npm 依赖的 d.ts）— 全局类型契约，改动只能经上游或 `pnpm patch`。
2. `@earendil-works/pi-agent-core` 的 session 状态机 — 同上。
3. `packages/review-pi/src/run/review-run.ts` — 单案全链单点，改一处要回归整条产物链（`review-run.test.ts` 12 条用例）。
4. `packages/review-pi/src/loop/agent-review-loop.ts` — 三钩子骨架与阶段推进，直接影响 wire 字节与 phaseLog。
5. `packages/review-pi/src/cli/main.ts` — stdout 单 JSON 契约、退出码与呈现降级语义。
6. `packages/review-pi/src/knowledge/rule-skill.ts` — 装载审计与缓存根，写错会污染被检仓库。
7. `src/presentation/engine-zh.ts` — 逐字段网关调用与建议生成，成本与超时敏感。

**上手建议**：先读 `README.md` / `CONTEXT.md` / ADR-0009 与 ADR-0024，再读 ADR-0025–0027（配置面、引擎路径、产物路径与规则包信任边界），然后按导览从 CLI 入口走到全链运行时，重点理解 `review-run.ts` 的单路径装配与 `agent-review-loop.ts` 的阶段推进；最后用 `pnpm --filter review-pi test` 与 `pnpm test` 验证理解。
