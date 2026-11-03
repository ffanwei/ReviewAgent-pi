# 从 0 基于 pi 内核重写 Review Runtime（取代 ADR-0005 / ADR-0006 的 DSH 内核形态）

**后续修订**：[ADR-0035](0035-upstream-kernel-as-npm-deps-and-single-package.md)（2026-11-03）——本 ADR 的「以 pi **fork**（锚定 `6671c604`）为基座」、「仪器冻结（判定链继续走 review-llm）」两条前提被取代：内核四包改为 **npm 上游依赖** `@earendil-works/*`（精确锁 `0.85.1`），默认只消费上游 `dist`，确需改内核时用 `pnpm patch`；`review-llm` 已删除，判定链与评测仪器层更早由 ADR-0024 废止。「Review Runtime 从 0 重写、应用逻辑不写进内核」的主干结论不变。

《ReviewAgent以DSH内核和PI内核的方案对比分析》以「可扩展性」为前置给出 DSH-first 结论；用户随后追加前提「不考虑 ReviewAgent Runtime 的扩展复用」（决策背景见 `docs/design/pi 内核可行性分析.md`，Pi 70 / DSH 30），2026-09-18 拍板反转：**pi-kernel 分支上以 pi fork（锚定 `6671c604`，接线见《Pi 内核定制基线方案》）为基座，Review Runtime 从 0 重写**。与 DSH 线的关键差别：DSH 线把 POC1 代码作为共享模块源做内核迁移（ADR-0005 的「POC1 主体冻结 + 内核侧重写」姿态）；本决策把现有实现整体降为行为参照——代码不导入，只保留两个角色：**评测装置**（判定链 / 指标 / 数据集 / 双门协议，冻结平移）与**期望生成器**（P2 字节门的离线对照源）。DSH 内核（`packages/review-dsh`）随之移除；其评测数据（`runs/phase2-dsh`，450 单元）保留并成为最终对照的基线侧——「pi 负责把 ReviewAgent 做出来，DSH 数据作为 Runtime Benchmark 对照」。实现方案全文见《Pi 内核从零实现方案》。

## 决策

- **从 0 边界**：Review Runtime（loop 组装 / 上下文组装 / `review.*` 工具 / 审计投影 / CLI）在 pi 原语（pi-agent-core Agent / agent-loop 钩子、pi-ai 统一 Provider API）上重写为 `packages/review-pi`；spec 真源 = 《总体架构设计方案》+ ADR + 《VUL4J 评测方案》。
- **仪器冻结**：判定链（judge 继续走 review-llm）、指标、人工抽检、校准、数据集物化、实验 runner、对齐门 CLI 平移复用、行为冻结——重写仪器会引入判定漂移，科学增益为零。Claude Code 外部参照（`src/reference`）保留。
- **评测口径对齐 DSH**：pi 侧最终评测与 `runs/phase2-dsh` 逐字段同协议（30 案 × A–E × 3 rep × `deepseek-v4-flash` × verifier off × judge `glm-5-3-260814` 判定链）；验收 = 双门——A/B 请求字节对照 DSH 审计真源（`requests[].wireBody`，已实测存在）逐字节一致；指标对齐门按 #30 对称 max σ 带（ADR-0007 第三轮应用）。
- **DSH 内核移除**：`packages/review-dsh`、实验 CLI `--kernel` 缝、`@deepseek-ai/dsh-sdk-protocol` 依赖、CI discipline-gate 作业一并移除；字节纪律改由 root golden bytes 断言携带，pi 线 P2 票以「对照 DSH 审计」形式重建纪律门。
- **退役时点**：`src/` 运行时模块（loop / run / tools / zoneb / codeintel / contracts / finding / audit / shared / fake / deepseek）在 P2 字节门绿、P4 runner 接缝切换后退役；此前它们是 runner 的活依赖（`src/deepseek` 是实验 CLI 缺省客户端）与期望生成器。

## Considered Options

- **增量适配**（基线方案姿态：POC1 为共享模块源，pi 内核做接缝）/ **从 0 重写**——被选后者：复用约束解除后，DSH 线「共享模块源」的历史包袱（双客户端、双序列化器、parity 票）不必继承；pi 原语面足够（agent-loop 钩子、`Model.baseUrl`、`onPayload` wire 捕获，均已核实）。
- **仪器也从 0** / **仪器冻结平移**——被选后者：判定链重写引入 judge 漂移风险，直接威胁与 DSH 数据的可比性——本次对照实验的立身之本。
- **judge 切 pi-ai** / **judge 留 review-llm**——被选后者：变量隔离（唯一变量 = 内核）；pi-ai 只承担被测侧。
- **全配置字节门** / **分层（A/B 字节门 + C/D/E 语义门）**——被选后者：工具 schema 的 wire 序列化是内核面（不同 SDK 构造上不可字节一致），phase2 main↔dsh 对照已确立先例。

## Consequences

- 工作量重排：从 0 面 ≈ 6k 行内核 + 1k 集成；仪器 ≈ 10k 行平移；比 DSH 线省（装置 / 方法 / 文档 / 数据全在），净成本集中在 P2 字节纪律与 P5 真跑（pi 侧 450 单元 + judge 网关成本）。
- 对照实验的前提被显式化：测量常量面（提示词 / 上下文组装 / 判定链）byte 或行为一致，内核变量面（Agent 状态 / 工具调用协议 / wire 序列化 / 会话）是被比较量——cache 命中率差异属内核效应，报告单列 `cacheReadTokens` 口径，不与质量结论混排。
- token 口径归一成为硬票：DSH usage `{inputTokens, outputTokens, cacheReadTokens}` ↔ pi-ai usage 字段映射 + 已知记录断言（P1）。
- ADR-0005 / ADR-0006 转为历史记录（DSH 线已按其完成使命并归档）；ADR-0007 对齐门协议第三轮应用；ADR-0008 的接入面语义在 pi 侧由 pi-ai 等价承担。
- 评测数据迁移为前置事项：`phase2-*` 与 `.cache/datasets` 从主工作仓拷入（`runs/` gitignored，零 git 影响）。

## 补记：期望生成器收口（P4b，#9，2026-09-22）

「退役时点」已到并执行完毕：P2 字节门绿（A/B 请求体对照 DSH 审计真源逐字节一致，门本体与黄金真源已随 P3/P4 收进 `packages/review-pi/src/bytegate` 与 `packages/review-pi/testdata/golden`）+ P4a 内核执行缝就绪（#8）后，`src/{loop,run,tools,zoneb,codeintel,contracts,finding,audit,shared,fake}` 与 `src/deepseek`（实验 CLI 缺省客户端）同批退役删除。

**期望生成器角色就此收口**。旧运行时在 P2 的第二角色是 A/B 请求体对照的期望生成器（golden bytes 由它产出并与 DSH 审计真源互证）；该职责已结构化固化——字节门与黄金真源迁入 pi 包后自携带字节纪律，DSH 审计真源是数据（`runs/phase2-dsh*`，重锚可移植），均不再依赖旧代码的活执行。删除是受控替换而非证据删除：审计、报告、git 历史（本补记之前的全部提交）与 archive 分支保留完整历史实现。

收口后的保全与边界：

- **单一内核**：执行路径全部收敛到 pi（`packages/review-pi`，经 `src/experiment/pi-kernel.ts` 适配）；实验 CLI `--kernel`/`--verifier` 旗标退役（未知 flag 拒绝），`cliOptionsToPlan` 钉死 `kernel: "pi"` / `verifier: "off"`（pi 恒 baseline-only，二遍复核消融面只存在于历史记录）。
- **历史记录可读**：`plan.kernel` 的 `"legacy"` 保留为只读值——`#8` 前持久化的 plan.json 归一为 legacy，`--report-only` 照常消费历史实验；续跑守卫双向拦截（plan.json 内核冲突 / model-verifier 漂移均启动即报错）。
- **读侧口径内联**：Evidence Gate 判定口径（含 `VerificationVerdict` 原形）内联至 `src/gate/candidate-gate.ts`；Cache Break 计数面收敛至 `src/instrument/cache-break.ts`（分类器执行面随内核退役，pi 以同形留痕 `CacheBreakRecord`）；RunRecord 记录契约冻结不动（`verifier`/`effective`/`verifierPass` 字段保留供消费历史记录，`report.verifierAblation` 在历史 plan `verifier: "on"` 时照常重建）。
