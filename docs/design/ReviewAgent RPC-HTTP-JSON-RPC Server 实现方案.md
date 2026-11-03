# ReviewAgent RPC / HTTP / JSON-RPC Server 实现方案

> **时效注记（ADR-0035，2026-11-03）**：本文文首的「vendored pi 锚定 commit `6671c604` 源码」前提已不成立——
> 内核四包改为 npm 上游依赖（精确锁 `0.85.1`），仓内不再有 `packages/{protocol,client,server}` 或四包源码树；
> 文中对 pi 实验性栈的源码引用请按上游 tag `v0.85.1` 核读。**结论仍有效**：不自建 CBOR/Unix socket 栈，
> ReviewAgent 侧走 HTTP JSON-RPC 2.0 + SSE。方案本身尚未实施（现无 `review-pi-server` 包）。

> **文首说明**（2026-10-20）：本文以 vendored pi 锚定 commit `6671c604`（v0.85.1+11d）的源码为准，
> 分析 pi 实验性 `protocol` / `client` / `server` / `session-backends` 栈，并给出 ReviewAgent
> 自建 HTTP / JSON-RPC server 的落地设计。
>
> **一句话结论**：**不整体 vendor pi 这四个包**。pi 栈是「CBOR 帧 + Unix socket + Chord service
> + 持久 Session 附件」的本地多端会话框架；ReviewAgent 需要的是「HTTP JSON-RPC 2.0 + SSE +
> 有界 review job 队列」。两者在传输、寻址语义、会话模型、鉴权与部署形态上都不同。推荐新增
> `review-pi-server` 包：以 `ReviewService` 为深模块，`runReview` 为执行适配器，HTTP/JSON-RPC
> 只做薄传输适配；pi 栈仅作为协议设计参照，后续如有真实 pi 客户端需求再加兼容适配器。

---

## 0. 决策摘要

| 决策点 | 结论 |
|---|---|
| 是否 vendor pi `protocol/client/server/session-backends` | **否**（整栈不 vendor） |
| 对外主协议 | **HTTP + JSON-RPC 2.0**（`POST /rpc`） |
| 进度推送 | **SSE**（`GET /v1/jobs/{jobId}/events`，支持 `Last-Event-ID` 重放） |
| 会话模型 | 先做 **job-oriented**（一次 MR 检视 = 一个 job），不引入 pi 的 attachment / 多 presentation |
| 持久化 | `ReviewJobStore` 端口：内存适配器（测试）+ `node:sqlite` 适配器（生产） |
| 执行形态 | `ReviewExecutor` 端口：P1 进程内适配器；P3 切 worker 池，隔离 CPU/parser 并支持硬取消 |
| 与 pi 内核的关系 | 只依赖 `runReview` 与 `Agent`/agent-loop 稳定面；**不依赖 harness/session/chord**（上游 1.x 会移除这些） |
| 默认配置 | `configId` 必填显式（ADR-0011）；服务端不给隐式缺省 |
| 与 pi-protocol 兼容 | 作为 P4 可选适配器；不作为核心协议，因为上游已于 `7472cda0d`（2026-10-12）移除该实验栈 |

---

## 1. pi 实验性 server 栈源码事实（锚定 `6671c604`）

### 1.1 包与依赖关系

| 包 | 作用 | 依赖 |
|---|---|---|
| `@earendil-works/pi-protocol` | 传输无关的 routed envelope + CBOR 编解码 + 4 字节大端长度帧 | `chord`、`typebox` |
| `@earendil-works/pi-server` | 实验性本地 server：连接握手、路由、会话附件、subscription 发布 | `chord`、`pi-agent-core`、`pi-protocol` |
| `@earendil-works/pi-client` | 传输无关客户端：请求相关、订阅、附件切换 | `chord`、`pi-protocol` |
| `@earendil-works/pi-session-backend-sqlite-node` | `pi-agent-core` Session 的 Node `node:sqlite` 后端 | `pi-ai`、`pi-agent-core` |

上游 `coding-agent` 在锚定版本里把 `pi-client` / `pi-protocol` / `pi-server` 列为 **devDependencies**，
且 npm 发布物与 standalone binary 不包含 server/client 命令与 experimental 源码。这本身就说明它们
是开发期实验面，不是稳定产品面。

### 1.2 `pi-protocol`：传输无关的 CBOR 协议

- 协议版本：`PROTOCOL_VERSION = 8`（`packages/protocol/src/protocol.ts`）。
- 客户端首帧必须是 `hello`；服务端回 `hello`（带 `serverId`）或 `hello_error`。
- 客户端消息：`request` / `cancel`；服务端消息：`response` / `service_update` / `attachment`。
- 寻址目标只有两类：
  - `server`：`{ serverId }`
  - `session`：`{ serverId, sessionId, attachmentId }`
- `request.call` 与 `response.result` 是不透明 strict JSON；协议只校验 JSON 值域，不理解业务语义。
- 帧格式：4 字节无符号大端 payload 长度 + 一个 definite-length CBOR item。
- 默认上限：16 MiB/帧、1,000,000 个数组元素或 map 项、64 层嵌套。
- **没有鉴权**：README 明确写「Peer authentication and authenticated service contexts are not
  implemented by the experimental transport.」

关键事实：pi-protocol 不是 JSON-RPC，也不是 HTTP。它是 CBOR + 长度前缀的字节流协议。

### 1.3 `pi-server`：会话路由 + Chord 服务 + 多 presentation

核心接口（`packages/server/src/types.ts`）：

```ts
interface ServerHost<TMetadata extends SessionMetadata> {
  readonly serverServices: RoutedServerServiceHost;
  resolveSession(sessionId: string, context: Context): Promise<TMetadata>;
  openSession(metadata: TMetadata, context: Context): Promise<RoutedSessionHandle>;
}
```

- `RoutedServerServiceHost.attachClient()`：每条连接拿到一个 server-scoped 服务端点。
- `RoutedSessionHandle.attachClient()`：每次 attach 生成一个 presentation-scoped attachment。
- `RoutedSessionAttachment.invokeService()`：把 `ServiceCall` 原样转发给 owning provider。
- `SessionRouter`：维护 `hostedSessions`、`attachmentsByClient`、`openingSessions`、
  `clientOperations`，保证同一 session 的多 presentation 路由、断线释放、关闭排空。
- 服务调用的 payload 语义由 **Chord** 拥有：`{ serviceId, instance?, member, args }`、
  订阅快照/更新、错误码、状态 codec。server 本身不做业务解码。
- 传输实现只有 **Unix domain socket**（`transports/unix`）。没有 HTTP listener。
- 生命周期：server shutdown 关闭所有 routed Session handle；断线只释放该 presentation 的
  attachment，已 admitted 的调用仍可能完成。

关键事实：pi-server 是「本地多 presentation 会话服务器」，不是「无状态 RPC 服务」。

### 1.4 `pi-client`：长连接 + 请求相关 + 订阅，不自动重连

- 传输抽象是 ordered byte transport（Unix socket / 其它有序字节流）。
- 请求按 `id` 相关；`attach` 成功后由服务端 out-of-band 发 `attachment`。
- 断线时 pending request 本地拒绝，但已 accepted 的工作**可能仍在远端完成**。
- **不自动 reconnect、不自动 replay**；重连后必须重新 attach，并显式重放安全操作。

关键事实：pi-client 面向「可重连的交互式会话」，ReviewAgent 面向「一次提交、异步完成」的
长任务，二者生命周期语义不同。

### 1.5 `session-backends/sqlite-node`

- 实现的是 `pi-agent-core` 的 `SessionRepo` / Session storage 接口。
- 每个 Session 一个 SQLite 文件；支持 append-only entries、branch/fork、usage ledger。
- 明确要求 host 保证「一个 Session 同一时刻只有一个 writable owner」；不提供跨进程
  lease / lock / fence / heartbeat / takeover。
- 与 ReviewAgent 的 `RunRecord` / audit 文件模型没有直接映射。

关键事实：如果未来要做「可续聊的 Review Session」，它是候选底座；但对一次 MR 检视 job
的队列、状态、幂等、取消没有帮助。

### 1.6 另一条线：`coding-agent` 自带 stdio JSONL RPC

`packages/coding-agent/src/modes/rpc/` 在锚定版本里已有 headless RPC mode：

- stdin 收 JSON line 命令（`prompt` / `abort` / `set_model` / `get_state` / session 管理等）。
- stdout 发 JSON line 响应与事件。
- 与 `AgentSessionRuntime`、extension UI、TUI 生命周期耦合，是 application-specific 的
  stdio 协议，不是 HTTP，也不是 pi-protocol。

关键事实：ReviewAgent 若需要「本地嵌入」，可借鉴这种 JSONL stdio 形态，但不应复用
coding-agent 的命令集。

### 1.7 上游现状（2026-10-20）

- 上游在 `7472cda0d`（2026-10-12）已删除 `protocol` / `client` / `server` 包，并重写 chord；
  `v1.3.0` main 上不再有这套 server 栈。
- 本仓 vendored 锚点仍是 `6671c604`；《Pi 内核上游更新影响分析》结论是「短期锚定不动，
  升级留到下一个内核变更窗口整体跳 1.x」。
- 因此本方案按锚定树设计，但**不把实现绑死在这套实验栈上**；未来升级 1.x 时 server 不应
  被连带重构。

---

## 2. ReviewAgent 需求与 pi 栈的差异

| 维度 | pi 实验栈 | ReviewAgent server 需要 |
|---|---|---|
| 传输 | CBOR 帧 + Unix socket | HTTP/1.1（可扩展 HTTP/2）+ JSON-RPC 2.0 |
| 推送 | `service_update` + attachment 路由 | SSE 事件流（按 job 订阅），可重连重放 |
| 寻址 | `{serverId, sessionId, attachmentId}` | `{tenantId, jobId}` + 可选 `caseId` |
| 会话 | durable Session + 多 presentation attachment | 一次 MR 检视 = 一个 job；future 可加 session 分组 |
| payload 语义 | Chord ServiceCall，server 不解析 | 明确方法契约，server 必须校验与授权 |
| 持久化 | pi-agent-core Session entries + SQLite backend | job 状态机 + 事件日志 + audit/record 引用 |
| 鉴权 | 应用自己实现；协议不含 | 必须内置 principal/scopes；企业接入硬要求 |
| 生命周期 | 长连接、断线释放 attachment | 提交即入队；HTTP 断开不等于取消 job |
| 并发 | 连接/session 维度 | 有界 worker 池 + 队列深度 + 背压 |

**结论**：pi 栈解决的是 A 问题，ReviewAgent 需要 B 问题；强行 vendor 会得到一套
「还要再写 HTTP listener、再写鉴权、再写 job 状态机」的框架，收益为负。

---

## 3. 推荐架构

### 3.1 总览

```text
                       ┌────────────────────────────────────────┐
  HTTP/JSON-RPC client │  review-pi-server                      │
  ────────────────────>│  http adapter (node:http)              │
                       │    ├─ POST /rpc        JSON-RPC 2.0    │
                       │    ├─ GET  /v1/jobs/{id}/events  SSE   │
                       │    ├─ GET  /healthz /readyz            │
                       │    └─ auth / limits / error mapping    │
                       │                 │                      │
                       │                 v                      │
                       │        ReviewService (deep module)     │
                       │  submit/get/list/cancel/subscribe/close│
                       │                 │                      │
                       │    ┌────────────┼────────────┐         │
                       │    v            v            v         │
                       │ JobStore   JobQueue   EventLog        │
                       │ (memory/   (bounded   (append-only)    │
                       │  sqlite)    worker)                   │
                       │                 │                      │
                       │                 v                      │
                       │      ReviewExecutor (port)             │
                       │                 │                      │
                       └─────────────────┼──────────────────────┘
                                         v
                              runReview (review-pi)
                                    │
                                    v
                         pi-ai / pi-agent-core (vendored)
```

设计要点：

- **`ReviewService` 是唯一深模块**：调用者只需要知道 6 个方法；队列、状态机、幂等、
  持久化、取消、事件重放全部藏在接口后面。
- **传输是适配器**：HTTP/JSON-RPC + SSE 是 P1 唯一适配器；stdio JSONL 或 pi-protocol
  兼容是 P4 可选适配器。传输层薄到只做解析、鉴权、错误映射、流控。
- **执行是端口**：`ReviewExecutor` 把 `runReview` 包起来；测试用 fake executor，
  生产 P1 用 in-process，P3 用 worker 池。两个以上适配器 = 真实 seam。
- **不依赖 chord/harness/session**：只依赖 `runReview` 与 pi `Agent`/agent-loop 稳定面，
  避免未来 pi 1.x 移除 harness 时 server 被连带重写。

### 3.2 新包与文件布局

```text
packages/review-pi-server/
  package.json
  bin/
    review-pi-server.js          # 薄入口：argv/env → startServer → 退出码
  src/
    index.ts                     # 公开面：createReviewService / startHttpServer
    service.ts                   # ReviewService 深模块
    contracts.ts                 # JobView / 状态 / 错误码 / CallContext
    store.ts                     # ReviewJobStore 端口
    stores/
      memory.ts                  # 测试/单进程
      sqlite.ts                  # node:sqlite 生产适配器
    queue.ts                     # 有界并发 + 排队 + drain + 取消
    events.ts                    # append-only job event log + 订阅扇出
    executor.ts                  # ReviewExecutor 端口
    executors/
      run-review.ts              # runReview 适配器（P1）
      worker.ts / worker-pool.ts # worker_threads 执行池（P3）
    source.ts                    # ReviewSourceProvider 端口（inline / MR provider）
    http/
      server.ts                  # node:http 路由 + 生命周期
      json-rpc.ts                # JSON-RPC 2.0 解析/校验/错误映射
      sse.ts                     # text/event-stream + Last-Event-ID
      auth.ts                    # Authenticator 端口 + bearer/mTLS 实现
    testing/
      fake-executor.ts
      memory-store.ts
```

构建接线：

- 根 `package.json` 增加 `build:pi-server`（依赖序：`review-pi` → `review-pi-server`）。
- 新包 `dependencies` 只写 `review-pi: workspace:*`；SQLite 使用 Node 内置 `node:sqlite`，
  不引原生第三方依赖。
- `exports` 沿用本仓形态：`types`/`source` 指向 `src/index.ts`，`default` 指向 `dist/index.js`。

### 3.3 深模块接口

```ts
export interface ReviewService {
  submit(input: ReviewSubmitInput, ctx: CallContext): Promise<ReviewJobView>;
  get(jobId: string, ctx: CallContext): Promise<ReviewJobView | undefined>;
  list(query: ReviewJobQuery, ctx: CallContext): Promise<ReviewJobPage>;
  cancel(jobId: string, ctx: CallContext): Promise<ReviewJobView>;
  subscribe(
    jobId: string,
    afterSeq: number,
    listener: ReviewJobEventListener,
    ctx: CallContext,
  ): Promise<ReviewSubscription>;
  close(): Promise<void>;
}
```

接口不变量：

- `submit` 对 `(tenantId, clientRequestId)` 幂等；重复提交返回既有 job。
- job 状态单调推进；终态不可逆。
- 同一 job 至多一个执行实例。
- `get/list/cancel/subscribe` 在 store 查询层做 tenant 过滤，越权统一按 not found 处理。
- HTTP 连接断开**不取消 job**；只有显式 `review.cancel` 才取消。
- `subscribe` 从 `afterSeq` 之后重放，支持 SSE `Last-Event-ID`。
- `close` 停止收单、排空运行中 job；超时后按配置硬停 worker。

`ReviewExecutor` 端口：

```ts
export interface ReviewExecutor {
  execute(
    request: ReviewExecutionRequest,
    ctx: ReviewExecutionContext,
  ): Promise<ReviewRunResult>;
}

export interface ReviewExecutionContext {
  readonly jobId: string;
  readonly signal: AbortSignal;
  readonly onProgress?: (event: ReviewProgressEvent) => void;
}
```

- `ReviewExecutionRequest` 从 `ReviewSubmitInput` 投影而来，包含 caseId / repoPath / diff /
  issueDescription / configId / modelId；凭据由 server 配置注入，不来自客户端。
- `runReview` 适配器是**唯一 import `review-pi` 的模块**；测试用 `FakeExecutor`。
- `persistRecord` 保持内核默认 `true`：server 只存 job 索引与 `recordPath`/`auditPath` 引用，
  不另写一份 RunRecord，避免双写。

`ReviewJobStore` 端口：

```ts
export interface ReviewJobStore {
  create(job: ReviewJobRecord): Promise<ReviewJobRecord>;
  get(tenantId: string, jobId: string): Promise<ReviewJobRecord | undefined>;
  list(tenantId: string, query: ReviewJobQuery): Promise<ReviewJobPage>;
  transition(
    tenantId: string,
    jobId: string,
    from: readonly ReviewJobStatus[],
    to: ReviewJobRecord,
  ): Promise<ReviewJobRecord>;
  appendEvent(event: ReviewJobEvent): Promise<void>;
  readEvents(tenantId: string, jobId: string, afterSeq: number): Promise<ReviewJobEvent[]>;
  close(): Promise<void>;
}
```

---

## 4. 对外协议契约

### 4.1 HTTP 端点

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/rpc` | JSON-RPC 2.0（单请求；batch 可选后置） |
| `GET` | `/v1/jobs/{jobId}/events` | SSE 事件流；支持 `Last-Event-ID` |
| `GET` | `/healthz` | liveness；只证明进程在 |
| `GET` | `/readyz` | readiness；store 可写、worker 池已启动 |
| `GET` | `/v1/capabilities` | 协议版本、方法表、limits、serverId、版本信息 |

约定：

- JSON-RPC 错误仍返回 HTTP 200 + JSON-RPC error object；鉴权失败、body 过大、限流在
  HTTP 层返回 401/403/413/429。
- `POST /rpc` 要求 `Content-Type: application/json`；body 上限默认 32 MiB。
- 不接受客户端传入的 `apiKey` / 任意 `baseUrl`；模型接入点由 server 配置决定。

### 4.2 JSON-RPC 方法

#### `server.capabilities`

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "method": "server.capabilities"
}
```

```json
{
  "jsonrpc": "2.0",
  "id": "1",
  "result": {
    "protocolVersion": 1,
    "serverId": "0f2f...",
    "methods": ["review.submit", "review.get", "review.list", "review.cancel"],
    "limits": { "maxBodyBytes": 33554432, "maxDiffBytes": 8388608, "maxQueueDepth": 100 }
  }
}
```

#### `review.submit`

```json
{
  "jsonrpc": "2.0",
  "id": "2",
  "method": "review.submit",
  "params": {
    "clientRequestId": "mr-12345-rev-1",
    "caseId": "VUL4J-1",
    "source": {
      "kind": "inline",
      "repoId": "vul4j-1-base",
      "diff": "diff --git ...",
      "issueDescription": "Vulnerability CVE-..."
    },
    "configId": "E",
    "modelId": "deepseek-v4-flash",
    "metadata": { "project": "platform-x", "mr": "12345" }
  }
}
```

```json
{
  "jsonrpc": "2.0",
  "id": "2",
  "result": { "jobId": "01J...", "status": "queued", "submittedAt": "2026-10-20T..." }
}
```

- `source.kind = "inline"` 是 P1 唯一实现：`repoId` 由 server 的 `RepoRegistry` 解析到
  allowlist 根下的实际路径；**客户端永远不传绝对路径**。
- `source.kind = "mr"`（`provider` / `projectId` / `mrId`）是 P4 扩展点：由 server 去代码平台
  拉 diff + issue，避免大 body 与仓库路径暴露。
- `configId` 必填（ADR-0011）；server 不提供隐式缺省。

#### `review.get` / `review.list` / `review.cancel`

```json
{ "jsonrpc": "2.0", "id": "3", "method": "review.get", "params": { "jobId": "01J..." } }
```

```json
{
  "jsonrpc": "2.0",
  "id": "3",
  "result": {
    "jobId": "01J...",
    "status": "succeeded",
    "caseId": "VUL4J-1",
    "configId": "E",
    "modelId": "deepseek-v4-flash",
    "submittedAt": "...",
    "startedAt": "...",
    "finishedAt": "...",
    "result": {
      "runId": "...",
      "findings": [],
      "usage": { "inputTokens": 0, "outputTokens": 0, "cacheReadTokens": 0 },
      "rounds": 1,
      "toolCalls": 0,
      "truncated": false,
      "auditRef": "artifact:audit/<runId>",
      "recordRef": "artifact:record/<runId>"
    }
  }
}
```

- `review.list` 参数：`status?`、`caseId?`、`limit?`、`cursor?`。
- `review.cancel` 返回最新 JobView；`queued` 直接 `cancelled`；`running` 进入 `cancelling`
  后 `cancelled`；已终态返回 409 语义的 JSON-RPC error `-32005 cancel_not_allowed`。

### 4.3 SSE 事件

```text
GET /v1/jobs/01J.../events
Accept: text/event-stream
Last-Event-ID: 7
```

```text
id: 8
event: job
data: {"seq":8,"jobId":"01J...","status":"running","progress":{"phase":"Deep Reasoning","round":1,"toolCalls":2}}
```

事件类型：

- `job`：状态或进度变化。
- `artifact`：可选，产物就绪（`record` / `audit`）。
- `error`：job 失败；同时终态 job 里带 error object。

`Last-Event-ID` 之后的事件从 `job_events` 表重放；不能重放（超出保留窗口）时发
`event: reset` + 最新快照，要求客户端重新 `review.get`。

### 4.4 错误码

JSON-RPC 标准码：

| code | 含义 |
|---|---|
| -32700 | parse error |
| -32600 | invalid request |
| -32601 | method not found |
| -32602 | invalid params |
| -32603 | internal error |

应用码（推荐区间 -32001 起）：

| code | 语义 | HTTP 配套 |
|---|---|---|
| -32001 | `job_not_found` | 200 + error |
| -32002 | `queue_full` | 429 |
| -32003 | `repo_not_allowed` | 403 |
| -32004 | `payload_too_large` | 413 |
| -32005 | `cancel_not_allowed` | 200 + error |
| -32006 | `unauthorized` | 401 |
| -32007 | `forbidden` | 403 |
| -32008 | `gateway_unavailable` | 502 |
| -32009 | `job_failed` | 200 + error |
| -32010 | `server_draining` | 503 |

`error.data` 只放安全细节：`jobId`、`caseId`、`limit`、`retryAfterMs`；不放路径、key、内部堆栈。

### 4.5 版本与能力协商

- `protocolVersion` 整数单源推进；破坏性变更 +1。
- 客户端可在 `hello`/`capabilities` 阶段比对；服务端拒绝未知 major。
- `serverId` 是逻辑身份（UUID），不是地址；用于日志与多实例排障。
- `capabilities` 返回方法表与 limits，客户端据此降级或提示。

---

## 5. Job 模型与持久化

### 5.1 状态机

```text
queued ──> running ──> succeeded
   │          │
   │          ├──────> failed
   │          │
   │          └──────> cancelling ──> cancelled
   │
   └──> cancelled
```

| 状态 | 语义 |
|---|---|
| `queued` | 已受理，等待 worker |
| `running` | executor 正在执行 |
| `cancelling` | 已发 abort，等待执行侧确认 |
| `succeeded` | 完成，result 可用 |
| `failed` | 执行失败，error 可用 |
| `cancelled` | 客户端取消或服务端 drain 取消 |

### 5.2 幂等与重试

- `(tenantId, clientRequestId)` 唯一；重复 `review.submit` 返回既有 job。
- 没有 `clientRequestId` 时不去重；客户端重试需自带稳定 id。
- `queued` job 在服务重启后可恢复（input blob + repo snapshot 仍在）。
- `running` / `cancelling` job 在服务重启后标记 `failed`，错误码 `SERVER_RESTART`；
  不假装续跑，因为当前 `runReview` 没有 checkpoint/resume 语义。

### 5.3 SQLite schema（生产适配器）

```sql
CREATE TABLE jobs (
  job_id            TEXT PRIMARY KEY,
  tenant_id         TEXT NOT NULL,
  client_request_id TEXT,
  case_id           TEXT NOT NULL,
  config_id         TEXT NOT NULL,
  model_id          TEXT,
  status            TEXT NOT NULL,
  source_kind       TEXT NOT NULL,
  repo_id           TEXT,
  diff_sha256       TEXT NOT NULL,
  issue_sha256      TEXT NOT NULL,
  metadata_json     TEXT,
  submitted_at      TEXT NOT NULL,
  started_at        TEXT,
  finished_at       TEXT,
  kernel_run_id     TEXT,
  record_path       TEXT,
  audit_path        TEXT,
  result_json       TEXT,
  error_code        TEXT,
  error_message     TEXT,
  UNIQUE (tenant_id, client_request_id)
);

CREATE TABLE job_events (
  job_id   TEXT NOT NULL,
  seq      INTEGER NOT NULL,
  at       TEXT NOT NULL,
  type     TEXT NOT NULL,
  data_json TEXT NOT NULL,
  PRIMARY KEY (job_id, seq)
);

CREATE INDEX jobs_status_submitted ON jobs (tenant_id, status, submitted_at);
```

### 5.4 产物布局

```text
<dataRoot>/
  jobs.sqlite
  blobs/<sha256>.diff
  blobs/<sha256>.issue
  runs/<jobId>/...          # runReview 的 runsRoot/experimentId 落点
```

- `experimentId = jobId`，保证 audit/record 目录互不冲突；`runId` 仍由内核生成并返回。
- API 返回 artifact 的**逻辑引用**（`artifact:audit/<runId>`），不返回服务器绝对路径；
  admin scope 才可走单独 artifact 下载接口。

---

## 6. 内核需要的配套改造

### 6.1 取消：`ReviewRunInput.signal`

现状：`runReview` 没有取消入口；`pi-ai` 的 `StreamOptions` 已有 `signal`，`Agent` 已有
`abort()` / `activeRun.abortController`。

改造：

1. `ReviewRunInput` 增加可选 `signal?: AbortSignal`。
2. A/B 直驱路径：`runReviewTurn` 透传 `signal` 到 `deepseekProvider().stream(..., { signal })`。
3. C/D/E agent 路径：`runAgentReviewLoop` 监听 `signal`，abort 时调用 `agent.abort()`；
   工具循环在工具调用边界检查 `signal.aborted`。
4. 取消错误统一为 `ReviewAbortedError`（`name = "AbortError"`，`code = "review_aborted"`）。
5. 语义决定：abort 不产生 `succeeded` run record；server 在 job store 记 `cancelled`。
   P1 允许无 partial audit；P2 再补「partial audit flush + 引用」。

验收：取消响应的 p95 上界（不含网关在飞请求）、不写半截 record、不污染指标数据。

### 6.2 进度：`ReviewRunInput.onProgress`

新增观测钩子（不进入 wire，不影响审计字节）：

```ts
export type ReviewProgressEvent =
  | { kind: "phase"; round: number; phase: ReviewPhase; requestCount: number }
  | { kind: "tool"; round: number; toolCall: number }
  | { kind: "usage"; usage: LlmUsage };
```

- 只在既有 phase 边界发出；不改变消息构造顺序，不改变 `wireBody`。
- `onProgress === undefined` 时行为与现在逐字节一致；t1–t5 门必须零漂移。
- server 把事件写 `job_events` 并扇出到 SSE。

### 6.3 结果投影：`ReviewRunSummary`

server 不应直接依赖 `RunRecord` 的内部形状。建议在 `review-pi` 公开面增加一个纯投影：

```ts
export interface ReviewRunSummary {
  readonly runId: string;
  readonly findings: readonly Finding[];
  readonly usage: LlmUsage;
  readonly rounds: number;
  readonly toolCalls: number;
  readonly truncated: boolean;
  readonly auditRef: string;
  readonly recordRef: string;
}
```

由 `toReviewRunSummary(result: ReviewRunResult): ReviewRunSummary` 单源产出；server 只消费
这个 DTO，内核改 RunRecord 内部字段时 server 不受影响。

### 6.4 不得触碰的字节纪律

- `signal` 与 `onProgress` 都是**可选观测/控制面**；不进入请求体、不影响 messages 顺序。
- 任何 server 需求都不得改 Zone A 常量、Zone B 组装、六阶段 phase 指令文本。
- server 的 `configId` 必须显式传入；不得在 server 内设「默认 E」这类隐式缺省。

---

## 7. 并发、隔离与运行形态

### 7.1 为什么用 worker 池

- `runReview` 内含同步 tree-sitter Java 解析与仓库扫描；大仓解析会占满 event loop。
- HTTP server 要与 job 执行解耦：健康检查、提交、查询、SSE 不能被解析阻塞。
- 取消的硬边界：worker 可 `terminate()`；进程内只能协作式 abort。

推荐：

- P1：`InProcessExecutor`，`concurrency = 1`，只用于本地开发与测试。
- P3：`WorkerPoolExecutor`，worker 数 = CPU/内存预算（默认 2），每个 worker 内独立
  parser 与模块状态；取消 = post abort + 超时 `terminate()`。

### 7.2 队列与背压

- `maxQueueDepth`：默认 100；满则 `-32002 queue_full` / HTTP 429。
- `maxConcurrentJobs`：默认 2；与 worker 池一一对应。
- 每 tenant 可加 `maxInFlight`，防单租户饿死其它租户。
- `queued` 超时（默认 30 min）自动 `failed`，错误码 `QUEUE_TIMEOUT`。
- `jobTimeoutMs`：默认 60 min；超时 abort + `failed`，错误码 `JOB_TIMEOUT`。

### 7.3 内存与仓库规模

- `RepoContext` 对每个 job 缓存源码与 symbol index；并发 × 大仓会放大内存。
- 准入检查：`maxRepoFiles`、`maxRepoBytes`、`maxDiffBytes`；超限在 submit 阶段拒绝。
- 预取预算与 config 语义不变；server 不额外注入上下文。

---

## 8. 安全与运维

### 8.1 鉴权与授权

- `Authenticator` 端口：P1 支持 bearer token；P3 支持 mTLS / 企业网关头。
- `Principal`：`tenantId`、`subject`、`scopes`（`review:submit` / `review:read` /
  `review:cancel` / `artifact:read` / `admin`）。
- 授权在 service 层按 principal 执行；store 查询强制 tenant 过滤。
- 未授权不泄漏资源存在性：统一 `job_not_found`。

### 8.2 仓库与路径

- 客户端只传 `repoId`，由 `RepoRegistry` 解析到 allowlist 根下的路径。
- 解析必须 `realpath` + 根前缀校验，拒绝 symlink/junction 逃逸、绝对路径、`..`。
- P4 MR provider 模式：`projectId/mrId` → 平台 API → 临时物化仓；物化目录受同一 allowlist 管理。

### 8.3 秘钥与出站

- `REVIEWER_API_KEY` / `REVIEWER_URL` 只从 server 环境或 secret provider 读取。
- 客户端不能指定 `baseUrl`、`apiKey`、任意模型端点；防 SSRF。
- 日志/事件/错误/审计四类输出统一 redaction；key 永不落盘、永不回显。

### 8.4 可观测性

- 结构化日志字段：`requestId`、`jobId`、`tenantId`、`caseId`、`configId`、`modelId`、
  `status`、`durationMs`、`rounds`、`usage`、`errorCode`。
- `/healthz`：进程活着即可；`/readyz`：store 可写 + worker 池 ready + 不在 drain。
- 可选 `/metrics`：计数器（submit/success/fail/cancel/queue_full）、直方图（queue wait、
  run duration）、gauge（queue depth、running jobs）。

### 8.5 生命周期

- SIGTERM：停止收单（`server_draining`）→ 排空 running → 关闭 store → 退出。
- drain 超时（默认 60s）后 abort 剩余 job，标记 `cancelled`（reason=`SERVER_DRAIN`）。
- `close()` 幂等；重复调用返回同一 Promise。

---

## 9. 实施顺序与验收

| 阶段 | 内容 | 验收 | 估计 |
|---|---|---|---|
| P0 | 内核 seam：`signal`、`onProgress`、`ReviewRunSummary` | 单测：取消不写 succeeded record；progress 钩子开启/关闭 t1–t5 字节门零漂移；`pnpm test` 全绿 | 0.5–1 天 |
| P1 | `review-pi-server` 包 + `ReviewService` + memory store + fake executor + in-process executor | 服务接口测试：submit/get/list/cancel/幂等/队列满/tenant 隔离/取消/close drain；无 HTTP 参与 | 1–2 天 |
| P2 | HTTP JSON-RPC + SSE + auth + limits + `/healthz` `/readyz` | 原始 HTTP 契约测试：JSON-RPC 错误码、401/403/413/429、SSE `Last-Event-ID` 重放、断线不取消 job | 1–2 天 |
| P3 | SQLite store + worker 池 + 重启恢复 + drain | 崩溃恢复（queued 恢复、running 标 failed/SERVER_RESTART）、worker 取消、并发 soak、内存上限 | 2–3 天 |
| P4 | 可选适配器：MR source provider / stdio JSONL / pi-protocol v8 / artifact 下载 | 每个适配器只加 transport/source 测试，不动 ReviewService | 视需求 2–5 天/项 |

建议先立 ADR（编号顺延）记录：

1. server 协议选型：HTTP JSON-RPC 2.0 + SSE，不 vendor pi server 栈；
2. job 生命周期与持久化：SQLite job store + job-oriented（非 pi Session）；
3. 取消语义：协作式 abort + worker 硬终止边界，取消不入指标；
4. repo 安全模型：repoId + allowlist，禁止客户端绝对路径。

---

## 10. 风险与开放问题

| 风险/问题 | 说明 | 建议 |
|---|---|---|
| 鉴权模型未定 | bearer vs mTLS vs 平台网关注入 | P2 前定；Authenticator 端口先留 |
| 仓库来源未定 | allowlist 本地仓 vs 平台拉取 | P1 用 repoId + inline diff；P4 加 MR provider |
| 取消粒度 | 网关在飞请求无法瞬时终止 | 定义「取消响应上界」；worker 超时 terminate |
| partial audit | abort 时可能没有完整 record | P1 允许无 audit；P2 补 partial flush |
| SSE vs WebSocket | SSE 单向但简单；WebSocket 双向但复杂 | 先用 SSE；有双向交互需求再评 |
| pi-protocol 兼容 | 上游已删除该栈 | 仅当有真实 pi 客户端时做 P4 适配器 |
| 并发 parser | 进程级 memoized parser | P3 worker 池隔离；P1 concurrency=1 |
| 多实例部署 | job 状态与执行者绑定 | P3 先单实例；多实例需 lease/fence，另立 ADR |

---

## 11. 明确不做

- 不 vendor `pi-protocol` / `pi-server` / `pi-client` / `session-backends` 整栈。
- 不复用 `AgentHarness` / `SessionRepo` 作为 server 底座；上游 1.x 会移除 harness。
- 不把 Chord service 语义引入对外契约；JSON-RPC 方法名就是契约。
- 不做同步阻塞式 `review.run`（检视分钟级，HTTP 超时不可控）；只做 submit + poll/SSE。
- 不允许客户端传绝对 `repoPath`、`apiKey`、任意 `baseUrl`。
- 不改变 Zone A/B、六阶段指令、Finding/Evidence 契约与判定链口径。

---

## 附录 A：pi SDK 能力边界（为什么 SDK 不能直接解决 RPC）

### A.1 pi SDK 是什么

锚定版本 `6671c604` 的「SDK」指 `@earendil-works/pi-coding-agent` 主包导出的
**coding-agent 进程内嵌入 API**，不是独立的 RPC 协议包。核心导出：

- `createAgentSession()` / `AgentSession`：单会话生命周期、prompt、steer、followUp、
  subscribe、abort、compaction、模型切换、消息历史。
- `createAgentSessionRuntime()` / `AgentSessionRuntime`：会话替换（new / resume / fork / import）。
- `SessionManager`、`ModelRuntime`、`ResourceLoader`、`DefaultResourceLoader`：
  会话持久化、模型/凭据解析、extensions / skills / prompt templates / context files 发现。
- 内置工具、工具工厂、extension API、slash command、skills、prompt templates。
- `runRpcMode()` + `RpcClient`：**stdio JSONL** headless 模式（stdin 命令 / stdout 事件）。

`docs/sdk.md` 的定位是「把 pi 嵌入你自己的应用、搭自定义 UI、跑自动化流水线」；
`docs/rpc.md` 明确写：Node/TS 用户应优先直接用 `AgentSession`，而不是起子进程。

### A.2 SDK / stdio RPC / experimental server 是三条不同的线

| 形态 | 传输 | 语义 | 适用 |
|---|---|---|---|
| `AgentSession` SDK | 进程内 TypeScript API | coding-agent 会话 | 嵌入 Node 应用 |
| `runRpcMode()` | stdin/stdout JSONL | coding-agent 命令集 | 子进程嵌入 / IDE |
| `pi-protocol` + `pi-server` + `pi-client` | CBOR 帧 + Unix socket | Chord service + Session attachment | 实验性本地多端会话 |

三者都不是 HTTP/JSON-RPC server。

### A.3 SDK 能解决什么

- 本地 Node 进程内嵌入：不经过网络，直接 `await session.prompt(...)`。
- 本地子进程嵌入：用 stdio JSONL RPC，按行发命令、收事件。
- 会话级事件流、abort、模型切换、compaction、session 持久化。
- coding-agent 语义的 extensions / skills / prompt templates / 工具装载。

### A.4 SDK 不能解决什么

- **不是 HTTP server**：没有 `listen()`、没有 HTTP 路由、没有 JSON-RPC 2.0 方法契约。
- **不是远程多客户端服务**：没有 principal/scopes、tenant 隔离、并发连接与背压。
- **不是 job 服务**：没有 submit/get/list/cancel 的异步 job 生命周期、幂等、队列、
  服务重启恢复、SSE 订阅重放。
- **不是 ReviewAgent 的 review 语义**：`AgentSession` 是 coding-agent 会话（工具是
  read/bash/edit/write，带 extensions/skills/compaction），不是六阶段 Review Runtime；
  用它替换 `runReview` 会直接改变 Zone A/B、工具面与审计口径。
- **仍是 stdio / 本地**：`runRpcMode()` 的 stdin/stdout 协议没有远程鉴权、没有 HTTP
  状态码、没有多客户端 attach 语义；要放到企业平台前面，仍要自写 HTTP 网关。

### A.5 结论

- 若目标是「本地嵌入」：可以用 pi SDK / stdio RPC，但那是 coding-agent 语义，
  不是 ReviewAgent review job 语义；ReviewAgent 自己已有更贴合的低层 `Agent` 路径。
- 若目标是「远程 HTTP/JSON-RPC server」：SDK 只能帮你写 agent 内核那一层，**不能
  替代 server 层**；鉴权、job 状态机、队列、SSE、审计产物与 tenant 隔离仍需自建。
- 因此本方案继续采用：`ReviewService`（自建深模块）+ `runReview`（已有内核执行缝）
  + HTTP/JSON-RPC/SSE 适配器；pi SDK 仅作为「本地嵌入形态」的参考实现。

---

## 附录 B：当前 ReviewAgent 进程模型（2026-10-20 现状）

### B.1 当前支持

| 形态 | 命令 / 入口 | 生命周期 |
|---|---|---|
| 单案 CLI | `review-pi review --repo ... --mr ...` | 一进程一案，stdout 单个 JSON，进程退出 |
| 冒烟自检 | `review-pi smoke` | 一进程一次双探针，进程退出 |
| 处置记录 | `review-pi disposition ...` | 一进程一次本地写库，进程退出 |
| 进程内库调用 | `import { runReview } from "review-pi"` | 由宿主进程决定；每次调用一个 run |
| 矩阵实验 | `pnpm experiment -- ...` | 一进程跑矩阵；完成后退出 |

「断点续跑」是实验 runner 的能力：它扫描 `runs/` 已有记录并跳过已完成单元。
这是**跨进程恢复**，不是长驻进程，也不是 stdin 协议。

### B.2 当前不支持

- 没有 daemon / server / 常驻 worker 启动模式。
- 没有 `process.stdin` 读取面；CLI 只解析 `process.argv`。
- 没有 stdin/stdout JSONL 协议；stdout 是单文档或一次性终端输出，不是命令/事件流。
- 一个进程不能连续接收第二个命令；`review-pi` bin 经 `spawnSync` 等子进程结束后退出。
- 没有 JSON-RPC / HTTP 监听口。

代码证据：

- `packages/review-pi/bin/review-pi.js`：`spawnSync` + argv 透传 + 退出码透传。
- `packages/review-pi/src/cli/main.ts`：`main()` 解析 argv 一次，执行一个子命令后
  `exitGracefully`；注释明确「本线无协议宿主，无 stdin 停读面」。
- `packages/review-pi/src/cli/args.ts`：`review` / `smoke` / `disposition` 均为 argv 子命令。

### B.3 与目标形态的差距

本方案 P4 的 stdio JSONL 适配器要新增的是：

1. 新入口（独立 bin 或 `--mode rpc`）：读 stdin，保持事件循环常驻。
2. 严格 LF-only JSONL 编解码；一行一个 JSON 文档。
3. 命令与响应按 `id` 相关；命令包括 `review.submit` / `review.get` / `review.list` /
   `review.cancel`；事件单独成行。
4. stdout 只写协议文档；日志走 stderr；EOF 或 `shutdown` 命令触发优雅 drain。
5. 复用同一 `ReviewService` 深模块；HTTP 适配器与 stdio 适配器只换传输。

现有 `review-pi review` 单文档 stdout 契约不得改变；stdio JSONL 必须是**新增模式**，
不能把现有 CLI 改造成多文档流。
