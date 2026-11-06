# Spec: 用户级运行配置 `~/.PiAgent/PiAgent.jsonc`（JSONC）

Status: **ready-for-human**（设计已收口，待用户批准后拆 issue 与动代码）
Date: 2026-10-31
Supersedes: ADR-0019（`--env` 凭据文件旗标）

## 0. 决策来源（已钉，不再问）

| # | 决策 |
|---|---|
| 文件 | `~/.PiAgent/PiAgent.jsonc`；Linux 读 `$HOME`，Windows 读 `%USERPROFILE%`；**JSONC**（注释 + 尾逗号） |
| 秘密 | API key 写进该文件（明文，权限 0600，绝不回显、绝不入产物） |
| 可配范围 | B 资源/运维 + C MR 边界 + 微限全部；**A 档死钉** |
| 模型 | (c) 默认 id + baseUrl；**序列化方言死钉** |
| 失败策略 | 类型/取值错 fail fast；未知键警告继续；权限宽于 0600 警告继续 |
| 环境变量 | **彻底禁**：任何 `REVIEWER_*` / `DEEPSEEK_*` / `REVIEW_PI_*` 都不再被读取 |
| 旗标 | `--env` 移除；`--config <path>` 新增；**不做项目级配置**；不设 `PIAGENT_CONFIG` |
| 读法 | 启动读一次 → 不可变快照 → 显式穿参（不用全局单例、不回写环境变量） |
| 留痕 | 审计文件记全量生效值 + 来源 + `configDigest`；stdout 键集不变 |
| CLI | `config init` / `config show` / `config init --from-env <file>` |

## 1. 路径解析

```
--config <path>            最高优先（相对路径按进程 cwd 解析）
否则  <home>/.PiAgent/PiAgent.jsonc
      <home> = process.env.HOME (POSIX) | process.env.USERPROFILE (Windows)
```

- `<home>` 缺失或空白 ⇒ **fail fast**，提示改用 `--config`。**不**回落 `os.homedir()`
  （可能落到 `/root` 或 `/`，写出谁都找不到的配置）。
- 这是全仓**唯一**被读取的环境变量（两个路径原语）。它不承载任何配置值，
  也不构成覆盖层；`--config` 完全绕开它。
- 默认路径不存在 ⇒ 不报错，等价于「全缺省」；但 `reviewer.apiKey` 缺省为空，
  因此 `review`/`smoke` 会在启动期 fail fast（见 §5）。`config show` / `config init`
  在无文件时正常工作。

## 2. 文件形状

```jsonc
{
  "$schema": "https://example.invalid/piagent.schema.json", // 可选，纯编辑器提示，不抓取
  "version": 1,                                             // 必填，缺失/≠1 = fail fast

  "reviewer": {
    "apiKey": "sk-...",                       // 必填（review/smoke 运行期）；秘密，绝不回显
    "baseUrl": "https://api.deepseek.com",    // 缺省官方直连；必须是 http(s)，尾斜杠归一
    "maxOutputTokens": null                   // null = 自动：官方直连不发 max_tokens；网关发 32768
  },

  "model": {
    "default": "deepseek-v4-flash",           // --model 缺省值
    "presentation": null                      // null = 跟随本次检视模型（ADR-0021）
  },

  "presentation": {
    "engine": "builtin"                       // 默认：制品自带引擎；null = 恒等直通（不产中文）
  },

  "limits": {
    "timeouts": { /* 见 §3.1 */ },
    "concurrency": { "suggestion": 4 },
    "boundary": { "maxFiles": 10, "maxDiffLines": 2000 },
    "archive": { /* §3.4 */ },
    "micro": { /* §3.5 */ }
  }
}
```

**单位**：所有时间一律**毫秒整数**（注释里写人类可读等价）。解析器不做 `"10m"` 之类的
单位魔法——字符串解析是 bug 温床。

**`null` 语义**：
- `reviewer.maxOutputTokens: null` = 自动判档（今天的缺省行为）。
- `model.presentation: null` = 跟随检视模型。
- `presentation.engine: null` = 不投影（整段省略同此）；`config init` 生成的模板默认写 `"builtin"`。
- `limits.boundary.*: null` = **该维度不设界**（永不因此维度告警）；两个都 `null` = 边界护栏整体停用。
- 其余键**不接受 `null`**；「没写」= 用缺省，「写了 null」= 显式关闭，两者在审计里可区分。
- 数字键 `0` 一律非法（超时与字数上限语义不同，混用必出事故）；唯一例外
  `limits.timeouts.presentationBufferMs` 允许 `0`。

## 3. 键表（全部键 + 缺省 + 取值域）

字节面分类：`WIRE` = 进模型可见请求；`AUD` = 进审计/记录；`OPS` = 只影响时长/并发；`DISP` = 只进 stderr。

### 3.1 `limits.timeouts`（全 OPS）

| 键 | 缺省 | 域 | 消费点 |
|---|---|---|---|
| `skillPassMs` | 600000 | 1000…3600000 | `knowledge/skill-pass.ts:140`（`options.timeoutMs` 缝已在） |
| `skillBashMs` | 120000 | 1000…600000 | `tools/skill-bash.ts:313`（缝已在） |
| `ruleSkillExtractMs` | 30000 | 1000…600000 | `knowledge/rule-skill.ts:59`（`limits.timeoutMs` 缝已在） |
| `ripgrepMs` | 30000 | 1000…600000 | `codeintel/rg.ts:31,37,75`（缝已在，调用方未传） |
| `probeHealthMs` | 15000 | 1000…120000 | `provider/gateway-probe.ts:27`（缝已在） |
| `probeModelMs` | 120000 | 10000…600000 | `provider/gateway-probe.ts:28`（缝已在） |
| `presentationRequestMs` | 90000 | 1000…3600000 | 单条翻译/建议请求超时 **且** `presentation-projection.ts` 每字段预算（合并两处同值常量，消漂移） |
| `presentationBufferMs` | 30000 | 0…3600000 | `presentation-projection.ts:134` |

总超时公式保持不变：`(字段数 + ceil(findings / suggestion 并发)) × presentationRequestMs + presentationBufferMs`。

### 3.2 `limits.concurrency`

| 键 | 缺省 | 域 | 消费点 |
|---|---|---|---|
| `suggestion` | 4 | 1…16 | `src/presentation/engine-zh.ts:81` 与 `cli/presentation-projection.ts:136`（两份重复定义合并为一份配置值） |

### 3.3 `limits.boundary`（AUD）

| 键 | 缺省 | 域 | 说明 |
|---|---|---|---|
| `maxFiles` | 10 | 1…10000 或 `null` | `>` 即 `too-many-files` 降级 |
| `maxDiffLines` | 2000 | 1…1000000 或 `null` | `>` 即 `diff-too-large` 降级 |

**告警文案必须由值派生**（当前 `DOMAIN_WARNING_OUT_OF_BOUNDARY` 硬编码 `files>10 or diff>2K`，
与常量各改各的）。派生规则（缺省下逐字节等价今天）：

```
both:      out-of-validated-domain (files>10 or diff>2K)
filesOnly: out-of-validated-domain (files>10)
diffOnly:  out-of-validated-domain (diff>2K)
```

`2000 → "2K"`（整千用 `K`，否则原样数字）。两个都 `null` ⇒ 护栏不判界、不产告警、审计 `mrBoundary` 缺席。

### 3.4 `limits.archive`（OPS + AUD 降级文案）

| 键 | 缺省 | 域 |
|---|---|---|
| `maxArchiveBytes` | 8388608（8 MiB） | 1…1000000000 |
| `maxEntries` | 2000 | 1…100000 |
| `maxTotalUncompressed` | 67108864（64 MiB） | 1…10000000000 |
| `maxCompressionRatio` | 100 | 1…10000 |

### 3.5 `limits.micro`

| 键 | 缺省 | 域 | 面 | 消费点 |
|---|---|---|---|---|
| `skillBashOutputChars` | 256000 | 1…10000000 | WIRE | `tools/skill-bash.ts:55,459,462`（需新 option） |
| `packageHeadBytes` | 8192 | 1…1048576 | WIRE | `zoneb/repo-context.ts:19,94` |
| `queryEchoChars` | 120 | 1…10000 | WIRE | `tools/search-tools.ts:188,191` |
| `callChainHops` | 2 | 1…3 | WIRE | `tools/search-tools.ts:106,108` + `zoneb/call-chain.ts`（**真实遍历深度**，不是只改文案——否则文案说谎） |
| `toolNameChars` | 60 | 1…10000 | WIRE | `tools/toolkit.ts:119`（未知工具错误文案里的名字截断） |
| `argumentsSummaryChars` | 80 | 1…10000 | DISP | `tools/tool-arguments.ts:20,37`（只进 stderr 进度行，不进审计） |
| `progressDetailChars` | 120 | 1…10000 | DISP | `tools/tool-progress.ts:20,75` |

> `callChainHops` 是唯一需要改**行为遍历**的微限（现状 hop1 引用者 + hop2 引用者的引用者）。
> 建议单独一刀（C3b），不混进纯穿参提交。

### 3.6 模型段

| 键 | 缺省 | 说明 |
|---|---|---|
| `model.default` | `deepseek-v4-flash` | `--model` 缺席时用它；CLI 显式 `--model` 仍最高优先 |
| `model.presentation` | `null`（= 跟随检视模型） | 旧 `REVIEW_PI_PRESENTATION_MODEL` |
| `reviewer.baseUrl` | `https://api.deepseek.com` | 旧 `REVIEWER_URL` |
| `reviewer.apiKey` | 无（运行期必填） | 旧 `REVIEWER_API_KEY` |
| `reviewer.maxOutputTokens` | `null` | 旧 `REVIEWER_MAX_TOKENS`；`null` 时官方直连不发、网关发 32768 |
| `presentation.engine` | `"builtin"`（模板默认；省略 = null） | 旧 `REVIEW_PI_PRESENTATION_ENGINE` |

模型画像只有内置目录（3 条）。目录外 id 拿 flash 模板只覆写 `id`，`contextWindow` /
`maxTokens` / `cost` 全部按 flash 计——**不提供用户侧元数据覆盖**（2026-10-31 修订
删除 `models{}`；成本数字对目录外 id 仅供参考）。序列化方言（`id` / `api` / `provider` /
`compat` / `thinkingFormat` / `thinkingLevelMap` / `reasoning` / `baseUrl`）仍钉死在代码里，
配置文件里没有缝。

## 4. 死钉（不可配，出现即 fail fast）

| 项 | 值 | 位置 |
|---|---|---|
| 最大轮次 | 5 | `loop/constants.ts:4` |
| 单 run 工具调用上界 | 100 | `loop/constants.ts:10` |
| 单次工具结果预算 | 8000 字符 | `tools/result-budget.ts:11` |
| 呈现 `temperature` | 0 | `src/presentation/engine-zh.ts:390` |
| effort 锁档 | 标签 `default` / 线上 `reasoning_effort: "high"` | `provider/pi-client.ts:27,29` |
| skill bash 子进程环境白名单 | 13 个变量 | `tools/skill-bash.ts:38-52` |
| 序列化方言 | provider 恒 deepseek、compat/thinkingFormat/maxTokensField | `provider/pi-client.ts` + 内置目录 |
| 截断原因与预算文案 | `MAX_ROUNDS_REACHED` 等 | `loop/constants.ts` |
| 工具名 | `bash` | `tools/skill-bash.ts:29` |
| 退出兜底 | 8000 ms | `cli/main.ts:341` |

配置文件里出现这些键（如 `limits.micro.toolResultBudgetChars`、`limits.boundary.*` 之外的
`loop.maxRounds`）按**未知键警告继续**处理——不报错，但会明确提示「该项已钉死，不会被采用」。

## 5. 校验、错误与警告

**fail fast（exit 1，人话，指出键路径与期望）**

| 场景 | 文案骨架 |
|---|---|
| 文件不是合法 JSONC | `PiAgent.jsonc: parse error at line N, column M: <msg>` |
| `version` 缺失 / ≠ 1 | `PiAgent.jsonc: version must be 1 (got …)` |
| 类型错 | `PiAgent.jsonc: limits.timeouts.skillBashMs must be an integer (got string)` |
| 越界 | `PiAgent.jsonc: limits.concurrency.suggestion must be in 1…16 (got 0)` |
| `--config` 指向的文件不存在 | `review-pi: --config 指定的文件不存在（<abs>）` |
| `--config` 指向目录/不可读 | `review-pi: 无法读取配置文件（<abs>）：<cause>` |
| 运行期缺 key | `review-pi: 配置中缺少 reviewer.apiKey（环境变量已不再被读取）——先跑 review-pi config init` |

**警告继续（stderr，一行一条，不改退出码）**

| 场景 | 文案骨架 |
|---|---|
| 未知键 | `PiAgent.jsonc: unknown key limits.boundary.maxFile (did you mean maxFiles?)` |
| 权限过宽（仅 POSIX） | `PiAgent.jsonc: 权限 0644 宽于 0600（文件含秘密）；建议 chmod 600 <path>` |
| cwd 有 `.env.local` | `review-pi: 已不再读取 .env.local（本版配置见 --config 或 ~/.PiAgent/PiAgent.jsonc）；迁移：review-pi config init --from-env .env.local` |

最近键提示：对全部已知键做编辑距离 ≤2 的匹配，只用于**未知键**提示（不用于禁配字段）。

## 6. 生效顺序

```
--model（CLI）        >  model.default（文件）  >  deepseek-v4-flash
--config（CLI）       >  <home>/.PiAgent/PiAgent.jsonc        （无第二层合并）
其余一切              >  文件（有值）/ 内置缺省（无值）
```

- **没有环境变量层**。这是本 ADR 与「env 高于文件」的旧直觉的正式分道。
- 快照在 `main()` 内构造一次（`ResolvedConfig`），之后只读；**不**写回 `process.env`。
- 消费者拿到的永远是同一个不可变对象，不在请求期重读文件（杀掉 `REVIEWER_MAX_TOKENS`
  那种「每次请求重读 env」的路径）。

## 7. 审计快照（只进审计文件，stdout 键集不变）

审计 JSON 顶层新增 `config`（`<out>/<experimentId>/audit/.../<ts>-<caseId>.json`）：

```jsonc
"config": {
  "path": "C:\\Users\\Li\\.PiAgent\\PiAgent.jsonc",
  "version": 1,
  "digest": "3f9c2a1b7d40",
  "values": {                                  // 全量生效值（非秘密），扁平点分键
    "reviewer.baseUrl": "https://…",
    "reviewer.maxOutputTokens": null,
    "model.default": "deepseek-v4-flash",
    "limits.timeouts.skillPassMs": 600000,
    "…": "…"
  },
  "overridden": ["reviewer.baseUrl", "presentation.engine"],  // 来源 = 文件（其余为缺省）
  "secret": { "reviewer.apiKey": "set" }       // 只记是否设置；不记值、不记长度
}
```

- `digest` = `sha256(canonicalJson(values))` 前 12 位十六进制。`values` 含缺省，
  因此 CLI 升级改变缺省值也会改变 digest（这是**配置指纹**，不是文件哈希）。
- `config` 键**恒在**（本次决策下成功 run 必有配置文件）。
- `RunRecord` / stdout / `reviews_en.json` 一律不加字段。

## 8. CLI 面

```
review-pi review --repo <path> --mr <diff> [--issue] [--out] [--model <id>] [--config <path>] …
review-pi smoke [--model <id>] [--config <path>]
review-pi config init [--force] [--from-env <file>] [--config <path>]
review-pi config show [--json] [--config <path>]
```

- `--env` ⇒ 确定报错：`--env 已移除（改用 --config <file> 或 ~/.PiAgent/PiAgent.jsonc）`。
- `config init`：写带注释的缺省 JSONC（含全部键与注释），POSIX 下 `0600`；
  已存在且无 `--force` ⇒ 拒绝覆盖（退出 1）。父目录自动创建。
- `config init --from-env <file>`：读一次 env 文件（**不是**进程环境），映射见 §9；
  未识别键（`JUDGE_*` / `GITHUB_TOKEN`）只报一行「已丢弃」。
- `config show`：逐键打印 `值  (file|default)`；`reviewer.apiKey` 只打印 `set|missing`；
  末行 `digest`。`--json` 输出与审计 `config` 同形（不含 `secret` 之外的真值）。
  文件非法 ⇒ exit 1；`apiKey` 缺失 ⇒ 正常显示并 exit 0（诊断命令不该因半成品文件失败）。

## 9. `.env.local` 迁移映射（一次性）

| 旧键 | 新位置 | 备注 |
|---|---|---|
| `REVIEWER_API_KEY` | `reviewer.apiKey` | 主 |
| `DEEPSEEK_API_KEY` | `reviewer.apiKey` | 仅当主缺失 |
| `REVIEWER_URL` / `DEEPSEEK_URL` | `reviewer.baseUrl` | 前者优先；校验 http(s)、尾斜杠归一 |
| `REVIEWER_MAX_TOKENS` | `reviewer.maxOutputTokens` | 非法数字 ⇒ 迁移期**报错**（不再静默忽略） |
| `REVIEW_PI_PRESENTATION_ENGINE` | `presentation.engine` | 相对路径按**写入时的 cwd** 解析成绝对路径再写 |
| `REVIEW_PI_PRESENTATION_MODEL` | `model.presentation` | |
| `JUDGE_API_KEY` / `JUDGE_URL` / `GITHUB_TOKEN` | — | 本仓无消费者，丢弃 + stderr 一行 |

迁移后 `.env.local` 保留由用户自行删除；仓库不再读它。`shared/env-local.ts` 的
**装载器**删除，只保留纯解析函数给 `--from-env` 用（不再写 `process.env`）。

## 10. 穿参改造（不可变快照 → 显式参数）

一层值对象贯穿，避免逐数字加参数：

```ts
interface ResolvedConfig {           // shared/config.ts
  version: 1;
  reviewer: { apiKey: string; baseUrl: string; maxOutputTokens: number | null };
  model: { default: string; presentation: string | null };
  presentation: { engine: string | null };
  limits: Limits;
  path: string;
  overridden: readonly string[];
  digest: string;
}
```

| 层 | 改动 |
|---|---|
| `cli/args.ts` | `--env` → 专用错误；加 `--config`；`model` 改可选（缺省来自配置）；新增 `config` 子命令解析 |
| `cli/main.ts` | 解析 → 载配置（唯一落点）→ `.env.local` 提示 → 分发；`resolveReviewerEndpoint(config.reviewer)` → `resolveReviewerEndpointFromConfig`（不再读 env） |
| `run/review-run.ts` | `ReviewRunInput` 新增 `runtime?: { limits, config }`；透传给 guard / toolkit / rule-skills / loop |
| `run/mr-boundary-guard.ts` | `guardMrBoundary(diff, limits?)`；告警文案由值派生 |
| `tools/toolkit.ts` | `BuildReviewToolkitOptions` 增加 `micro` + `ripgrepMs`，下传 repo-context / search-tools / boundedToolName |
| `tools/skill-bash.ts` | 新增 `maxOutputChars` option（进 `spawnCapture`） |
| `knowledge/skill-pass.ts` | 已有 `timeoutMs`；调用方补传 |
| `knowledge/rule-skill.ts` | 已有 `limits`；调用方补传 |
| `loop/agent-review-loop.ts` | 只补 skillPass 的 `timeoutMs` + bash `timeoutMs`；**A 档不动** |
| `provider/pi-client.ts` | `maxTokensFor(baseUrl, configured: number \| null)`；`reviewModelOf(id, baseUrl)` |
| `cli/presentation-projection.ts` | 去 `process.env`：`isPresentationProjectionConfigured(enginePath)`；`applyPresentationProjection(source, { enginePath, runtime, timeoutMs })` |
| `src/presentation/engine-zh.ts` | 去 `process.env`：从 `source.runtime` 取 endpoint/key/model/并发/超时 |

`src/presentation` 改动后必须 `pnpm build:presentation`；内核改动后 `pnpm --filter review-pi build`（进程测试跑 `dist`）。

## 11. 测试改造

### 11.1 进程测试（22 条，`cli/bin.process.test.ts`）

根本问题：`runBin` 只覆盖显式 `env`，**`HOME`/`USERPROFILE` 透传真实值**——用户级配置一旦落地，
本机 `~/.PiAgent/PiAgent.jsonc` 会静默改掉全部 22 条用例。

修法（上线前置条件）：

1. `runBin` 每例在 temp cwd 写一份最小配置（`version` + `reviewer`），并**总是**传 `--config <tmp>`；
2. 同时把 `HOME` / `USERPROFILE` 指到 temp cwd（双保险，防止漏传）；
3. `--env` 相关 3 条（`--env` 单文件、缺失、目录）改为 `--config` 等价用例；
4. 剩余 19 条断言**零改动**——它们只该看到「缺省 = 今天」。

### 11.2 零漂移回归（必须先立）

改造前（C1）先用现有代码抓一份 `testdata/golden/wire-baseline.json`：
一次进程跑的全部 `wireBody` 序列 + 关键审计字段。C3/C4 之后断言
「文件只含 `version` + `reviewer`（不含任何 limits）⇒ 序列与 baseline 逐字节相等」。

### 11.3 单元测试影响

| 文件 | 处理 |
|---|---|
| `shared/env-local.test.ts` | 删；换成 `shared/env-file.test.ts`（纯解析，不改 `process.env`） |
| `cli/args.test.ts` | `--env` 4 条改写；补 `--config` 与 `config init/show` 解析 |
| `run/mr-boundary-guard.test.ts` | 签名 + 派生文案；10/2000 仍断言原字节 `files>10 or diff>2K` |
| `provider/pi-client.test.ts` | `maxTokensFor` 新签名；「非法字符串静默忽略」用例删除（改为配置层 fail fast 用例） |
| `cli/presentation-projection.test.ts` | `env` 注入 → `enginePath` 选项 |
| `tests/presentation/engine-zh.test.ts` | 构造 `runtime`；`temperature === 0` 断言保留（死钉） |
| `loop/agent-review-loop.test.ts` | 不动（A 档常量仍被直接断言） |
| `tools/toolkit.test.ts` | 补 micro 覆盖；`DEFAULT_TOOL_RESULT_BUDGET_CHARS === 8000` 保留 |
| 新增 `shared/config.test.ts` | 解析/校验/合并/digest/路径/未知键/权限 |
| 新增 `cli/config.process.test.ts` | `init` 写盘与权限、`--force`、`--from-env`、`show` 脱敏、非法文件 exit 1 |

`testdata/golden/*` 的提示词/工具 schema **不变**（limits 不进 schema 字节）。

## 12. 文档改造

| 文件 | 改动 |
|---|---|
| `docs/adr/0025-*.md` | 新增（草案见 `adr-0025-draft.md`） |
| `docs/adr/0019-env-file-flag.md` | 头部加 `状态：已废止（ADR-0025）` |
| `README.md` | §凭据配置整节重写为「运行配置」；构建前置、`.env.local` 行、目录表同步 |
| `docs/运行手册-单次检视.md` | 删 `--env` 行；新增 `--config` / `config init/show`；凭据段重写；排障表（缺 key / 未识别配置 / 权限）重写；架构流程图改「配置装载」 |
| `CONTEXT.md` | 新增「运行配置」；重写「测量常量面」；改「检视模型」「翻译投影」两节的环境变量描述 |
| `.env.empty` | 删除，换成入库的 `PiAgent.example.jsonc`（`config init` 的模板同源） |
| `AGENTS.md` | 无需改（不含配置描述） |

## 13. 提交切分

| # | 内容 | 绿线 |
|---|---|---|
| C1 | `shared/config.ts`（JSONC 解析/校验/合并/digest/路径）+ 单测 + `wire-baseline.json` 抓取 + 新依赖 `jsonc-parser` | typecheck + test |
| C2 | CLI 面：`--config`、`--env` 移除、`config init/show`、`main.ts` 装载、`.env.local` 提示、删 env-local 装载器 | 进程测试全绿（含新 `--config` 用例） |
| C3 | 穿参 C + B：boundary、archive、toolkit micro、skill/bash/rg/probe/presentation 超时与并发 | 零漂移回归绿 |
| C3b | `callChainHops` 真实遍历深度（可选拆出） | 单测 |
| C4 | presentation 去 env（engine runtime 注入） | `build:presentation` + 测试 |
| C5 | 审计 `config` 快照 + digest | 审计断言 |
| C6 | 文档 + ADR-0025 + 删 `.env.empty` | 全仓 grep 归零 `REVIEWER_`/`REVIEW_PI_`/`.env.local`（历史文档除外） |

## 14. 风险与未决

1. **新依赖**：`jsonc-parser`（Microsoft，零依赖）。备选是手写去注释/尾逗号，但字符串内
   `//`、`/*`、转义与 BOM 的边界多，不建议。**需你批准**。
2. **`callChainHops` 需要改遍历**（不是只改文案）。可延后到 C3b；若你希望首批零行为改动，
   我建议本批**钉死为 2**，只在 ADR 里记「未开放」。
3. **`.env.local` 检测**：只 `stat` cwd 一个路径，成本可忽略；不做任何 env 变量探测
   （保持「全禁 env」的字面纪律）。
4. **`config show` 打印绝对路径**：与本机 pnpm build 路径同类的本地信息，仅 stderr/stdout 诊断，不入审计以外的地方。
5. **幂等**：配置文件读到一次后不再重读；长跑进程里改文件不生效（明确写进 ADR）。
