# 0064. 非 diff 区域过滤：检视意见必须落在本次变更的 hunk 内

**状态**：已接受（2026-11-09，用户决策）
**关联**：[ADR-0023](0023-candidate-gate-and-content-dedup.md)（候选拦截链与内容去重）、[ADR-0052](0052-tips-four-tier-severity-and-confidence-filter.md)（置信度过滤）、[ADR-0056](0056-mr-review-result-covers-files-without-tips.md)（无意见文件补空包）
**范围**：本仓 pi 线 0064。只改**候选拦截链**的准入位置判定与新增配置 `limits.findingScope`；不动机型、提示词字节面、六阶段语义与输出侧过滤。

## Context

大 MR 场景下，模型会把「同文件远处」甚至「根本不在本次 diff 里」的既有问题报成检视意见。10 例 VUL4J 真实评测（`docs/report/VUL4J-10例评测报告-20261109.md`）显示：33 条位置可判定的意见里，22 条落在 hunk 内、8 条在同文件 hunk 外、3 条的文件不在 diff 内；越界的 11 条中有 8 条确实描述了真实问题，但它们**不是本次 MR 引入的**，平台评审人无法据此要求作者修改，属于范围噪声。

用户决策（2026-11-09）：加一个**默认开启**的过滤开关，只保留本次 diff 变更 hunk（含前后可配置行数）内的意见；可显式关闭以保留全量。

## Decision

### 1. 配置面：`limits.findingScope`

```jsonc
"findingScope": { "enabled": true, "contextLines": 10 }
```

- `enabled`：缺省 `true`。关闭 = 不构建位置范围，候选链零介入（内核直调 / 单测零漂移）。
- `contextLines`：缺省 `10`，取值 `0`–`2000`；`0` = 只保留 hunk 内。

### 2. 判定口径

- 单位是 **finding 的新侧行号**：落入某个 hunk 的 `+start,count` 区间，或距 hunk 边界不超过 `contextLines` 行，即视为范围内；多个 hunk 取并集。
- 文件不在本遍 diff → 范围外（原因可区分：`file-not-in-diff`）。
- 以下情况 **fail-open**：空 diff / 解析不出任何文件 / 删除文件（`+++ /dev/null`）/ 只有 mode 变更而没有 hunk 的文件。不因解析不到位置而丢意见。
- 分片模式以**片内 diff** 为准；单片路径以整份 diff 为准。

### 3. 拦截阶段与生效面

新增 `OUT_OF_SCOPE`，位置在 `VERIFICATION_FAILED` 之后、`DUPLICATE_ID` 之前（先证明证据成立，再证明位置相关，最后才判重）。每候选至多留痕一条首个失败阶段。

过滤在 gate 生效，因此 findings / 中文 tips / MCP 上报 / 审计**同时生效**：被拒候选只进入 `rejections` 与 `rejectionCounts.OUT_OF_SCOPE`，不进入任何消费产物。审计 `rejectionCounts` 固定含六类键（含 `OUT_OF_SCOPE: 0`），缺席省键纪律不变。

### 4. 与既有过滤的关系

| 开关 | 作用点 | 影响产物 |
| --- | --- | --- |
| `limits.testFiles.skip` | 检视**输入**（diff 预过滤） | 测试文件整块不进 diff |
| `limits.findingScope` | 候选**拦截链**（本 ADR） | 范围外意见不产 findings / tips / 上报 |
| `limits.severity.min` / `limits.confidence.min` | 输出侧（tips / MCP） | 英文真源仍全量 |

三者互不替代：`findingScope` 关闭后，同文件远处与未改动文件的意见会重新进入英文真源，但输出侧过滤仍然生效。

## Options（为什么不是别的）

- **在提示词里要求模型只报 hunk 内问题**：否。提示词只能降低概率，不能作为可审计的准入条件；且 `PHASE_INSTRUCTIONS` 字节冻结。
- **删除越界意见而不留痕**：否。越界意见里有真实问题，留痕是后续调 `contextLines` 或引入 `scope` 标注的依据。
- **默认关闭、只在评测里对比**：否。用户明确要求默认开启，先把噪声挡在默认路径外。
- **直接按 hunk 严格过滤（contextLines = 0）**：否。真实的「相邻通道未加固」类发现常落在 hunk 外几行；默认 ±10 行是评测后的折中。
- **改 ADR-0023 的判重顺序**：否。位置过滤是新增语义，不动既有的内容去重口径。

## Consequences

- **好**：默认路径不再把「本次 MR 之外的问题」当成本次检视意见；findings / tips / MCP 三处口径天然一致；越界候选有审计计数可追踪。
- **代价 / 风险**：±10 行会丢掉部分高价值但位置偏远的相关发现（评测中 8 条真实越界意见里有一部分属此类）；需要时可调大 `contextLines` 或显式关闭。未来可评估给越界意见加 `scope` 标注而不是丢弃。
- **测试面**：`gate/diff-scope.test.ts` 覆盖 hunk 展开、多 hunk、纯删除、删除文件、无 hunk 文件、空 diff、路径归一、带引号 / 时间戳路径；`gate/candidate-gate.test.ts` 覆盖保留 / `OUT_OF_SCOPE` / 文件不在 diff / 优先于 `DUPLICATE_ID`；`shared/config.test.ts` 覆盖缺省、解析、fail-fast；`run/review-run.test.ts` 覆盖默认过滤与关闭保留全量（含审计 `rejectionCounts`）。
