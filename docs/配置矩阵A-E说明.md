# 配置 A–E 详解：每个配置到底做了什么

> 适用范围：`packages/review-pi`（pi 内核线 Review Runtime）。
> 契约：`packages/review-pi/src/contracts/config.ts`、`src/instrument/contracts/config.ts`。
> 按当前源码描述实际行为，并标注“声明位但未接线”的字段。

## 1. 配置是什么

A–E 是**受控实验矩阵**：五个布尔开关的组合，用来隔离“预取 / 工具 / 全仓注入 / 稳定前缀 / Ledger”的贡献。`configId` 写入 `RunRecord` 与审计，指标和 S/A/B 判定按它分组。

| 开关 | 含义 |
|---|---|
| `toolsEnabled` | 是否启用七个 `review.*` 工具（C/D/E 为 true） |
| `prefetch` | 确定性预取：Diff → Symbol → Reference → Call Chain（仅 B） |
| `fullRepo` | 仓库全部 Java 源文件注入初始上下文（仅 C） |
| `stablePrefix` | Zone A 稳定前缀纪律（D/E 声明 true） |
| `ledger` | Context Ledger + append-only（仅 E） |

```ts
A: tools=false prefetch=false fullRepo=false stablePrefix=false ledger=false
B: tools=false prefetch=true  fullRepo=false stablePrefix=false ledger=false
C: tools=true  prefetch=false fullRepo=true  stablePrefix=false ledger=false
D: tools=true  prefetch=false fullRepo=false stablePrefix=true  ledger=false
E: tools=true  prefetch=false fullRepo=false stablePrefix=true  ledger=true
```

## 2. 所有配置共用

1. **MR 边界护栏**（`run/mr-boundary-guard.ts`）：≤10 文件且 ≤2K 变更行；界内零介入；超界只追加 `domainWarning` + 审计 `mrBoundary`，**不拒检**。
2. **六阶段**（`loop/phases.ts`）：变更理解 → 风险分类 → 上下文决策 → 上下文检索 → 深度推理 → 证据验证。
3. **候选门禁**（`gate/candidate-gate.ts`）：`SCHEMA_INVALID → NON_ENGLISH → NO_EVIDENCE → VERIFICATION_FAILED → DUPLICATE_ID`，每个候选只留首个失败原因，通过者成为 Finding 并去重。
4. **审计与记录**：`audit/audit-writer.ts`（含可重放 `requests[].wireBody`）+ `experiment/run-record.ts`。
5. **上界**：`MAX_ROUNDS=5`，`MAX_TOOL_CALLS=6`（仅 C/D/E 有工具）。

## 3. A：纯 diff 基线

1. 入口护栏。
2. 不计算预取；强行注入 `prefetch` 会直接报错。
3. 初始上下文仅：Zone A system prompt + 一条 user 消息（caseId + issueDescription + unified diff）。
4. `runReviewLoop` 六阶段：每轮固定 **6 次无工具请求**，阶段指令追加、回复 append-only；验证阶段解析候选/verdict，轮末过门禁；最多 5 轮。
5. 审计无 `prefetch/fullRepo/ledger`；超界时仅有 `mrBoundary` 尾键。

特点：成本最低、0 工具；模型无法主动读仓库；作为“无外部上下文”基线。

## 4. B：确定性预取（零工具）

1. 与 A 相同的入口与六阶段循环。
2. `buildPrefetchContext`（`zoneb/prefetch.ts`），**零 LLM、零工具**，固定顺序：
   - Diff：变更文件与新旧行区间
   - Symbol：变更文件签名级符号
   - Reference：符号引用点
   - Call Chain：调用链
3. 注入：Zone B（Repo Map + 符号索引）位于 system prompt 与初始 user 消息之间；Symbol / Reference / Call Chain 作为追加的确定性 user 消息。
4. 预取记录写入审计 `prefetch` 键。

特点：比 A 多静态仓库上下文，但仍不能按需检索；同仓库+同 diff 字节级一致，可缓存重放。

## 5. C：全仓注入 + 工具

1. 拒绝预取注入。
2. `loadRepoContext` 懒加载一次仓库上下文。
3. `buildFullRepoInjection`（`zoneb/full-repo-injection.ts`）：按排序路径拼接全部 Java 源文件；预算 **80,000 字符**，超限在行边界截断并留痕；产出 `FullRepoRecord`。
4. 初始上下文 = MR/issue/diff + 全仓注入。
5. 七工具 toolkit（`tools/toolkit.ts`）：`get_diff/get_symbol/get_file/find_references/get_call_chain/search_rule/search_history`；Ledger 为 **inert**；RepoContext 懒加载并 memoize。
6. `runAgentReviewLoop`：`Agent` + `shouldStopAfterTurn` 推进阶段，阶段内工具子循环；工具调用硬上界 6。
7. 审计额外包含 `fullRepo`。

特点：效果上限对照；token 最高但缓存命中通常高；是 S/A/B 的锚点（`verdict.ts` 固定 C）。

## 6. D：工具驱动（无全仓、无 Ledger）

1. 与 C 相同的工具路径、六阶段、工具预算、轮次上限。
2. 不加载全仓注入；初始上下文只有 MR/issue/diff。
3. Ledger 为 inert。
4. `stablePrefix=true` 语义为 Zone A 稳定前缀（system prompt 常量、消息只追加）。

**实现注记**：当前源码中 `stablePrefix` **未被运行时读取**（只在契约与测试出现）。实际稳定前缀由“Zone A 常量 + 不设 `transformContext`、消息 append-only”保证，对 C/D/E 同时成立。因此实际差异：**D vs C = 没有全仓注入；D vs E = 没有 Ledger**。

## 7. E：工具 + 稳定前缀 + Ledger（完整形态）

1. 与 D 相同上下文与工具路径。
2. `ledgerMode="enabled"`（`tools/ledger.ts`）：重复读取返回引用 `Already loaded: ctx#NNN`，按 `kind+description` 生成确定性编号；预算截断规则不变。
3. 审计额外包含 `ledger`；`includeLedgerAudit=true`。
4. 生产入口默认 E（ADR-0011；CLI 缺省 E，程序化接口 `configId` 必填）。

特点：在 D 上减少重复上下文，控制长会话 token；质量差异通常小，主要影响 token/缓存/多轮稳定性。

## 8. 对照总表

| 维度 | A | B | C | D | E |
|---|---|---|---|---|---|
| 工具 | 无 | 无 | 7 个 | 7 个 | 7 个 |
| 预取 | 无 | 四段固定管线 | 无 | 无 | 无 |
| 全仓注入 | 无 | 无 | 有（80k） | 无 | 无 |
| 稳定前缀 | 否 | 否 | 否 | 声明 true | 声明 true |
| Ledger | 无 | 无 | inert | inert | enabled |
| 每轮请求 | 6 次无工具 | 6 次无工具 | 阶段+工具 | 阶段+工具 | 阶段+工具 |
| 最大轮次 | 5 | 5 | 5 | 5 | 5 |
| 工具上界 | 0 | 0 | 6 | 6 | 6 |
| 典型 token | 最低 | 低–中 | 最高 | 中 | 中（重复读取更省） |
| 审计尾键 | 无 | `prefetch` | `fullRepo` | 无 | `ledger` |
| 用途 | 纯 diff 基线 | 预取收益 | 效果上限/锚 | 工具检索 | 生产完整形态 |

## 9. 判定口径

- 每条 case × 配置重复 `--reps N`；**rep1=cold，rep2+=hot**。
- S/A/B 只用 **hot 均值**，锚点 **C**：
  - S：Recall ≥ C×90% ∧ Precision ≥ C×100% ∧ Token ≤ C×30% ∧ Cache ≥85%
  - A：Recall ≥ C×80% ∧ Token ≤ C×30% ∧ Cache ≥80%
  - B：Recall ≥ C×70% ∧ Token ≤ C×50%
- C 自比时 Token 判据必然失败，故 C 显示 `BELOW_B`（锚不参与评级）。
- 少于 2 reps 无 hot 指标 → `NOT_EVALUABLE`。

## 10. 运行示例

> PowerShell 下逗号列表必须加引号。

```bash
# 纯基线
pnpm experiment -- --id smoke --cases-file data/vul4j/materialized-cases.json --configs "A" --reps 1 --model deepseek-v4.1-flash

# A 相对锚 C
pnpm experiment -- --id cmp-ac --cases-file data/vul4j/materialized-cases.json --configs "A,C" --reps 3 --model deepseek-v4.1-flash

# 生产 E 相对锚 C，并启用 judge
pnpm experiment -- --id cmp-ce --cases-file data/vul4j/materialized-cases.json --configs "C,E" --reps 3 --model deepseek-v4.1-flash --judge --judge-model glm-5.3-flash
```

产物：`runs/<experimentId>/`（`plan.json`、逐单元记录、`report.json`、`dashboard.md`、`audit/**`）。

> 单案、单配置、rep-1 的**生产形态**（含 config F + 规则 Skill 的 `review-pi` CLI 直跑）见《[运行手册：单次检视](运行手册-单次检视.md)》。
> F 的端到端流程图（装载 / 主循环 / skill 会话 / 候选合流 / 降级矩阵 / 审计映射）见《[Config F 完整流程图](design/Config%20F%20完整流程图（规则%20Skill%20独立检视会话）.md)》。

## 11. 代码位置

| 内容 | 位置 |
|---|---|
| A–E 契约 | `packages/review-pi/src/contracts/config.ts`、`src/instrument/contracts/config.ts` |
| 入口/分派 | `packages/review-pi/src/run/review-run.ts` |
| 边界护栏 | `packages/review-pi/src/run/mr-boundary-guard.ts` |
| 六阶段 | `packages/review-pi/src/loop/phases.ts` |
| 零工具循环 | `packages/review-pi/src/loop/review-loop.ts` |
| 工具循环 | `packages/review-pi/src/loop/agent-review-loop.ts` |
| 预取 | `packages/review-pi/src/zoneb/prefetch.ts` |
| 全仓注入 | `packages/review-pi/src/zoneb/full-repo-injection.ts` |
| 工具与 Ledger | `packages/review-pi/src/tools/toolkit.ts`、`tools/ledger.ts` |
| 候选门禁 | `packages/review-pi/src/gate/candidate-gate.ts` |
| 审计/记录 | `packages/review-pi/src/audit/audit-writer.ts`、`experiment/run-record.ts` |
