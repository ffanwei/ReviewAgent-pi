# 0037. MCP 上报：把进度、状态与结果经进度事件流外发

**状态**：已接受（2026-11-04；同日落地，见文末「实施记录」）
**关联**：ADR-0016（运行进度投影：只投影既有留痕、不新增审计键、不改 wire 字节、不改退出码）、ADR-0025（用户级 JSONC 单配置源）、ADR-0027（外部能力默认降级、只认显式输入）、ADR-0030（收尾摘要与进度旗标解耦）、ADR-0035（单包发行、内核按 npm 依赖精确锁版）、ADR-0038（退役对外部真源的逐字节对照）
**跨仓**：本 ADR 为本仓 pi 线序列 0037；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

需求方要在一次检视进行中，把**进度、状态与结果**上报给外部系统，接收端的形式已确认为：

| 项 | 结论 | 对方案的影响 |
|---|---|---|
| 接收端 | **已有的 MCP 服务**（不是我们要建的） | 协议由对方定，我们做 client |
| 传输 | **HTTP**（Streamable HTTP / JSON-RPC over POST） | **不做 stdio**，省掉子进程与 Windows 引号那一整档 |
| 消费方式 | **机器流水**（下游入库 / 入队，非人看看板） | 需要稳定的载荷 schema、`seq`、幂等；能接受迟到，不能接受乱序 |

这与「从 MCP 取数喂给模型」是两类问题：

| 维度 | 取数（读） | 上报（写） |
|---|---|---|
| 结果去向 | 进模型上下文，影响结论 | **不进模型**，模型完全无感 |
| 失败语义 | 降级或 strict 失败 | **绝不能影响检视结果**，是旁路 |
| 时序 | 必须在阶段推进前完成 | 可异步、可迟到、可丢 |
| 对请求字节的影响 | 会改阶段消息 | **零**（不进 wire） |
| 主要风险 | 提示注入、证据污染 | 顺序、去重、背压、泄密 |

本仓已经有一条为「投影」设计的接缝，纪律正好对上：

1. **`contracts/progress.ts` 定义了 `RunProgressSink`**，四类事件：`phase`（阶段推进）、`request`（模型请求首尾 + usage）、`tool`（工具调用首尾）、`skill`（规则 Skill 会话首尾）。头注释写死三条约束：**不新增审计键、不改 wire 字节、不改退出码**。
2. **注入点现成**：`run/review-run.ts:84` 的 `onProgress?: RunProgressSink`，`:171` 传给 loop；`cli/main.ts:132` 注入 CLI 渲染器。改成「组合 sink」即可多挂一个消费者。
3. **`progress-render.ts` 的 `switch` 现在处理四类**；新增 `kind` 必须走「未知即忽略」的默认分支，否则 TTY 状态行会抛错。
4. **缺口是 `run` 级**：开始与结束（含 findings 摘要、成本、truncated）没有事件，但数据在 `runReview` 收尾处已经齐备（`outcome.usage` / `findings` / `runId` / `truncated`）。
5. **字节门已退役**（ADR-0038），本 ADR 不需要为「不碰阶段指令 / 七工具 schema」做任何绕行——上报本来就不进 wire。

## Decision

### 1. 上报挂在进度事件流上，不挂阶段钩子

```text
runReview ──emit──> RunProgressSink ──┬──> CLI renderer（已有）
                                      └──> MCP reporter（新增，只在 CLI 侧组装）
```

**明确不做**：不在 `advancePhase()` 里插 `await mcpCall(...)`。理由：

- 阶段钩子同步阻塞，网络 I/O 会直接拖慢检视；
- 阶段钩子只覆盖边界，覆盖不了「阶段内部」——而事件流天然覆盖（阶段内的每次请求、每次工具调用都会发射）；
- 阶段钩子会把「外部系统不可用」变成主链的一个分支，ADR-0016 的接缝从一开始就不允许这样。

### 2. 上报是独立契约，不是内部事件的直出

内部 `RunProgressEvent` 会随内核演进，**不能直接当出站 schema**。上报定义自己的一层 DTO，由纯函数映射：

```ts
/** 出站事件的稳定面：字段只会追加，不会改名或改语义（schemaVersion 升级才允许破坏性变更） */
type ReportEventType =
  | "run.start"
  | "phase"
  | "request.start" | "request.end"
  | "tool.start"    | "tool.end"
  | "skill.start"   | "skill.end"
  | "run.end";
```

`run.start` / `run.end` 是本次新增的两类内部事件，其余六类由现有事件映射得到。

### 3. 载荷：信封 + 事件

```ts
interface ReportEnvelope {
  readonly schemaVersion: 1;
  /**
   * 上报流标识（reporter 生成，一次 run 一个）。
   * 不能用 `runId` 当流键：`runId` = 首次模型请求时刻（ADR-0032），
   * 在 run 开始上报时**还不可知**；它只在 `run.end` 事件里出现。
   */
  readonly streamId: string;
  /** 1-based，单流内严格递增；接收端按 (streamId, seq) 去重 */
  readonly seq: number;
  /** 事件发生时刻（ISO-8601）；不是发送时刻 */
  readonly at: string;
  readonly event: ReportEvent;
}
```

**批量调用**的 `arguments`：

```jsonc
{
  "streamId": "3f2c1a9e-…",
  "schemaVersion": 1,
  "events": [ { "seq": 1, "at": "...", "event": { "type": "run.start", ... } }, ... ]
}
```

> 为什么不是 `runId`：`runId` 由首次模型请求时刻决定（ADR-0032 明确禁止改用
> `runReview` 入口的 `startedAt`），所以 `run.start` 发出时它从未存在过。
> 流键由 reporter 自己分配；`run.end` 到达时接收端再把它与产物 `runId` 关联。

字段白名单（**出站最小化**）：

| 事件 | 字段 | 来源 |
|---|---|---|
| `run.start` | `caseId`、`model`、`startedAt` | `runReview` 入参 |
| `phase` | `round`、`phase`（名）、`phaseKey`（v1 等于名）、`index`、`total` | `phaseLog` 推进点 |
| `request.start` / `.end` | `requestId`；end 另带 `durationMs`、`usage` | `onPayload` / `shouldStopAfterTurn` |
| `tool.start` / `.end` | `name`；end 另带 `durationMs`、`ok`、`resultChars`、`resultLines` | 工具包装层 |
| `skill.start` / `.end` | `round`、`skill`、`status`、`requestCount`、`toolCallCount` | `skillPassLog` |
| `run.end` | `status`、`durationMs`、`usage`、`truncated`、`findings{count,bySeverity}`、`runId`（**成功路径才有**） | `runReview` 收尾 |
| `run.end`（出站增强） | `dropped`、`failed` | **reporter 注入**（核心不知道上报状态，也不应该知道） |

**明确不上报**：代码片段、finding 正文、工具参数原文、宿主绝对路径、任何密钥、`apiKey`、`headers`。`$changedFiles` 之类的仓库路径也不上报——机器流水拿 `runId` 自己关联即可。

### 4. 传输：只做 HTTP，接口留一层

| 做 | 不做 |
|---|---|
| JSON-RPC 2.0 编解码、id 配对、错误码映射 | stdio（本地 `npx` 服务）——本场景不需要 |
| `initialize` 握手（版本协商，不匹配即明确报错） | OAuth 授权流程 |
| `tools/call`（POST） | resources / prompts / sampling / roots |
| 响应是 `application/json` 或 `text/event-stream` 都解析 | 长连接 GET 流、断线自动重连、多路复用 |
| 单次超时 + `AbortController` | 富媒体内容（只消费 `text` 内容块） |

传输放在 `src/mcp/transport.ts` 的接口后面（`send(request): Promise<response>`），HTTP 是唯一实现。将来真需要 stdio 时新增一个实现即可，不动 `client.ts` 与 `report.ts`。

### 5. 投递语义（机器流水版）

| 问题 | 决策 | 理由 |
|---|---|---|
| 是否阻塞 | **不阻塞**：`emit()` 只入队 | 上报慢不能拖慢检视 |
| 批量 | 满 `batch.maxEvents` 条或距首条超 `batch.maxDelayMs` 即发 | 流水场景下减少请求数 |
| 顺序 | 单 writer，FIFO；`seq` 严格递增 | 接收端可检测缺口 |
| 幂等 | 键 `(streamId, seq)` | 重试不产生重复 |
| 重试 | 最多 3 次，100/400/1600 ms 退避，整体受 flush 预算约束 | 瞬时故障自愈 |
| 收尾 | `runReview` 返回后 `await flush(flushTimeoutMs)`，超时放弃 | 保证「跑完基本都发出去」 |
| 失败 | 计 `failed` / `dropped`，在 `run.end` 里回报；stderr 一行摘要 | 旁路不能反噬主链 |
| 背压 | 队列上限 `queue.maxEvents`，溢出**丢最旧**并计数 | 宁可丢进度，不撑爆内存 |
| 崩溃 | **v1 不做 spool**；预留配置位，出现「进程被杀导致丢单」的事故再开 | 避免无消费者时的过度设计 |
| 退出码 | **永不改变**，没有 `--strict-mcp` | 外部系统没起不能毁掉一次检视 |

`dropped` / `failed` 由 reporter 在映射 `run.end` 时注入，随最后一批上报，是接收端判断「这段流水是否完整」的唯一依据。核心包里的 `run.end` 事件不含这两个字段。

### 6. 配置

```jsonc
{
  "mcp": {
    "servers": {
      "ops": {
        "transport": "http",
        "url": "https://mcp.example.com/mcp",
        "headers": { "Authorization": "Bearer sk-..." },
        "timeoutMs": 10000
      }
    },
    "report": {
      "server": "ops",
      "tool": "report_events",
      "include": ["run.start", "run.end", "phase", "request.end"],
      "batch": { "maxEvents": 50, "maxDelayMs": 2000 },
      "queue": { "maxEvents": 1000 },
      "flushTimeoutMs": 5000,
      "findings": "summary"
    }
  }
}
```

- **单槽位 `tool`**：机器流水只需要一个接收工具，批量塞进 `events` 数组；对方若拆成多个工具，用 `include` + 多个 report 块表达（v1 不做）。
- `include` 缺省 `["run.start", "run.end", "phase", "request.end"]`——`tool.*` 与 `skill.*` 默认不上报（频率最高、对流水价值最低）。要就显式加。
- `findings`：`none` / `summary`（缺省）。机器流水默认只要 `summary`（条数 + 严重度分布）；
  **v1 不支持 `full`**——finding 正文永不出进程，要正文请读 `reviews_en.json`（配置写 `full` 直接 `ConfigError`）。
- 走主配置（ADR-0025 单一配置源），`--config` 仍可换整份文件；**不做 `--mcp-config`**。
- `headers` 里的秘密与 `reviewer.apiKey` 同等待遇：文件 `0600`、`config show` 只报 `set | missing`、审计 / stdout / stderr 均不回显。

### 7. 组装点在 CLI，核心包对 MCP 零 import

`onProgress` 本来就是 `cli/main.ts` 注入的。reporter 的创建、`flush`、关闭都在 CLI 侧；`runReview` 只负责多发射 `run.start` / `run.end`。

好处：

- `src/mcp/**` 只被 `cli/` 引用，库使用者与测试默认不付任何代价；
- 核心包保持「不知道有 MCP 这回事」，将来的取数形态也不会把两套语义搅在一起。

### 8. 不写进审计文件

**不新增 `mcpLog` 审计键**。理由：审计是「可复现的运行记录」，而网络结果（耗时、失败、丢弃）本质上不可复现；写进去等于让审计变成非确定性产物。留痕改为：

- `run.end` 事件里的 `dropped` / `failed`（随流水走）；
- stderr 一行摘要：`mcp report: sent 42 / failed 1 / dropped 0`；
- 不新增任何落盘产物（v1 无 spool）。

### 9. 阶段演进：消费方按 `type` + `phaseKey`，不按下标

`ReviewPhase` 现在是 6 个名字字面量，`phaseKey` 在 v1 就等于它。将来落 `PhaseProfile` / `PhaseDescriptor`（语义 `role` 替代 `CANDIDATES_PHASE_INDEX` 之类的下标常量）时：

- 上报契约**不改**：`phase` 事件继续带 `phaseKey`（稳定标识）+ `index` / `total`（仅显示用）；
- 接收端不得按 `index === 5` 判断「这是验证阶段」，只能按 `phaseKey`；
- 自进化只在「离线生成 → 评测 → 发布新版本」闭环里做，运行期不改指令。

### 10. 边界：模型驱动取数明确出界

若将来要「模型在阶段内自己调 MCP 工具取数」，那是另一个决策：工具表要扩、`fromWireToolName` 要改成命名空间感知、结果进上下文要处理注入与「不得成为 finding `evidence`」。本 ADR 只保证 `client.ts` 是纯客户端，能复用。

## Options（为什么不是别的）

- **A. 官方 `@modelcontextprotocol/sdk`**：实测 `1.32.2` unpacked 4.49 MB、17 个直接依赖（含 `express` / `hono` / `cors` / `jose` / `ajv` / `express-rate-limit`，多为 server 侧），`npm install --dry-run` 新增 **95 个包**（当前全局安装 `review-pi` 是 107 个）。我们只用 client 侧一个子集。否。
- **B. `@anthropic-ai/sdk/helpers/beta/mcp`**：方向相反（把工具交给模型在 `toolRunner` 里调用）、绑 Anthropic Beta Messages、仍要求自备 `mcpClient`。否。
- **C. 完整自研（stdio + HTTP 两种传输）**：本场景接收端已确认是 HTTP 平台服务，stdio 的收益为零，而它是测试成本最高的一档（子进程、半包、Windows 引号、退出清理）。**收窄为 HTTP-only**，接口留一层。
- **D. 阶段钩子（`advancePhase` 内 await）**：阻塞主链、只覆盖边界、把外部故障引入主链分支。否。
- **E. 把 MCP 工具挂给模型**：上报不需要模型参与。否。
- **F. 等 pi 内核支持 MCP**：`pi-agent-core` 0.85.1 / 0.86.0 / 0.86.1 与 `pi-ai` 0.85.1 实测 `mcp` 命中均为 0。否。
- **G. 不用 MCP，直接 plain HTTP POST**：接收端已存在且是 MCP，改协议要对方配合，收益只是省掉握手。否（但说明：MCP 在此场景的价值确实只有「标准信封」，复杂度主要来自 `initialize` 与 SSE 解析）。
- **H. 核外 reporter 模块（像 `presentation.engine` 那样动态 import 用户脚本）**：核心最省，但把协议维护推给使用方；接收端是既有服务、协议稳定，不需要这个逃生口。**保留为将来的扩展位**。
- **I. 写进审计 `mcpLog`**：网络结果不可复现，会污染审计。否。

## Consequences

- **正**：
  - 主链零风险：上报是 sink 的消费者，`emit()` 不阻塞，失败不改退出码；
  - 阶段内与阶段边界都被覆盖，无需任何钩子；
  - 零新增运行时依赖，发行面不变；
  - 出站 schema 独立于内部事件，内核怎么演进都不破坏接收端；
  - 审计保持可复现，产品级逐字节契约（ADR-0038 C 类）零改动。
- **负 / 风险**：
  - 自研客户端要自己跟 HTTP 版 MCP 的演进（版本协商、SSE 分帧）；
  - 机器流水对**完整性**敏感，而 v1 没有 spool：进程被强杀时最后一批会丢（`run.end` 也就不会发出，接收端只能靠超时判定）；
  - `include` 默认不含 `tool.*`，若对方确实要工具级明细，需要改配置并接受请求量上升；
  - 出站流量的泄密面靠字段白名单把守，新增字段必须先过一遍「是否可以出站」。
- **中性**：
  - `stdout` 键集、退出码、审计顶层键序、七工具面、阶段指令全部不变；
  - 配置新增一个可选块，不配置即不存在（N=0 零成本、零网络）。

## 验收标准

1. **N=0 零影响**：无 `mcp.report` 配置时，不建连、不发请求；stdout / 审计 / 退出码与今天一致。
2. **事件补齐**：`run.start` / `run.end` 在正确时点发射；异常路径必发 `run.end(status="failed")`。
3. **不阻塞**：用一个「永不返回」的假 transport，run 仍能正常跑完。
4. **收尾 flush**：`flushTimeoutMs` 内尽力发完；超时后仍 `exit 0`，stderr 一行摘要。
5. **顺序与幂等**：假服务端收到的 `seq` 严格递增、无重复；注入重试后集合不重复计数。
6. **背压**：灌入超过 `queue.maxEvents` 的事件时丢最旧，`run.end.dropped` 数值正确。
7. **失败不改退出码**：连接拒绝 / 401 / 超时均 `exit 0`，findings 正常产出。
8. **秘密不泄漏**：`headers` 值不出现在审计、转录、stdout、stderr、`config show`。
9. **CLI 渲染面不变**：新增 `kind` 在 TTY 状态行与事件行上都不产生输出。
10. **schema 稳定**：`ReportEnvelope` 的字段只增不改；接收端按 `(streamId, seq)` 去重、按 `phaseKey` 而非 `index` 判断阶段；`runId` 只保证在 `run.end` 里出现（且仅成功路径）。
11. **核心零耦合**：`packages/review-pi/src/{loop,run,contracts,tools}` 不 import `src/mcp/**`（用 grep 断言）。

## 实施记录

**日期**：2026-11-04（实现落地；状态从「提议」转「已接受」）

### 文件清单

| 新增 | 行数级 | 职责 |
|---|---|---|
| `src/contracts/mcp-report.ts` | ~120 | 出站契约：事件类型全集、事件形状、信封、统计 |
| `src/mcp/protocol.ts` | ~120 | JSON-RPC 编解码 + SSE 分帧（纯函数） |
| `src/mcp/transport.ts` | ~80 | 传输接口 + HTTP 实现（唯一实现） |
| `src/mcp/client.ts` | ~180 | `initialize` → `tools/call` → `close` |
| `src/mcp/config.ts` | ~40 | `mcp` 配置块 → 运行期 `ReportConfig` |
| `src/mcp/report.ts` | ~280 | 白名单映射 + 队列 / 批量 / 重试 / flush |
| `src/mcp/index.ts` | ~15 | 对外出口 |
| `src/shared/version.ts` | ~2 | 产品版本单源（`clientInfo.version`） |

改动：

- `src/contracts/progress.ts`：新增 `run` start / end 两类事件（仍是既有留痕投影）。
- `src/run/review-run.ts`：入口发 `run.start`，成功收尾发 `run.end(status="ok")`，
  **异常路径发 `run.end(status="failed")` 后原样重抛**（`runReview` = 薄包装 +
  `runReviewInner`，主体一行未改）。
- `src/shared/config.ts`：新增 `mcp` 块解析（默认值 / 范围 / 未知事件类型 fail fast）、
  `configSnapshot` 的 `secret` 增加 `mcp.servers.<name>.headers`；模板新增注释块。
- `PiAgent.example.jsonc`：与 `DEFAULT_CONFIG_TEMPLATE` 保持逐字节同源。
- `src/cli/main.ts`：组装 reporter、组合 sink、`finally` 里 `flush` + 一行 stderr + `close`。
- `src/cli/progress-render.ts`：**零改动**（`switch` 无 default 分支，未知 kind 自然忽略）。

### 实现期确定的两处设计细节

1. **信封键用 `streamId` 而不是 `runId`**。`runId` = 首次模型请求时刻（ADR-0032，
   明确禁止改用 `startedAt`），`run.start` 发出时它还不存在；`run.end` 里带
   `runId`，接收端据此关联产物。这是本节对决策 3 的唯一修订。
2. **`findings` 只有 `none` / `summary`**，`full` 在装载期直接拒绝：finding 正文
   的出口永远只有 `reviews_en.json`。

### 测试清单

| 文件 | 覆盖 |
|---|---|
| `mcp/protocol.test.ts` | 编解码往返、6 类非法结构、SSE 多行 `data:` / CRLF |
| `mcp/transport.test.ts` | 真本地 HTTP：请求形状、两种 content-type、非 2xx 不抛、超时且不回显 headers |
| `mcp/client.test.ts` | 握手一次、版本不接受、未握手调用、SSE 响应、非 2xx、JSON-RPC error、非 text 块丢弃 |
| `mcp/report.test.ts` | 批量触发、`seq` 递增、include 过滤、背压丢最旧、重试 3 次、重试耗尽、flush 超时、close 幂等、run.end 注入、工具事件不入参 |
| `mcp/no-core-coupling.test.ts` | 核心目录零 `mcp/` import；组装点唯一 |
| `run/progress.test.ts` | `run` 事件时点与字段、findings 摘要、正文不外泄 |
| `shared/config.test.ts` | mcp 缺省值、secret 映射、server 不存在 / include 未知 / stdio / findings=full、模板解析为 null |
| `shared/version.test.ts` | `REVIEW_PI_VERSION` 与 `package.json` 同源 |

验证：`pnpm --filter review-pi test` → 59 files / 544 passed / 1 skipped；
`pnpm -r typecheck` → exit 0。

### 欠账（明确不做）

- **未与真实 MCP 接收端做端到端验证**：手上没有可用的服务地址与工具名，
  全部验证止于本地假 server / 假 transport（验收 1–11 中的 3、4、5、7 用注入实现）。
  接入真实接收端后需补一次真机记录（照 ADR-0036 的表格式）。
- 版本判定未执行：新增能力 ⇒ `0.2.0 → 0.3.0`，留给 release 提交（`package.json`
  与 `REVIEW_PI_VERSION` 两处同时改，由 `version.test.ts` 把守）。
- 心跳 `status` 事件、多接收端、磁盘 spool 均按决议不在 v1。
