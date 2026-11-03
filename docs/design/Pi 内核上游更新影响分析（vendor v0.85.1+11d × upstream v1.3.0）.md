# Pi 内核上游更新影响分析（vendor v0.85.1+11d × upstream v1.3.0）

> **历史分析（2026-10 撰写，问题本身已被 ADR-0035 取消）**：本文评估「vendored 四包如何跟上上游 v1.3.0」。
> ADR-0035 之后该问题不复存在：内核四包改为 npm 依赖并精确锁 `0.85.1`，与上游同步 = 改版本号 + 跑门
> （必要时 `pnpm patch`），不再有 `git diff` 对照与仓内源码树。文中 `packages/*` 路径与「vendor +11d」基线均为当时事实。

> **文首说明**：本文是研究性分析（2026-10-20），回答「pi 上游 0.85.1 → 1.3.0 的演化对本仓 vendor fork 与 Review Runtime 意味着什么、要不要跟进」。
> 方法：本地一手材料（基线方案 / 演化缝盘点 / ADR / vendored 源码 / review-pi 使用面 grep）× 上游一手材料（`gh api` 取 main 的 CHANGELOG / package.json / 源码 / releases / compare，npm tarball 取 1.3.0 发布物数据）三方交叉。
> **一句话结论**：上游跨 1.0 大改（agent 包收缩 92→6 源文件、harness 整体移出、`shouldStopAfterTurn` 等关键 API 更名、模型数据 schema v6 且 `deepseek-v4-flash` 目录退役），但本仓 fork 源码零分歧 + review-pi API 使用面极窄（13 文件 / ~25 个触点），升级的真实代价不在 re-anchor 而在**升级后必须重跑的验证链**（t1–t5 双门 + 质量门证据 + 真跑对照）；当前无驱动性需求，**建议锚定不动**，把升级留到下一个内核变更窗口并整体跳 1.x（不 backport）。

---

## 1. 事实基线

### 1.1 本仓 vendor 侧

| 事实 | 数值 / 内容 | 出处 |
|---|---|---|
| 锚定 commit | `6671c604`（2026-09-16，v0.85.1 发布后 11 天的 main 修复） | 《Pi 内核定制基线方案》§2 |
| 目录 → npm 名映射 | `ai`→`@earendil-works/pi-ai`、`agent`→`@earendil-works/pi-agent-core`、`chord`→`@earendil-works/chord`、`telemetry`→`@earendil-works/pi-telemetry`，四包 `version` 均 `0.85.1` | `packages/{ai,agent,chord,telemetry}/package.json` |
| fork 本地分歧 | 仅接线层：4× package.json（`workspace:*`、exports 补 types/source、tsgo→tsc）、telemetry/chord 两个 vitest.config.ts、chord `boundary.test.ts` 1 行 `path.sep` 修复、`THIRD-PARTY-NOTICES.md`、`.gitignore`、根 package.json `build:pi`、`ai/src/providers/data/*.json` 39 文件入库（npm 0.85.1 tarball 快照）。**源码本体零改动** | 基线方案 §4/§5 |
| 采纳后本地改动 | **零**：`git log d5b5534..HEAD -- packages/{ai,agent,chord,telemetry}` 为空 | 本仓 git（2026-10-20 核验） |
| 上游包测试信号 | agent 665/712 过（45 败全为 POSIX 路径）、ai 1037/1064 过（27 败全为目录快照期望）——均不进门 | 基线方案 §6.2 |
| byte 纪律门 | t1–t5（B 直驱字节门）+ t1–t5 agent（C/D/E 语义门）：真源 = `runs/phase2-dsh*` 审计 `requests[].wireBody`，fake 适配器重放，`compareRecordParity` 白名单外零容忍；`testdata/golden` 36 文件 | `packages/review-pi/src/bytegate/gate-runner.ts:1-27`、ADR-0009「分层门」 |
| 生产状态 | config E 已切流生产入口（CLI 缺省 E、`configId` 必填），上线门 2026-10-20 判过（质量门主判） | ADR-0011 Decision 1/4 |

「不更新就一切照旧」的结构性原因：working tree 干净 + 四包零本地改动 + 上游不会反向破坏本仓（无 npm 依赖、无 CI 拉上游）。

### 1.2 review-pi 对内核的使用面（API 底册）

全仓 `@earendil-works/*` import 只存在于 `packages/review-pi/src`（13 文件：8 源 + 5 测试）；`packages/review-llm` 与根 `src/`、`scripts/` 均为零（根 `src/experiment/pi-kernel.ts` 只 import `review-pi` 包入口 `runReview`）。按子系统归类：

| 子系统 | 使用的 API | 本地 file:line |
|---|---|---|
| agent-loop 钩子 | `AgentOptions.shouldStopAfterTurn`（review 状态机）、`onPayload`（wire 捕获）、`toolExecution: "sequential"` | `src/loop/agent-review-loop.ts:174/:170/:169` |
| Agent 对象面 | 构造 `initialState{systemPrompt, model, messages, tools}` + `streamFn`；`agent.prompt()` / `agent.followUp()` / `agent.state.messages`（错误扫描） | `agent-review-loop.ts:160-187/:191` |
| 内核类型 | `AgentMessage`、`AgentTool`（name/label/description/parameters/`prepareArguments`/`execute(_toolCallId, params)`）、`StreamFn` | `agent-review-loop.ts:2/:106-144` |
| LLM 客户端 | `deepseekProvider()`（子路径 `providers/deepseek`）、`.stream(model, context, {apiKey, fetch, reasoningEffort:"high", onPayload})`、`.getModels()`、`stream.result()` | `src/provider/pi-client.ts:2/:68-76/:112`、`agent-review-loop.ts:4/:146-152` |
| LLM 类型 | `AssistantMessage`（content/stopReason/errorMessage/usage）、`Context{systemPrompt, messages}`、`FetchFunction`、`Model<"openai-completions">`（目录模板展开 + id/baseUrl 覆写）、`TextContent`、`Usage{input, output, cacheRead, cacheWrite}` | `pi-client.ts:1`、`src/provider/usage-map.ts:9-18`、`src/loop/review-loop.ts:1` |
| wire 捕获契约 | `onPayload` payload 形状：`model` / `messages[]{role, content}` / `tools[].function{name, description, parameters}`（openai function 形） | `pi-client.ts:127-186`（`captureWire`） |
| 传输注入 | `FetchFunction`（fake-fetch / gateway-probe / recording-fetch / review-run） | `src/provider/fake-fetch.ts:1` 等 4 文件 |
| chord / telemetry | **零直接使用**（chord 仅作 agent 的传递依赖，vendored agent 内仅 3 个 harness 文件 import；telemetry 经 ai/agent 传递） | grep `packages/agent/src`：`harness/{agent-harness,context,session/types}.ts` |

使用面合计：11 个具名 import + Agent/provider 对象面约 25 个具体触点。这是「若升级要适配什么」的全部底册。

### 1.3 上游版本线与包结构变化

- **commit 距离**：`compare 6671c604...main` ahead_by = **639**，main HEAD `73f8de80`（2026-10-19）。出处：`gh api repos/earendil-works/pi/compare`。
- **release 序列**（锚点后 15 个）：v0.86.0（09-19）→ 0.86.1 → 0.87.0 → 0.87.1 → 0.99.0（09-29，1.0 预备）→ 0.99.1/0.99.2 → **v1.0.0（10-01）** → 1.0.1–1.0.4 → 1.1.0（10-07）→ 1.2.0（10-12）→ **v1.3.0（10-15）**。注意 0.88–0.98 不存在（0.87.1 直接跳 0.99.0）。出处：`gh api releases`。
- **包结构**（main `packages/`）：四包目录全部仍在；新增 `codemode` / `durable` / `env` / `mcp`；`protocol`/`client`/`server` 已随 chord 1.2.0 移除（`packages/agent/package.json`@main 依赖仅剩 `@earendil-works/pi-ai: 1.3.0` + `typebox`——**chord、pi-telemetry、diff、ignore、yaml 全部出依赖图**）。
- **规模变化**：agent 源码 92 个 .ts（其中 84 个在 `harness/`）→ **6 个**（agent/agent-loop/proxy/stream-fn/types/index；npm dist 6 js）；ai dist 178 js + 39 data → 198 js + **43 data**。出处：本仓 find vs npm 1.3.0 tarball。
- **npm 现状**：`pi-ai` / `pi-agent-core` / `chord` / `pi-telemetry` / `pi-durable` 全部 latest = 1.3.0；本机 SoL-Pi devDeps 已消费 `pi-agent-core@1.3.0` + `pi-ai@1.3.0`（`D:/xubao/code/AI4SE/SoL-Pi/package.json`）——生态可行性已由邻仓背书。
- **上游演化速率**：约 5 周 639 commits、两个大 breaking 版本（0.99.0、1.2.0）+ Unreleased 又有新 breaking（telemetryContext 改名）——上游仍处高速演化期。

## 2. 上游 delta：breaking changes 与行为变化

> 只列与本仓相关或有结构性意义者；出处均为上游各包 CHANGELOG@main 条目（版本 + issue 号）。

### 2.1 pi-agent-core（0.85.1 → 1.3.0）

| 版本 | 变更 | 对本仓的意义 |
|---|---|---|
| 0.87.0 Breaking | **移除 `AgentOptions.shouldStopAfterTurn` / `AgentLoopConfig.shouldStopAfterTurn`**，改 `finishTurn(turn, signal) => {action:"end"} \| undefined`；`finishTurn` 在 assistant/tool-result 定稿后、`turn_end` 前回调，**error/aborted 回合也会回调**（决策被忽略），返回 `{action:"end"}` 保留 steer/followUp 队列并跳过 `prepareNextTurn` | **直接命中**：`agent-review-loop.ts:174` 是 C/D/E 主循环的状态机钩子 |
| 0.87.0 Added | 新增 `prepareRequest`（每次 provider 请求前回调，含首个）、`Agent.peekQueuedMessages()` | 演化缝盘点 G1（无按请求工具过滤钩子）部分闭合——`prepareRequest` 可返回替换 `context`（含 tools） |
| 0.99.0 Added | `onProviderStreamEvent` 选项（观察归一化前 provider 事件）；loop 把请求 thinking level 记为 `AssistantMessage.thinkingLevel` | 审计面可选增强 |
| **1.0.0 Breaking** | **移除 experimental harness 全家**：`AgentHarness`、sessions/session storage、durable runtime、pico3、harness tools、compaction、skills、prompt templates、system prompt helpers、telemetry schemas、`uuidv7`/pi-telemetry re-exports；`./node`、`./harness/*`、`./experimental/pico3` 子路径导出删除。**包只剩 `Agent`、agent loop、proxy stream 及其类型**；durable 会话去 `@earendil-works/pi-durable` | **结构性**：vendored agent 树 84 个 harness 文件可删；chord 出依赖图（harness 是 chord 唯一消费者）；演化缝盘点 S6（会话模型）、G2/G4 随之失效——但从 0 线本就不依赖 harness |
| 1.1.0 Changed/Added | `streamProxy()` 返回 `AssistantMessageEventStream`；`durationMs` 进 tool result / `AgentToolCallOutcome` / `tool_execution_end` 事件 | 审计面新字段（可选） |

### 2.2 pi-ai（0.85.1 → 1.3.0）

| 版本 | 变更 | 对本仓的意义 |
|---|---|---|
| 0.86.0 Breaking | **provider 侧 `ProviderStreams`/`StreamFunction` 输入从 `Context` 改为归一化 `TranscriptContext`**：system prompt 与工具声明移入 transcript 前导 system 消息，provider 经 `getCurrentSystemPrompt()`/`getCurrentTools()` 读取；`Context` 退化为公共入口的简写形态（`normalizeContext()` 折叠） | **直接命中**：`pi-client.ts:68` 直驱路径向 `provider.stream()` 传裸 `Context`（1.3.0 签名为 `TranscriptContext`，类型红） |
| 0.86.0 Breaking | `ToolCall.arguments` 与 `ToolResultMessage.details` 限定 JSON 兼容值；`ToolResultMessage` 改条件类型；`JsonValue` 数组只读 | `agent-review-loop.ts` 的 `prepareArguments`/`stripUnknownArguments` 返回类型需复核 |
| 0.86.0 Fixed #9423 | **DeepSeek 目录改标 `deepseek-flash`（V4.1 Flash），旧 Flash 别名退役并刷新定价** | **直接命中**：本仓钉住的评审模型 `deepseek-v4-flash` 在 1.3.0 npm 目录中已不存在（`data/deepseek.json` 仅剩 `chat:deepseek-flash`/`chat:deepseek-v4-pro`）——`reviewModelOf`（`pi-client.ts:104-123`）模板查找会 throw |
| 0.87.0 Fixed #9816 | 未知 OpenAI 兼容端点不再默认收 strict tool schemas（内建能力模型保留） | 影响自定义网关工具面；本仓网关走 provider=deepseek（内建），不受影响 |
| **0.99.0 Breaking** | **模型数据 schema v6**：条目携带 `type`（chat/image/classifier）、目录按操作分类、`image-models.generated.ts` 移除、需 `npm run hydrate:model-data` | **直接命中**：本仓 committed data（0.85.1 npm 快照，39 文件）与新源码不兼容，须重提取 1.3.0 tarball data（43 文件）；基线方案 §5 的「锁定发布快照」流程重演 |
| 0.99.0 Added | `Models.classify()` 分类器合同、`onProviderStreamEvent`、`getAllModels()` 等 | 不使用 |
| 1.0.3 Breaking | Azure provider 改名 `azure-openai-responses`→`azure` | 不使用 Azure，无命中 |
| 1.1.0 Breaking | stream function 必须返回 `AssistantMessageEventStream`（`createAssistantMessageEventStream()`） | 无命中：本仓 streamFn 转发 `provider.stream()` 返回值，1.3.0 正是该类型 |
| 1.1.0 Added | `AssistantMessage.durationMs` / `ToolResultMessage.durationMs` | 审计面新字段（可选） |
| 1.3.0 Breaking | 移除 `AssistantMessageFrame`/`AssistantMessageFrameEncoder`/`reduceAssistantMessageFrames()`（仅被已移除的 harness 使用） | 无命中 |
| 1.3.0 Fixed #10897 | **畸形 JSON 工具参数不再静默按已解析前缀执行**：携带 `argumentsError` 并以原文验证失败 | 工具调用协议行为变化：C/D/E 里模型发坏参数时的回路语义改变（更严格） |
| 1.3.0 Changed #10995 | 模型切换时丢弃前序 assistant 的 thinking 块 | 单模型恒定，无命中 |
| Unreleased（1.3.0 后） | `telemetryContext` 改名 `telemetry?: TelemetrySpan`（无别名） | 无命中（本仓不传该选项；vendored `types.ts:127` 仍是旧名） |

**兼容性确认（逐项核过，不是猜的）**：`deepseekProvider()` 工厂与 `providers/deepseek` 子路径导出不变（npm 1.3.0 exports `./providers/*` 在位）；`OpenAICompletionsOptions.reasoningEffort` 仍在（`api/openai-completions.ts`@main :156）——`LOCKED_REASONING_EFFORT="high"` 经 `thinkingLevelMap{high:"high"}` → wire `reasoning_effort:"high"` 链路不变；`Usage` 四字段与 `totalTokens`/`cost` 必填形态与 0.85.1 逐字相同（本仓 `ai/src/types.ts:383-401` vs main `types.ts:451`）；`stream.result()` 存活（`AssistantMessageEventStream extends EventStream` 带 `result()`，npm dist `utils/event-stream.d.ts`）；`AssistantMessage{usage, stopReason, errorMessage}` 形状不变；`AgentTool` 的 `execute(toolCallId, params, ...)`/`prepareArguments` 不变；`AgentInitialState` 仍收 `systemPrompt/model/messages/tools`（`systemPrompt` 播种前导 system 消息，`AgentState.systemPrompt` 变只读 getter——本仓只播种不改写，无命中）；`Agent.streamFunction` 公有可变字段仍在（演化缝盘点 S1 有效）。

### 2.3 chord / pi-telemetry

- **chord 1.2.0（2026-10-12）整体重写**：facet/service 运行时换成 typed host runtime（`createHost`/`defineFacet`/contracts/IPC-WebSocket 链路），**移除 `createFacetHost`、`defineService` 等**——演化缝盘点 S7 记录的全部 API 名消失；1.3.0 继续 breaking（`Handle`→`Ref` 等术语改名、`PROTOCOL_VERSION` 4）。同时移除 `pi-client`/`pi-protocol`/`pi-server` 三包。**对本仓**：chord 仅是 vendored agent 的传递依赖，agent 1.3.0 已不依赖它 → 升级时 chord 整包退出 vendor 集（vendor 4→3 包），基线方案 §4.4 的 chord `boundary.test.ts` 1 行修复与 chord vitest.config.ts 分歧随之消失。
- **pi-telemetry**：1.x 期无 breaking（各版本条目为空），Unreleased 在扩契约（`addLink`/metrics/propagation）。仍是 ai 的依赖，随升即可。

### 2.4 与运行时语义相关的修复（backport 候选池）

本仓关心的语义面 = 企业网关（火山）长跑鲁棒性 + deepseek 流式 + 长上下文。锚点树**不含**以下修复（锚点 2026-09-16，均在其后合入）：

| 修复 | 版本 | 相关性 |
|---|---|---|
| 网关上游错误不触发自动重试：`upstream_error: Upstream request failed`、`upstream_stream_read_error`、`Upstream HTTP/2 stream failed`、`Unable to forward upstream stream` | 1.3.0 + Unreleased，#10920 | **高**：正是企业网关瞬时错误形态；现行内核下这类错误直接终局为 stopReason "error"，run 报废 |
| `The upstream provider returned an error` 不重试 | 1.2.0，#10842 | 高，同上 |
| `The service is temporarily unavailable` 不重试（compaction 首试即败） | 1.3.0，#10965 | 高 |
| `server_busy` / `servers are currently busy` 终局而非重试 | 1.1.0，#10543 | 高 |
| `Selected model is at capacity` 不重试 | 1.0.1，#10278 | 高 |
| Mistral 流 `finish_reason:"error"` 不重试 | 1.1.0，#10487 | 中（deepseek 网关方言可能复用该终局路径） |
| `Retry-After` 不可解析日期时立即重试而非退避 | 0.99.2，#9571 | 中 |
| 上下文溢出误判：输入估算 4 → 3.5 字符/token，减少假性 context-limit 失败 | 1.1.0，#10497 | 中（Zone B 预取后大前缀场景） |
| 空白-only 工具输出直发被某些 provider 400 | Unreleased，#8720 | 低（review 工具输出恒非空文本，但 t-series 复刻语义上属工具回包序列化面） |
| 事件流排空二次方 CPU | 0.86.0，#9055 | **已在锚点树内**（锚点 CHANGELOG Unreleased 即含此条）——非增量 |

另：0.86.0 的 DeepSeek 定价刷新（#9423）只影响成本记账，不影响 token 口径（本仓记账用 `Usage` token 字段）。

## 3. 三方交叉分析

### 3.1 上游 breaking × review-pi 使用面：升级 1.3.0 的适配项清单

| # | 命中 | 位置 | 迁移方式 | 量级 |
|---|---|---|---|---|
| A1 | `shouldStopAfterTurn` 移除（agent 0.87.0） | `agent-review-loop.ts:174-181` | 改 `finishTurn(turn)`：按官方迁移样例加 `turn.message.stopReason === "error" \|\| "aborted"` 守卫（防 usage 累计/相位推进副作用在硬退出回合计入）；返回 `{action:"end"}` 替 `true`、`undefined` 替 `false`。followUp 注入缝语义保持（`{action:"end"}` 才跳过队列消费） | 1 钩子重写 + 守卫，~30 行 |
| A2 | `provider.stream(model, Context, …)` → `TranscriptContext`（ai 0.86.0） | `pi-client.ts:68`（B 直驱） | 三选一：自调 `normalizeContext()`（`pi-ai/utils/transcript`）、或经 `Models` 入口（其 `stream()` 仍收 `Context` 并代为归一化，`models.ts`@main :890-899）、或包一层。`agent-review-loop.ts:146` 的 streamFn 转发天然适配（loop 传入的已是 `TranscriptContext`） | ~5 行 + 类型复核 |
| A3 | 目录 `deepseek-v4-flash` 退役（ai 0.86.0 #9423） | `pi-client.ts:104-123`（`reviewModelOf`）与 `REVIEW_MODEL_ID` | 模板查找改 `deepseek-flash`（V4.1）；**wire 上的 model id 不必变**——#45 自由 id 语义本就支持目录外 id + 模板画像。已核两代模板 `compat` 画像逐字段一致（`thinkingFormat:"deepseek"`、`maxTokensField:"max_tokens"`、`requiresReasoningContentOnAssistantMessages:true`、`supportsDeveloperRole:false`、`supportsStore:false`、`thinkingLevelMap{high:high,…}`、contextWindow/maxTokens 同），1.3.0 仅新增 `supportsStrictMode:true` 与新定价（input 0.14→0.3 等成本面）——序列化画像不漂移 | ~3 行 + 断言更新 |
| A4 | 模型数据 schema v6（ai 0.99.0） | `packages/ai/src/providers/data/`（39 文件）+ 构建链 `check:model-data` | 从 npm `@earendil-works/pi-ai@1.3.0` tarball 重提取 `dist/providers/data`（43 文件）回填 `src/providers/data` 并提交（基线方案 §5 流程重演）；上游 27 个目录期望红测试应随之转绿 | 流程性，半天内 |
| A5 | `ToolCall.arguments` JSON 限定 + `argumentsError` 协议（ai 0.86.0/1.3.0 #10897） | `agent-review-loop.ts:106-144`（AgentTool 装配）、`bytegate/tool-dialect.ts` | 类型复核 `prepareArguments` 返回；工具坏参数回路语义变化（现在会带 `argumentsError` 验证失败而非静默半解析）登记进形态记录；t 系列工具回包真源不受影响（真源本就无坏参数样本则零差异） | 类型 + 文档 |
| A6 | 结构性：agent harness 移除（agent 1.0.0） | vendored `packages/agent`（92→6 源文件）、`packages/chord` 整包 | 换树即得；chord 退出 vendor 集与 `build:pi` 拓扑（telemetry→ai→agent）；根 `package.json`/`THIRD-PARTY-NOTICES.md`/基线方案 §3 表回写 | 流程性 |

**不命中项**（核过）：`stream.result()`、`Usage` 四字段、`reasoningEffort` 选项、`deepseekProvider` 子路径、`AssistantMessage` 错误扫描形态、`AgentInitialState` 播种、`fetch` 注入、`onPayload` 签名（`(payload, model) => unknown` 不变）。附带语义差异（登记不必适配）：transcript 前导 system 消息使 `state.messages[0]` 从 user 变 system（本仓只按 role 扫描，无索引假设）；`AssistantMessage.thinkingLevel`/`durationMs` 新字段进审计投影可选。

### 3.2 上游改动 × fork 分歧：re-anchor 冲突面

结论：**冲突面近乎为零，因为源码本体零分歧**。上游 639 commits 的海量改动（ai 核心文件 diff 数千行：`types.ts` 1779 行差、`models.ts` 2240 行差、`openai-completions.ts` 3453 行差）全部落在「上游 vs 上游旧版」，与本仓分歧（§4 接线层）不相交——re-anchor 是**整树替换 + 重放接线**，不是三方合并。需要人工重放的分歧清单（基线方案 §4 全表）：4× package.json 改造、2× vitest.config.ts（chord 的删掉）、data 入库（A4）、`THIRD-PARTY-NOTICES.md` 与锚定信息回写（§9 约定）。唯一会「消失」的分歧：chord `boundary.test.ts` 的 1 行 `path.sep` 修复（chord 整包退出）。

### 3.3 wire 字节面：序列化路径对照（B 字节门的风险评估）

B 字节门要求 pi 侧 zero-tool 请求的 `wireBody` 与 DSH 审计逐字节一致——升级内核后这是最可能碎的门。逐函数对照（vendored vs main 源码 diff）：

- `convertTools`：**逐字一致**（diff = 0 行）。
- `convertMessages`：system prompt 注入从 `context.systemPrompt` 改为 transcript 前导 system 消息（i===0 → `getSystemMessageText(msg)` → `{role: instructionRole, content: sanitizeSurrogates(text)}`）；`instructionRole` 判定式与 0.85.1 相同（`model.reasoning && compat.supportsDeveloperRole ? "developer" : "system"`），deepseek `supportsDeveloperRole:false` → `"system"` 不变。**单 system prompt + user/assistant/tool 序列的输出形状保持**。
- `buildParams`：tools 从 `context.tools` 改 `resolveTranscriptTools(context.messages, …).requestTools`——工具面（C/D/E，语义门管辖）结构保持；`stream_options.include_usage`、`max_tokens` 分支、thinking 序列化（`thinkingFormat:"deepseek"` → `thinking:{type:"enabled"}` + `reasoning_effort`）逻辑未变；`prompt_cache_key`/`store` 对 deepseek（`supportsStore:false`、baseUrl 非 api.openai.com）不出场。
- 目录画像：§3.1 A3 已核逐字段一致。
- **残余风险**：OpenAI SDK 版本跳跃（openai 6.40.0 → 7.19.0，`ai/package.json` 对比）对请求体 JSON 键序/序列化的影响无法静态排除；`prompt_cache_key: undefined` 等新键在 SDK 序列化层的处理需实证。
- **处置**：t1–t5 双门重跑是升级验收的硬前置；若 B 门碎且 diff 可归因为「等价序列化方言」（键序/空键），按 P5b 先例（ADR-0011 Context：序列化方言不可分解）走形态记录 + 黄金字源重锚；工具 schema 序列化本就是「内核变量面」（ADR-0009：不可跨 SDK 字节一致），C/D/E 只受语义门约束。

## 4. 三条路的影响面与代价

### 4.1 路线一：不更新（锚定 `6671c604` 不动）

- **成本**：零工程成本、零验证成本、零判定链风险。生产（config E）与全部质量证据（judge recall 0.5962、E 判 B、四侧对照）锚定在当前内核上不动。
- **代价与风险**：
  1. **漂移复利**：上游 ~128 commits/周 + 连续大 breaking（0.99/1.2/1.3/Unreleased），每过一个月 re-anchor 的验证链成本不变但「上游行为面」差异变大，未来升级时的形态分歧记录更难归因。
  2. **目录锁定**：`deepseek-v4-flash` 只存在于 0.85.1 快照——单模型评测口径下无碍；但**换模型（模型迁移门 #14 的场景）若需新目录条目，0.85.1 快照读不到**（schema v5 数据 + 旧 `getModel`）。data 升级绑定源码升级（schema v6 只有 0.99+ 源码能读），不存在「只升 data」的便宜路。
  3. **网关鲁棒性修复吸收不到**：§2.4 表中 7 项重试修复对生产长跑（真实 PR 检视流）有实效——现行内核把网关瞬时错误终局化成失败 run。
  4. **无外部强制力**：本仓不依赖上游 npm 包、CI 不拉上游，「不更新」没有任何被动破坏路径。

### 4.2 路线二：升级 v1.3.0（fork re-anchor + review-pi 适配）

工作量分解（按依赖序）：

| 阶段 | 内容 | 估计 |
|---|---|---|
| R1 换树 | 上游 v1.3.0 tag 四包（实为三包：chord 退出）整树替换；重放 §4 接线（package.json ×3、telemetry vitest.config.ts、tsc 构建链、`build:pi` 拓扑去 chord）；从 npm tarball 重提取 43 个 data 文件入库 | 1–2 天（分歧面极小，见 §3.2） |
| R2 适配 | A1–A5：`finishTurn` 迁移（含 stopReason 守卫）、`TranscriptContext` 入口、`reviewModelOf` 模板切换、类型复核；5 个测试文件夹具复核 | 1–2 天 |
| R3 门 | 根 typecheck/test + review-pi 全测 + **t1–t5 双门重跑**（B 字节门是碎门高危区，见 §3.3）+ 上游包测试信号采集（agent 包 POSIX 失败面随 harness 删除基本消失；ai 27 个目录红应转绿） | 1 天 + 真源树预取墙钟 |
| R4 证据链 | **质量门重跑**（ADR-0011 中性条款：换集/换模型须重跑；内核变更同理——450 单元真跑 + judge 网关成本）+ cacheHitRate 跑前时段探针（ADR-0011 Decision 3）+ 对照报告新篇 | 这是大头（P5 量级真跑） |
| R5 决策留痕 | **新 ADR**（内核基座 re-anchor：锚点 6671c604 → v1.3.0、vendor 集 4→3 包、适配项与形态记录）；基线方案 §2/§3/§9 回写；`THIRD-PARTY-NOTICES.md` 更新 | 半天 |

**升级的收益**：网关重试鲁棒性全套；`prepareRequest`/`onProviderStreamEvent` 新缝（G1 部分闭合、审计增强）；agent 树 84 文件维护面与 chord 整包消失；与 npm 生态同版（SoL-Pi 邻仓 1.3.0 已验证可用性）；上游目录新鲜（未来换模型不再撞目录墙）。
**升级的风险**：B 字节门可能碎（键序/SDK 序列化方言，§3.3）——碎而不等价则需人工判定是否「形态分歧」；`argumentsError` 等协议收紧改变 C/D/E 工具回路行为，指标可能漂移（对齐门已转形态记录不拦上线，但漂移检测照跑）；1.3.0 未必是稳定停靠点（Unreleased 又在 breaking）。

### 4.3 路线三：选择性 backport（只挑关键修复）

- **可行面**：源码零分歧 → 任何 cherry-pick 都干净落位；§2.4 的重试修复集中在 ai 的错误分类/adapter 层，改动面窄。
- **不可行/不划算面**：
  1. 每笔 backport 都**扩大分歧清单**（基线方案 §9 要求逐笔回写 + fork 注释），直接违背演化缝盘点 §3 的成本侧原则（「每一次越缝都在缩小未来同步上游的自由度」——backport 同理，且它改的正是内核源码本体，比接线层分歧更贵）。
  2. 重试修复跨 0.99–1.3 多版本互相依赖（重试分类器是渐进补的），单点摘取可能拿不到完整行为。
  3. backport 后本仓树不等于任何上游 tag，未来 re-anchor 从「换树」退化成「真合并」——路线二的最大优势（零冲突面）被自毁。
- **结论**：backport 只在「单点紧急修复 + 明确不打算整体升级」时才成立；本仓现状不满足。

## 5. 推荐结论与纪律语境

**推荐：短期锚定不动；把升级立项为「下一个内核变更窗口的整体 1.x re-anchor」，不做 backport。**

1. **现在不动**（至 2026 年内）：config E 五天前刚切流生产（ADR-0011，2026-10-20），质量证据链（E 判 B、recall 0.5962）锚定在当前内核；ADR-0011 中性条款明示换集/换模型须重跑质量门——内核变更同理，R4 的真跑成本与当前收益（鲁棒性修复属生产运营改善，非评测正确性）不成比例。且上游仍在连续 breaking（1.2.0 chord 重写、1.3.0、Unreleased），不是稳定停靠点。
2. **触发条件**（满足其一即立项路线二，预计 R1–R3 约 3–5 天 + R4 真跑）：
   - 模型迁移门（#14）真的要换模型且新模型不在 0.85.1 目录快照内；
   - 生产长跑中网关瞬时错误（§2.4 形态）造成实际失败 run 且重试缺失被证实为主因;
   - 上游进入稳定期（连续两个 minor 无 breaking）或出现本仓刚需的内核能力（如 `prepareRequest` 承载新需求）。
3. **升级时必须携带**（不可裁剪）：新 ADR（内核基座变更属 ADR-0009/0011 语境下的内核变量面变更）；基线方案 §2/§9 与 `THIRD-PARTY-NOTICES.md` 回写；t1–t5 双门 + 质量门证据链重跑 + cacheHitRate 时段探针留痕；`deepseek-v4-flash` 目录退役的形态记录（wire id 不变、模板换 `deepseek-flash`，画像逐字段一致已预核）。
4. **与 DSH 兄弟仓对照的关系**：对照实验（P5b）已完成并按 ADR-0011 收口；未来升级 pi 内核不再是「对照实验变量」，而是本仓独立的内核演进决策——但 DSH 审计真源（`runs/phase2-dsh*`）仍是 t 系列门的不可再生资产，升级验收依赖它存续（跨仓限定语纪律：本仓 ADR-0011 ≠ DSH 线任何决策）。

---

**附：证据清单**（关键结论 → 出处）

| 结论 | 出处 |
|---|---|
| 锚点/接线/分歧/验证门 | 《Pi 内核定制基线方案》§2/§4/§5/§6/§9；`packages/*/package.json` |
| 缝盘点与越缝判据 | 《Pi 内核演化缝盘点》S1–S8、G1–G5、§3 |
| 从 0 重写边界与双门 | ADR-0009（Decision/Consequences、P4b 补记） |
| 上线门与 config E 切流 | ADR-0011（Context/Decision/Consequences） |
| 639 commits / 15 releases / main HEAD | `gh api repos/earendil-works/pi/compare/6671c604...main`、`releases?per_page=30`（73f8de80，2026-10-19） |
| agent breaking 全表 | 上游 `packages/agent/CHANGELOG.md`@main：[0.87.0] Breaking/Added、[0.99.0] Added、[1.0.0] Breaking、[1.1.0] |
| ai breaking 全表 | 上游 `packages/ai/CHANGELOG.md`@main：[0.86.0] Breaking/Fixed#9423、[0.87.0] Fixed#9816、[0.99.0] Breaking、[1.0.3]、[1.1.0] Breaking、[1.3.0] Breaking/Fixed#10897、[Unreleased] |
| 网关重试修复 | ai CHANGELOG：#10920（1.3.0+Unreleased）、#10842（1.2.0）、#10965（1.3.0）、#10543（1.1.0）、#10278（1.0.1）、#10487（1.1.0）、#9571（0.99.2）、#10497（1.1.0） |
| chord 重写 | 上游 `packages/chord/CHANGELOG.md`@main：[1.2.0] Breaking、[1.3.0] Breaking |
| agent 依赖只剩 pi-ai | `gh api contents/packages/agent/package.json?ref=main`（deps：pi-ai 1.3.0 + typebox） |
| agent 92→6 / chord 3 文件消费 / 零本地改动 | 本仓 `find packages/agent/src`、grep `@earendil-works/chord`、`git log d5b5534..HEAD -- packages/{ai,agent,chord,telemetry}`（空） |
| 目录退役与画像一致 | npm `pi-ai@1.3.0.tgz` `dist/providers/data/deepseek.json` vs 本仓 `packages/ai/src/providers/data/deepseek.json`（旧含 `deepseek-v4-flash`，新仅 `chat:deepseek-flash`/`chat:deepseek-v4-pro`；compat 逐字段对比） |
| `finishTurn`/`prepareRequest`/`AgentInitialState` | `gh api contents/packages/agent/src/{agent,types}.ts?ref=main`（agent.ts:114-141、types.ts:33-37/78-111/155-158/186-189） |
| `TranscriptContext`/`Context`/`Usage`/`reasoningEffort`/`stream.result()` | `gh api contents/packages/ai/src/{types,models,api/openai-completions}.ts?ref=main` + npm dist `utils/event-stream.d.ts`、`package.json` exports |
| convertTools 逐字一致 / convertMessages、buildParams 差异 | 本仓 `packages/ai/src/api/openai-completions.ts` vs 上游 main 同路径 diff |
| review-pi 使用面 / byte 门机制 | `packages/review-pi/src/loop/agent-review-loop.ts`、`src/provider/pi-client.ts`、`src/provider/usage-map.ts`、`src/bytegate/gate-runner.ts` |
| SoL-Pi 已消费 1.3.0 | `D:/xubao/code/AI4SE/SoL-Pi/package.json` devDeps |
