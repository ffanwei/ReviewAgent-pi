# 0033. 落盘位置改为任务模型：`--taskId` 决定输出目录，`--out` 移除

**状态**：已接受（2026-11-03）
**关联**：ADR-0032（本 ADR 只改「一次 run 落哪个目录」，目录内形态 `runs/` + `audit/` + `.cache/` 不变）、ADR-0025（`.PiAgent/` 用户级目录）、ADR-0017（cwd 副本 `review-result.json`）、ADR-0031（参数回显）
**跨仓**：本 ADR 为本仓 pi 线序列 0033；DSH 兄弟仓决策须引用全限定语「DSH 线 ADR-XXXX」。

## Context

ADR-0032 之后，一次 run 的形状是 `<out>/{runs,audit,.cache}/`，其中 `<out>` 由 `--out <dir>` 给定，缺省值 `review-pi-output`（相对 cwd）。这留下了三个问题：

- **落盘位置是「命令行随手给的路径」**：同一任务重跑时必须自己记住上次用的目录，忘了就散落在 cwd 各处；CI 里更是每次拼一个绝对路径；
- **缺省值把产物写进当前工作目录**：在仓库里直接跑，产物就落在仓库内（`review-pi-output/`），需要 `.gitignore` 兜底；
- **任务身份没有载体**：`--out` 只是路径字符串，`~`、相对路径、`../` 都能穿透，「这次是哪次任务」只能靠目录名口头约定。

用户要求把落盘位置改成**任务模型**：产物统一落在 `~/.PiAgent/tasks/<taskId>/`（与配置文件同住 `.PiAgent/`），同时**保留向 cwd 复制一份 `review-result.json`** 的既有能力（ADR-0017 决策 14）。

## Decision

### 1. `--taskId <id>` 必需，产物落 `<tasks 根>/<id>/`

```text
~/.PiAgent/
├── PiAgent.jsonc                  # 用户级配置（ADR-0025，不变）
└── tasks/
    └── <taskId>/                  # 一个任务一个目录
        ├── runs/
        │   ├── run.json
        │   ├── session-<ts>.json
        │   ├── reviews_en.json
        │   └── reviews_tips_zh.json
        ├── audit/
        │   └── <ts>.json
        └── .cache/
            └── rule-skills/<sha256>/…
```

- 目录**内部形态完全沿用 ADR-0032**（`runs/` + `audit/` + `.cache/`，`runId` = 首次请求时刻）——本 ADR 只换「哪个目录」；
- `--taskId` **必填**：漏传即用法错误（`missing required flag --taskId`）。不做缺省派生（例如回落 `caseId`）——落盘位置必须由调用方显式声明，否则「忘了传」会静默写进别人的任务目录；
- 同一个 taskId 再跑一次，与 ADR-0032 §3 同语义：`run.json` / `reviews_*.json` 覆盖，转录与审计按 `<ts>` 累积；
- **taskId 与 caseId 正交**：`caseId` 仍由 MR 文件名派生（ADR-0029 / ADR-0032 的「case 不是身份维度」），`taskId` 只看 `--taskId`。任务目录里不出现 caseId 段。

### 2. tasks 根 = `<home>/.PiAgent/tasks`，`--tasks-dir <dir>` 只覆盖根

- 缺省根与配置文件同住 `.PiAgent/`：`Windows` 读 `USERPROFILE`、POSIX 读 `HOME`（与 `resolveConfigPath` 同源，`shared/config.ts` 的 `homeDirectory`）；
- 主目录为空 = **fail fast**，提示改用 `--tasks-dir`（不猜路径、不回落 `os.homedir()`——与配置路径同口径）；
- `--tasks-dir <dir>` 覆盖的是**根**，不是单次目录：产物仍落 `<tasksDir>/<taskId>/`。相对路径按 cwd 解析。这是测试 / CI / 沙箱的隔离口（既有进程测试全部靠它指到 temp 目录）；
- 不新增配置键：tasks 根不参与 `PiAgent.jsonc`，避免「配置说 A、命令行说 B」的第二来源。

### 3. `--out` 彻底移除，传入即报错并提示迁移

- `--out` 不在已知旗标面内；解析前先扫一遍 argv，命中即返回专用文案（不是裸 `unknown flag`）：

  ```text
  --out 已移除（ADR-0033）：产物改落 ~/.PiAgent/tasks/<taskId>/，改用 --taskId <id>
  （--tasks-dir <dir> 只覆盖 tasks 根目录）
  ```

- 不保留隐藏别名：`--out` 与 taskId 的语义（「任意路径」vs「任务身份」）相冲，静默兼容会让旧脚本继续写出不受管目录；
- `review-pi-output` 缺省值随之消失，仓库内不再需要为它留 `.gitignore` 条目。

### 4. cwd 副本 `review-result.json` 保留

ADR-0017 决策 14 的「执行目录副本」语义不变，但**触发条件收紧为「产出 tips 且配置了呈现引擎」**（与现有实现一致）：

- 有 tips → 往 `<cwd>/review-result.json` 写一份（契约字节与 `reviews_tips_zh.json` 同源）；
- 无 tips（未配呈现引擎 / 呈现层失败降级）→ 不写、并清理上次遗留的副本（ADR-0017 的「有就是本次的」口径）；
- 副本只写 cwd，**不**写进任务目录；任务目录是唯一权威落点。

### 5. taskId 校验：必须是**单段目录名**

`shared/tasks-dir.ts` 是唯一校验点（`checkTaskId`），`args.ts` 只负责把错误透传成用法错误。规则：

| 规则 | 理由 |
|---|---|
| 非空、`trim()` 后生效、上限 100 字符 | 目录名，不追求语义，只挡畸形输入 |
| 拒绝 `/` `\`、盘符（`C:`）、绝对路径 | taskId 不是路径；`--taskId ../../x` 不能把产物写出 tasks 根 |
| 拒绝 `.` / `..` / 前导 `.` | 前导点会造出隐藏目录（`.cache` 就是隐藏层），任务目录必须在 `~/.PiAgent/tasks` 里可见 |
| 拒绝控制字符（`\p{Cc}`）、Windows 非法字符 `<>:"|?*` | 跨平台建目录失败面 |
| 拒绝 Windows 保留设备名（`CON` / `NUL` / `COM1…` / `LPT1…`，带扩展名同样拒绝） | `CON.txt` 在 Windows 上仍不可用 |
| 拒绝尾随 `.` 与空格（trim 后） | Windows 会静默裁掉，导致「传的 id ≠ 实际目录名」 |
| **允许**空格与任意 Unicode（含中文任务名） | 中文任务名是合法使用形态；空格只要求不在首尾 |

## Options（为什么不是别的）

- **`--taskId` 可缺省派生为 caseId**：零配置确实方便，但「忘传 = 写进 caseId 目录」是隐性行为，且同一 MR 多套命名会分裂任务。否——必需，漏传即错误。
- **只认 `~/.PiAgent/tasks`，不给覆盖口**：测试需要隔离（现有 27 个进程用例全部指 temp 目录），沙箱化 home 虽可行但每条命令都要改环境。否——留 `--tasks-dir`，只覆盖根。
- **`--out` 保留为隐藏别名**：见 §3，语义相冲。否。
- **tasks 根走配置键 `paths.tasksDir`**：配置与命令行两个来源会打架，且 `config show` 还得新增一段。否。
- **taskId 允许嵌套（`--taskId a/b`）**：等于把路径控制权交回调用方，`..` 穿透面重现。否。
- **产物直接平铺到 `~/.PiAgent/tasks/<taskId>`（去掉 `runs/` / `audit/`）**：ADR-0032 刚把「扫目录不把审计当转录」的语义定下来，不为换根再拆一次。否。

## Consequences

- **好**：落盘位置由任务身份决定，不再依赖调用方记忆路径；缺省位置在用户级 `.PiAgent/` 下，仓库内不再产生 `review-pi-output/`；`--tasks-dir` 给测试 / CI / 沙箱单一隔离口；`--out` 的就地迁移有明确文案。
- **坏 / 需要显式认识的刻意偏离**：
  - **`--out` 是硬破坏**：旧脚本必须改 `--taskId`（或加 `--tasks-dir` 保持目录位置接近），无兼容期；
  - **taskId 是目录名，不是任意字符串**：中文与空格可以用，`/`、前导点、Windows 保留名不行；
  - **tasks 根不在配置里**：要改根只能每次带 `--tasks-dir`（或设 `HOME`/`USERPROFILE`）；
  - **cwd 副本只与 tips 同在**：不产 tips 的 run 在 cwd 里看不到 `review-result.json`（与 ADR-0017 一致，不是回归）。
- **测试面**：`shared/tasks-dir.test.ts`（根解析 / 跨平台 `resolveFor` / taskId 全分支）、`cli/args.test.ts`（`--taskId` 必需、`--tasks-dir` 透传、`--out` 迁移文案）、`cli/args-echo.test.ts`（回显行数与缺省标注）、`cli/bin.process.test.ts`（`CLI_TASK_ID` 注入、`<tasks-dir>/t-1/runs|audit` 落点、缺省根 = `<home>/.PiAgent/tasks` 的进程级用例）。

## 后续修订

- ADR-0032 的目录内形态（`runs/` + `audit/` + `.cache/`、`runId` 形态）**保持不变**；ADR-0032 中「`--out` 是 run 粒度」的表述在本 ADR 之后读作「`<tasks 根>/<taskId>` 是 run 粒度」。
