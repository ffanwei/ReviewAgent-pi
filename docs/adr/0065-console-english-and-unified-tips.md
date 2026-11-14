# 0065. 控制台恒英文：取消呈现翻译投影，中文 tips 统一由片级语义生成提供

> **后续修订（[ADR-0090](0090-chinese-native-review.md)，2026-11-14）**：本 ADR 的「控制台 / `reviews_en.json` 恒英文」与「片级语义生成产 tips」被取代——候选直接产出中文与 `tips` 语义块，stdout 与 `reviews_all.json`（原 `reviews_en.json`）即为中文真源；语义生成的第二次模型调用整体退役。12 键 tips 形状与置信度 / 严重级过滤口径（ADR-0052）不变。

**状态**：已接受（2026-11-09）
**关联**：ADR-0010（检视输出恒英文 + 核外翻译投影——本 ADR 取消其中「控制台呈现档」的一半）、ADR-0045（MCP 业务 tool 与统一 tips——本 ADR 把「统一生成」扩为唯一真源）、ADR-0017（分组意见导出）、ADR-0021（呈现模型档）、ADR-0022（`reviews_zh.json` 停产）、ADR-0052（四档严重级与置信度过滤）、ADR-0059（呈现投影部分降级——本 ADR 后仅存于 legacy 代码）、ADR-0062（一次性调用超时）
**范围**：本仓 pi 线 0065。只改 CLI 呈现面与中文 tips 的来源；六阶段骨架、检视请求字节、审计 / `reviews_en.json` 契约不变。

## Context

ADR-0010 把「中文呈现」放在核外翻译投影里，CLI 在检视结束后调用该投影，把 `title` / `description` 等自然语言字段逐字段译成中文：

- **控制台 stdout**：注入 `presentation.engine` 时输出中文呈现档，并追加 `presentation` 留痕键；
- **中文 tips**：业务上报关闭时，`reviews_tips_zh.json` 的唯一生产者就是这同一次投影。

ADR-0045 之后，业务上报开启的 run 已经改由**片级统一语义生成**产出 tips（与 `mrReviewResult` 同一份语义），呈现投影只做 stdout。于是每次检视出现两条中文管线，且控制台那条是纯粹的重复劳动：

- 每条 finding 至少 2 次**串行**网关调用（`title`、`description`），长描述单字段可达 30 s+；
- 大 MR / 多分片下这些调用占总时长与 token 的显著比例；
- 控制台的实际消费者（人快速扫、脚本解析）并不需要翻译——机器可读面本来就该恒英文，中文交付物是 tips 文件与 MCP 报文。

同时，「业务关闭时靠呈现引擎产 tips」意味着 tips 的生产者随业务开关漂移：同一份英文 findings，打开 MCP 得到 12 键统一形态，关闭 MCP 得到 10 键引擎形态，两条路径的文本、过滤与降级语义都不同。这个分叉没有产品价值。

## Decision

1. **控制台 stdout 恒英文，不做任何翻译。**
   - CLI 不再调用呈现投影；stdout 的 `findings` 直接取 `record.baseline.findings`（与审计、`reviews_en.json` 同一份英文真源）。
   - 移除 stdout 的 `presentation` 留痕键（连同 `PresentationFootprint` 类型与「投影成功 / 降级」两套语义）。投影不再发生，留痕无从谈起。
   - `presentation.engine` 配置项保留（读取、校验、路径解析行为不变），但**不再驱动控制台翻译**；历史上注入的引擎模块不会再被加载。

2. **中文 tips 的唯一真源 = 片级语义生成。**
   - 与 `mrReviewResult` 使用同一份语义输出：12 键形态（10 键 + `id` + `level`），业务开关不改变内容形态。
   - 业务开启：片级回调里已经生成并登记语义，收尾零额外调用。
   - 业务关闭：收尾对**经 `limits.confidence.min` / `limits.severity.min` 过滤后的 `keptFindings`** 补做一次 `buildShardReportResilient`，只登记语义、不发 MCP 报文。这是「统一生成 = 唯一真源」的兜底，不是第二条管线。

3. **移除呈现引擎回落。**
   - 此前「统一 tips 全灭 → 呈现引擎按全量模式回落」的路径删除。引擎不再是 tips 生产者。
   - 选源简化为：
     - 有产出 ⇒ 落盘；
     - 零 findings 或全部被过滤 ⇒ 产 `[]`（这是确定事实，不是生成失败）；
     - 有 finding 但零覆盖（生成失败 / 逐条被拒）⇒ 不产文件并清除陈旧，stderr 逐条留痕。

4. **配置面语义收窄。**
   - `model.presentation` 仍生效：报文生成、总结生成与片级语义生成的模型档（ADR-0021 / ADR-0045）。
   - `presentation.engine` 保留为兼容键，不再影响控制台或 tips。
   - `limits.timeouts.presentationRequestMs` / `presentationBufferMs` / `limits.retry.presentationAttempts` / `limits.concurrency.suggestion` 仍被 legacy 模块与配置校验引用，数值不动。

5. **保留 legacy 代码，不做删除式收敛。**
   - `packages/review-pi/src/cli/presentation-projection.ts` 与根 `src/presentation/*`（`engine-zh.ts` / `translate-projection.ts` / `tips.ts`）留在仓库与发行物里，供外部消费方与历史调用方使用；CLI 不再调用它们。
   - 因此它们导出的类型、打包产物与 `pnpm build:presentation` 不变，避免破坏公共导出与发布面。

6. **阶段账本去掉「呈现投影」行。**
   - `StageClock.projectionMs` 删除，`buildStageBreakdown` 不再列出该段；「中文 tips 组装 / 落盘」段继续存在，业务关闭时也包含那次语义生成。

## Consequences

- **成本**：业务开启的大 MR 不再有「每条 finding 2 次串行翻译」的开销；控制台路径的网关调用归零。业务关闭的 run 多一次一次性调用（仅当存在通过过滤的 finding），换来与业务开启一致的 tips 形态。
- **可观测性**：控制台恒英文后，stderr 不再出现「呈现投影进行中 / 降级 / 部分降级」类心跳；tips 失败的原因统一收敛为「语义生成失败 / 未覆盖」两类文案。
- **消费者**：需要中文的人看 `reviews_tips_zh.json` 或平台 MCP 报文；需要机器可读的人拿 stdout 单 JSON 即可，且与英文真源逐字段同源。
- **兼容性**：配置键与 legacy 模块保留，已有配置文件不会报错，外部对呈现引擎的直接调用也不受影响；但它们不再是 CLI 的运行时依赖。
- **测试面**：进程测试中业务关闭的单片 run 请求数由 6 变 7（六回合检视 + 一次语义生成）；呈现投影的成功 / 降级 / 路径解析用例退役，改为「引擎配置不再触发翻译」的恒英文断言；中文 tips 生命周期用例改为统一生成口径。
