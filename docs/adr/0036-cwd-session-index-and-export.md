# 0036. cwd session 索引与 `review-pi export`

**状态**：已接受（2026-11-03，随代码落地）
**关联**：ADR-0033（产物落盘由 taskId 决定：`<tasks 根>/<taskId>/{runs,audit}/`）、ADR-0032（`run.json` / `session-<ts>.json` 的扁平布局与时间戳 runId）、ADR-0014（skill 会话独立转录 `session-<runId>-skill-<name>-r<N>.json`）、ADR-0025（用户级 JSONC 配置）、ADR-0027（cwd 单名副本 `review-result.json`）
**局部修订**：ADR-0027 决策 2「cwd 副本只留 `review-result.json`」——cwd 现在会多一个 `.review-pi-session.json`（隐藏的寻址索引，不含检视内容）；该决策的其余部分（不写原名副本、写失败不改变退出码、不产 tips 时清理陈旧副本）继续有效。
**跨仓**：本 ADR 为本仓 pi 线序列 0036；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
**后续修订（2026-11-09）**：决策 3 的 stdout 由「一行一个路径」改为「**单行、逗号 + 空格分隔**」（如 `a.json, b.json`），便于调用方直接把整行当作一个字符串消费；决策 4 的 `--path` 返回值同样按该格式输出复制后的路径。两项决策的寻址、顺序与错误语义不变。

## Context

生产用法是**在代码仓目录里执行** `review-pi review`：

```text
cd D:\work\myrepo
review-pi review --repo . --mr-diff change.diff --taskId change-001 --rule-skill-zip rules.zip
```

产物按 ADR-0033 落在 `<tasks 根>/<taskId>/`（缺省 `~/.PiAgent/tasks/change-001/`），转录文件名带 runId（ADR-0032），skill 会话再多一层 `-skill-<name>-r<N>` 段（ADR-0014）。也就是说：

1. **跑完的人拿不到 session 路径**：stdout 是单 JSON 文档（findings），stderr 是进度与摘要，两者都不含转录路径；要找回转录必须知道 tasks 根、taskId 与 runId 三件事。
2. **runId 不在 `run.json` 顶层**：它只以文件名形式出现在 `baseline.auditPath`（`audit/<runId>.json`）里，人工反推容易错。
3. **下游（评测 / 归档 / 复跑对照）只想拿路径**：它们不需要检视内容，也不想为此加载配置、持有 key 或起网关。

现有命令面（`review` / `smoke` / `config`）都不解决这件事：`config show` 打印配置，`smoke` 打网关诊断，`review` 只出结果。

## Decision

### 1. `review` 成功后写一份 cwd 索引 `.review-pi-session.json`

隐藏文件（不污染用户的仓库工作区），内容只含**寻址信息**：

```json
{
  "version": 1,
  "taskId": "change-001",
  "tasksDir": "C:\\Users\\Li\\.PiAgent\\tasks",
  "runId": "20261103_112336_401",
  "repo": "D:\\work\\myrepo",
  "updatedAt": "2026-11-03T11:23:36.401Z",
  "main": "C:\\Users\\Li\\.PiAgent\\tasks\\change-001\\runs\\session-20261103_112336_401.json",
  "skills": [
    "C:\\Users\\Li\\.PiAgent\\tasks\\change-001\\runs\\session-20261103_112336_401-skill-general-code-review-r1.json"
  ]
}
```

- **路径一律绝对**：相对路径在别的 cwd 下会漂移，导出面就失去意义；
- **每次成功 run 整份覆盖**：不做历史累积（历史转录仍在 tasks 目录，靠 runId 区分）；
- **写入时机**：skill 转录、`run.json`、`reviews_*.json` 都落盘之后，呈现投影之后、stdout 之前；
- **原子写**：同目录临时文件 + `rename`，避免导出面读到半截 JSON；
- **写失败只 stderr 警告**：索引是便利能力，不改变 run 的退出码，也不回滚检视产物；
- **失败 run 不写**：异常退出时旧索引保留，`export` 永远指向上一次**成功**的 run。

`skills[]` 的顺序 = `skillPassLog[]` 的顺序（即规则包装载顺序）；只有真正发出过请求的 skill 才有转录，装载失败的包不产生条目（与 `transcriptFile` 同源）。

### 2. 新增 `review-pi export`

```text
review-pi export [--taskId <id>] [--tasks-dir <dir>] [--path <dir>]
```

**纯文件系统命令**：不加载 `PiAgent.jsonc`、不需要 `apiKey`、不调模型、不探测 `.env.local`。这样换机器 / CI / 只拿到产物目录的场景也能导出。

两种寻址：

| 模式 | 依据 |
|---|---|
| 缺省 | 读 cwd 的 `.review-pi-session.json`（上一次成功 run 写的绝对路径） |
| `--taskId <id>` | 读 `<tasks 根>/<id>/runs/run.json`，runId 由 `baseline.auditPath` 文件名反推（ADR-0032 单源），skill 按 `baseline.audit.skillPassLog[].transcriptFile` 拼接 |

`--taskId` 的 tasks 根判定顺序：**cwd 索引里的 `tasksDir` → `--tasks-dir` → 缺省 `~/.PiAgent/tasks`**。同目录有索引时沿用它的绝对根——CI / 自定义 `--tasks-dir` 场景不会因为换 cwd 找错。

两种模式都只认**最新一次 run**（`run.json` 每次覆盖，天然指向最新）；历史 run 的转录不列（要「全历史」得另加旗标，不在本决策内）。

### 3. 输出 = 纯文本，一行一个绝对路径，主会话在前

```text
C:\Users\Li\.PiAgent\tasks\change-001\runs\session-20261103_112336_401.json
C:\Users\Li\.PiAgent\tasks\change-001\runs\session-20261103_112336_401-skill-general-code-review-r1.json
```

- `review-pi export | head -1` 直接拿主会话；
- 没有 skill 会话时只有一行；
- 不引入 `--json`：需要机读的调用方按行切分即可，多一个旗标就是多一条分支。

### 4. `--path <dir>`：平铺复制，返回复制后的路径

- 目标目录不存在就创建；相对路径按 **cwd** 解析；
- **平铺、保留原文件名**（主会话与 skill 文件名天然不冲突），同名直接覆盖；
- 返回值改为**复制后**的目标绝对路径（调用方可以直接拿返回值去读文件，不用自己拼目标目录）；
- 目标是源目录本身时跳过拷贝（`copyFile` 同路径行为依平台而异）；
- 任一文件复制失败 ⇒ `exit 1`，stderr 指明是哪个文件，已复制的保留（不回滚）。

### 5. 退出码与错误

`0` 成功；`1` 索引缺失 / 索引非法 / taskId 不合法 / 任务目录不存在 / `run.json` 缺失或坏 JSON / session 文件缺失 / 复制失败 / 未知旗标。全部是人话错误，不抛堆栈。

**不返回幽灵路径**：解析出的每个路径都必须真实存在（`stat` 是普通文件），否则整体失败——导出面宁可报错，也不给下游一个读不到的文件名。

## Options（为什么不是别的）

- **把索引并进 `review-result.json`**：会改变现有下游契约，而且不产 tips 时 `review-result.json` 会被删除，索引跟着消失。否。
- **可见文件 `review-pi-session.json`**：和 `review-result.json` 一样常年挂在 `git status` 里，会被人误提交。否（隐藏文件 + 文档提醒）。
- **写进 `~/.PiAgent/`（全局单份）**：多仓 / 多 CI workspace 并行时会互相覆盖（最后一次赢），而「当前目录 = 当前项目」正是用户的心智模型。否。
- **`export` 默认输出 JSON**：与 `review` 的「stdout 单 JSON」一致，但导出面的主用途是喂 shell / 拷文件，一行一路径最省事。否。
- **`export` 自己加载配置去解析 tasks 根**：会把 key 读进一个只读路径的命令里，且换机器就不可用。否（`--tasks-dir` / 索引里的绝对根足够）。
- **返回源路径**：调用方还得自己拼目标目录与文件名，等于把复制语义泄漏给每个下游。否。
- **列出该 task 下全部 `session-*.json`**：一次 run 的产物应当是封闭集合；历史 run 混进来会让「主会话是哪个」变成猜谜。否（`--all` 留给将来）。

## Consequences

- **正**：
  - 生产用法「在仓里跑一次、然后取 session」变成两条命令，不再需要知道 tasks 根 / runId 的拼法；
  - 索引是纯数据（绝对路径 + runId），评测、归档、复跑对照都能直接消费；
  - `export` 零配置、零网络、零秘密，可在 CI 的任意目录执行；
  - 失败不污染检视结论：索引写失败只警告，`exit 0` 不变。
- **负 / 风险**：
  - cwd 多一个隐藏文件（ADR-0027 决策 2 的局部修订），需在文档提醒**不要提交**；`.gitignore` 由用户按需自行添加（本仓不代改用户仓库）；
  - 索引是**快照**：手工移动 / 删除 tasks 目录后，`export` 会报「session 文件不存在」而不是自动重找（换 `--taskId` 可重算）；
  - 依赖 `baseline.auditPath` 与 `skillPassLog[].transcriptFile` 两个字段的既有形状；将来若改这两个字段的落盘形态，`export --taskId` 需同步（索引模式不受影响）。
- **中性**：
  - `review` 的 stdout / stderr 契约不变（索引路径不上 stdout）；
  - 配置面、模型调用面、产物文件名全部不变。

## 验收标准

1. **索引**：跑一次 `review` ⇒ cwd 有 `.review-pi-session.json`，`version = 1`、路径全绝对、`main` 与 `runId` 自洽；同一目录再跑一次 ⇒ 整份覆盖（无历史累积）（`session-index.test.ts`、`bin.process.test.ts`）。
2. **export 缺省**：`review-pi export` 打印主会话在前、skill 按装载顺序，一行一个路径（`session-export.test.ts`）。
3. **export --taskId**：只读任务目录即可还原同一组路径；tasks 根按「索引 → `--tasks-dir` → 缺省」判定（`session-export.test.ts`）。
4. **export --path**：平铺复制、内容逐字节相同、返回复制后的绝对路径（`session-export.test.ts`、`bin.process.test.ts`）。
5. **不加载配置**：配置文件缺席 + 空 HOME 下 `export` 仍 `exit 0`（`bin.process.test.ts`）。
6. **错误面**：索引缺失 / 坏 JSON / 版本不符 / 任务不存在 / 文件缺失 / 未知旗标都是 `exit 1` + 人话（`session-index.test.ts`、`session-export.test.ts`、`args.test.ts`）。
7. **文档**：README / 使用手册 / 运行手册 / `CONTEXT.md` 写明索引文件、`export` 用法与「别提交索引」。

## 实施记录（2026-11-03）

| 文件 | 内容 |
|---|---|
| `packages/review-pi/src/export/session-index.ts` | 索引形状、原子写、读数校验（缺失 / 坏 JSON / 版本不符 → 人话） |
| `packages/review-pi/src/export/session-export.ts` | 索引模式与 `--taskId` 模式、runId 反推、skill 顺序、`--path` 平铺复制、存在性校验 |
| `packages/review-pi/src/cli/export-command.ts` | 子命令执行：只往 stdout 打路径 |
| `packages/review-pi/src/cli/args.ts` | `export` 解析（`--taskId` 走 `checkTaskId` 同口径）、usage 与旗标说明 |
| `packages/review-pi/src/cli/main.ts` | 配置装载早退（export 不读配置）；review 收尾写 cwd 索引 |
| 测试 | `session-index.test.ts`、`session-export.test.ts`、`args.test.ts`、`bin.process.test.ts`（进程级：review → 索引 → export / `--path` / `--taskId`） |

### 真机验证（2026-11-03，`review-pi@0.2.0`）

发布前做了一次「卸载 → 从 tarball 重装 → 独立目录真跑」的端到端核对，全部通过：

| 验证 | 结果 |
|---|---|
| 卸载/重装 | `npm uninstall -g review-pi` 移除 8 个包；`npm i -g .artifacts/tarballs/review-pi-0.2.0.tgz` 装回 107 个包；usage 面出现 `export` 子命令 |
| 无索引时 `export` | `exit 1` + 人话（`未找到 session 索引 …`），stdout 空 |
| 真实网关 review（无规则包） | `exit 0`，runId `20261103_122614_393`，索引 `main` 指向真实文件、`runId` 与 `run.json` 的 `auditPath` 文件名一致 |
| 真实网关 review（带规则 Skill） | `exit 0`，索引 `skills` 1 条（`session-…-skill-general-code-review-r1.json`），`export` 输出 2 行、主 session 第一行 |
| `--path` | 平铺复制、内容逐字节相同、返回复制后的绝对路径；目标不存在时自动建（含嵌套）；目标即源目录时跳过而不报错 |
| `--taskId` / `--tasks-dir` | 无索引目录下用 `--tasks-dir` 能还原同一组路径；缺省根缺失时 `exit 1` 报 `任务目录里没有 run.json` |
| 不读配置 | 空 `HOME` + 配置文件缺席时 `export` 仍 `exit 0`、stdout 正确、stderr 空 |
| `--config` | `export --config <path>` → `exit 1` + `unknown flag "--config"`（与「不加载配置」一致） |

顺带确认的两条边界：**cwd 有索引时 `--tasks-dir` 不生效**（优先级见上方决策 2）；**PowerShell 的 `review-pi.ps1` shim 会把 CLI 的 stderr 包成 `NativeCommandError`**（内容与退出码都正确，属 PowerShell 行为，已在《使用手册》排障表里注明）。
