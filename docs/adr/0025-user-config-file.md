# 0025. 运行配置迁到用户级 JSONC（`~/.PiAgent/PiAgent.jsonc`），`--env` 退出，测量常量面重新定义

**状态**：已接受（2026-10-31，用户经 grill 逐项决策；实现分 6 个提交落地）
**关联**：ADR-0009（pi 内核从 0 重写）、ADR-0010（语言钉英文 + 核外翻译）、ADR-0016（进度投影与冻结键集）、ADR-0021（呈现模型跟随检视模型）、ADR-0024（删除配置矩阵；本 ADR 在其后重建**唯一一层**运行配置）
**废止**：ADR-0019（`--env <file>` 凭据文件旗标）、ADR-0024「无 `--config` 旗标」一条
**跨仓**：本 ADR 为本仓 pi 线序列 0025；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
**后续修订**：[ADR-0026](0026-config-surface-engine-and-endpoint-tier.md)（配置面：`presentation.engine` 相对路径改锚**配置文件所在目录**、新增 `"builtin"` 哨兵、官方/网关判档归一化为单源、模板去 `$schema`、`presentationBufferMs` 允许 `0` 的例外写明、缺配置一行提示）与 [ADR-0027](0027-runs-layout-and-rule-skill-trust.md)（产物面：`runs|audit/mr/<caseId>` 去实验标识层、cwd 只写 `review-result.json`、审计快照家目录归一为 `~/...`、规则包只认显式输入、配置目录 `0700` / 文件 `0600`）。本 ADR 的其余决策（唯一配置文件、JSONC、键表与类型校验、`config init/show`、测量常量面收窄）继续有效。
**修订（2026-10-31，实现期）**：默认文件名由 `PiAgent.json` 改为 **`PiAgent.jsonc`**——文件名与内容形态（JSONC：注释 + 尾逗号）一致，避免编辑器把注释判成非法 JSON。语义不变：内容形态、键表、校验、`config init/show` 行为与默认路径都只换了扩展名；`--config <path>` 仍接受任意路径，扩展名不参与判定。发布前改名，无存量用户文件需迁移。
**修订（2026-10-31，实现期）**：**删除模型元数据覆盖面 `models{}`**（连同 `ModelOverride`、`reviewModelOf` 的 overrides 形参与 `ReviewRuntime.models`）。配置面只保留 `reviewer` / `model` / `presentation` / `limits` 四段。后果：目录外模型 id 一律沿用 `deepseek-v4-flash` 画像（`contextWindow` / `maxTokens` / `cost` 均按 flash），成本数字仅供参考；旧配置文件里的 `models` 键降级为 `unknown key models` 警告（不阻断）。本文 Context 第 3 条动机、Decision 3 可配清单中的「模型元数据」一条、Decision 5 的 `ReviewRuntime` 组成、Consequences 中「第三方网关元数据可补全」一条随之失效。

## Context

ADR-0024 之后，运行配置面是**仓库内**的 `.env.local`（cwd 相对；`--env` 可指定替代路径，ADR-0019）加十几处硬编码常量：

- 秘密（`REVIEWER_API_KEY`）与端点（`REVIEWER_URL`）落在**工作树里**的文件中，误提交/误打包的风险高于用户 home；
- 超时、并发、MR 边界、规则包归档上限、若干文本截断上限全是模块级常量，用户无旋钮；
- 模型元数据只有 vendored pi 的 3 条内置 JSON 目录，接第三方网关（`ep-xxx`）时 `contextWindow` / `maxTokens` / `cost` 全错，成本估算失真（此动机对应的 `models{}` 覆盖面已在 2026-10-31 修订中删除）；
- 呈现引擎的开关/模型靠 `REVIEW_PI_PRESENTATION_*` 环境变量，与「配置应可审计」相悖；
- `REVIEWER_MAX_TOKENS` 是唯一「每次请求重读 `process.env`」的路径，配置在请求期可变，产物无法反查是在什么设置下生成的。

ADR-0024 刚把「配置作为实验自变量」删掉，因此这次**不能**再把旋钮做成 CLI 旗标或实验维度；需要的是一个**唯一的、用户级的、可审计的**运行配置。

## Decision

### 1. 唯一配置文件

`~/.PiAgent/PiAgent.jsonc`（Linux `$HOME`，Windows `%USERPROFILE%`），**JSONC**（注释 + 尾逗号）。
`--config <path>` 可覆盖；**不设** `PIAGENT_CONFIG` 环境变量，**不做**项目级配置（无第二层合并语义）。

- `<home>` 缺失/空白 ⇒ fail fast（提示改用 `--config`），不回落 `os.homedir()`。
- 这是全仓唯一被读取的环境变量来源（两个路径原语，不承载配置值）。
- 相对引擎路径在**写入时**按 cwd 绝对化（`config init --from-env`），之后换 cwd 不失效。

### 2. 环境变量层彻底移除

任何 `REVIEWER_*` / `DEEPSEEK_*` / `REVIEW_PI_*` 都不再被读取、不再有覆盖优先级。
`.env.local` 与 `--env` 一并退出：`--env` 成为确定性错误（带迁移提示），cwd 存在 `.env.local` 时
stderr 一行提示「已不再读取」。

保留的边界（写清楚，避免误读为「env 全灭」）：
- skill bash 子进程的环境白名单仍从 `process.env` 取值再筛选（那是**进程边界**，不是配置通道）；
- vendored `packages/ai` 内仍存在 `DEEPSEEK_API_KEY` 自动读取的辅助函数，但本仓请求路径**始终显式注入 apiKey**，不经过它（无双口径）；
- `HOME` / `USERPROFILE` 只用于定位配置文件，不承载配置值。

### 3. 可配 / 死钉的边界

**可配**：
- B 资源/运维：全部超时（skill 会话 / skill bash / ripgrep / 规则包解压 / 双探针 / 呈现单请求与缓冲）、建议并发、MR 边界阈值、规则包归档上限；
- 模型接入：默认 id、`baseUrl`、请求输出预算、呈现模型、呈现引擎路径；
- 模型元数据：按 id 深合并 `contextWindow` / `maxTokens` / `cost` / `input`（已废止，见修订）；
- 微限：skill bash 输出上限、包头部字节、检索回显上限、调用链跳数、工具名/参数摘要/进度摘要截断。

**死钉**（配置文件里出现即按未知/钉死键警告，不生效）：

| 项 | 值 |
|---|---|
| 最大轮次 | 5 |
| 单 run 工具调用上界 | 100 |
| 单次工具结果预算 | 8000 字符 |
| 呈现 `temperature` | 0 |
| effort 锁档 | 标签 `default` / wire `reasoning_effort: "high"` |
| skill bash 子进程环境白名单 | 13 个变量 |
| 序列化方言 | provider 恒 deepseek；`compat` / `thinkingFormat` / `maxTokensField` 不可改 |
| 截断原因与预算文案、工具名 `bash`、退出兜底 8000 ms | 字面量 |

### 4. 「测量常量面」重新定义

原定义（`CONTEXT.md`）把「Zone A 提示词 + 六阶段语义 + Finding/Evidence 契约」整体称作测量常量面，
并暗含「请求字节跨版稳定」。本 ADR 把它**收窄为 5 项运行期常量**：

```
maxRounds=5 · maxToolCalls=100 · toolResultBudgetChars=8000 · temperature=0 · reasoningEffort=high
```

其余文本截断上限（包头部字节、检索回显、调用链跳数、工具名截断）**移出**该面，成为可配项。

**这是本次最贵的一条代价，必须显式承认**：同一 MR、同一模型，换一份配置文件即可产出**不同的请求体**
（工具结果尾部长度、检索回显长度、调用链块数都会变）。ADR-0024 建立的「唯一形态」从此只指
**唯一执行路径**，不再指**唯一字节面**。相应地，本 ADR 引入审计配置快照来补回可反查性。

`callChainHops` 的实现是**真实遍历深度**（`zoneb/call-chain.ts` 逐层展开 + visited 去环），
不是只改文案；缺省 2 与历史输出逐字节一致（`call-chain.test.ts` 锁定 hop 1/2/3 三档）。

### 5. 读一次 → 不可变快照 → 显式穿参

不在模块顶层读配置、不设全局单例、不把配置翻译回环境变量。
`main()` 内构造一次 `ResolvedConfig`，经 `ReviewRunInput.runtime`（`ReviewRuntime`：`limits` /
`maxOutputTokens`）与 `ReviewRunInput.config`（审计快照）下传；请求期不重读文件。
长跑进程里改文件不生效（明确写入文档）。内核直调形态缺省 `DEFAULT_REVIEW_RUNTIME`（今天的缺省行为）。

### 6. 审计配置快照（只进审计文件）

审计 JSON 顶层 `config`：`path` / `version` / `digest` / `values`（全量生效值，扁平点分键）/
`overridden`（来源为文件的键）/ `secret`（`reviewer.apiKey` 只记 `"set"|"missing"`）。
`digest = sha256(canonicalJson(values)).slice(0,12)`。stdout、`RunRecord`、`reviews_en.json` 一律不加字段
（键序纪律：`config` 是审计尾部新键，缺席省键）。

### 7. 失败策略

- 类型错 / 越界 / `version` 不符 / 禁配字段 ⇒ **fail fast exit 1**，指出键路径与期望（不钳制）；
- 未知键 ⇒ stderr 警告继续（附最近键提示）；
- 文件权限宽于 `0600`（仅 POSIX）⇒ stderr 警告继续；
- `0` 一律非法（`presentationBufferMs` 是唯一允许 0 的键）；「关闭」用 `null`（`boundary.*` /
  `maxOutputTokens` / `presentation.engine` / `model.presentation`）。

### 8. CLI 面

新增 `--config <path>`（review / smoke / config 全部子命令）与 `config init | show`（含
`init --from-env <file>` 一次性迁移、`--force` 覆盖、`--json` 机读快照）。`--env` 移除。
`config show` 只报 `set|missing`，绝不打印 key 值或长度。

## Options（为什么不是别的）

- **继续用 `.env.local`，只加旋钮**：秘密仍在工作树、仍无注释/嵌套/类型、仍不可审计；把它扩成
  40 个键的 env 文件等于自造一个无 schema 的配置文件。放弃。
- **半迁（秘密留 env，其余进 JSON）**：`.env.local` 不能删，目标只完成一半；且「哪半在哪」变成长期记忆负担。放弃。
- **只认 env、用 `PIAGENT_CONFIG` 指文件**：`PIAGENT_CONFIG` 是 env 变量，与「全禁 env」自相矛盾；
  且用户明确选择彻底禁。放弃。
- **项目级配置覆盖用户级**：能按仓不同模型/规则包，但引入「到底哪份生效」的排查成本；
  `--config` 已能覆盖该场景（CI 里指过去即可）。放弃。
- **全局单例 `getLimits()`**：测试互相污染、顺序敏感；本仓大量用例直接构造 loop/toolkit/skill-pass。放弃。
- **把 JSON 翻译成环境变量供旧消费点读取**：等于把刚废弃的东西换个马甲，还保留「请求期可变」。放弃。
- **开放序列化方言（thinking / compat / maxTokensField）**：那是字节复现面；开放它等于把内核序列化纪律交给用户。放弃。
- **A 档也开放**：`maxRounds` / `maxToolCalls` / 工具预算直接决定搜索深度与 `truncated` 语义——
  同一 MR 不同人跑出不同「截断」结论，且正是 ADR-0024 刚删掉的实验自变量。放弃。

## Consequences

- **正**：
  - 秘密离开工作树，进用户 home 单文件（0600，绝不回显）；
  - 配置有 schema、类型、注释、取值域与最近键提示；
  - 每次 run 的产物可反查配置（`config.values` + `digest`）；
  - 第三方网关的模型元数据可补全，成本估算不再失真（已废止，见修订）；
  - 请求期不再读 env，同一 run 内配置恒定。
- **负/风险**：
  - **请求字节面随配置可变**（见 Decision 4）；「唯一形态」只保证执行路径唯一。
  - **CI 需要把 secret 落盘**：从 env 注入改为「写临时 JSON + `--config`」（多一步、失败更隐蔽）；
    文档必须给可复制的片段（`umask 077` + JSON 转义）。
  - **所有进程测试都要提供配置文件**，且必须沙箱 home（否则开发者本机配置污染测试）；
    `bin.process.test.ts` / `config.process.test.ts` 已按此纪律改造。
  - **`--env` 用户无过渡期**：立即报错。`.env.local` 存在时只给 stderr 提示，不自动迁移
    （迁移入口是 `config init --from-env`）。
  - **新增一个依赖** `jsonc-parser`（JSONC 解析；手写去注释在字符串/转义/BOM 边界上不可靠）。
  - **`config show` 打印绝对路径**：本地诊断信息，与既有 pnpm/构建路径同类。
- **中性**：
  - 缺省值全部保持今天的行为；`testdata/golden/*` 提示词与工具 schema 不变。
  - **零漂移守卫不新增基线文件**：沿用既有逐字节断言（wireBody 快照与工具结果形态）守住「只写
    `version` + `reviewer` 时与改造前同字节」。
  - `config init` 模板与仓库内 `PiAgent.example.jsonc` 同源（`config.test.ts` 断言逐字节相等；
    `.env.empty` 删除）。

## 验收标准

1. **零漂移**：配置文件只含 `version` + `reviewer`（不含任何 `limits`）时，请求 `wireBody`
   与改造前同形态（既有逐字节断言全绿）；审计关键字段不变。
2. **可配生效**：改 `limits.boundary.maxFiles` 后审计 `mrBoundary.reason` 与 `domainWarning` 文案
   随之变化；改 `limits.micro.callChainHops` 后调用链块真的多/少一层。
3. **死钉不生效**：配置文件里写 `limits.micro.toolResultBudgetChars` / `loop.maxRounds` ⇒
   stderr 警告「已钉死」，请求字节与行为不变。
4. **env 全禁**：`REVIEWER_API_KEY` / `REVIEWER_URL` / `REVIEWER_MAX_TOKENS` 全设在进程环境里、
   配置文件缺 key ⇒ 仍 fail fast；设了也不被采用（断言 stdout/审计里没有该值）。
5. **`--env` 退出**：`--env <file>` ⇒ exit 1 + 迁移提示；cwd 有 `.env.local` ⇒ 一行提示、行为不变。
6. **权限与失败策略**：POSIX 下 `0644` ⇒ 警告继续；类型错/越界/`version≠1` ⇒ exit 1 且指出键路径。
7. **配置命令**：`config init` 写盘（0600、注释模板、已存在拒绝覆盖、`--force`）、`config show` 脱敏、
   `--from-env` 正确映射且丢弃无消费者键、坏 JSONC 带行列。
8. **测试与构建**：`pnpm typecheck`、`pnpm --filter review-pi build`、`pnpm build:presentation`、
   `pnpm test`、`pnpm --filter review-pi test` 全绿；进程测试不依赖真实 home。
9. **文档**：README / 运行手册 / CONTEXT / AGENTS 相关段落完成改写；全仓 grep `REVIEWER_` /
   `REVIEW_PI_` / `.env.local` 在产品代码与当前文档中归零（历史 ADR、历史报告、问答整理与
   `config init --from-env` 的迁移键名表除外）。
