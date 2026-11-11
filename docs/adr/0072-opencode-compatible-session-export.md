# 0072. OpenCode 兼容会话导出（run 时落盘 + `export --native` 表示切换）

**状态**：已接受（2026-11-11，随代码落地）
**关联**：ADR-0013（检视转录 `{info,messages,view}` 与原生真源）、ADR-0015（`view` 定形投影与时间/id 对齐）、ADR-0036（cwd session 索引与 `review-pi export`）、ADR-0014（skill 会话独立转录）、ADR-0039（分片）
**局部修订**：ADR-0036 决策 3/4——`review-pi export` 缺省产物由「pi 原生转录」改为「OpenCode 兼容版」，新增 `--native` 切换回原生，`--path` 只负责复制所选表示。
**跨仓**：本 ADR 为本仓 pi 线序列 0072；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

目标：**与 OpenCode 兼容，方便已兼容 OpenCode 的 session 查看工具复用**。本机 OpenCode v2.2.0 的会话真源是 `{info, messages}`（顶层恰好 `info` + `messages` 两键），`opencode session import` 对额外顶层键（`view` / `runId`）、消息 id 形态、`finish` 枚举、空 `metadata` 对象等有严格约束（实测见文末）。

一次检视的落盘现状（ADR-0013 / ADR-0015）是 `{info, messages, view}`：`messages` 是 pi 原生真源（`role` + `content` blocks），`view` 是 OpenCode 风格**定形投影**（刻意以 `null` 占位「无源」字段）。二者**都不是** import-clean：

| 不兼容点 | 后果（实测） |
|---|---|
| 顶层多 `view` / `info.runId` | `Internal Server Error` |
| `msg_0001`（纯数字） | `Internal Server Error`（必须含非数字字符） |
| 消息 id 跨会话重复 | `Internal Server Error` |
| `finish: "toolUse"` | `Bad Request`（枚举要求 `stop \| tool-calls \| error`） |
| `model.variant: null`、system `metadata: {}`、tool `state.error` 缺 `type` | `Bad Request` |

对齐层选择：**运行时原生转录保持现状**（`{info,messages,view}` 不删、不改），把兼容转换放在一条独立的、由原生 `messages` 纯函数推导的路径上，产物在 **run 时**和原生转录一起落盘（不推迟到导出层再转换）。

## Decision

### 1. 兼容版在 run 时另存一份，原生真源不动

每次 `review` 在 `review-pass.ts` 写原生转录的同时，新增一份 OpenCode 兼容版：

```text
<runDir>/session-<runId>[-skill-<name>-r<n>].json      ← 原生 {info,messages,view}（不变）
<runDir>/opencode/session-<runId>[-skill-<name>-r<n>].json   ← 兼容版 {info,messages}
```

- 原生 `messages` 不可从兼容文件反推，所以 `--native` 永远是一等表示，不是遗留分支；
- 放 `opencode/` **子目录**：`session-export.ts` 的兜底扫描
  `name.startsWith("session-<runId>-skill-") && name.endsWith(".json")` 会把平铺的
  `*.opencode.json` 误认成原生 skill 转录，子目录彻底隔离；
- 失败的 run 只要有转录就同样写兼容版，`outcome` 如实带入。

### 2. 归一化规则（纯函数 `buildOpenCodeSession`，零网络/零密钥）

兼容版由 `buildView(SYSTEM_PROMPT, capture.messages)` 归一化得到（不读文件里已有的
`view`，老转录可能没有；`buildView` 是纯函数）。规则全部经 `opencode session import`
实测：

- `info` 恰好 OpenCode 10 键（子会话多 `parentID`）；剥除 `runId`；
  `cost` ← `cost.total`（拍平成数字）；`model.variant` ← `"default"`；
  `model.providerID` ← 首条 assistant 的 `provider`，缺省回落 `baseUrl` host 映射，
  再兜底 `custom`；`projectID` ← `sha1(location.directory)`（按仓库分组的稳定值）。
- 消息 id 确定性派生 `msg_m` + `sha1(sessionId:index)` 前 19 hex——含字母、跨会话唯一、
  同 run 重导出稳定（`sessionId` 即原生 `info.id`，全局唯一）。
- `finish` 归一 `toolUse → tool-calls`；其余 `stop` / `error` 原样，未知值回落 `stop`
  （原始值仍走 `rawFinish`）。`outcome` 归一 `succeeded | failed`（pi `truncated` →
  `succeeded`：OpenCode 枚举无 `truncated`，实测 `truncated`/`errored`/`aborted` → 400）。
- 无源字段：`streamed/completed` ← `created+1/+2`；`reasoning.time` / `tool.time`
  ← 相邻时间戳合成；`tool.executed` ← `false`（OpenCode 导出语义，非「没执行」）；
  `tool.state.status` 归一 `pending → completed`；`state.error` 补 `type:"tool.execution"`；
  **可选项整键省略，永不输出 `null`**。

### 3. 子会话只写增量，父会话注入可跳转链接

- `SkillPassTranscript` 增加 `seedCount`（种子消息条数，`runSkillPass` 里
  `options.seedMessages.length` 精确已知）；兼容子会话只写
  `capture.messages.slice(seedCount)`，`info.parentID` 指向同 run 主会话——与
  OpenCode 真实子会话「只含自己的对话」语义一致，代价是「继承的父上下文在子文件
  里不可见」（已知保真度损失）。
- 父兼容会话末条 assistant 追加合成 `tool(name="subagent")` part，
  `state.metadata.sessionID` 指向各子会话（viewer 据此渲染跳转）。
- shard 是兄弟：各自顶层、不设 `parentID`；只有 skill 会话设 `parentID`。

### 4. `review-pi export`：缺省兼容版，`--native` 切原生

```text
review-pi export [--taskId <id>] [--tasks-dir <dir>] [--path <dir>] [--native]
```

- 缺省返回**兼容版**路径（`<runs>/opencode/…`）；`--native` 返回原生；
- `--path <dir>` 复制**所选表示**（`--native --path` 复制原生，平铺、同名覆盖）；
- 旧 run（无 `opencode/` 子目录）缺省时报**人话错误**并提示 `--native`（不做现场
  补生成——那会因缺 `seedCount` 把「只写增量」悄悄退化成全量 fork）；
- 只约束到一个开关 `--native`，不另设 `--opencode`（否则「`--path` 复制哪个」
  变成双规则）。

### 5. `manifest.json`：只在导出时写目标目录

runs 侧不产 manifest（清单随 schema 演进会过期；`run.json` 的 `skillPassLog` /
`shards` 已给顺序）。`export` 复制兼容版时，向目标目录写一份
`manifest.json`：`{ generatedAt, importOrder: [sessionId…], sessions: [{id,file,parentID?,outcome?}] }`，
`importOrder` 父先于子，供第三方按序导入。原生复制不写。

## Options（为什么不是别的）

- **把 `view` 原地改成 import-clean**：丢掉了「无源＝`null`」的诚实信号
  （ADR-0015 有意保留），且 `view` 嵌在原生文件里、原生文件又因 `runId`/`view`
  顶层键本就不可 import。否。
- **导出层才转换**（不改 run 产物）：导出层拿不到 skill 会话的 `seedCount`，
  只能靠父子前缀比对推切点（启发式），且每次导出重跑一遍归一化。否——run 时
  切点精确已知、逐次生成没有额外成本。
- **复用 `--path` + 单独 `--opencode` 旗标**：两个旗标对「复制兼容版」各有一套
  语义，`--path` 到底复制哪个要查文档。否（单一 `--native` 表示开关）。
- **老 run 现场补生成**：补生成路径没有 `seedCount`，只能写全量 fork 前缀——
  正是被明确否掉的形态。否（报错 + 提示 `--native`）。

## Consequences

- **正**：
  - 兼容查看工具零适配复用：`opencode session import <runs>/opencode/session-*.json`
    可直接回灌；`session export` 回读消息条数与文本一致（已测 16 条真样本）；
  - 原生转录逐字节不变，回放 / 诊断 / 既有下游（审计配对键 `runId`）不受影响；
  - 兼容版是 `buildView(messages)` 的确定性函数，可独立单测（无网络/无密钥）。
- **负 / 风险**：
  - `review-pi export` 缺省产物翻转（ADR-0036 局部修订）：README / 使用手册 /
    运行手册 / `CONTEXT.md` / `UA_ONBOARDING.md` 六处契约需同步；
  - 兼容文件不是「更干净的转录」：`messages` 不可反推原生；语义级仍不可对齐
    （`compaction` / `snapshot` / `idle` / `model-switched` / `shell` 无源）；
  - `import` 对形状的接受面随 OpenCode 版本漂移（本 ADR 规则以 v2.2.0 实测为准）。
- **中性**：
  - 每 run 多一份兼容文件（子目录，不参与寻址扫描）；
  - `projectID` 是 `sha1(目录)` 的稳定值，与 OpenCode 自身同目录的 projectID 未必相等
    （只保证「同仓库的 review-pi 会话归到同一组」）。

## 验收标准

1. **黄金 shape（CI 单测）**：`opencode-compat.test.ts` 断言 `info` 10 键、`runId`
   剥除、`cost` 拍平、`msg_m` 确定性 id、`finish`/`tool`/`model.variant` 归一、
   全文档无 `null`、`seedCount` 只写增量、`subagents` 注入。
2. **run 时落盘（进程面）**：一次 run 后 `<runs>/opencode/session-*.json` 存在
   （`review-run-artifacts.test.ts` / `bin.process.test.ts` 覆盖）。
3. **export 表示切换**：缺省兼容版 / `--native` 原生 / 旧 run 报错提示 `--native` /
   `--path` 复制兼容版时写 `manifest.json`（`session-export.test.ts`）。
4. **真机 import**：`scripts/opencode-compat/verify.mjs`（opt-in）跑
   `opencode --standalone session import` + `session export` 回读一致。

## 实施记录（2026-11-11）

| 文件 | 内容 |
|---|---|
| `packages/review-pi/src/export/opencode-compat.ts` | `buildOpenCodeSession` 归一化纯函数、`writeOpenCodeSession`、`providerIdFromBaseUrl`、`OPENCODE_DIR` |
| `packages/review-pi/src/export/opencode-compat.test.ts` | 黄金 shape 单测（无 null、id、finish/seedCount/subagents） |
| `packages/review-pi/src/knowledge/skill-pass.ts` | `SkillPassTranscript` 增 `seedCount` |
| `packages/review-pi/src/run/review-pass.ts` | 写原生转录时同写兼容版；skill 子会话设 `parentID` + 只写增量；父会话注入 `subagent` part |
| `packages/review-pi/src/cli/args.ts` | `--native` 布尔旗标、usage 与说明 |
| `packages/review-pi/src/cli/export-command.ts` | `native` 透传 |
| `packages/review-pi/src/export/session-export.ts` | 表示切换（缺省兼容版 / `--native`）、旧 run 人话报错、`manifest.json` 写入 |
| 测试 | `session-export.test.ts`、`args.test.ts`、`bin.process.test.ts`（表示切换 + manifest + 旧 run） |
| `scripts/opencode-compat/verify.mjs` + `README.md` | opt-in 真机 import/export 回读验证器 |

### 真机验证（2026-11-11，OpenCode v2.2.0）

真实 16 条样本 `session-20261109_122156_875.json`：

- 归一化后 `opencode --standalone session import` 成功（`Imported session: session-20261109_122156_875`）；
- `session export` 回读 16 条消息、类型序列一致、无 `null`；
- 约束实测：顶层多 `view` → 500；多 `info.runId` → 500；`msg_0001`（纯数字）→ 500；
  `msg_0001a` / `msg_m*` → 可导入；跨会话重复 id → 500；`finish:"toolUse"` → 400；
  `outcome:"truncated"/"errored"/"aborted"` → 400（枚举只有 `succeeded | failed`）；
  system `metadata:{}` → 400；悬空 `parentID` → 404（父先于子导入）。