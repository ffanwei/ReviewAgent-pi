# 0059. 呈现投影按字段部分降级

**状态**：已接受（2026-11-09，用户决策）
**关联**：[ADR-0010](0010-inspection-language-pinned-english-with-out-of-kernel-translation.md)（英文产出 + 核外翻译投影）、[ADR-0017](0017-out-of-kernel-grouped-review-tips-export.md)（核外分组意见）、[ADR-0045](0045-mcp-business-task-tools.md)（统一 tips 与呈现引擎分链）、[ADR-0051](0051-llm-call-retry-and-timeout.md)（LLM 调用重试与超时）
**范围**：本仓 pi 线 0059。只改**呈现投影的失败粒度**：单字段翻译失败从「整次投影降级英文源」收窄为「该字段保留英文 + provenance 留痕」。检视产物、审计、英文 findings、退出码零改动；全量成功时 stdout 逐字节同旧形态。

## Context

呈现投影（ADR-0010）在检视结束后动态加载 `presentation.engine`，逐字段翻译 `Finding.title` / `Finding.description`（以及工具摘要）。旧实现是**全有或全无**：

- `translateField` 对任何非空输入拿不到非空译文就抛错；
- `projectReviewDocument` 不捕获字段错误；
- CLI 缝把任何抛出归为 `degraded`，stdout 整份回退英文源。

生产上因此出现「**投影一直失败，但 `reviews_tips_zh.json` 正常**」：统一 tips（ADR-0045）走内核自己的 one-shot 调用（review 模型、`json_object`、逐 finding 组装），与呈现引擎是两条独立链路。tips 的成功不能证明引擎链路健康；反过来，引擎链路里**任意一个字段**（长 description、偶发空 completion、单次 4xx）失败，就会让几十条已经译好的 finding 一起退回英文。

这与「提高呈现成功率」的产品目标不符：失败隔离粒度太粗，一个字段的偶发问题被放大成整次投影失败。

## Decision

### 1. 失败只降级该字段，不再整次回退

`translateField` 改为**部分降级**：

- 引擎抛错、返回非字符串、或对非空输入返回空/纯空白译文 ⇒ 该字段保留英文源文本；
- 字段路径记入 `provenance.degradedFields`，首个失败原因记入 `provenance.degradedReason`（截断 200 字符）；
- 其余字段照常翻译，`language` 仍为 `zh`。

成功路径（无任何字段失败）不写这两个键——整键缺席，stdout 与旧形态逐字节相同。

### 2. 系统级失败快速短路

逐字段回退不能把死网关放大成「每个字段都等满重试」：

- 引擎**抛错**（网络 / HTTP / 超时）先按内容级失败隔离：当前字段回退英文，**下一字段照常调用**——单个「输入太长 / 单条 4xx」不会把后面几十个字段全部拖成英文；
- **连续 2 个字段**抛错才判定网关/引擎整体不可用：剩余字段不再调用引擎，直接英文回退并逐个记账；
- 空/空白译文同样先按内容级失败逐字段继续；连续 **3** 个字段空译文后判定系统级失败并短路。

这样一次全挂的投影最多探测两个字段（引擎内部重试仍由 ADR-0051 负责），墙钟有界；偶发单字段失败只损失该字段，仍产出可用的混合语言文档。

### 3. 源字段类型非法仍是装配错误

`Finding.title` / `description` 非字符串属于源文档畸形，不是翻译失败，继续 fail fast 抛错，由 CLI 缝归整次 `degraded`。降级只兜「翻译没成功」，不掩盖「输入本身坏了」。

### 4. provenance 是机器可读的留痕面

`PresentationProvenance` 追加两个可选键（缺席省键）：

```json
{
  "language": "zh",
  "terminologyVersion": 1,
  "findingLinks": [],
  "degradedFields": ["findings[0].description"],
  "degradedReason": "findings[0].description: engine returned an empty translation"
}
```

CLI 缝校验其形状：`degradedFields` 必须是非空字符串数组，`degradedReason` 必须是字符串；坏形状仍归整次 `degraded`（stdout 是机器契约，不输出垃圾）。

CLI 在部分降级时额外打一行 stderr（stdout 只报事实）：

```text
review-pi: 呈现投影部分降级（findings[0].description 保留英文）：findings[0].description: ...
```

整份回退仍沿用原有一行：

```text
review-pi: 呈现投影降级为英文源文档（<reason>）
```

### 5. 中英混合是正常形态

ADR-0010 已规定代码标识、文件路径、API 名、代码摘录保持英文；中文叙述里出现这些英文标识是正常输出。本 ADR 只处理「**叙述文字**没译成中文」的字段：逐字段回退后，同一份文档里可能有的 finding 全中文、有的 finding 某字段保留英文，这是可接受的降级形态，且比整份英文保留了更多已译内容。

## Options（为什么不是别的）

- **整份回退（现状）**：否。失败放大到全量，一个字段的偶发问题让所有已译内容作废；生产已反复出现。
- **按 finding 回退（title 或 description 之一失败就把整条 finding 退回英文）**：否。会丢弃同一条里已经成功的译文，且与「代码描述中英混合正常」的事实不符；逐字段隔离已经足够避免半条坏数据。
- **失败字段填空串**：否。静默丢内容比保留英文更差，消费者无法区分「没译」和「没有内容」。
- **失败后改走一次性 JSON 调用重译**：否。新增一套提示词与终检，且把呈现路径重新耦合到内核一次性调用链；本 ADR 只收紧失败粒度，不新增生成链。
- **引擎抛错后每个字段都继续重试**：否。死网关下每个字段都等满 `perFieldTimeoutMs × maxAttempts`，墙钟不可接受；连续 2 次抛错即短路是成功率与成本的折中，同时保住单次抛错的字段级隔离。
- **把 degradedFields 写进 stderr 而不进 stdout**：否。部分降级不是整次失败，消费者需要机器可读地知道哪些字段保留英文；stderr 只做人类可读摘要。

## Consequences

- 单字段/单条 finding 的翻译失败不再让整次投影降级；生产成功率显著提高。
- 全量成功路径零改动：provenance 无新键，stdout / 审计 / `reviews_en.json` 逐字节同旧形态。
- 部分降级时 stdout 的 `presentation` 键携带 `degradedFields` / `degradedReason`，下游可按字段回退英文。
- 死网关的投影墙钟从「每个字段都等满重试」降为「两次探测 + 剩余字段直接回退」；偶发单字段失败不再影响后续字段。
- 中英混合文档成为显式支持的降级形态；不再追求「整份文档必须单一语言」。
- 测试面：`tests/presentation/translate-projection.test.ts` 锁定逐字段回退、系统级短路与零漂移；`packages/review-pi/src/cli/presentation-projection.test.ts` 锁定 provenance 形状校验；`tests/presentation/engine-zh.test.ts` 锁定引擎装配层的部分降级。
