# ReviewAgent-pi

一次 MR 检视、一条命令：读仓库快照 + 变更集（+ 可选规则 Skill），在 pi 内核上跑检视循环，产出**英文 findings**（`reviews_en.json`，结构化真源）与**中文按行分组的建议**（`reviews_tips_zh.json`，可选，由呈现引擎翻译），同时留全量审计与转录。

- 内核基座：pi 代码仓的 npm 上游包（`@earendil-works/{pi-ai,pi-agent-core,chord,pi-telemetry}`，精确锁定 `0.85.1`，ADR-0035）；Review Runtime 在 `packages/review-pi` 从 0 重写。
- 上下文策略：最小充分上下文（Minimal Sufficient Context）+ 缓存稳定循环（Cache-Stable Review Loop）——工具按需拉取，不整仓灌入。
- 检视语言：英文是测量真源，中文只做核外投影，不改变请求面。

## 功能

| 能力 | 说明 |
|---|---|
| 单次检视 | 一条命令一次 run：六阶段循环 + 七个 review 工具 + Context Ledger + 审计投影 |
| 两种变更集输入 | `--mr-diff`（标准 unified diff）或 `--mr-json`（GitCode/GitLab `/pulls/:number/files` 原样 JSON：数组或 `{diffs:[…]}`；路径取 `new_path` / `filename` / `file_path` / `path`、正文取 `diff` / `patch`，`diff` 为对象时取内层 `diff.diff`） |
| 规则 Skill | `--rule-skill-zip` / `--rule-skill <dir>`，一次可传多个（逗号列表或重复旗标），**只认显式输入**（不扫描被检视仓库）；`--strict-rule-skill` 把装载失败改为 fail fast |
| 中文建议 | 配置 `presentation.engine` 后额外产出 `reviews_tips_zh.json`：`"builtin"` 用包内引擎，路径用自定义模块，`null` 关闭 |
| MR 边界护栏 | 过滤后超 `limits.boundary` 只告警不拒检；`maxDiffChars` 是输入体积门（超限直接报错，不发模型） |
| 大 MR 分片 | 过滤后 diff 超 `limits.split.maxShardChars` 时按 `diff --git` 文件块自动切片（绝不切 hunk）并确定性合并 findings；单片路径逐字节不变（ADR-0039） |
| 单源配置 | 用户级 JSONC（`~/.PiAgent/PiAgent.jsonc` 或 `--config`），启动读一次成不可变快照，审计留 digest |
| 可观测 | stdout 单 JSON 文档；stderr 诊断与 `--progress` 阶段投影；退出码 0（含诚实截断）/ 1 |
| diff 检视技能 | 仓内 `.agents/skills/` 两个可复跑技能：真实缺陷回放（默认 VUL4J-38 / CVE-2014-4172）与合成缺陷注入（GEN-RES-001）；真跑模型检视后把证据归档到 `repo-diff-skill-result/`（不入库） |
| 离线回放 / 并发阶梯 | `scripts/offline-replay/`：冻结 trace → 本机回放服务替代模型网关，零网络、零 key 跑完整检视；支持规则 Skill / 分片场景、真网关录制与进程级并发档位（ADR-0048 / ADR-0049，不进产品包） |

检视本体不限语言；符号 / 引用 / 调用链工具支持 Java、TypeScript（含 JS 变体）、Python、Go 与 C/C++（`codeintel.languages` 可配，缺省 `"auto"`，ADR-0041 / ADR-0042）。

## 环境要求

| 项 | 要求 | 说明 |
|---|---|---|
| Node.js | **≥ 22.19** | `review-pi` 包 `engines.node` 为 `>=22.19.0`（仓库根为 `>=22`）；低于要求启动即报错 |
| npm | 任意近期版本 | 安装发行包（registry 或本地 tarball） |
| pnpm | **12.x**（`packageManager: pnpm@12.14.0`） | 仅源码开发 / 打包需要；`corepack enable` 会自动对齐版本 |
| 网络 | 首次安装需可达 npm registry | 内核四包与约 60 个传递依赖**不在 tarball 内**，安装时按 `dependencies` 拉取 |

私有网络只映射内核 scope，不要整体换源（否则 `@earendil-works/*` 解析不到）：

```ini
@earendil-works:registry=https://your-registry/
```

## 安装

产品以单个包发行：`@baize/review-pi`（提供 `review-pi` 命令）。内核四包作为普通 npm 依赖随安装自动拉取（`@earendil-works/*`，版本精确锁定），不再由本仓打包或发布。

### 方式 A：从 registry 全局安装（使用者）

```bash
npm i -g @baize/review-pi     # 全局安装，提供 review-pi 命令
review-pi config init         # 首次：生成 ~/.PiAgent/PiAgent.jsonc
```

- 依赖装在 `<npm 全局根>/@baize/review-pi/node_modules/`（不提升到 prefix 根），`npm rm -g @baize/review-pi` 会一起带走。
- 镜像 / 私服若未同步 `0.85.1`，安装会 404——先探一次：`npm view @earendil-works/pi-ai@0.85.1 version`。

### 方式 B：装进项目

```bash
pnpm add @baize/review-pi     # 或 npm i @baize/review-pi
npx review-pi config init
npx review-pi review --repo . --mr-diff ./change.diff --taskId change-001
```

### 方式 C：从源码构建后安装（开发者 / 离线分发）

```bash
git clone <repo> && cd ReviewAgent-pi
corepack enable
pnpm install                  # 装工作区依赖（内核四包从 registry 拉取）
pnpm build:dist               # 构建 CLI dist + 呈现引擎（见「编译与打包」）

# C1. 仓内直接跑（不安装，也不需 npm link）
node packages/review-pi/bin/review-pi.js review --repo <path> --mr-diff <diff> --taskId <id>

# C2. 打成 tarball 再安装（离线分发 / 验证发行面）
pnpm pack:packages            # → .artifacts/tarballs/baize-review-pi-<version>.tgz
pnpm verify:pack              # 安装布局冒烟（不发网络、不发布）
npm i -g .artifacts/tarballs/baize-review-pi-<version>.tgz
```

`pnpm install` + `pnpm build:dist` 之后才能跑仓内形态：bin 会做**新鲜度门**（见下），产物陈旧直接拒跑，不自动重编。

### 安装后自检

```bash
review-pi config init    # 生成 ~/.PiAgent/PiAgent.jsonc（已存在则拒绝，--force 覆盖）
review-pi config show    # 脱敏查看生效值（reviewer.apiKey 应为 set）
review-pi smoke          # 双探针自检：网关健康 + 模型可达；通过 exit 0
```

`config init` 生成的模板需要填入 `reviewer.apiKey`（以及需要时的 `baseUrl`）后再跑 `smoke`；`config show` 只报 `set | missing`，不回显值。

### 升级 / 卸载

```bash
npm i -g @baize/review-pi@latest     # 升级
npm rm -g @baize/review-pi           # 卸载（嵌套依赖一并移除）
```

## 使用

### 0. 子命令总览

| 子命令 | 用途 | 读配置 / 需要 key | 产出 |
|---|---|---|---|
| `review` | 跑一次检视（唯一产出检视结论的路径） | 是 / 是 | `runs/` + `audit/` + stdout JSON |
| `smoke` | 网关双探针自检（网关健康 + 模型可达） | 是 / 是 | stdout 人话诊断 |
| `config init\|show` | 写缺省模板 / 脱敏查看生效值 | 是 / 否 | 配置文件 / 诊断文本 |
| `export` | 打印或复制本次 run 的 session 路径 | 否 / 否 | stdout 绝对路径 |

不带子命令执行 `review-pi` 会把完整用法打到 stderr 并 `exit 1`（**没有 `--help` / `--version`**，这是设计行为）。未知子命令、未知旗标同样 `exit 1` + usage。

### 1. 配置

唯一配置来源是用户级 JSONC（Linux `$HOME` / Windows `%USERPROFILE%`），`--config <path>` 可换文件；环境变量与 `.env.local` 不再读取。

```jsonc
{
  // 配置版本：当前只支持 1，不匹配即 fail fast。
  "version": 1,
  "reviewer": {
    // 模型网关密钥（必需）。审计与日志只报 set / missing，绝不回显值。
    "apiKey": "sk-...",
    // 网关基址：官方直连用 https://api.deepseek.com；OpenAI 兼容网关需自带 /v1。
    "baseUrl": "https://api.deepseek.com",
    // 单次请求输出上限：null = 自动（官方直连不发 max_tokens；网关发 32768）。
    "maxOutputTokens": null
  },
  "model": {
    // 默认检视模型（--model 可覆盖）。
    "default": "deepseek-v4-flash",
    // 中文投影模型：null = 跟随本次检视模型（ADR-0021）。
    "presentation": null
  },
  "presentation": {
    // 核外中文呈现引擎：builtin = 包内自带；null = 不投影（英文直通）；路径按本文件所在目录解析。
    "engine": "builtin"
  }
}
```

`config init` 生成的是完整模板：全部键 + 逐项中文注释 + 缺省值（含 `limits` 的每个超时 / 并发 / 边界 / 归档 / 文本截断项），可直接照着改。完整键表见 [`PiAgent.example.jsonc`](PiAgent.example.jsonc)；`review-pi config show [--json]` 脱敏查看生效值与来源。

- **可配**：超时、并发、MR 边界、规则包归档上限、微限（回显 / 跳数 / 摘要截断）。
- **死钉**：轮次 5、工具调用 100、工具结果预算 8000 字符、`temperature: 0`、effort 锁档——写进配置只会得到告警。
- **失败策略**：类型 / 取值 / 版本错 fail fast（exit 1 并指出键路径）；未知键与权限过宽只告警。

### 2. 一次检视

```bash
# A. 标准 unified diff
review-pi review \
  --repo /data/snapshots/my-repo-base \
  --mr-diff /data/diffs/change-001.diff \
  --taskId change-001

# B. 直接吃 GitCode 接口返回的文件变更 JSON
curl.exe -H "Authorization: Bearer $env:GITCODE_TOKEN" \
  "https://api.gitcode.com/api/v5/repos/OWNER/REPO/pulls/1234/files" -o MR-1234.json
review-pi review --repo D:\work\myrepo --mr-json MR-1234.json --taskId MR-1234

# C. 带规则 Skill + 自定义 tasks 根（CI / 沙箱）
review-pi review \
  --repo /repo --mr-diff /d/change.diff --taskId change-001 \
  --tasks-dir /tmp/tasks \
  --rule-skill-zip ./general-code-review.zip --strict-rule-skill
```

- `--repo` 是**目录**，约定停在 diff 的 base 侧（CLI 不 apply diff）。
- `--taskId` **必需**：产物落 `~/.PiAgent/tasks/<taskId>/`（`--tasks-dir` 只覆盖根）。
- `--mr-diff` 与 `--mr-json` **恰好给一个**；`caseId` = 文件名去最后一个扩展名（`MR-1234.json` → `MR-1234`），与 `taskId` 是两个维度。
- PowerShell 用 `>` / `Out-File` 写 JSON 会得到 UTF-16，解析失败；用 `curl.exe -o` 或 `Set-Content -Encoding utf8`。
- 开跑前 stderr 先回显**本次生效参数**（相对路径已解析、缺省值已标注来源）；之后才装载 diff / 进入检视。失败路径同样看得到输入面。

### 3. 取回 session 路径（`export`）

每次 `review` 成功后在**执行目录**写一份隐藏索引 `.review-pi-session.json`（只有绝对路径与 runId，不含检视内容；重复执行整份覆盖；`version: 2` 起主转录是 `mains[]`，读取端兼容 v1 的单个 `main`）。`export` 直接读它：

```bash
review-pi export                      # 单遍：主 session 第一行、skill 依次在后；分片：s01 主 → s01 skill → s02 主 → …
review-pi export --path ./sessions    # 复制到该目录（平铺、同名覆盖），返回复制后的路径
review-pi export --taskId change-001  # 不经索引：去 tasks 根下读该任务最新一次 run
```

- `export` **不加载配置、不需要 apiKey、不调模型**——纯文件系统命令，CI / 换机器都能用（因此也不认 `--config`）。
- `--taskId` 的 tasks 根判定：cwd 索引里的 `tasksDir` → `--tasks-dir <dir>` → 缺省 `~/.PiAgent/tasks`；同目录有索引时以索引里的绝对根为准（想让 `--tasks-dir` 生效，请在无索引的目录执行）。
- 只认**最新一次 run**（`run.json` 每次覆盖）。
- 索引是隐藏文件，**别提交进仓库**；`export` 找不到索引 / 任务 / 文件时 `exit 1` 并给人话原因（不返回幽灵路径）。
- `--path` 目标目录不存在则创建（相对 cwd），**平铺、保留原文件名、同名覆盖**；输出改为复制后的绝对路径。

## 参数总表

### 0. 通用解析规则

| 规则 | 行为 |
|---|---|
| 值分隔 | 必须空格分隔：`--model deepseek-v4-flash`。**不支持 `--flag=value`**（会被判 unknown flag） |
| 值形态 | 值不能以 `--` 开头（`--issue --taskId x` 报 `requires a value`，不会静默吞旗标） |
| 重复旗标 | 非列表旗标重复出现 = `duplicate flag`；`--rule-skill-zip` / `--rule-skill` 例外（按出现顺序累积） |
| 列表写法 | 列表旗标支持逗号（`a.zip,b.zip`）、连续 token（`a.zip b.zip`）或重复旗标，三种等价 |
| 布尔对 | `--progress` 与 `--no-progress` 同给 = `conflicting flags`；其余无值旗标重复 = `duplicate flag` |
| 帮助 | 无 `--help` / `--version`；裸跑或未知子命令 → usage 到 stderr + `exit 1` |

### 1. `review`（13 个旗标）

| 旗标 | 取值 | 必填 / 缺省 | 作用 |
|---|---|---|---|
| `--repo <dir>` | 目录 | **必填** | 仓库快照根目录，约定停在 diff 的 base 侧（CLI 不 apply diff）；不是目录即报错 |
| `--mr-diff <file>` | 文件 | 与 `--mr-json` **二选一** | 标准 unified diff 文本；`caseId` = 文件名去最后一个扩展名 |
| `--mr-json <file>` | 文件 | 与 `--mr-diff` **二选一** | GitCode / GitLab `/files` 原样 JSON（数组或 `{diffs:[…]}`）；路径取 `new_path` → `filename` → `file_path` → `path`，正文取 `diff` → `patch`（`diff` 为对象时取内层 `diff.diff`）；其余字段忽略，装载期补文件头转统一 diff |
| `--issue <text>` | 文本 | 缺省空 | MR 议题描述，**原样**进入初始 user 消息；多行 / 引号由 shell 负责转义 |
| `--taskId <id>` | 单段目录名，≤100 字符 | **必填** | 任务 id：产物落 `<tasks 根>/<id>/`（`runs/` + `audit/`）。拒绝路径分隔符 / 盘符 / 控制字符 / `<>:"\|?*` / 前导点 / 尾随点或空格 / Windows 保留名（`CON` `NUL` `COM1…`） |
| `--tasks-dir <dir>` | 目录 | 缺省 `~/.PiAgent/tasks` | 只覆盖 tasks **根**（测试 / CI / 沙箱）；相对路径按 cwd 解析；主目录不可判定时可用它兜底 |
| `--model <id>` | 模型 id | 缺省配置 `model.default` | 检视模型；自由 id 透传，不做别名或退役校验 |
| `--config <path>` | 文件 | 缺省 `~/.PiAgent/PiAgent.jsonc` | 替代配置文件，相对路径按 cwd 解析；**显式给出但文件不存在 = fail fast**（缺省路径缺席只提示、不报错） |
| `--rule-skill-zip <path[,path…]>` | zip 路径（可重复） | 缺省不装载 | 规则 Skill zip；**顺序 = 执行顺序**；一个包 = 一个 skill；不自动扫描被检视仓库（ADR-0027） |
| `--rule-skill <dir[,dir…]>` | 目录（可重复） | 缺省不装载 | 已解压规则 Skill 目录；先审计（符号链接 / 越界一律拒绝）→ 按内容哈希复制进 run 缓存 → 同一装载链路；**排在全部 zip 之后**（ADR-0018） |
| `--strict-rule-skill` | 无值 | 缺省关 | 规则包装载失败即 `exit 1`（一个包都没给也算）；缺省为「降级该包 + 审计留痕 + run 照常」 |
| `--progress` | 无值 | 缺省按 stderr 是否 TTY | 打开阶段 / 模型请求 / 工具调用 / skill 会话事件行（stderr） |
| `--no-progress` | 无值 | 同上 | 关闭事件行（批跑收日志时显式静音）；**收尾一行总结恒打印**，不受此旗标影响 |

### 2. `smoke`

| 旗标 | 取值 | 缺省 | 作用 |
|---|---|---|---|
| `--model <id>` | 模型 id | 配置 `model.default` | 冒烟模型；端点与 key 取配置文件，绝不回显 |
| `--config <path>` | 文件 | 用户级路径 | 替代配置文件 |

### 3. `config`

| 旗标 / 动作 | 取值 | 适用动作 | 作用 |
|---|---|---|---|
| `init` | — | — | 写缺省配置模板；已存在则拒绝，POSIX 权限 `0600` |
| `show` | — | — | 逐键打印生效值与来源；`reviewer.apiKey` 只显示 `set` / `missing` |
| `--config <path>` | 文件 | `init` / `show` | 目标 / 读取的配置文件 |
| `--force` | 无值 | 仅 `init` | 覆盖已存在的配置文件（`show` 用它 = 用法错误） |
| `--from-env <file>` | 文件 | 仅 `init` | 一次性从 `.env` 迁移 key / url / 呈现配置（`show` 用它 = 用法错误） |
| `--json` | 无值 | 仅 `show` | 输出机器可读 JSON（与审计 `config` 同形） |

### 4. `export`

| 旗标 | 取值 | 缺省 | 作用 |
|---|---|---|---|
| `--taskId <id>` | 单段目录名 | 无（读 cwd 索引） | 不经索引：去 `<tasks 根>/<id>/run.json` 反推最新一次 run |
| `--tasks-dir <dir>` | 目录 | `~/.PiAgent/tasks` | tasks 根覆盖；**cwd 有索引时以索引里的 `tasksDir` 为准** |
| `--path <dir>` | 目录 | 无（只打印路径） | 把 session 复制到该目录（平铺、保留文件名、同名覆盖），输出改为复制后的绝对路径 |

### 5. 已移除的旗标（会 `exit 1` 并给迁移提示）

| 旧旗标 | 替代 |
|---|---|
| `--env <file>` | `--config <path>`（ADR-0025）；旧 `.env.local` 用 `review-pi config init --from-env .env.local` 迁移 |
| `--mr <file>` | `--mr-diff` 或 `--mr-json`（ADR-0029） |
| `--out <dir>` | `--taskId <id>`（ADR-0033）；`--tasks-dir` 只换根 |
| `--rule-skill-name <name>` | 不替代：一个规则包就是一个 skill，多包用逗号列表或重复旗标（ADR-0034） |

## 产物

```
~/.PiAgent/tasks/<taskId>/        # --tasks-dir <dir> 可换根
  runs/
    run.json                   RunRecord：模型、耗时、findings 计数、usage（分片时多 shards[]）
    session-<ts>.json          检视转录（请求 / 工具 / 相位全留痕）
    session-<ts>-skill-<name>-r<N>.json   规则 Skill 会话转录（每个会话一份）
    reviews_en.json            英文 findings（结构化真源；分片时为合并去重后的一份）
    reviews_tips_zh.json       中文按行分组建议（配置了呈现引擎才有）
    shards/attempt-<ts>/sNN/   仅分片：每片主/skill 转录 + 片内 reviews_en.json
  audit/
    <ts>.json                  审计：请求、工具调用、相位、Context Ledger、规则 Skill 留痕
    shards/attempt-<ts>/sNN/<ts>.json   仅分片：每片审计（聚合审计的 requests/toolCallLog 为空）
```

`<ts>` = 首次模型请求时刻（UTC 毫秒），形态 `20261031_101010_123`，同时是 `runId`、审计文件名与 `session-<ts>` 的中段。进程 cwd 另写一份下游约定名副本 `review-result.json`（与真源逐字节相同，只在本次产 tips 时写），并写一份隐藏的 `.review-pi-session.json`（供 `export` 寻址，见上一节）。同一个 taskId 重跑只保留最新 `run.json` / `reviews_*.json`，审计 / 转录按 run 累积——想保留多次结果就换 `--taskId`。

## 退出码与 stdout

- stdout 是**单个 JSON 文档**，日志与诊断一律走 stderr。
- 退出码：完成（含诚实截断）`0`，中止或错误 `1`。截断信号在 JSON 的 `truncated=true`，不体现在退出码。
- stderr 在开跑前先打一段「本次 review 传入参数」生效值回显；成功 run 结束后再打一行运行总结。
- 真实网关调用只在本机按需执行，CI 恒离线。

## 编译与打包（源码开发）

```bash
pnpm install                       # 工作区依赖（内核四包从 registry 拉取）
pnpm build:dist                    # 发行全量构建：CLI dist + 呈现引擎（= build:presentation）
pnpm pack:packages                 # 打 tarball → .artifacts/tarballs/baize-review-pi-<version>.tgz
pnpm verify:pack                   # 安装布局冒烟（只借已装依赖，不发网络、不发布）
```

| 命令 | 做什么 | 产物 |
|---|---|---|
| `pnpm --filter @baize/review-pi build` | `tsc -p tsconfig.build.json`，编译 CLI 与运行时（排除测试 / `testing` / `e2e`） | `packages/review-pi/dist/`（bin spawn 目标是 `dist/cli/main.js`） |
| `pnpm build:presentation` | 上一步 + `tsc -p tsconfig.presentation.json` + `node scripts/copy-presentation.mjs` | `packages/review-pi/presentation/`（`.tmp-gen/presentation/*.js` 拷贝） |
| `pnpm build:dist` | 等于 `build:presentation`，一次建齐发行面 | 以上两者 |
| `pnpm pack:packages` | 清空并重建 `.artifacts/tarballs/`，对 `@baize/review-pi` 执行 `pnpm pack`（触发 `prepack`） | `baize-review-pi-<version>.tgz` |
| `pnpm verify:pack` | 把 tarball 装进临时布局并冒烟：产物在位、安装形态 bin 定位、`config init/show`、`builtin` 引擎、wasm / ripgrep | 通过 / 失败退出码 |
| `pnpm publish:packages` | `build:dist` + `pnpm -r publish`（显式发布动作） | registry |
| `pnpm test` / `pnpm --filter @baize/review-pi test` / `pnpm typecheck` | 根包测试 / 内核 + CLI 进程烟测 / 根包类型检查 | — |

`prepack`（`scripts/prepare-package.mjs`）会把 9 个必需产物校验一遍、附上第三方声明，并把首行为 CRLF 的 bin 改成 LF；`files` 白名单只含 `dist` / `bin` / `presentation` / `THIRD-PARTY-NOTICES.md` / `README.md`，**不含 `node_modules`**。

**新鲜度门**：bin 启动时检查运行时腿——内核四包是 npm 依赖（安装布局只判在位），本包 `dist` 判 mtime（源树新于产物即拒跑），拒跑消息带每腿的修复命令，**不自动重编**。改完源码必须重建。

仓库布局：

```
packages/review-pi/       检视运行时 + CLI（六阶段循环、七工具、规则 Skill、审计、呈现投影装配）
src/presentation/         核外呈现层（中文翻译投影 / 分组意见映射）
.agents/skills/           agent 技能：真实缺陷回放 / 合成缺陷注入（共享执行层在 _shared/）
repo-diff-skill-result/   diff 检视技能的真跑归档（gitignored）
scripts/                  构建、打包、安装面验证
docs/                     ADR、设计与使用文档
```

内核四包（`ai` / `agent` / `chord` / `telemetry`）不在仓内：它们是 npm 依赖，源码与 dist 都随 `pnpm install` 落在 `node_modules`（ADR-0035）。仓内开发 = 安装形态：内核按上游名 `@earendil-works/*` 从 `node_modules` 解析（dist + d.ts）；`review-pi` 自己的 `exports.source` 条件让 vitest / typecheck 读 `src/*.ts`，安装方读 `dist/*.js`。

## 检视技能（真实缺陷回放 / 合成缺陷注入）

仓内 `.agents/skills/` 提供两个可复跑的 **diff 检视技能**。它们不是产品运行时的一部分，也不是被检视仓库携带的规则 Skill，而是「已知真值 → 构造缺陷 diff → 真跑一次 `review-pi` → 判定并归档」的验证闭环：

| 技能 | 做什么 | 底座 / 真值 |
|---|---|---|
| `real-defect-url-injection` | 回滚真实修复补丁，让 URL 参数注入缺陷重新出现（默认 VUL4J-38 / CVE-2014-4172） | `.cache/datasets/vul4j-repos/` 的已物化快照 + `data/vul4j/materialized-cases.json` |
| `synthetic-defect-resource-leak` | 在夹具副本新增一个 `os.Open` 后不关闭文件句柄的 Go 文件（GEN-RES-001） | `packages/review-pi/testdata/repos/multilang`（默认装载 `general-code-review` 规则包） |

```bash
# 各真跑一次（真实模型、真实计费）
node .agents/skills/real-defect-url-injection/scripts/run.mjs
node .agents/skills/synthetic-defect-resource-leak/scripts/run.mjs

# 只构造 diff 与真值，不调用模型
node .agents/skills/real-defect-url-injection/scripts/run.mjs --dry-run
```

共享执行层在 `.agents/skills/_shared/review-eval.mjs`：构造 diff、调用 `review-pi`、读取 findings、按真值判定、写归档。每次运行把 `defect.diff` / `ground-truth.json` / `meta.json` / `stdout.json` / `stderr.log` / `result/`（runs + audit）/ `verdict.{json,md}` 写到仓根 `repo-diff-skill-result/<skill>/<时间戳>/`；该目录已在 `.gitignore` 中（运行留痕不入库，遵循 ADR-0033 纪律）。

两个脚本自己的参数（**不是产品 CLI 的旗标**，尤其 `--out` 与被移除的 CLI `--out` 无关）：

| 参数 | 适用 | 作用 |
|---|---|---|
| `--model <id>` | 两个 | 覆盖检视模型（缺省取 `PiAgent.jsonc` 的 `model.default`） |
| `--out <dir>` | 两个 | 覆盖归档目录（缺省 `repo-diff-skill-result/<skill>/<时间戳>/`） |
| `--dry-run` | 两个 | 只构造 diff 与真值，不调用模型 |
| `--keep-temp` | 两个 | 保留临时 fixed/defect（或 base/defect）副本，便于人工核对 |
| `--fail-on-miss` | 两个 | 未捕获真值时 `exit 2`（缺省 `exit 0`，判定写进 verdict） |
| `--case <id>` | real | 选 `data/vul4j/materialized-cases.json` 里的案件（缺省 `VUL4J-38`） |
| `--rule-skill <dir>` | real | 额外装载规则包（缺省不装，纯工具检视） |
| `--fixture <dir>` | synthetic | 换夹具仓库（缺省 `packages/review-pi/testdata/repos/multilang`） |
| `--no-rule-skill` | synthetic | 不装载 `general-code-review` 规则包 |

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/使用手册-安装与运行.md`](docs/使用手册-安装与运行.md) | 安装 / 配置逐字段 / smoke / 任意目录运行 / 并发隔离 / session 导出 / 排障 |
| [`docs/运行手册-单次检视.md`](docs/运行手册-单次检视.md) | 单次检视的旗标、前置、产物、cwd 索引与 `export`、排障 |
| [`docs/运行手册-离线回放.md`](docs/运行手册-离线回放.md) | 离线回放 / 并发阶梯：命令、全部参数、场景 schema、延迟与安全阀、报告读法、未命中排障、重录流程 |
| [`CONTEXT.md`](CONTEXT.md) | 领域词汇表（术语唯一权威） |
| [`docs/adr/`](docs/adr/) | 架构决策记录（Go / C++ 符号提取器见 ADR-0042） |
| [`docs/agents/`](docs/agents/) | agent 协作约定（issue tracker / triage labels / domain docs） |
| [`.agents/skills/real-defect-url-injection/SKILL.md`](.agents/skills/real-defect-url-injection/SKILL.md) | 真实缺陷回放：VUL4J-38 / CVE-2014-4172 的 diff 构造、真跑与归档 |
| [`.agents/skills/synthetic-defect-resource-leak/SKILL.md`](.agents/skills/synthetic-defect-resource-leak/SKILL.md) | 合成缺陷注入：GEN-RES-001 资源泄漏的 diff 构造、真跑与归档 |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | 第三方许可声明 |
