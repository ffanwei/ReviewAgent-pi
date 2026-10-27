# 0015. 检视转录的 `view`/`info` 对齐 OpenCode：补时间戳、合成消息 id、删 `perMessageTimestamps`

**状态**：已接受（2026-10-27，用户经 grill 逐项决策 Q1–Q10）
**关联**：ADR-0013（被本 ADR **部分修订**：`view` 的 `id`/`time` 由「恒 `null`」改为「有源就填」；`info.time` 改 epoch 毫秒并删 `perMessageTimestamps`）、ADR-0009（会话投影属内核变量面）、CONTEXT.md（「检视转录」）、`.scratch/transcript-reviews-export/spec.md`（其映射表与 Out of Scope 段由本 ADR 修订）

## Context

- ADR-0013 决策 3 把 `view` 定成「定形投影」：**无源字段一律 `null` 占位**，其中 `messages[].id` / `messages[].time` / `tool.time{created,ran,completed}` 全部记 `null`；决策 10 另立一条「**不新增耗时仪器**」。
- 落地后复盘发现「无源」这个前提**只对了一半**：

  | 事实 | 源 | 证据 |
  |---|---|---|
  | `assistant.timestamp` 是**真毫秒** | 建 partial 消息时打点 | `packages/ai/src/api/openai-completions.ts:334` |
  | `toolResult.timestamp` 是**真毫秒** | 结果消息定型时打点 | `packages/agent/src/agent-loop.ts:796` |
  | `user.timestamp` 在**主会话恒 0** | 本仓硬编码 | `loop/agent-review-loop.ts:429` / `:439` |
  | `user.timestamp` 在 **skill 会话是真值** | 首条 prompt 传的是 string，pi 自己打点 | `packages/agent/src/agent.ts:406` |

  也就是说：产物里「真源有值、投影全 `null`」；而且同一份产物内部还出现了「主会话 user 全 0、skill 会话首条 user 有真值」的裂缝。
- 需求：让导出的 `session-*.json` 能和 OpenCode 会话导出（`D:\Project\tmp\session-*.json`）**并排读**——补时间戳、补消息 id、会话开始/结束时间与 OpenCode 同形。
- 两条已经核实的边界：
  1. **wire 不携带时间戳**：审计 `requests[].wireBody.messages[]` 只序列化 `role` 与 `content`（实测产物核对）；改 `user.timestamp` **不动字节门**。
  2. **`view` 可以是 `messages` 的纯函数**：所有要补的值都能从 native 字段直接读出，不需要旁路采集。

## Decision

1. **范围 = 纯投影，不新增仪器**。只把 native `AgentMessage` 上**已有**的值搬进 `view`；不挂 `Agent.subscribe`、不引入 `message_start/update/end` 事件时序。ADR-0013 决策 10「不新增耗时仪器」**继续成立**——本 ADR 只是把「有源」的字段从「一律 `null`」改成「照实填」。
2. **`user.timestamp` 就地修真**：`phaseMessage()` 与 `toUserMessage()` 两处 `timestamp: 0` → `Date.now()`。这是 native `messages[]` 唯一改动；assistant / toolResult / 合成 system 一律不动。
3. **`info.time` 改 epoch 毫秒两态**：`{created: <ms>, updated: <ms>}`。`created` = `firstRequestAt`（与文件名同源）；`updated` = `finishedAt`（run 收尾）；`completed` 这个名字退役（它给读者的暗示是「会话结束」，实际是「产物定稿」）。
4. **删除 `info.perMessageTimestamps`**：该键的存在意义是声明「逐消息时间戳不可用」，决策 2 之后不再成立；OpenCode 的 `info` 也没有这个键。
5. **`messages[].id`**：`user` 一律 `msg_<4 位补零序号>`；`assistant` **优先 `responseId`**（可回查网关）。序号 = 该消息在「user/assistant 子序列」中的 **1-based** 位置，**跳过合成 system**；assistant 用 `responseId` 时**不重排、不复用**序号。
   **两遍分配 + 唯一性兜底**：先为全部 user/assistant 预分配合成序号并把它们登记为已占用；再仅当 assistant 的 `responseId` **非空、未被占用、且不与合成 id 的形状（`msg_` + ≥4 位数字）同形**时替换。`responseId` 缺失、重复（provider 复用同一个响应 id，如 fake 适配器恒回一个值）、撞上已分配序号或形如 `msg_0100` ⇒ 该条保留合成序号。合成序号预分配后**不再让出**，因此 id 只有「`responseId`」与「`msg_<4 位>`」两种形态，且在单份转录内唯一可引用。
6. **`messages[].time` 与 part 级 time 的填法**（一律 epoch 毫秒）：
   - `user.time = {created: <message.timestamp>}`
   - `assistant.time = {created: <message.timestamp>, streamed: null, completed: null}`
   - `tool.time = {created: null, ran: null, completed: <toolResult.timestamp | null>}`
   - `reasoning.time = {created: null, completed: null}`
7. **恒 `null` 清单（无源，不是未实现）**：`assistant.time.streamed`、`assistant.time.completed`、`tool.time.created`、`tool.time.ran`、`reasoning.time.created/completed`、`snapshot`、`tool.state.metadata`、`model.variant`。要填它们必须新增事件时序采集（另一项内核仪器工作），不在本 ADR 内。
8. **接受「`info.time.created` 晚于开头消息」的倒挂**：`info.time.created` 是**首次模型请求**时刻，而**开跑前已入列的 user 消息**（初始上下文 + Phase 0 指令）在构造 Agent / 首次 `prompt` 入列时就已产生。OpenCode 的顺序是「会话诞生 → 首条消息」，我们正好相反；这是 ADR-0013 决策 4 选「命名时间 = `firstRequestAt`」的必然代价，**只能写清、不能掩盖**——不新增 `info.time.started`，也不把 `created` 改成会话诞生时刻（那会让文件名与 `info.time.created` 脱钩）。主会话里首个 assistant 也可能略早（pi 在 `onPayload` 之前就给 partial 消息打点，`packages/ai/src/api/openai-completions.ts:334`）；**主会话中首个 assistant 之后**的消息一律不早于 `created`。**skill 会话转录（config F）不在该断言内**：它以 Phase 5 结束时的 messages 快照为种子（`knowledge/skill-pass.ts:98`），种子里的 user/assistant 全部早于该会话的 `created`——`created` 只表示该 skill 会话的首次模型请求，不代表转录开头。
9. **`view` 仍是 `messages` 的纯函数投影**：所有填充值都直接从 native message 读，`buildView(systemPrompt, messages)` 签名不变、不引入时钟参数。
10. **测试纪律 = 真实时钟 + 结构断言**：转录因此**不再可复现**（同输入两次跑必不同），任何「整文件 golden 对比」失效；测试只断言「键在场 / 值类型正确 / 落在 `info.time` 区间内 / 序号与序列单调」。不做时钟注入（`RunOptions` 是审计与运行记录的形状源头，为测试改它是反向依赖）。

### Supersede 清单（ADR-0013 与 spec）

| 被取代 | 新口径 |
|---|---|
| 0013 决策 3「`view` 无源字段一律 `null`」中的 `id`/`time` 部分 | 有源就填；仅第 7 条清单内的字段保持 `null` |
| 0013 决策 10「transcript 只带全局 `time{created, completed}`」 | 全局时间改 `{created, updated}`（ms），并补逐消息 `created` 与工具 `completed` |
| 0013 / spec `info` 键表的 `perMessageTimestamps` | 删除（键表为 11 键） |
| spec「`info.time` = ISO `{created, completed}`」 | epoch 毫秒 `{created, updated}` |
| spec 映射表「`messages[].id` / `messages[].time` → `null`」 | 见决策 5/6 |
| spec 映射表「`tool.time{created,ran,completed}` 全 `null`」 | `completed` 取 `toolResult.timestamp`；另两键仍 `null` |
| spec Out of Scope「Per-message timing instrumentation」 | **仍成立**：本 ADR 未新增任何仪器，只搬运既有时间戳 |

## Options（为什么不是别的）

- **挂 `Agent.subscribe` 采三态时序**（真能对齐 OpenCode 的 `created/streamed/completed`）：要改 ADR-0013 决策 10、给内核加事件时序仪器，并且会让 `view` 不再是 `messages` 的纯函数（变成第二份真源）。本次诉求是「能并排读」，不是「测首 token 延迟」，收益不抵成本。
- **`info.time` 保留 ISO / 或 ISO 与 ms 并存**：OpenCode 是 ms；并存会多一份冗余键、并且「哪个是真源」立刻变成新问题。
- **`completed` 改名后不保留旧名**：产物无版本键（0013 决策 9），改名靠字段名演进；`runs/**` 不外发，读者只有本仓。
- **给 `tool.time.created/ran` 编近似值**：转录是 crime scene 不是指标源；编出来的数一旦被当成工具耗时就会算错，宁缺勿假。
- **改 `info.time.created` 为「会话诞生」**：会破坏「文件名中段 ↔ `info.time.created` 可机械对账」这条既有性质（`review-run-artifacts.test.ts` 有断言把守）。
- **合成哈希 id**（形如 `msg_<8 位>`）：不透明且不带来任何可回查性；位置型序号可读、可排序，跨文件配对本来就由 `info.runId` 负责。
- **注入固定时钟让产物可复现**：`RunOptions` 是审计/运行记录的形状源头，为测试可复现而改入口签名属反向依赖；结构断言已经足够。

## Consequences

- **正**：同一份产物里「真源有值、投影无值」的矛盾消失；`session-*.json` 可**并排**读 OpenCode 导出（同形 `id`、同形 epoch 毫秒、同形 part 级 `time`）；主会话与 skill 会话的 user 时间戳不再一半真一半假；`view` 仍是纯投影，取证时任何 `view` 值都能在 `messages` 里找到来源。
- **负 / 需要显式认识的刻意偏离**：
  - **转录从此不可复现**：`messages[].timestamp`、`view.*.time`、`info.time` 每次运行都不同。任何「整文件 diff 转录」的用法作废；判级只看审计与运行记录。
  - **`info.time.created` 晚于开头消息**（决策 8）：**主会话**读产物时先看开跑前入列的 `messages[1..2].timestamp`（初始上下文 + Phase 0 指令）与首个 assistant 的时刻，才知道会话真正开始于何时；首个 assistant 之后才与 `created` 对齐。**skill 会话转录**以 Phase 5 快照为种子，整段种子都早于 `created`。
  - **`streamed` / `completed`（assistant）、`created` / `ran`（tool）、`reasoning.time` 永远是 `null`**：不要把它们当「还没实现」，它们是没有源（第 7 条）。
  - **`user.timestamp` 变真值后，native `messages[]` 不再是「逐字节可复现的 pi 状态」**——它依旧是 pi 的真实状态，只是这次真的带了时间。
- **中性**：不动请求字节（wire 只序列化 `role`/`content`），不进字节门／语义等价门／上线门；`info` 键表从 12 键变 11 键（删 `perMessageTimestamps`）。

跨仓限定语纪律：本 ADR 为本仓 pi 线序列 0015；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
