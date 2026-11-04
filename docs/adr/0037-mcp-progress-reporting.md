# 0037. MCP 上报：把进度、状态与结果经进度事件流外发

**状态**：提议（2026-11-04，待评审；尚未落代码）
**关联**：ADR-0016（运行进度投影：只投影既有留痕、不新增审计键、不改 wire 字节、不改退出码）、ADR-0025（用户级 JSONC 单配置源）、ADR-0027（外部能力默认降级、只认显式输入）、ADR-0030（收尾摘要与进度旗标解耦）、ADR-0035（单包发行、内核按 npm 依赖精确锁版）、ADR-0038（退役对外部真源的逐字节对照）
**跨仓**：本 ADR 为本仓 pi 线序列 0037；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

需求方要在一次检视进行中，把**进度、状态与结果**上报给外部系统，外部系统以 MCP（Model Context Protocol）服务的形式提供接收端。

这与「从 MCP 取数喂给模型」是两类问题，方案空间完全不同：

| 维度 | 取数（读） | 上报（写） |
|---|---|---|
| 结果去向 | 进模型上下文，影响结论 | **不进模型**，模型完全无感 |
| 失败语义 | 降级或 strict 失败 | **绝不能影响检视结果**，是旁路 |
| 时序 | 必须在阶段推进前完成 | 可异步、可迟到、可丢 |
| 对请求字节的影响 | 会改阶段消息 | **零**（不进 wire） |
| 主要风险 | 提示注入、证据污染 | 顺序、去重、背压、泄密 |

本仓恰好已经有一条为「投影」设计的接缝，纪律正好对上：

1. **`contracts/progress.ts` 定义了 `RunProgressSink`**，四类事件：`phase`（阶段推进）、`request`（模型请求首尾 + usage）、`tool`（工具调用首尾）、`skill`（规则 Skill 会话首尾）。其头注释写死了三条约束：**不新增审计键、不改 wire 字节、不改退出码**。
2. **注入点现成**：`run/review-run.ts:84` 的 `onProgress?: RunProgressSink`，`:171` 传给 loop；`cli/main.ts:132` 注入 CLI 渲染器。改成「组合 sink」即可多挂一个消费者。
3. **代码事实**：`progress-render.ts` 的 `switch` 只处理上述四类（`case "phase" / "request" / "tool" / "skill"`），新增 `kind` 必须走「未知即忽略」的默认分支，否则 TTY 状态行会抛错。
4. **缺口只有两个层级**：`run` 级（开始 / 结束）与 `result` 级（findings 数、成本、truncated、产物位置）。这两处的数据在 `runReview` 收尾时已经齐备（`outcome.usage` / `findings` / `runId` / `truncated`），补事件仍然只是「既有留痕的投影」。
5. **字节门已退役**（ADR-0038）。本 ADR **不需要**再为「不碰 `phase-*.txt` / 七工具 schema」设计绕行——上报本来就不进 wire，这条约束自然满足。

## Decision

### 1. 上报挂在进度事件流上，不挂阶段钩子

```text
runReview ──emit──> RunProgressSink ──┬──> CLI renderer（已有）
                                      └──> MCP reporter（新增）
```

**明确不做**：不在 `advancePhase()` 里插 `await mcpCall(...)`。理由：

- 阶段钩子是**同步阻塞**的，把网络 I/O 塞进它会直接拖慢检视；
- 阶段钩子只能覆盖「边界」，覆盖不了「阶段内部」——而事件流天然覆盖（阶段内的每次请求、每次工具调用都会发射）；
- 阶段钩子会把「外部系统不可用」变成主链的一个分支，而 ADR-0016 的接缝从一开始就不允许这样。

**保留的能力**：将来若需要「取数」（把 MCP 结果喂给模型），那是一个独立决策，见第 10 节的边界说明。

### 2. 补三类事件，仍然是「既有留痕的投影」

`contracts/progress.ts` 的 `RunProgressEvent` union 增加：

| 新事件 | 字段（全部来自已有数据） | 发射点 |
|---|---|---|
| `run.start` | `runId`、`caseId`、`model`、`startedAt` | `runReview` 进入、首个请求之前 |
| `run.end` | `runId`、`status`（`ok` / `failed`）、`durationMs`、`usage`、`truncated` | `runReview` 收尾、stdout 写出之前；异常路径在 `catch` 里发 `status: "failed"` + `reason` |
| `result` | `runId`、`findings`（默认只给条数与严重度分布）、`rejected`、`usage`、`artifacts`（路径的相对形式） | 候选门之后、`run.end` 之前 |

三条约束原样继承：**不加审计键、不改 wire 字节、不改退出码**。`progress-render.ts` 对这三个 `kind` 走「忽略（不渲染）」——CLI 显示面不变。

### 3. MCP reporter 是 sink 的一个消费者

新建 `packages/review-pi/src/mcp/`，只做客户端侧子集，**零新增运行时依赖**：

| 包含 | 明确不做 |
|---|---|
| JSON-RPC 2.0 编解码、id 配对、错误码映射 | MCP server（不开端口、不提供服务） |
| `stdio` 传输（spawn + 换行分隔 JSON） | OAuth 授权流程 |
| Streamable HTTP 传输（`fetch` + SSE 分帧） | resources / prompts / sampling / roots |
| `initialize` → `tools/list` → `tools/call` | 断线重连、多路复用、长连接保活 |
| 超时、`AbortController`、子进程清理 | 富媒体内容（只消费 `text` 内容块） |
| 事件 → 工具参数的映射、批量、重试、spool | 协议版本全覆盖（不匹配即明确报错） |
| 结果 → 有界摘要（去绝对路径、去敏） | 把 MCP 结果写回模型上下文 |

传输与连接**懒启动**：配置里没有 `mcp.report` 时，不 spawn、不 fetch、零启动成本。

### 4. 投递语义（本 ADR 的核心，比「调哪个工具」重要）

| 问题 | 决策 | 理由 |
|---|---|---|
| 是否阻塞 | **不阻塞**：`emit()` 只入队，后台 drain | 上报慢不能拖慢检视 |
| 批量 | 满 `batch.maxEvents` 条或距首条超 `batch.maxDelayMs` 即发 | 避免每事件一次请求 |
| 顺序 | 单 writer，FIFO；`seq` 从 1 单调递增 | 消费方可按 seq 重组 |
| 幂等 | 幂等键 `(runId, seq)` | 重试不产生重复计数 |
| 重试 | 指数退避，最多 N 次，整体受 flush 预算约束 | 瞬时故障自愈 |
| 收尾 | `runReview` 末尾 `await flush(flushTimeoutMs)`，超时即放弃并告警 | 保证「跑完基本都发出去」 |
| 失败 | 记 `failed` / `dropped` 计数，stderr 一行摘要；**退出码不变** | 旁路能力不能反噬主链 |
| 背压 | 队列上限 `queue.maxEvents`，溢出**丢最旧**并计数 | 宁可丢进度，不撑爆内存 |
| 崩溃 | 可选 spool：`<tasks 根>/<taskId>/runs/.mcp-report/<runId>.jsonl`，下次启动**手动**重放（默认关闭） | 进程被杀也能补报，但不引入自动重放的不确定性 |
| 泄密 | 事件字段白名单；不含代码片段、绝对宿主路径、任何密钥 | 上报是出站流量，默认最小化 |

**没有 `--strict-mcp`**：上报失败升级为失败会让「外部系统没起」毁掉一次检视，与旁路定位矛盾。上一版 ADR 的 strict 语义只属于「取数」形态；若将来落地取数，再在那边引入。

### 5. 工具名与映射由配置声明，不写死在代码里

MCP 服务端的工具是对方定义的，不同实现叫法不同。配置里声明三个槽位：

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
      "tools": {
        "progress": "report_progress",   // { runId, seq, events: [...] }
        "status": "report_status",       // { runId, phase, round, elapsedMs }
        "result": "report_result"        // { runId, findings, usage, artifacts }
      },
      "batch": { "maxEvents": 20, "maxDelayMs": 2000 },
      "queue": { "maxEvents": 500 },
      "flushTimeoutMs": 5000,
      "findings": "summary"              // none | summary | full
    }
  }
}
```

- `progress` 槽位接收 `phase` / `request` / `tool` / `skill` 四类事件的批量；
- `status` 槽位接收 `run.start` 与心跳（可选，默认关闭）；
- `result` 槽位接收 `result` / `run.end`。
- 某个槽位缺省 = 该类事件不外发（不是错误）；配置里出现未知槽位名 = 启动期 fail fast。

若服务端不做批量，把 `batch.maxEvents` 设为 1 即可，无需代码分支。

### 6. 配置面与秘密

- 走主配置 `~/.PiAgent/PiAgent.jsonc`（ADR-0025 单一配置源），`--config` 仍可换整份文件；
- **不做 `--mcp-config`**：第二个配置源会引出「谁优先」的问题，而 `--config` 已能换整份配置；
- `headers` 里的秘密与 `reviewer.apiKey` 同等待遇：文件 `0600`、`config show` 只报 `set | missing`、审计与 stdout 绝不回显、错误信息里脱敏。

### 7. 不写进审计文件

**不新增 `mcpLog` 审计键**。理由：

- 审计是「可复现的运行记录」，而网络结果（耗时、失败、丢弃数）本质上不可复现；写进去等于让审计变成非确定性产物；
- ADR-0016 的口径已经明确「进度是投影，不是新仪器」，上报是投影的消费者，不该反过来污染被投影的面；
- 留痕放到**独立 side 记录**：`<tasks 根>/<taskId>/runs/.mcp-report/<runId>.jsonl`（只有启用上报时才创建），外加 stderr 一行摘要（`mcp report: sent 42 / failed 1 / dropped 0`）。

这项决策同时让「审计顶层键序」这条产品级契约（ADR-0038 决策 1 的 C 类）保持零改动。

### 8. 阶段可自定义 / 自进化的扩展缝

现状的耦合点是「阶段 = 下标」：

| 位置 | 现在的假设 | 自定义后会怎样 |
|---|---|---|
| `loop/phases.ts` | 固定 6 条指令常量 | 指令不可换 |
| `contracts/run.ts` | `ReviewPhase` 是 6 字面量 union | 新阶段名进不了类型 |
| `agent-review-loop.ts` | `CANDIDATES_PHASE_INDEX = 4` / `VERIFICATION_PHASE_INDEX = 5` | 顺序一变就解析错 |
| `phaseMessage()` | 按 `index === 5` 附加 skill 候选清单 | 附加点漂移 |
| skill pass | 绑 `phaseIndex === 4` | 同上 |
| 进度事件 | 带 `index` / `total` | 消费方硬编码 6 |

改造方向：把「阶段」从下标改成**描述符 + 语义角色**。

```ts
interface PhaseProfile {
  readonly id: string;        // "builtin-v1"
  readonly version: string;
  readonly hash: string;      // 审计留痕；跨 profile 不可比
  readonly phases: readonly PhaseDescriptor[];
}

interface PhaseDescriptor {
  readonly key: string;       // "understand" | "classify" | ...（稳定标识）
  readonly name: string;      // 展示名
  readonly instruction: string;
  readonly contract: "json-object" | "candidates" | "verdicts" | "free-text";
  readonly role?: "candidates" | "verification";  // 替代下标常量
}
```

三条纪律：

1. **事件契约是稳定面，阶段是可换实现**：消费方（CLI 渲染器、MCP reporter）只按 `kind` + `phase.key` 分支，**不按 `index`**；`index` / `total` 保留给显示，不参与判断。
2. **内置 profile 与自定义 profile 用同一套形状校验**：`candidates` 与 `verification` 两个角色必须存在、顺序合法、每个 `contract` 有对应解析器。ADR-0038 之后不再比对字节，所以「换指令」不再需要同步黄金文件。
3. **审计记 `phaseProfile: {id, version, hash}`**（条件尾键，仅非内置 profile 时出现），跨 profile 的两次 run 不可直接比指标。**自进化只在「离线生成 → 评测 → 发布新版本」闭环里做，运行期不改指令**——否则同一 `runId` 的审计不可复现。

### 9. 「阶段内部也能上报」由事件流天然满足

阶段内的 `request` / `tool` 事件就是在阶段内部发射的；只要 reporter 按 `batch.maxDelayMs` 及时 drain，外部系统就能看到「阶段 4 正在调 `review.get_file`」这种粒度。不需要模型参与，也不需要阶段钩子。

### 10. 边界：模型驱动取数明确出界

如果将来需要「模型在阶段内自己决定调某个 MCP 工具取数」，那是另一个决策，且代价明确：

- 工具表要从 7 变成 7 + N（或增加两个通用工具 `mcp__list` / `mcp__call`），`fromWireToolName` 需改成命名空间感知；
- 结果会进模型上下文，必须处理提示注入与「不得成为 finding `evidence`」；
- 与本 ADR 的上报链路可以共用客户端，但**不共用语义**（一个旁路、一个主链）。

本 ADR 只做到「把口子留清楚」：`src/mcp/` 的 `client.ts` 是纯客户端，两种用途都能接。

## Options（为什么不是别的）

- **A. 官方 `@modelcontextprotocol/sdk`**：协议正确性最有保障，但实测 `1.32.2` unpacked 4.49 MB、17 个直接依赖（含 `express` / `hono` / `cors` / `jose` / `ajv` / `express-rate-limit`，其中多个是 server 侧）、`npm install --dry-run` 新增 **95 个包**；当前全局安装 `review-pi` 是 107 个包。与我们只用的 client 子集不匹配，且新增依赖要同步 `THIRD-PARTY-NOTICES.md`。否（将来需要 OAuth 或完整协议覆盖时重评）。
- **B. `@anthropic-ai/sdk/helpers/beta/mcp`**：方向相反——它把工具交给**模型**在 `anthropic.beta.messages.toolRunner()` 里调用；本仓 reviewer 走 OpenAI 兼容网关，这条 runner 走不进去；而且签名是 `mcpTool(tool, mcpClient)`，仍要自备客户端。否。
- **C. 阶段钩子（`advancePhase` 内 await）**：阻塞主链、只覆盖边界、把外部故障引入主链分支。可作为**取数**形态的备选，不作上报主线。否。
- **D. 把 MCP 工具挂给模型**：上报根本不需要模型参与；挂工具还会让工具面变化、缓存前缀抖动。否。
- **E. 等 pi 内核支持 MCP**：`pi-agent-core` 在 0.85.1 / 0.86.0 / 0.86.1 实测 `mcp` 命中均为 0，`pi-ai` 0.85.1 亦为 0。不作为依赖。
- **F. 阶段间独立小会话（skill-pass 式，由模型决定报什么）**：会引入一次额外模型请求，且让「报什么」变成非确定性的。上报要的是确定性事件流。否。
- **G. 单独 `--mcp-config`**：第二配置源。否。
- **H. 写进审计 `mcpLog`**：网络结果不可复现，会污染审计。否（改 side 记录 + stderr 摘要）。
- **I. 用 SMTP / webhook / OTLP 而不是 MCP**：需求方指定 MCP；且上报层做成「事件 → 工具参数」的薄映射后，换协议只需换 transport（`transport.ts` 之外不改）。不否，但不在本次范围。

## Consequences

- **正**：
  - 主链零改动风险：上报是 sink 的消费者，`emit()` 不阻塞，失败不改退出码；
  - 阶段内与阶段边界都被覆盖，无需为「阶段内部也要报」加任何钩子；
  - 零新增运行时依赖，发行面（单包、tarball、许可证履约）不变；
  - 审计保持可复现（不写网络结果），产品级逐字节契约（ADR-0038 C 类）零改动；
  - 事件契约与阶段实现解耦，六阶段将来怎么演进都不影响上报消费方。
- **负 / 风险**：
  - 自研客户端要自己跟协议演进（版本协商、SSE 分帧、stdio 半包），测试面比用 SDK 大一档；
  - Windows 下 `npx` 型 stdio 服务涉及 shell 引号与子进程清理，异常路径需要专门用例；
  - 上报是**尽力而为**：进程被强杀且未开 spool 时，最后一批事件会丢；
  - 出站流量的泄密面由 `report.findings` 粒度决定，默认 `summary`；
  - 新增 3 类事件会给 `progress-render.ts` 增加「未知 kind 忽略」的分支，需要一条测试锁住「CLI 渲染面不变」。
- **中性**：
  - `stdout` 键集、退出码语义、审计顶层键序、七工具面、阶段指令全部不变；
  - 配置新增一个可选块，不配置即不存在（N=0 零成本）。

## 验收标准

1. **N=0 零影响**：无 `mcp.report` 配置时，不 spawn、不 fetch；stdout / 审计 / 退出码与今天逐字节一致（`review-run.test.ts`、`bin.process.test.ts`）。
2. **事件补齐**：新事件在正确时点发射，字段全部可在既有留痕里找到出处；异常路径必发 `run.end(status="failed")`（`run/progress.test.ts`）。
3. **不阻塞**：`emit()` 的耗时与 sink 内部网络无关（用一个「永不返回」的假 transport 断言 run 能跑完）。
4. **收尾 flush**：`flushTimeoutMs` 内尽力发完；超时后 run 仍 `exit 0`，stderr 一行摘要。
5. **幂等与顺序**：假服务端收到的事件 `seq` 严格递增、无重复；重试注入后消费方看到的集合不重复计数。
6. **背压**：灌入超过 `queue.maxEvents` 的事件时丢最旧、计数正确、不 OOM。
7. **失败不改退出码**：连接拒绝 / 401 / 超时三种情况均 `exit 0`，且 findings 正常产出（`bin.process.test.ts`）。
8. **秘密不泄漏**：`headers` 值不出现在审计、转录、stdout、stderr、`config show`（只显示 `set | missing`）。
9. **CLI 渲染面不变**：新增 `kind` 在 TTY 状态行与事件行上都不产生输出；既有四类事件渲染字节不变。
10. **阶段解耦**：把 `PhaseProfile` 换成任意合法形状（阶段数、名称不同）后，reporter 与 renderer 仍能工作；非法 profile（缺 `candidates` 角色）启动期 fail fast。

## 实施记录

待实现。落地时补：文件清单、测试清单、真实 MCP 接收端的端到端验证（照 ADR-0036 的「真机验证」表格式），以及版本判定（新增能力 ⇒ `0.2.0 → 0.3.0`）。
