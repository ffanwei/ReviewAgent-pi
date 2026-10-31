# ReviewAgent-pi

一次 MR 检视、一条命令：读仓库快照 + 变更集（+ 可选规则 Skill），在 pi 内核上跑检视循环，产出**英文 findings**（`reviews_en.json`，结构化真源）与**中文按行分组的建议**（`reviews_tips_zh.json`，可选，由呈现引擎翻译），同时留全量审计与转录。

- 内核基座：pi 代码仓 vendor fork（`packages/{ai,agent,chord,telemetry}`，锚定 v0.85.1+11d）；Review Runtime 在 `packages/review-pi` 从 0 重写。
- 上下文策略：最小充分上下文（Minimal Sufficient Context）+ 缓存稳定循环（Cache-Stable Review Loop）——工具按需拉取，不整仓灌入。
- 检视语言：英文是测量真源，中文只做核外投影，不改变请求面。

## 功能

| 能力 | 说明 |
|---|---|
| 单次检视 | 单案 × rep-1：六阶段循环 + 七个 review 工具 + Context Ledger + 审计投影 |
| 两种变更集输入 | `--mr-diff`（标准 unified diff）或 `--mr-json`（GitCode/GitLab `/pulls/:number/files` 原样 JSON，只读每项 `new_path` 与 `diff`） |
| 规则 Skill | `--rule-skill-zip` / `--rule-skill <dir>`，**只认显式输入**（不扫描被检视仓库）；`--strict-rule-skill` 把装载失败改为 fail fast |
| 中文建议 | 配置 `presentation.engine` 后额外产出 `reviews_tips_zh.json`：`"builtin"` 用包内引擎，路径用自定义模块，`null` 关闭 |
| MR 边界护栏 | 缺省 ≤10 文件 / ≤2K 变更行；超界只告警不拒检（`limits.boundary` 可改） |
| 单源配置 | 用户级 JSONC（`~/.PiAgent/PiAgent.jsonc` 或 `--config`），启动读一次成不可变快照，审计留 digest |
| 可观测 | stdout 单 JSON 文档；stderr 诊断与 `--progress` 阶段投影；退出码 0（含诚实截断）/ 1 |

面向 Java 仓优化（角色提示词 + tree-sitter-java 符号索引）；其它语言可跑，质量不保证。

## 环境要求

- **Node ≥ 22.19**（`review-pi` 包 `engines`）。
- npm 或 pnpm；源码开发用 pnpm（`packageManager` 见 `package.json`，`corepack enable` 即可）。

## 安装

产品以六个包发行：内核四包 `@review-agent-pi/pi-{telemetry,chord,ai,agent-core}` + `review-llm` + `review-pi`（提供 `review-pi` 命令）。

```bash
npm i -g review-pi      # 全局安装
pnpm add review-pi      # 或装进项目，用 npx review-pi
```

装完先做两件事：

```bash
review-pi config init   # 生成 ~/.PiAgent/PiAgent.jsonc（已存在则拒绝，--force 覆盖）
review-pi config show   # 脱敏查看生效值（reviewer.apiKey 应为 set）
review-pi smoke         # 双探针自检：网关健康 + 模型可达；通过 exit 0
```

`config init` 生成的模板需要填入 `reviewer.apiKey`（以及需要时的 `baseUrl`）后再跑 `smoke`；`config show` 只报 `set | missing`，不回显值。

## 使用

### 1. 配置

唯一配置来源是用户级 JSONC（Linux `$HOME` / Windows `%USERPROFILE%`），`--config <path>` 可换文件；环境变量与 `.env.local` 不再读取。

```jsonc
{
  "version": 1,
  "reviewer": {
    "apiKey": "sk-...",                     // 必需
    "baseUrl": "https://api.deepseek.com",  // 可选，OpenAI 兼容网关需自带 /v1
    "maxOutputTokens": null                 // null = 自动（网关档 32768）
  },
  "model": { "default": "deepseek-v4-flash" },
  "presentation": { "engine": "builtin" }   // 中文投影：builtin / 模块路径 / null 关闭
}
```

完整键表见 [`PiAgent.example.jsonc`](PiAgent.example.jsonc)；`review-pi config show [--json]` 脱敏查看生效值与来源。

- **可配**：超时、并发、MR 边界、规则包归档上限、微限（回显 / 跳数 / 摘要截断）。
- **死钉**：轮次 5、工具调用 100、工具结果预算 8000 字符、`temperature: 0`、effort 锁档——写进配置只会得到告警。
- **失败策略**：类型 / 取值 / 版本错 fail fast（exit 1 并指出键路径）；未知键与权限过宽只告警。

### 2. 一次检视

```bash
# A. 标准 unified diff
review-pi review \
  --repo /data/snapshots/my-repo-base \
  --mr-diff /data/diffs/change-001.diff \
  --out /data/reviews/change-001

# B. 直接吃 GitCode 接口返回的文件变更 JSON
curl.exe -H "Authorization: Bearer $env:GITCODE_TOKEN" \
  "https://api.gitcode.com/api/v5/repos/OWNER/REPO/pulls/1234/files" -o MR-1234.json
review-pi review --repo D:\work\myrepo --mr-json MR-1234.json --out D:\reviews\MR-1234
```

- `--repo` 是**目录**，约定停在 diff 的 base 侧（CLI 不 apply diff）。
- `--mr-diff` 与 `--mr-json` **恰好给一个**；`caseId` = 文件名去最后一个扩展名（`MR-1234.json` → `MR-1234`）。
- PowerShell 用 `>` / `Out-File` 写 JSON 会得到 UTF-16，解析失败；用 `curl.exe -o` 或 `Set-Content -Encoding utf8`。

### 旗标

| 旗标 | 说明 |
|---|---|
| `--repo <dir>` | 仓库快照根目录（必需） |
| `--mr-diff <file>` | 统一 diff 文件（与 `--mr-json` 二选一） |
| `--mr-json <file>` | 文件变更 JSON 数组（与 `--mr-diff` 二选一） |
| `--issue <text>` | MR 描述，原样进入初始 user 消息（缺省空） |
| `--out <dir>` | 落盘根，缺省 `review-pi-output` |
| `--model <id>` | 检视模型，缺省取配置 `model.default` |
| `--config <path>` | 替代配置文件（相对 cwd） |
| `--rule-skill-zip <zip>` / `--rule-skill <dir>` | 规则 Skill 包 / 已解压目录，可重复 |
| `--rule-skill-name <name>` | 包内多 skill 时指定装载哪个 |
| `--strict-rule-skill` | 装载失败即退出（缺省降级 + 审计留痕） |
| `--progress` / `--no-progress` | 非 TTY 下把阶段摘要逐行打到 stderr |

### 3. 产物

```
<out>/
  runs/mr/<caseId>/
    rep-1.json                 RunRecord：模型、耗时、findings 计数、usage
    session-<runId>.json       检视转录（请求 / 工具 / 相位全留痕）
    rep-1/
      reviews_en.json          英文 findings（结构化真源）
      reviews_tips_zh.json     中文按行分组建议（配置了呈现引擎才有）
  audit/mr/<caseId>/rep-1/audit/
    <runId>.json               审计：请求、工具调用、相位、Context Ledger、规则 Skill 留痕
```

`runId = <时间戳>-<caseId>`。进程 cwd 另写一份下游约定名副本 `review-result.json`（与真源逐字节相同）。同一个 `--out` 重跑只保留最新 canonical 产物，审计 / 转录按 run 累积——想保留多次结果就换 `--out`。

### 4. 退出码与 stdout

- stdout 是**单个 JSON 文档**，日志与诊断一律走 stderr。
- 退出码：完成（含诚实截断）`0`，中止或错误 `1`。截断信号在 JSON 的 `truncated=true`，不体现在退出码。
- 真实网关调用只在本机按需执行，CI 恒离线。

## 从源码开发

```bash
pnpm install
pnpm build:pi                                    # 内核四包，拓扑序
pnpm --filter review-llm build
pnpm --filter review-pi build                    # dist/cli/main.js 是 bin 的 spawn 目标
pnpm build:presentation                          # 呈现引擎 → packages/review-pi/presentation/
```

- **新鲜度门**：bin 会检查内核与自身 dist 的 mtime，陈旧直接拒跑，不自动重编——改完源码必须重建。
- 仓内开发 = 安装形态：源码 specifier 就是发布名（`@review-agent-pi/*`），`exports.source` 条件让 vitest / typecheck 读 `src/*.ts`，安装方读 `dist/*.js`。

测试与打包：

```bash
pnpm test                                        # 根包（呈现层）
pnpm --filter review-pi test                     # 检视链内核 + CLI 进程烟测
pnpm typecheck                                   # 根包类型检查
pnpm build:dist                                  # 发行全量构建
pnpm pack:packages                               # 六个 tarball → .artifacts/tarballs/
pnpm verify:pack                                 # 离线安装布局冒烟（不联网、不发布）
```

仓库布局：

```
packages/review-pi/       检视运行时 + CLI（六阶段循环、七工具、规则 Skill、审计、呈现投影装配）
packages/review-llm/      LLM 接入共享缝（provider 参数画像与常量单源）
packages/{ai,agent,chord,telemetry}/   pi 内核 vendor 基座
src/presentation/         核外呈现层（中文翻译投影 / 分组意见映射）
scripts/                  构建、打包、安装面验证
docs/                     ADR、设计与使用文档
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/使用手册-安装与运行.md`](docs/使用手册-安装与运行.md) | 安装 / 配置逐字段 / smoke / 任意目录运行 / 并发隔离 / 排障 |
| [`docs/运行手册-单次检视.md`](docs/运行手册-单次检视.md) | 单次检视的旗标、前置、产物与排障 |
| [`CONTEXT.md`](CONTEXT.md) | 领域词汇表（术语唯一权威） |
| [`docs/adr/`](docs/adr/) | 架构决策记录 |
| [`docs/agents/`](docs/agents/) | agent 协作约定（issue tracker / triage labels / domain docs） |
| [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md) | 第三方许可声明 |
