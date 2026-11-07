# 0046. 检视轮次上限移入配置面（缺省 3），最后一轮强制 complete

**状态**：已接受（2026-11-07，用户直接决策）
**关联**：ADR-0025（用户级配置与测量常量面——本 ADR 把 `maxRounds` 从死钉移入配置面）、ADR-0006（六阶段骨架与轮次驱动）、ADR-0039（分片检视——每片独立跑本循环）、ADR-0013（转录结局 `truncated` 的语义）
**取代**：ADR-0025 Decision 4「5 项死钉」中的 `maxRounds` 一项、验收标准第 3 条中「`loop.maxRounds` 告警」一节

## Context

ADR-0025 把 `maxRounds=5` 列为 5 项运行期死钉之一，理由是「同一 MR 不同人跑出不同截断结论」。实际使用中这条约束的价值低于成本：

1. 成本上限需要按场景调整——回归/CI 想更快更省，深度检视想多看一轮；
2. 轮次耗尽的 `truncated=true` / `MAX_ROUNDS_REACHED` 在平台上会被读成「检视失败/不完整」，而多数情况下最后一轮的产出已经可用；
3. 六阶段语义本身没有变：模型仍在 Phase 6 用自己的 `complete` 判断要不要再来一轮，只是外层多了一个可配的成本线。

用户决策：**轮次上限进配置**，缺省 **3 轮**；**最后一轮强制 complete**（不再因「模型还想再审」而标记截断）。

## Decision

### 1. 配置键与缺省值

```jsonc
{
  "limits": {
    "loop": { "maxRounds": 3 }
  }
}
```

- 键路径 `limits.loop.maxRounds`，范围 **1–20**（整数；越界装载期 fail fast，与其他 `limits` 键同策略）。
- 缺省 **3**（比旧死钉 5 更省；需要更深时显式调大）。
- 从 `PINNED_KEYS` 删除 `maxRounds`：旧配置文件写 `"maxRounds"`（任意路径）仍按未知键/普通键处理，不再报「已钉死」。
- 进 `ReviewRuntime.limits`，与其它 `limits` 一样经显式参数逐层下传；审计 `config.values` / `digest` 自动覆盖（`limits.loop.maxRounds`）。

### 2. 最后一轮强制 complete

轮循环 `1..maxRounds`，每轮仍是完整六阶段。Phase 6 收尾时：

```text
complete = 模型返回的 complete
if complete                         → 停（正常完成）
if round >= maxRounds               → 强制 complete = true，停（本轮产出即最终结果）
else                                → 开下一轮
```

- 轮次耗尽**不是失败**：不置 `truncated`、不写 `MAX_ROUNDS_REACHED`；`RunAudit.truncated` 只由模型输出撞上界（`MODEL_MAX_TOKENS_REACHED`）翻转。
- 轮次耗尽前各轮已产出的 findings 照常进入候选门与最终结果；最后一轮的候选与裁决也照常处理。
- 工具预算 `MAX_TOOL_CALLS=100` 语义不变：跨轮不重置、耗尽只追加 `TOOL_BUDGET_EXHAUSTED` 原因、不翻转 `truncated`。

### 3. 常量面变化

- `loop/constants.ts` 删除 `MAX_ROUNDS` 与 `TRUNCATION_MAX_ROUNDS`；轮次上限只存在于配置（及其缺省值 `DEFAULT_LIMITS.loop.maxRounds`）。
- 死钉收窄为 4 项：`maxToolCalls=100` / 工具结果预算 8000 / 呈现 `temperature=0` / `reasoningEffort=high`。
- `MODEL_MAX_TOKENS_REACHED` / `TOOL_BUDGET_EXHAUSTED` 的留痕语义不变。

## Options（为什么不是别的）

- **保留死钉、只改缺省 3**：用户要的是可配置，且「不同场景不同轮数」是真实需求；放弃。
- **耗尽仍标 `truncated=true`**：与「最后一轮强制 complete」直接矛盾；平台会把正常结束读成失败；放弃。
- **把轮次放进新的顶层 `loop` 段**：为一个标量新增根段，`--config`/`config show`/审计键表都要多一层；`limits` 本来就是「执行资源上限」的家；放弃。
- **允许 0 轮 / 不限轮**：0 轮没有产出；不限轮破坏「单次检视成本有界」；用 1–20 的显式范围兜底。

## Consequences

- **正**：CI 可用 `maxRounds: 1` 快速跑；深度检视可调大；正常结束不再被误读为截断；成本可预测（每轮约 6 次模型请求）。
- **负/风险**：同一 MR 换配置会得到不同深度的结果——这正是 ADR-0025 当初担心的点，现由审计 `config.values` + `digest` 反查补偿。
- **中性**：六阶段字节面、工具 schema、Finding/Evidence 契约、分片边界与产物形状均不变；`rounds` 审计字段仍记实际跑完的轮数。

## 验收标准

1. **缺省**：不写 `limits.loop` ⇒ 最多 3 轮；Phase 6 恒 `complete:false` 时 `rounds=3`、`complete=true`、`truncated=false`、`truncationReasons=[]`。
2. **可配**：`limits.loop.maxRounds=2` ⇒ 2 轮后强制 complete；越界（0 / 21 / 非整数）⇒ exit 1 且指出 `limits.loop.maxRounds`。
3. **提前完成**：任一 Phase 6 返回 `complete:true` 仍立即停，不跑满上限。
4. **截断语义**：轮次耗尽不产生 `MAX_ROUNDS_REACHED`；模型输出撞上界仍 `truncated=true` + `MODEL_MAX_TOKENS_REACHED`。
5. **模板**：`config init` 模板与 `PiAgent.example.jsonc` 逐字节一致，均含 `limits.loop.maxRounds` 注释。
6. **测试**：`pnpm -r typecheck`、`pnpm --filter review-pi test`、`pnpm test` 全绿。
