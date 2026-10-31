# 0021. 呈现（翻译 / suggestion）模型的缺省跟随检视模型

**状态**：已接受（2026-10-30；ADR-0025 修订其配置载体：`REVIEW_PI_PRESENTATION_MODEL` → 配置键 `model.presentation`）
**关联**：ADR-0010（英文产出 + 核外翻译投影）、ADR-0017（分组意见的 `suggestion` 生成）、`src/presentation/engine-zh.ts`（模型解析）、`packages/review-pi/src/cli/presentation-projection.ts`（呈现源契约）
**跨仓**：本 ADR 为本仓 pi 线序列 0021；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

翻译与 `suggestion` 生成各发一次 `chat/completions`，模型 id 原先只有两级：

1. `REVIEW_PI_PRESENTATION_MODEL`；
2. 缺省 `deepseek-v4-flash`。

当时的理由是「呈现配置不是实验自变量，不与被测模型 `--model` 耦合」。这条在**官方直连**下成立：base URL 固定 `https://api.deepseek.com`，模型名是公开 id 集合，`deepseek-v4-flash` 一定可用。

但**网关档**下这条假设破了。`REVIEWER_URL` 指向方舟 / 自建网关时，可路由的模型集合由服务端决定：

- 用户常用 `--model ep-xxxxxxxx`（接入点 ID）——网关只认这一个；
- 呈现模型仍是写死的 `deepseek-v4-flash`，网关返回 4xx / 模型不存在；
- 而**翻译失败是整次降级**（不是单条空串，`translateField` 拒绝空译文），于是「检视成功、中文全灭」，且只在 stderr 留一行 `呈现投影降级为英文源文档（…）`。

结果是：调用方必须记得**同时**配两个模型 id（`--model` 与 `REVIEW_PI_PRESENTATION_MODEL`），漏一个就静默失去中文。这与凭据面的直觉不一致——`REVIEWER_URL` / `REVIEWER_API_KEY` 本来就是「一份配置管两个通道」，模型却是「两份配置」。

## Decision

1. **模型解析改成三级链**：`REVIEW_PI_PRESENTATION_MODEL` → 本次检视的 `--model` → `deepseek-v4-flash`。前两级 `trim()` 后非空才生效（与既有的 env 解析口径一致）。
2. **`--model` 经呈现源透传，不走环境变量回写**。`PresentationSource` 增可选 `modelId`（`packages/review-pi/src/cli/presentation-projection.ts`），`main.ts` 填 `args.model`；核外引擎在 `REVIEW_PI_PRESENTATION_MODEL` 缺席时消费它。**不**在 CLI 里改 `process.env`——那会让「引擎自己的配置面」和「CLI 的进程环境」纠缠，且顺序敏感。
3. **显式配置仍压过一切**。要「检视用 `ep-xxx`、翻译用便宜模型」时，照旧写 `REVIEW_PI_PRESENTATION_MODEL=…`，行为与本 ADR 之前完全一致。
4. **直调引擎（不经 CLI）仍可独立工作**：`source.modelId` 缺失 ⇒ 落到 `deepseek-v4-flash`（既有缺省），root 侧 e2e / 单测无需改。
5. **呈现配置仍不是实验自变量**：本 ADR 只改**缺省值**，不把呈现语言/模型塞进 plan、审计或内核执行缝（ADR-0010 的边界不动）。`presentation.model` 也不进审计——它是运行环境，不是检视事实。

## Options（为什么不是别的）

- **让 CLI 在投影前写 `process.env.REVIEW_PI_PRESENTATION_MODEL = args.model`**：改环境变量的副作用会延续到进程退出，且与「显式配置优先」的判定顺序强耦合（要先判空再写），排障时看不出模型从哪来。放弃。
- **给引擎加 `--model` 参数**：引擎是核外模块、由 `REVIEW_PI_PRESENTATION_ENGINE` 注入，没有自己的命令行面；要新增参数就得扩协议。放弃。
- **把 `deepseek-v4-flash` 换成「读 `REVIEW_MODEL_ID`」**：`REVIEW_MODEL_ID` 是内核缺省常量，不含 `--model` 的显式覆盖；用户传 `ep-xxx` 时仍会错。放弃。
- **保持两级、只在文档里提醒「网关档记得配两个」**：正是本次要消除的静默失败模式。放弃。
- **翻译失败改为逐字段降级（保留英文原文而非整次降级）**：会产出一份中英混排、且 `language: "zh"` 名不副实的文档，比「明确降级为英文源」更难判读。不在本 ADR 范围。

## Consequences

- **正**：
  - **一份配置原则**：`REVIEWER_URL` / `REVIEWER_API_KEY` / `--model` 三项即可跑通网关档中文，漏配不再静默失去 zh；
  - **ep-xxx 场景自愈**：`--model ep-xxx` 时翻译自动打同一接入点；
  - 显式配置优先级不变，已有 `.env.local` 无需改动。
- **负/风险**：
  - **成本默认上升**：没配 `REVIEW_PI_PRESENTATION_MODEL` 时，翻译改用检视同档模型（可能贵于 `deepseek-v4-flash`）。要省钱需显式写一个轻模型——手册已把这条写在 `.env.local` 示例里。
  - **呈现结果与检视模型绑定**：换检视模型会连带动译文（同为 LLM 输出，非确定）。这是跟随的代价，也是跟随的目的。
  - **跨模块契约多一字段**：`PresentationSource.modelId` 是可选键，旧引擎实现忽略它也不会坏；但「谁消费它」成了一条需要保持的约定（核外引擎）。
- **中性**：不新增环境变量、不新增旗标、不改退出码与审计/RunRecord 形状；A–E 字节冻结面零改动。

## 验收标准

1. `REVIEW_PI_PRESENTATION_MODEL` 覆盖 `source.modelId`：请求体 `model` = 显式值。
2. 未配置且 `source.modelId = "ep-review-20261030"`：请求体 `model` = `ep-review-20261030`。
3. 未配置且无 `source.modelId`（直调引擎）：请求体 `model` = `deepseek-v4-flash`。
4. CLI 进程面：`--model <id>` 的 run 的呈现请求全部使用 `<id>`（除非 env 显式覆盖）——翻译与 suggestion 同一模型。
5. 既有断言不回归：显式覆盖用例、凭据缺失用例、投影形状校验全部保持绿。
