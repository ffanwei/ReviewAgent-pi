# large-MR 端到端检视 + MCP 前端（e2e-mcp）

真实的 `review-pi review` 跑一个 **改动 >1000 行**的 MR，同时连一个**真实的 HTTP
MCP server**（带浏览器展示页），用来验证 ADR-0061 的「summary 之前每个改动文件
都必须上报一次 `mrReviewResult`」在生产形态下成立。

和 `scripts/offline-replay/` 的分工：

- 本目录负责**真模型 + 真 MCP** 的端到端跑通（每次结果都可能不同）；
- 跑出来的这次真实调用另录成离线回放 trace（`large-mr` 场景），后续
  `pnpm test:replay` 用冻结字节复跑，不再调模型。

## 文件

| 文件 | 作用 |
|---|---|
| `make-large-mr.mjs` | 由 `before/` 骨架 + 最终态仓库生成统一 diff，并自检行数与 `git apply` 往返 |
| `server.mjs` | 真实 MCP server：JSON-RPC `initialize` / `tools/list` / `tools/call`，外加状态 API 与 SSE |
| `dashboard.html` | 零依赖展示页（SSE 实时刷新：覆盖计数、调用顺序、每文件意见、总结、事件时间线、原始报文） |
| `run-e2e.mjs` | 注入临时配置 → 起检视 → 读 server 状态与 `runs/` 产物 → 断言 |

## 夹具

- `packages/review-pi/testdata/repos/large-mr/**`：最终态仓库（9 文件：C++ / Go /
  Python / Java / TypeScript + `README.md` + `pom.xml`），埋了多类缺陷。
- `packages/review-pi/testdata/e2e/large-mr/before/**`：同路径的改动前骨架。
- `packages/review-pi/testdata/e2e/large-mr.diff`：两者的统一 diff（9 文件 /
  1216 增加行）。**不要手改**，改完两侧快照后重新生成：

```bash
node scripts/e2e-mcp/make-large-mr.mjs            # 重新生成 diff + 自检
node scripts/e2e-mcp/make-large-mr.mjs --check-only  # 只校验现有 diff 是否与快照一致
```

生成器用临时 git 仓做 `git diff --cached`，并在 Windows 上固定
`-c core.autocrlf=false -c core.eol=lf`，保证往返字节一致。

## 参数

三个脚本都是仓内验证工具（**不是** `review-pi` 的产品旗标）：

| 脚本 | 参数 | 缺省 | 作用 |
|---|---|---|---|
| `make-large-mr.mjs` | `--check-only` | 关 | 只校验现有 diff 与两侧快照一致，不重写文件 |
| `server.mjs` | `--port <n>` | `7317`（或 `E2E_MCP_PORT`） | 监听端口 |
| | `--host <addr>` | `127.0.0.1` | 监听地址（默认只本机可达） |
| `run-e2e.mjs` | `--server-url <url>` | `http://127.0.0.1:7317` | 已运行的 MCP server 地址 |
| | `--task-id <id>` | `e2e-large-mr-<ISO 时间戳>` | 本次任务 id（本地目录名 + 远端任务标识同值） |

`run-e2e.mjs` 需要 `~/.PiAgent/PiAgent.jsonc` 里已有可用的 `reviewer.apiKey` 与
`model.default`（只读，不打印、不改写）；`mcp.servers.e2e` 与事件 tool 由脚本注入
临时配置。跑前先 `pnpm build:presentation`，否则 bin 的新鲜度门会拒跑。

## 起 server

```bash
node scripts/e2e-mcp/server.mjs --port 7317
```

- 展示页：<http://127.0.0.1:7317/>
- 健康检查：`GET /api/health`，状态快照 `GET /api/state`

`POST /api/reset` 清空状态，`POST /api/expect { files, taskId, caseId }` 声明本次
应覆盖的文件列表（展示页据此算缺失项）。server 不落盘、不联网，退出即清空。

## 跑 e2e

```bash
pnpm build:presentation          # e2e 跑的是 dist 里的 CLI
node scripts/e2e-mcp/run-e2e.mjs  # 需要 server 已在 7317 监听
```

`run-e2e.mjs` 会：

1. 读用户配置 `~/.PiAgent/PiAgent.jsonc`，把 `mcp.servers.e2e` 与
   `mcp.report = { server: "e2e", tool: "report_events" }` 注入一份**临时配置**
   `.tmp-gen/e2e-large-mr/PiAgent.e2e.jsonc`（gitignored，含用户密钥，绝不提交）；
2. 调 `POST /api/reset` + `POST /api/expect`；
3. 以 `--repo testdata/repos/large-mr --mr-diff testdata/e2e/large-mr.diff
   --rule-skill-zip testdata/rule-skills/general-code-review.zip` 起真实检视；
4. 跑完对照三份证据：server 内存状态、`runs/mcp.json`、`runs/reviews_en.json`。

### 断言口径（ADR-0061）

- 调用顺序必须是 `startTask → mrReviewResult × N → saveReviewSummary → endTask`；
- diff 里的**每个**文件都有一条 `mrReviewResult`，不重复、不多不少；
- 没有意见的文件也照发，`reviewTips: []`（空包不得省略）——server 把这类文件
  计入 `counts.emptyFiles`；
- `runs/mcp.json` 的调用条数与 server 收到的条数一致，且无失败调用；
- `saveReviewSummary.markdownContent` 非空；
- server 侧「顺序违规」列表为空（`startTask` 之前 / `endTask` 之后再来业务调用
  都会被记录）。

全部通过打印 `e2e assertions PASSED`，否则逐条列出失败原因并以退出码 1 结束。

## 产物

全部落在 `.tmp-gen/e2e-large-mr/`（gitignored）：

```
PiAgent.e2e.jsonc           # 临时配置（含密钥，勿提交）
stdout.log / stderr.log     # 检视进程原始输出
tasks/<taskId>/runs/mcp.json
tasks/<taskId>/runs/reviews_en.json
tasks/<taskId>/runs/reviews_tips_zh.json
tasks/<taskId>/runs/review-pi.log
```

`<taskId>` 由 `--task-id` 指定，缺省按时间戳生成；同一次运行的 taskId 会同时
出现在展示页与 `runs/mcp.json` 里，便于对照。

## 冻结成离线回放

这次真实调用录成 `packages/review-pi/testdata/traces/large-mr.json`
（`scripts/offline-replay/scenarios/large-mr.json`，场景 id `large-mr`）。录制与
重录细节见 [`packages/review-pi/testdata/traces/README.md`](../../packages/review-pi/testdata/traces/README.md)。
注意场景把 `timeouts.oneShotMs` 放大到 600s：报文生成单次可输出 1.6 万 tokens，
产品缺省 300s（ADR-0062）在慢网关下仍可能不够；录制期一旦超时中断，代理却收全
落盘，回放就会与录制分叉（录制走二分重试、回放走全量一次）。
