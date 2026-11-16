# 0093. 检视模型单源：忽略 `--model`、配置必须显式 `model.default`（阶段 1）

**状态**：已接受（2026-11-16，用户决策：`review` 忽略 `--model` 但保留旗标并告警；`model.default` 必须显式；`smoke --model` 保留；`reviewer.modelFallback` 阶段 1 保留键+告警、阶段 2 删除）
**关联**：[ADR-0025](0025-user-config-file.md)（配置是唯一来源、env 层关闭——本 ADR 收窄其模型优先级链）、[ADR-0080](0080-model-fallback-on-model-not-found.md)（`--model` 探测与降级——本 ADR 使其触发前提失效）、[ADR-0021](0021-presentation-model-follows-review-model.md)（展示模型跟随检视模型——链改写为 `presentation → model.default`）、[ADR-0091](0091-retire-presentation-layer.md)（保留 `model.presentation`）、[ADR-0008](0008-reviewer-model-swappable-with-capability-scoped-metrics.md)（模型是评测量——单源是其可核对性的前提）
**范围**：本仓 pi 线 0093。阶段 1 改 `review` 的 `--model` 语义、配置显式性、`reviewer.modelFallback` 状态、仓库内调用方与文档；不改 `smoke` 的 `--model` 语义、不删 `model.presentation`、不改单次请求的序列化字节。阶段 2（删除旗标与降级键/代码）不在本 ADR 实施，由维护清单 M-002 追踪。

## Context

ADR-0025 定下「配置是唯一来源」，但模型 id 一直是例外：CLI `--model` 优先于 `model.default`，缺省再回落钉住的评审模型。这个例外在实验期是有意的（模型是实验数据），但当平台/运维用 `--model ep-xxxx` 驱动生产检视时，模型来源分裂成两处：

- 「这份检视是谁做的」同时取决于调用方脚本与配置文件，审计只能记录结果、无法约束来源；
- ADR-0080 为了兜住 `--model` 写错，又引入了一次前置探测与单边降级——一个只为「CLI 覆盖」存在的失败面；
- 同一份部署配置下，不同调用方可以跑出不同的模型与成本，评测口径与成本账本都失去单源。

用户决策：检视模型一律取配置文件 `model.default`，`--model` 逐步退场；本 ADR 记录阶段 1（忽略值但保留旗标、显式告警），阶段 2 再删除旗标与降级机制。

## Decision

1. **`review` 忽略 `--model` 的值**：生效模型恒为 `modelIdForGateway(config.model.default, reviewer.stripModelPrefix)`。旗标仍被接受（不破坏既有脚本），裸旗标 / 空值 / 重复出现都不再是用法错误。
2. **零静默告警**：每次传入 `--model` 都在 stderr 打一行「已废弃并忽略（传入值；生效模型取配置文件 model.default `<id>`）」；参数回显两行——`--model` 显示原始值 + 「已废弃，已忽略」，新增 `生效模型` 行显示配置值与来源。usage 文案标注废弃。
3. **配置必须显式 `model.default`**：`review`（以及未传 `--model` 的 `smoke`）在 apiKey 检查之后、任何模型请求之前检查 `overridden` 是否含 `model.default`；缺失即 `ConfigError` 并给出补救动作（补键或 `config init`）。`config init/show`、`export`、`version` 豁免。`DEFAULT_MODEL_ID` 只保留为 `config init` 模板值与 `config show` 的来源标记，不再是运行期回落。
4. **`smoke --model` 保留**：它是探针目标，不产出检视结果、不影响成本归属；忽略它会逼用户先改配置才能诊断一个 id。显式传参时不再要求配置含 `model.default`。
5. **`reviewer.modelFallback` 阶段 1 退场**：键仍被识别（旧配置不会突然报未知键），装载期给一条废弃告警；生效值恒 `"off"`，`main.ts` 不再调用 `resolveReviewModel` 与模型探测，审计 / `run.json` 不再写 `modelFallback`。`provider/model-fallback.ts` 保留但标 `TODO(ADR-0093 阶段2)`，与键一起在阶段 2 删除。
6. **展示模型链改写**：`model.presentation` 保留；解析链从 `presentation → --model → default` 变为 `presentation → model.default`（代码本来就以生效模型为缺省，无需行为改动，只改文档）。
7. **仓库内调用方同批迁移**：offline-replay lane 把 `scenario.model` 写进 lane 配置的 `model.default` 并删除 `--model`（否则请求体 `model` 变化会让 trace 哈希整批失配）；两份 diff-review eval skill 与 `scripts/eval` 不再透传 `--model`；文档与示例配置同步。
8. **阶段 2 留痕**：维护清单新增 `M-002`（状态「生效中，阶段 2 未完成」），写清触发信号与清账条件；ADR 正文保留「阶段 2：未完成」；代码标记 `TODO(ADR-0093 阶段2)`；阶段 1 契约由测试锁住（传 `--model` 必告警、生效模型恒为配置值）。
9. **阶段 2 的失败语义（预先定死）**：`--model` 改为专用错误「已移除，检视模型取 model.default」，旗标 token 再留一个版本后清理；触发器 = 仓库内已无 `--model` 调用方且平台侧确认不再传，满足后下一版本执行。

## Options（为什么不是别的）

- **继续让 `--model` 覆盖配置，只加告警**：否。没有解决来源分裂；告警会被批跑日志淹没，模型仍可被调用方悄悄改写。
- **直接把 `--model` 变成未知旗标（一次到位删除）**：否。会立刻打断所有现存脚本与平台调用方，且失去「先告警、后删除」的迁移窗口；用户明确选择“逐步删除”。
- **静默忽略**：否。平台侧会以为跑的是接入点 id，实际跑默认模型——这正是 ADR-0080 要防的「静默换模型」，比失败更糟。
- **配置文件缺 `model.default` 时回落内置值**：否。那会让“配置是唯一来源”在首跑时失效；显式报错配 `config init` 指引更可核验。注意 apiKey 也只能来自配置文件，所以该错误只在“文件存在但缺键”时可达。
- **`smoke` 一起忽略 `--model`**：否。smoke 是诊断命令，不是检视；牺牲诊断能力换字面一致没有收益。
- **`model.presentation` 一并收编到 `model.default`**：否。它是独立的成本/质量取舍，不是本次要解决的来源分裂；ADR-0091 刚刚刻意保留。

## Consequences

- **好**：一次 run 的模型来源可核验（配置单一来源）；ADR-0080 的探测请求与替换分支从常态路径消失；调用方脚本与配置的行为差被显式告警暴露；阶段 2 的删除面已被清单与代码标记圈定。
- **破坏性**：只有 `reviewer.apiKey` 的最小配置从此跑不了 `review`，必须补 `model` 键（`config init` 生成完整模板）；平台/脚本传 `--model ep-xxxx` 会收到告警并跑 `model.default`——迁移动作是把该 id 写进配置。
- **风险**：`reviewer.modelFallback` 在阶段 1 是“已知但无效”的键，阅读配置的人可能误以为仍有兜底；由装载期告警与文档双重标注缓解。`provider/model-fallback.ts` 暂时是无调用点的死代码，由 `TODO` 标记与 M-002 圈定；阶段 2 删除前不得重新接线。
- **测试面**：`args` / `args-echo` / `config` 单测改写模型语义；进程测试删除 5 条降级集成用例，改为「忽略但不探测 / 降级键告警 / 缺键 fail fast / smoke 覆盖保留」；`test:replay` 验证 lane 模型迁移后 trace 仍命中。
- **阶段 2 未完成**：见 `docs/待优化维护清单.md` M-002。
