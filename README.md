# ReviewAgent-pi

低 Token、高质量代码检视 Agent：用**最小充分上下文**（Minimal Sufficient Context）与**缓存稳定循环**（Cache-Stable Review Loop），以 20~30% 的 Token 成本获得接近全量上下文的检视质量。终点是落地到企业内部代码托管平台的 MR 检视。内核基座：pi 代码仓 fork（ADR-0009）。

本仓是 **pi 内核线的 Review CLI 产品仓**：一条命令完成一次检视，产出**英文 findings**（`reviews_en.json`，结构化真源）与**中文按行分组的建议**（`reviews_tips_zh.json`，核外翻译投影）。规则 Skill（`--rule-skill-zip` / `--rule-skill <dir>`，**只认显式输入**）是唯一形态，不再有配置矩阵。

> **历史定位（已废止）**：本仓曾是「pi 内核线 × 五配置（A–E）受控实验 + 四层判定链」的跨内核对照实验仓。A–E 配置矩阵、`configId` 身份维度与评测仪器层已按 [ADR-0024](docs/adr/0024-drop-config-matrix-and-config-identity.md) 删除（`--config` 旗标、实验运行器、judge / 指标 / 采样 / 对齐门 / 字节门、数据物化脚本一并移除）；`docs/report/**` 与 `runs/**/REPORT.md` 中的历史报告保留为记录，但**不可复跑**。需要评测能力时从历史 tag 或 DSH 兄弟仓取回。
>
> **姊妹仓（DSH 内核线）**：兄弟仓 [`MustacheXb/ReviewAgent`](https://github.com/MustacheXb/ReviewAgent) 承载 DeepSeek Harness（DSH）内核线。两仓 ADR 各自独立编号（本仓 0001–0028 为 pi 线序列）：引用 DSH 仓的决策必须写全限定语「DSH 线 ADR-XXXX」；裸写「ADR-XXXX」一律指本仓 ADR（双 0009 尤其如此：本仓 0009 = pi 内核从 0 重写，DSH 线 0009 = 大 MR 切分）。
>
> **pi 内核基座**：以 [pi](https://github.com/earendil-works/pi) 代码仓为基础的全源码定制（vendor fork，锚定 commit `6671c604` / v0.85.1+11d），vendored `packages/{ai,agent,chord,telemetry}` 四个包。方向拍板（2026-09-18，ADR-0009）：Review Runtime 在 pi fork 上从 0 重写（`packages/review-pi`）。方案见《[Pi 内核从零实现方案](docs/design/Pi 内核从零实现方案.md)》，fork 接线事实见《[Pi 内核定制基线方案](docs/design/Pi 内核定制基线方案.md)》，第三方声明见 [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md)。

## 产品形态

**一次检视**（单案 × rep-1）：`review-pi review` 读仓库 + MR diff（+ 可选规则 Skill），跑 pi 内核的检视循环，落盘审计与转录，并导出检视意见；配了呈现引擎时再产出中文按行分组的建议：

| 产物 | 内容 |
|---|---|
| `rep-<N>.json` | `RunRecord`：本次运行的记录（模型、耗时、findings 计数、usage） |
| `session-<runId>.json` | 检视转录（请求/工具/相位全留痕） |
| `reviews_en.json` | 英文结构化检视意见（finding 全量，含同行多条） |
| `reviews_tips_zh.json` | 中文按行分组建议（同文件同行去重） |
| `audit/<runId>.json` | 审计（审计真源：请求、工具调用、相位、Context Ledger、规则 Skill 装载与执行留痕） |

`runId = <时间戳>-<caseId>`；产物路径不含任何配置段（ADR-0024）。落点为 `<out>/runs/mr/<caseId>/` 与 `<out>/audit/mr/<caseId>/rep-<N>/audit/`（ADR-0027：`mr` 是输入形态段，没有实验标识层）。

**规则 Skill 是唯一形态**：显式传入的规则包装到就用于候选阶段的规则检视；不传就照常检视并在 stderr 提示一行（`--strict-rule-skill` 可改为 fail fast）。**不扫描被检视仓库**（`.review-rules/` 不再自动装载，ADR-0027）。

## 仓库结构

```
src/presentation/       核外呈现层（中文翻译投影 / 分组意见映射 / 真引擎装配；ADR-0010/0017）
packages/{ai,agent,chord,telemetry}/
                        Pi 内核 vendor 基座（发行名 @review-agent-pi/*，`pnpm build:pi`
                        拓扑构建，见《Pi 内核定制基线方案》与 ADR-0028）
packages/review-pi/     Review Runtime（pi 内核从 0 重写：六阶段骨架 + 七工具 + Context
                        Ledger + 规则 Skill 会话 + 审计投影 + review-pi CLI，ADR-0009）
packages/review-llm/    LLM 接入共享缝（provider 参数画像与 DeepSeek 接入常量单源）
data/                   数据集清单与 MR 元数据（vul4j / defects4j / msb-java / clean-mr 的清单层）
runs/                   运行产物（不入库；*/REPORT.md 作为历史结论文档例外入库）
docs/                   ADR / 设计方案 / 评测方案 / 历史报告 / 计划书 / agent 协作约定
CONTEXT.md              领域词汇表（术语唯一权威，单一上下文）
reference_project/      外部参考项目（不入库，见下节）
```

## 快速开始

```bash
# 前置：Node >= 22，pnpm（版本见 package.json 的 packageManager，corepack enable 即可）
pnpm install
pnpm test          # root 回归：呈现层（5 文件 / 52 项）
pnpm typecheck     # 根包类型检查
```

检视链的测试面在自己的包里：`pnpm --filter review-pi test`（内核单测 + CLI 进程烟测）。

CI（push / PR）跑 `suites`：root + review-llm + review-pi 三处 typecheck 与测试，零网络。**真实网关调用不进 CI**（零网络纪律，#28），只走本地按需执行。

## 常用命令

| 命令 | 用途 |
|---|---|
| `pnpm test` / `pnpm test:coverage` | root（呈现层）回归 / 覆盖率 |
| `pnpm --filter review-pi test` | 检视链内核 + CLI 进程烟测 |
| `pnpm typecheck` | 根包类型检查 |
| `pnpm build:pi` | Pi 四包拓扑构建（telemetry → chord → ai → agent） |
| `pnpm --filter review-llm build` / `pnpm --filter review-pi build` | 共享 LLM 缝 / 检视链 CLI 的 dist 构建 |
| `pnpm build:presentation` | 呈现层引擎构建（前置 review-pi build；产物 `.tmp-gen/presentation/`，随后复制到 `packages/review-pi/presentation/` 供 `"builtin"` 引用） |
| `pnpm build:dist` | 发行全量构建（内核四包 → review-llm → 呈现层） |
| `pnpm pack:packages` | 打 6 个 tarball 到 `.artifacts/tarballs/`（ADR-0028） |
| `pnpm verify:pack` | 离线安装布局冒烟（不联网、不发布） |

## 安装与发行（npm 多包，ADR-0028）

产品以**六个包**发行：内核四包 `@review-agent-pi/pi-{telemetry,chord,ai,agent-core}`（版本随上游锚点 `0.85.1`）+ `review-llm` + `review-pi`（提供 `bin: review-pi`）。

```bash
npm i -g review-pi      # 全局安装
pnpm add review-pi      # 或装进项目
review-pi review --repo <path> (--mr-diff <diff> | --mr-json <files.json>) --out <dir>
```

- **仓内开发 = 安装形态**：源码里的 specifier 就是发布名（`@review-agent-pi/*`），没有 npm alias；`exports.source` 条件让仓内 vitest / typecheck 读 `src/*.ts`，安装方读 `dist/*.js`。tarball 不含源码。
- **scope 可整体替换**：发布到公司私有 registry 时，改六个 `package.json` 的 `name` 与全仓 specifier 即可；`verify:pack` 从各包 `package.json` 派生包名，不写死 scope。
- **打包与发布分离**（发布前须确认 registry 与凭据）：

  | 命令 | 做什么 |
  |---|---|
  | `pnpm build:dist` | 全量构建：内核四包 → review-llm → 呈现层 |
  | `pnpm pack:packages` | 6 个 tarball 落到 `.artifacts/tarballs/`（拓扑序） |
  | `pnpm verify:pack` | 离线安装布局冒烟：bin 腿表 / `config init`·`show` / `"builtin"` 引擎 / tree-sitter wasm / ripgrep |
  | `pnpm publish:packages` | 重新构建后 `pnpm -r publish` |

- `prepack` 断言 `dist` / `bin` / `presentation` / 履约文本在位，并把仓根 `THIRD-PARTY-NOTICES.md` 复制进 `review-pi` 包；bin 的 shebang 由 `.gitattributes` 固定 LF（Windows 上 CRLF 会被 `pnpm pack` 拒绝）。

**装完怎么用**：从 Node 版本、PATH、registry、ripgrep postinstall 检查，到配置逐字段、`smoke` 自检、任意目录运行、不同 `--out`/cwd 的并发隔离与排障，见《[使用手册：安装、配置与运行](docs/使用手册-安装与运行.md)》。自己打包与 tarball 安装的逐步说明在同手册 §2.4 与 §2.7。

## 单次检视执行

`packages/review-pi` 的 `review-pi` CLI：解析 → 配置装载（`~/.PiAgent/PiAgent.jsonc` 或 `--config`）→ 装配 → run → 导出 → 呈现；stdout 单 JSON 文档；退出码：完成（含诚实截断）0 / 中止 1；被测模型缺省 `deepseek-v4-flash`，换模型加 `--model <id>`；`smoke` 子命令提供网关双探针自检。

**唯一形态（规则 Skill）**——单案 × rep-1，一条命令出审计、转录与检视意见导出（完整前置、旗标说明、产物布局与排障见《[单次检视运行手册](docs/运行手册-单次检视.md)》）：

```powershell
node packages\review-pi\bin\review-pi.js review --repo .cache\datasets\vul4j-repos\VUL4J-38-ab6cbdc3da --mr-diff .cache\datasets\vul4j-diffs\VUL4J-38.diff --rule-skill-zip packages\review-pi\testdata\rule-skills\general-code-review.zip --strict-rule-skill --issue "Vulnerability CVE-2014-4172 (CWE-74) in apereo/java-cas-client. Fixed by https://github.com/apereo/java-cas-client/commit/ab6cbdc3daa451b4fef89c0bd0f4e6568f3aa9ef." --out runs\f-demo-session-skill-2
```

前置三件：内核产物不过期（`pnpm build:pi` → `pnpm --filter review-llm build` → `pnpm --filter review-pi build`，陈旧即拒跑、不自动重编）、用户级配置 `~/.PiAgent/PiAgent.jsonc`（`review-pi config init` 生成；`--config <path>` 可指定替代文件）、仓库快照与 diff 就位（本机 `.cache/datasets/**`；数据物化脚本已随评测层删除，缺失时自备）。产物落 `<out>/{runs,audit}/mr/<case>/`（ADR-0027：无实验标识层）；stdout 是单个 JSON 文档，诊断走 stderr；退出码 0（含诚实截断）/ 1。

其余仍然有效的口径与注意：

- **口径三要素**：物化仓（base 态）+ 数据集原生 diff + 数据集原生英文 issue（清单见 `data/vul4j/*.json`）。issue 改用自编文本会引入口径污染。
- **中文 MR 描述是内核已知边界，不是用户义务**：产出被 NON_ENGLISH 门要求纯英文，模型会把 `--issue` 中的中文自然引用进 evidence 导致整条 finding 被拒；正解在内核侧（输出语言核外投影，ADR-0010）。
- **内核面向 Java**：角色提示词为 senior Java code reviewer、符号索引基于 tree-sitter-java；检视非 Java 仓可运行但质量不保证。
- **基线态语义**：检视读的上下文以仓内现状为准（CLI 不 apply diff）；约定仓停在 diff 的 base 侧。
- **单次结果 ≠ 判定**：被测模型非确定，单跑落在历史 rep 波动族内即属正常；本仓已无判定链与指标聚合，需要评测判定请到 DSH 兄弟仓复跑。

## 配置（`~/.PiAgent/PiAgent.jsonc`，JSONC）

唯一配置来源是**用户级** JSONC 文件（ADR-0025）：Linux 读 `$HOME`，Windows 读 `%USERPROFILE%`；`--config <path>` 可指定替代文件。**环境变量层已彻底移除**——`.env.local`、`REVIEWER_*`、`DEEPSEEK_*`、`REVIEW_PI_*` 都不再被读取（`--env` 是确定性错误）。

```powershell
review-pi config init                 # 写缺省模板（已存在则拒绝，--force 覆盖）
review-pi config show                 # 脱敏打印生效值 + 来源 + digest
review-pi config show --json          # 审计同款快照（机读）
review-pi config init --from-env .env.local   # 一次性迁移旧 .env.local
```

最小可跑配置（完整键表与注释见仓库根 [`PiAgent.example.jsonc`](PiAgent.example.jsonc)）：

```jsonc
{
  "version": 1,
  "reviewer": {
    "apiKey": "sk-...",
    "baseUrl": "https://api.deepseek.com",  // 网关需自带 /v1
    "maxOutputTokens": null                 // null = 自动（网关档 32768）
  },
  "presentation": { "engine": "builtin" }   // "builtin" = 制品自带（config init 默认）/ null = 关 / 路径（相对按配置文件目录，ADR-0026）
}
```

- **秘密只进该文件**（POSIX 权限建议 `0600`，过宽只警告）；`config show`、审计、stdout 一律只报 `set|missing`。
- **可配**：超时、并发、MR 边界（`limits.boundary`，`null` = 关闭该维）、规则包归档上限、微限（回显/跳数/摘要截断）。
- **死钉**：轮次 5、工具调用 100、工具结果预算 8000 字符、`temperature: 0`、effort 锁档——写进配置文件只会得到「已钉死」警告。
- **读一次**：启动装载为不可变快照，运行中改文件不生效；每次 run 的审计顶层 `config` 记录全量生效值 + 来源 + `digest`。
- **失败策略**：类型/取值/版本错 fail fast（exit 1 并指出键路径）；未知键与权限过宽只警告。

被测模型经 `--model <id>` 自由指定；wire 序列化按 review-llm 的 provider 画像表单源分派。judge 相关凭据（`JUDGE_*` / `OPENAI_*`）随判定链一并删除（ADR-0024），本仓不再读取。

自定义网关（`reviewer.baseUrl` 指向中转/自建端点）的可用性与兼容性由使用者自证：换端点或换模型后先跑 `review-pi smoke`（双探针：网关健康 + 模型可达，输出人话诊断与处置建议；通过退出码 0、失败 1；探针请求体走生产画像序列化）。目录外模型 id 可直接跑，但画像借用 `deepseek-v4-flash`（成本数字仅供参考）。

## 目录与入库约定

| 路径 | 入库 | 说明 |
|---|---|---|
| 源码 / 文档 / 数据集清单 | ✅ | |
| `runs/**/REPORT.md` | ✅ | 历史实验结论文档（唯一例外） |
| `.env.local` | ❌ | 历史凭据文件（本版不再读取；迁移后请删除） |
| `~/.PiAgent/PiAgent.jsonc` | 仓外 | 用户级运行配置（含秘密；不入库） |
| `reference_project/` | ❌ | 外部参考仓（见下节） |
| `runs/**`（除 REPORT.md） | ❌ | 运行记录与数据 |
| `.cache/` | ❌ | 数据集缓存 / 留痕 / 分析产物 |
| `.tmp-gen/` | ❌ | 呈现层编译中转产物 |
| `packages/review-pi/presentation/` | ❌ | 呈现引擎制品（`build:presentation` 从 `.tmp-gen/` 复制；`"builtin"` 指向这里） |
| `.artifacts/` | ❌ | 发行中间物：`tarballs/`（打包产物）与 `verify/`（安装面冒烟临时目录） |
| `packages/review-pi/THIRD-PARTY-NOTICES.md` | ❌ | `prepack` 从仓根复制的履约文本（只有 tarball 里需要） |

**历史基线数据仍在本地**：三侧 runs 数据（`phase2-main` / `phase2-noise` / `phase2-dsh`）、t 系 audit 真源（`phase2-dsh-t{1..5}`，原 P2 字节门对照物）与 `.cache/datasets` 物化仓按《[Pi 内核从零实现方案](docs/design/Pi 内核从零实现方案.md)》§9 迁入本仓（robocopy，git 零影响——`runs/**` 与 `.cache/` 均 gitignored）。ADR-0024 之后这些只作**历史记录与解读背景**保留：复算脚本（`pnpm analyze:phase2` / 字节门）已删除，不可再一键重放。

## 参考项目（reference_project/，不入库）

协同开发时需要的机制参照源。本地目录已被 gitignore——在新机器上按下表 clone 并 checkout 到锚定 commit 即可复现当时的参照状态：

| 本地目录 | 上游 | 锚定 commit | 参照角色 |
|---|---|---|---|
| `pi` | <https://github.com/earendil-works/pi> | `6671c604`（2026-09-16，v0.85.1+11d） | Pi 内核 vendor 源与定制基座：`packages/{ai,agent,chord,telemetry}` 即出自此锚定（fork 接线与分歧清单见《Pi 内核定制基线方案》） |
| `deepseek-harness` | <https://github.com/deepseek-ai/deepseek-harness> | `5dda764`（2026-09-08，0.1.5-alpha.1） | DSH 线内核机制参照（ADR-0005/0006 的决策依据，已归档）；phase2-dsh 对照数据的解读背景 |
| `open-code-review` | <https://github.com/alibaba/open-code-review> | `82af2fb`（2026-09-02） | 同域开源检视 Agent：产品形态与公开评测对齐对象（AACR-Bench 已支持 reviewer 之一） |
| `prime-agent` | <https://github.com/PrimeIntellect-ai/prime-agent> | `c718bf3`（2026-08-31） | Agent harness 设计参照（self-improving RLM harness） |
| `whale-pod` | <https://github.com/Timothyhay/whale-pod> | `d76f522`（2026-08-13） | 轻上下文 + 前缀缓存设计参照：known world + 懒拉取 + 前缀稳定，与本项目 Minimal Sufficient Context / Stable Prefix 命题同源；其实测化 bench 方法论亦为本项目纪律参照 |

```bash
# 恢复参考项目（在仓库根执行）
git clone https://github.com/earendil-works/pi.git                 reference_project/pi
git clone https://github.com/deepseek-ai/deepseek-harness.git      reference_project/deepseek-harness
git clone https://github.com/alibaba/open-code-review.git          reference_project/open-code-review
git clone https://github.com/PrimeIntellect-ai/prime-agent.git     reference_project/prime-agent
git clone https://github.com/Timothyhay/whale-pod.git              reference_project/whale-pod
cd reference_project/pi  && git checkout 6671c604   # 其余同理
```

**DSH 线归档注记**：DSH 内核（`packages/review-dsh`）与 `@deepseek-ai/dsh-sdk-protocol` 依赖已按 ADR-0009 移除；其机制事实记录（《[DSH 内核机制偏差清单](docs/design/DSH 内核机制偏差清单（npm 0.1.2-rc.1 × reference 0.1.5-alpha.1）.md)》）、`runs/phase2-dsh` 评测数据与双门报告保留，作为历史对照（DSH↔pi）的解读依据。

## 文档地图

| 文档 | 内容 |
|---|---|
| [`CONTEXT.md`](CONTEXT.md) | 领域词汇表（Minimal Sufficient Context / Zone A–C / Finding 等术语唯一权威） |
| [`docs/adr/`](docs/adr/) | 架构决策记录 0001–0028（POC1 harness / 模型钉扎 / 静态代码情报 / DSH 迁移姿态 / 从 0 基于 pi 内核重写 / 规则 Skill 会话 / 核外中文投影 / 分组意见 / **0024 废止配置矩阵与 configId** / **0025 用户级 JSONC 配置** / **0026 引擎路径与判档单源** / **0027 产物路径与规则包信任边界** / **0028 npm 多包发行形态**） |
| [`docs/design/`](docs/design/) | 总体架构设计方案 / Pi 内核从零实现方案 / Pi 内核定制基线方案 / VUL4J 评测方案与数据复制指南 / DSH 偏差清单 / Token 优化方案 |
| [`docs/report/`](docs/report/) | POC1 实现报告 / DSH 迁移实现报告 / DSH 指标对齐门报告 / Phase 2 主数据分析报告 / Phase 2 pi-S1 五配置对照报告 / 兄弟项目调查报告（均为**历史记录，不可复跑**） |
| [`docs/plan/`](docs/plan/) | 项目分阶段实现计划书 |
| [`docs/agents/`](docs/agents/) | agent 协作约定（issue tracker / triage labels / domain docs） |
| [`docs/使用手册-安装与运行.md`](docs/使用手册-安装与运行.md) | 面向安装形态的使用手册（安装 / 配置逐字段 / smoke / 任意目录运行 / 并发隔离 / 排障） |
| [`docs/运行手册-单次检视.md`](docs/运行手册-单次检视.md) | 单次检视的完整运行手册（旗标 / 前置 / 产物 / 排障） |

## 协作约定

- **Issue 即 spec**：需求与验收标准在 GitHub Issues（`MustacheXb/ReviewAgent-pi`）管理，经 `gh` CLI 读写；约定见 [`docs/agents/issue-tracker.md`](docs/agents/issue-tracker.md)。
- **Triage 标签**：`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`。
- **提交信息**：Conventional Commits（`feat` / `fix` / `refactor` / `docs` / `test` / `chore` / `perf` / `ci`）。
- **零网络纪律**：真实网关调用只在本地按需执行，CI 恒离线（#28）。
