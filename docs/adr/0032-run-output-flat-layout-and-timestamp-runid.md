# 0032. run 产物拍平：一个 `--out` 一次 run、`runId` 收敛为首次请求毫秒时刻

**状态**：已接受（2026-11-03）
**关联**：ADR-0027（runs 布局；本 ADR 取代其「`<out>/runs/mr/<caseId>/rep-<N>` 与 `<out>/audit/mr/<caseId>/rep-<N>/audit/`」路径决策）、ADR-0013（转录是 run 产物）、ADR-0017 / ADR-0022（`reviews_en.json` / `reviews_tips_zh.json` 同目录同生命周期）
**跨仓**：本 ADR 为本仓 pi 线序列 0032；DSH 兄弟仓决策须引用全限定语「DSH 线 ADR-XXXX」。
**后续修订**：落盘根由 `--out <dir>` 改为任务模型 `--taskId <id>`（`<home>/.PiAgent/tasks/<taskId>/`），见 ADR-0033。本 ADR 的**目录内形态**（`runs/` + `audit/` + `.cache/`、`runId` = 首次请求时刻）不变；正文中「一个 `--out` 一次 run」读作「一个任务目录一次 run」。
**后续修订**（2026-11-14）：[ADR-0088](0088-run-artifact-layout-single-source.md) 允许单遍 `baseline` 记录 `transcriptPath`（绝对路径），供 `export` / trace 消费；`auditPath` 与其余字段不变，分片路径仍在 `shards[]`。

## Context

ADR-0027 之后，一次检视的产物是这样的：

```text
<out>/runs/mr/<caseId>/rep-1.json
<out>/runs/mr/<caseId>/session-<ts>-<caseId>[-skill-<name>-r<N>].json
<out>/runs/mr/<caseId>/rep-1/reviews_en.json
<out>/runs/mr/<caseId>/rep-1/reviews_tips_zh.json
<out>/audit/mr/<caseId>/rep-1/audit/<runId>.json
<out>/.cache/rule-skills/<sha256>/…
```

问题不在「按 case 分目录」本身，而在这些层已经不再承载信息：

- **`rep`** 恒为 1（多 rep 采样在 ADR-0024 之后不再存在），`rep-1/` 与 `rep-1.json` 里那一段是纯历史包袱；
- **`mr`** 只剩一种输入形态（ADR-0029 的 `--mr-json` 同样落 `mr` 段），作为路径段不区分任何东西；
- **`<caseId>`** 在目录层重复了文件名与 JSON 字段里已有的信息；
- **`audit/…/audit/`** 中间夹了 4 层，审计文件本身已经用 `<runId>` 唯一命名。

同时，`runId` 当时的形态是 `<启动时刻>-<caseId>`（`20260914T180846.922-VUL4J-1`），而转录文件名用的是**另一个时间源**（首次模型请求时刻）。结果是：

- 审计文件名与转录文件名**无法互相推导**，`export <runId>` 必须扫目录读 `info`；
- 同一 run 的「开始」有两个不同毫秒值（`startedAt` 与 `firstRequestAt`），人读时需要分辨哪个是哪个；
- `caseId` 一旦要换（重命名 MR、同一 diff 多套命名），文件名与目录都得跟着动。

## Decision

### 1. 三个顶层目录，内部不再分层

```text
<out>/
├── runs/
│   ├── run.json                                        # RunRecord
│   ├── session-<ts>.json                               # 主会话转录
│   ├── session-<ts>-skill-<name>-r<N>[-K].json         # 规则 Skill 会话转录
│   ├── reviews_en.json
│   └── reviews_tips_zh.json                            # 本次产 tips 才有
├── audit/
│   └── <ts>.json                                       # 审计（requests / toolCallLog / …）
└── .cache/
    └── rule-skills/<sha256>/…                          # 规则包解压缓存（不变）
```

`<cwd>/review-result.json`（ADR-0017 决策 14 的下游副本）不变。

- 删除的目录层：`runs/mr/`、`runs/<caseId>/`、`runs/<caseId>/rep-<N>/`、`audit/mr/`、`audit/<caseId>/`、`audit/<caseId>/rep-<N>/`、`audit/…/audit/`；
- 保留 `runs/` 与 `audit/` 两个语义目录（而不是全部拍进 `<out>` 根）：转录 / 记录 / 意见与审计仍然分开，扫目录时不会把审计当转录；
- `rep-1.json` 改名 `run.json`：`rep` 概念不进入文件名；
- `caseId` 只保留在**数据字段**：`RunRecord.caseId`、审计 `caseId`、转录 `info.title`。

### 2. `runId` = 首次模型请求时刻（UTC 毫秒），形态 `YYYYMMDD_HHMMSS_mmm`

```text
20261031_101010_123
└──┬───┘ └──┬───┘ └┬┘
  日期     时间   毫秒
```

- **不含点号**（Windows 文件名不用 `:`，也不留 `.` 以免被当成扩展名分隔）；
- 三段定宽、字典序 == 时间序；
- **不含 caseId**：case 不是身份维度，不能进路径/文件名。

同一个 `<ts>` 同时是：

| 位置 | 值 |
|---|---|
| `runId`（stdout / 审计内容 / `reviews_en.json` 信封 / 转录 `info.runId`） | `<ts>` |
| 审计文件名 | `<out>/audit/<ts>.json` |
| 主会话转录文件名 | `<out>/runs/session-<ts>.json` |
| 转录 `info.id` | `session-<ts>`（skill 会话加 `-skill-<name>-r<N>`） |

于是 `info.id`、`info.runId`、审计文件名**三者可互推**：读到转录就知道审计在哪，拿到 stdout 的 `runId` 就能直接定位 `<out>/audit/<runId>.json` 与 `<out>/runs/session-<runId>.json`。

时间源统一为 **`firstRequestAt`**（内核已有的唯一时间仪器，`agent-review-loop` 在首次 `onPayload` 时记录）：

- 审计与转录不再各自取时钟，也**不**使用 `runReview` 入口的 `startedAt`（它仍用于 `durationMs` / `startedAt` 字段）；
- 所有 skill 子会话的转录**共用主会话的 `<ts>`**（子会话靠 `-skill-<name>-r<N>` 区分），不再各自用自己的首次请求时刻——一次 run 只应有一个时间戳身份；
- 转录内部 `info.time.created` 仍是**该会话**的首次请求时刻（skill 会话可能晚几百毫秒），这是「会话何时开始」的事实，与 run 级 id 不冲突。

### 3. 一个 `--out` = 一次 run 的输出目录

- `run.json`、`reviews_en.json`、`reviews_tips_zh.json` 在同一个 `<out>` 再跑一次会被**覆盖**；
- 转录与审计因为文件名唯一会**累积**（同毫秒同 out 才可能撞名）；
- 需要保留多次 run 的产物，就每次换 `--out`（或每次拷走 `runs/` 与 `audit/`）；
- 陈旧清理的作用域随之变成 `<out>/runs/`（`main.ts` 的 `dirname(reviewsPath)`）：本次不产 tips 时删除的是**本 out 上一次 run** 的 `reviews_tips_zh.json` / `reviews_zh.json`，与「一个 out 一次 run」的约定一致。

### 4. 旧布局不迁移

新代码不读 `<out>/runs/mr/**` 与 `<out>/audit/mr/**`。旧 run 仍可人工查阅，但不再被任何命令识别（与 ADR-0027 换代同口径）。

## Options（为什么不是别的）

- **完全平铺到 `<out>` 根**（连 `runs/`、`audit/` 也去掉）：`<out>` 根会同时出现转录、审计、记录、意见 4 类文件 + `.cache/`，未来加 `export` 之类命令扫根目录时必须逐个排除，误读风险高。否。
- **文件名加 case 前缀**（`<case>.reviews_en.json`）：保留了 case 维度，与「case 不是身份维度」的结论相反，且多 case 同 out 本来就不该混。否。
- **审计文件名与 `runId` 解耦**（`audit-<ts>.json` ≠ `runId`）：白白多一套命名，破坏「三者可互推」。否。
- **保留两个时间源**（审计 `startedAt`、转录 `firstRequestAt`）：同一 run 出现两个毫秒值，正是本 ADR 要消除的歧义。否。
- **每个 skill 会话用自己的 `<ts>` 作为文件名中段**：一次 run 出现 N+1 个时间身份，`export <runId>` 选不到子会话。否——子会话用后缀表达从属关系。
- **`runId` 加随机段 / ULID 保证唯一**：可排序性与人读性都变差，而「同 out 同毫秒并发」在你的使用形态（一次一条命令）下不是真实风险。保持时间戳。

## Consequences

- **好**：路径短、语义单一；`runId` ↔ 审计文件 ↔ 转录文件可互推；`--out` 目录自身就是一次 run 的快照，便于打包/归档；`rep` 概念从文件名消失。
- **坏 / 需要显式认识的刻意偏离**：
  - **同 out 再跑会覆盖 `run.json` / `reviews_*.json`**：这是约定的一部分，不是 bug；要并存必须换 out。
  - **规则包缓存随 out 走**：换 out 会重新解压规则包（内容哈希相同也不跨 out 复用）；跨 out 复用得另立决策（把缓存挪到用户级目录）。
  - **`runId` 不再包含 case**：从 stdout 的一行 `runId` 看不出是哪个 MR，要读 `caseId` 字段；`reviews_en.json` 信封里 `caseId` 仍独立存在。
  - **毫秒碰撞面**：同一 `<out>` 在同一毫秒内启动两次 run 会重名（审计/转录互相覆盖）。单次命令形态下不现实；并发批跑应各自用独立 out。
  - **旧产物需人工迁移**：没有升级脚本。
- **测试面**：`audit/audit-writer.test.ts`（`buildRunId` 形态）、`experiment/run-record.test.ts`（`<out>/runs/run.json`、case/rep 不进路径）、`run/review-run-artifacts.test.ts`（转录落点 / 命名 / `info.runId` 与审计同名 / reviews 同目录）、`cli/bin.process.test.ts`（stdout `runId` 正则、`<out>/runs/reviews_*.json`、陈旧清理作用域）。
