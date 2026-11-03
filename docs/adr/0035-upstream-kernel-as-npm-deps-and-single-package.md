# 0035. 内核四包改为 npm 上游依赖，发行面收为单包 `review-pi`

**状态**：提议（2026-11-03，待用户确认后执行；执行前不改 ADR-0009 / ADR-0028 正文）
**关联**：ADR-0009（pi 内核从 0 重写 Review Runtime）、ADR-0024（仓收窄为 Review CLI 产品仓）、ADR-0025（用户级 JSONC 配置）、ADR-0028（现行发行形态 A：npm 多包）、ADR-0033（产物落盘，不受本决策影响）
**跨仓**：本 ADR 为本仓 pi 线序列 0035；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
**取代关系**：本 ADR 若被接受，取代 ADR-0028 §1（六个包 / 两个 scope）、§2（specifier 用自有 scope）、§4（`review-pi` 之外的发布面）、§6（六包四段流水线），并修订 ADR-0009 的「全源码 vendor fork」前提；ADR-0028 §3（三条件 exports）、§5（LF shebang）、§7（scope 可换）中仍然成立的部分保留。

## Context

ADR-0028 把发行面定成六个包：四个 `@review-agent-pi/*` 内核定制件 + `review-llm` + `review-pi`。当时的三条理由（上游 scope 不是我们的、产品包 `private` 装不出去、仓内吃源码/安装吃 dist）至今成立，但它默认了一个前提：**内核必须由本仓发布**。本轮核对发现这个前提的成本已经大于收益。

### 事实 1：上游四包本来就在 npm 上，而且是同一个版本线

```
@earendil-works/pi-ai           latest 1.5.0   0.85.1 存在（2026-09-05 发布）
@earendil-works/pi-agent-core   latest 1.5.0   0.85.1 存在
@earendil-works/chord           latest 1.5.0   0.85.1 存在
@earendil-works/pi-telemetry    latest 1.5.0   0.85.1 存在
（旧 scope @mariozechner/* 停在 0.73.1——上游自己改过一次名）
```

对 `pi-ai@0.85.1` / `pi-agent-core@0.85.1` 的 tarball 实测：

| 事实 | 结果 |
|---|---|
| 内容面 | `dist` + `README.md` + `package.json`（780 KiB / 641 KiB），**不含 `src`** |
| 模型数据 | `dist/providers/data/` 40 条目（39 个 provider 目录 + manifest）——本仓 `packages/ai/src/providers/data` 就是从这里提取的 |
| `review-pi` 用到的子路径 | 全部存在：`./node`、`./harness/*`、`./providers/*`（含 `providers/deepseek`） |
| `engines` | `node >=22.19.0`，与产品包一致 |
| 依赖面 | `openai` / `@anthropic-ai/sdk` / `@google/genai` / `@aws-sdk/client-bedrock-runtime` 等，与本仓 vendored 四包**同构**——换 npm 依赖后安装体积不变 |
| license | MIT（`THIRD-PARTY-NOTICES.md` 照旧履约） |

### 事实 2：本仓 vendored 的不是任何已发布版本

锚定 commit `6671c604` 是 2026-09-16（`v0.85.1` 之后 11 天的 main）。GitHub compare `v0.85.1...6671c604`：

- 79 个 commit、257 个文件；
- 落在四包 `src/` 的 **33 个**：主体是 `agent/src/harness/session/`（fork / jsonl / legacy-v3 重构，+1700/−1000 量级），以及 `ai/src/utils/event-stream.ts`、`ai/src/utils/retry.ts`、`ai/src/api/openai-completions.ts`——后三个在运行时热路径上。

时间上最接近锚点的已发布版本是 **0.86.0（09-19）**、**0.86.1（09-20）**；没有任何已发布版本与锚点字节相同。

### 事实 3：vendored 至今没有换到任何「定制」

《Pi 内核定制基线方案》§4/§9 与后续提交记录一致：四包**源码本体零改动**。全部差异是接线与发行面：

| 差异 | 性质 |
|---|---|
| `package.json`（包名、`workspace:*`、`exports` 三条件、`tsgo → tsc`、devDeps） | 构建/发行接线 |
| `packages/{telemetry,chord}/vitest.config.ts` | 仓内测试接线 |
| `chord/test/boundary.test.ts` 的 `path.sep` 修复 | **测试文件**，非产品代码 |
| `packages/ai/src/providers/data/*.json` 入库 | 上游不入库、由联网脚本生成；数据来自 npm tarball |
| ADR-0028 的 112 文件 specifier 重写 | 发行面 |

也就是说，vendor 目前买到的是「比 `v0.85.1` 新 11 天的快照」+「仓内能跑上游测试」；而后者**本来就不进 CI 门**，且在 Windows 上有 45+27 个既有失败（POSIX 路径假设 / 目录快照期望，成因都在上游）。

### 事实 4：`review-llm` 已经没有任何消费者（模型调用不经过它）

**三层证据**（2026-11-03 核查）：

1. **源码面**：`git grep "review-llm"` 在代码里只命中注释、`package.json`、tsconfig `paths` 与测试的「允许名单」；没有任何 `import` / `export ... from` / 动态 `import()`；
2. **产物面**：`packages/review-pi/dist/**` 里 `review-llm` 只出现在 `shared/config.js` / `shared/config.d.ts` 的一条注释中（`DEEPSEEK_API_BASE_URL` 同值说明），`from "review-llm"` / `require("review-llm")` 为零；
3. **历史面**：`git log -S 'from "review-llm"' --all` 为空——本仓自 pi 线开仓起就从未 import 过它，它属于 DSH 线 + 仪器期的依赖，`package.json` 里的声明是迁移残留。

**模型的真实调用链是两条，都不经过 `review-llm`**：

| 路径 | 链路 |
|---|---|
| 检视主循环 / skill 会话 | `cli/main.ts:88` `resolveReviewerEndpoint(config)` → `provider/reviewer-endpoint.ts:23`（只读配置快照，不读 env，注释明写不再 import review-llm 的 resolver）→ `loop/agent-review-loop.ts:225` / `knowledge/skill-pass.ts:145` 的 `reviewStreamFn` → `provider/pi-client.ts:183` `deepseekProvider().stream(...)`（pi-ai + OpenAI SDK）→ 网关 |
| 呈现层翻译 / 建议生成 | `cli/main.ts:228` 组装 `runtime{apiKey,baseUrl,modelId}` → `src/presentation/engine-zh.ts:109` 拼 `${baseUrl}/chat/completions` → `:362-378` 裸 `fetch` + `Bearer`（连 pi-ai 都不经过） |

请求参数也不是它给的：`provider/pi-client.ts:34` 的 `LOCKED_REASONING_EFFORT = "high"`、`:159` 的 `maxTokensFor`（官方直连不发 `max_tokens`，网关发 `shared/config.ts:25` 的 32768）、`:127` 的 `reviewModelOf`（目录内 id 原样、目录外 id 借 `deepseek-v4-flash` 画像）全部在 `review-pi` 内单源。

**它导出的四项能力，现状分别是**：

| review-llm 导出 | 现状 |
|---|---|
| `DEEPSEEK_API_BASE_URL` | 复制为 `shared/config.ts:22` 的 `OFFICIAL_REVIEWER_BASE_URL`（注释明写「两处刻意不互相 import」） |
| `resolveEndpointUrl` / `resolveApiKey`（显式 > env > 默认） | **故意关闭**：ADR-0025 改为 JSONC 配置；`reviewer-endpoint.ts:5` 明写 |
| `profileOf` / `providerFamilyOf`（provider 画像表） | **未接线**。pi 线用「单档锁死」：provider 恒 `deepseek`、恒发 `thinking{enabled}` + `reasoning_effort:"high"`，目录外 id 借 deepseek 画像（`pi-client.ts:124-125`，测试 `pi-client.test.ts:175` 明确锁「序列化不随 id 改变」） |
| `RETIRED_MODEL_IDS`（退役 id 拒绝） | **未接线**：`--model deepseek-chat` 不会被本地拒绝，直接透传给网关（`cli/args.ts:245` 只校验非空） |
| `positiveIntOption` / `nonNegativeIntOption` | 配置层自校验（`shared/config.ts:752` 起），格式不同、语义等价 |

因此删除它**不改变任何运行时行为**；ADR-0008 的「参数画像表 / 退役 id 拒绝」在 pi 线从未接线，若要恢复多模型画像分派，那是一件**新功能**（应另开票），不是「保留 review-llm」。

**非调用的真实耦合（删包时必须一并处理）**：

| 耦合 | 后果 |
|---|---|
| `bin/lib/cli-runtime.js:54` 腿表 + `checkRuntimeArtifacts` | 源码布局下 `review-llm` 参与 mtime 判鲜——改它的源码不重建会让 `review-pi` **拒跑**，尽管没人 import |
| `packages/review-llm/package.json` 的 `prepare: tsc` | 它的类型错会让 `pnpm install` 直接失败 |
| `review-pi` 的 `dependencies` 声明 | 用户必须多装一个 7.8 KiB 的死包；六个 tarball 必须成套（手册 §2.4） |
| `.github/workflows/ci.yml` | 独立的 typecheck / test 步骤，与产品无关 |

**口径债（文档说它在用，实际没用）**：`CONTEXT.md:172`（「单源查表（review-llm）」）、`README.md:173`（「provider 参数画像与常量单源」）、`tests/presentation/translate-projection.test.ts:361`（注释称呈现层经 review-llm 走网关，断言只是「允许」该 specifier，空集也成立）、`docs/使用手册-安装与运行.md:523`（排障行「Cannot find module 'review-llm'」——实际不会发生）。删除时要一起清掉，否则下一个人会按文档去找这条不存在的链路。

## Decision

### 1. 内核四包改为 npm 直接依赖，不再由本仓发布

`review-pi` 的 `dependencies` 增加四个**精确锁版**的直接依赖（不用 `^`）：

```json
"@earendil-works/pi-ai": "0.86.1",
"@earendil-works/pi-agent-core": "0.86.1",
"@earendil-works/chord": "0.86.1",
"@earendil-works/pi-telemetry": "0.86.1"
```

- 四个都显式声明：上游 `pi-agent-core` 对 `ai/chord/telemetry` 声明的是 `^0.86.1`，直接精确声明 + npm 去重可保证**单副本**；同时覆盖 `npm i -g` 不使用本仓 lockfile 的场景；
- `packages/{ai,agent,chord,telemetry}` 从仓内删除（约 6300 个 ts/json 文件、5.6 万行）；
- 全仓 specifier 回归上游名 `@earendil-works/*`（复用 `.tmp-gen/rename-kernel-scope.mjs` 的 `MAP` 反向执行）；
- 根 `tsconfig.json` 与 `packages/review-pi/tsconfig.build.json` 里指向 `packages/*/dist/*.d.ts` 的 `paths` 全部删除——tsc 直接消费 `node_modules` 的 `.d.ts`（当前这些 `paths` 本来就指向 dist，语义等价）；
- `pnpm build:pi` 删除；`build:dist` = `pnpm --filter review-pi build` + `pnpm build:presentation`。

**不接受的中间态**：源码继续 vendor、发行时把依赖声明成上游包名。理由见 §Options。

### 2. 版本锚点判定程序（必须留痕）

切换后锚点不再是 commit，而是 npm 版本。按下列顺序取**第一个全门通过**的版本，并把结论写进本 ADR 的「执行记录」：

1. `0.86.1`（2026-09-20，锚点后 4 天，同 minor 的最后一个 patch）；
2. `0.86.0`（2026-09-19，锚点后 3 天）；
3. `0.85.1`（2026-09-05，锚点前 11 天——只有在 0.86.x 触发无法归因的行为差异时才退）。

判定依据是 §验收标准的全门 + 真实网关对照，不是「看起来更接近」的主观判断。四包必须**同版本成套**，不允许混搭。

### 3. `review-llm` 删除，不搬进 `review-pi`

「合并」的实质目标是**发行面只有一个包**，不是「把另一个目录搬过来」。而 `review-llm` 已无消费者，搬进去等于给死代码搬家，还会制造两处真源（`profileOf` 的表 vs `provider/pi-client.ts` 的 `LOCKED_REASONING_EFFORT`）。

因此：删除 `packages/review-llm` 整个目录，并清掉四处残留（§实施清单 S1）。若执行时发现确有需要的纯函数，只搬**被调用到的那个函数**到 `review-pi/src/llm/`，不整包平移。

### 4. 发行面 = 一个 tarball

```text
npm i -g review-pi
  ├─ @earendil-works/{pi-ai,pi-agent-core,chord,pi-telemetry}   ← npm 下载（MIT）
  └─ @vscode/ripgrep / tree-sitter-java / web-tree-sitter / jsonc-parser
```

`pnpm pack:packages` 只产出 `review-pi-0.1.0.tgz`；`pnpm publish:packages` 收敛为单包发布。四段流水线（build → pack → verify → publish）保留，但每一段只处理一个包。

### 5. 将来要改内核时的路径：`pnpm patch`，不再默认 vendor

ADR-0009 的「全源码 vendor fork」前提修订为：**默认消费上游 dist；确需改内核时用 `pnpm patch`（生成 `patches/*.patch` + `pnpm.patchedDependencies`），把补丁面显式化、可审计、可随版本升级重放**。是否退回 fork 由届时的新 ADR 决定，不在本 ADR 里预授权。

### 6. `bin` 腿表保留，语义顺势简化

`bin/lib/cli-runtime.js` 的腿表逻辑**不改结构**：它用 `import.meta.resolve` 定位包，并靠「入口路径含 `node_modules` → 只判在位、不判 mtime」区分源码树/安装布局。切换后四条内核腿自动落入「安装布局」分支，正是分发形态想要的语义。只改标签（去掉 `(vendored)`）与包名。

## Options（为什么不是别的）

- **维持六包自发布（现状）**：用户诉求就是「不要再自己打包这四个 SDK」；且我们发的是「看起来像上游 fork」的包名，维护责任与收益不匹配。否。
- **源码继续 vendor + 发行时依赖上游名**：发布物里 `@earendil-works/pi-ai@0.86.1` 是上游字节，仓内链接的是「0.85.1+11d 快照」，两者版本号撞成同一个数字——**开发跑的代码与生产跑的代码静默不同**，且无法用版本号表达差异。这正是 ADR-0028 拒绝 npm alias 的理由换了个方向出现。否。
- **把四包合成一个自有包 `@review-agent-pi/pi-kernel`**：包数从 6 降到 3，但仍要维护 fork，还要把四套 `exports` 子路径聚合成一份（`./node`、`./harness/*`、`./providers/*` 都要重新设计），成本高于直接用上游，收益只是少两个包名。否。
- **只发 `review-pi`，四包继续 vendor 但 `private`（`file:` 依赖）**：`npm i -g` 无法解析 `file:` 到包外路径，安装即失败。否。
- **单包 bundle（把上游四包 + review-pi 打成一个大文件）**：ADR-0028 已否决（丢 `source`/可调试性、presentation/wasm/二进制难处理）；且四包既已从发布面消失，bundle 的收益只剩「省几次 npm 下载」，不抵成本。否。
- **版本用 `^0.86.1` 或 `latest`**：`npm i -g` 绕过 lockfile，浮动版本会让「同一台机器昨天和今天跑的不是同一份代码」。否——精确锁 + ADR 留痕。
- **`review-llm` 并入 `review-pi/src/llm/`**：见 §3，无消费者的代码搬进产品包会制造第二处真源。否（有条件例外已写明）。

## Consequences

- **正**：
  - 用户侧从「六个 tarball 一起装 / 六个包都得发到同一个 registry」变成 **`npm i -g review-pi` 一条命令**；
  - 不再发布「上游定制件」形态的包，包名、版本、内容的责任边界清晰；
  - 仓体积砍掉 5.6 万行；打包/校验/发布从 6 份变 1 份；`build:pi` 段消失，构建与 CI 变快；
  - 上游更新从「cherry-pick + 重跑 112 文件 specifier 重写」变成「改版本号 + 跑门」，ADR-0028 自己列的头号负项（import 行冲突面）消失。
- **负 / 风险**：
  - **锚点漂移**：0.86.1 ≠ `6671c604`。切换后必须重跑全门 + 一次真实网关实跑；最可能出问题的是 `agent/harness/runtime/drive/*`（retry / response / boundary 有改动）与 `ai/utils/event-stream.ts`、`ai/api/openai-completions.ts`；
  - **失去源码在手**：仓内不能再跑上游四包测试（它们本来就不进 CI 门，Windows 上还红）；将来要改内核走 `pnpm patch`；
  - **首次安装需要网络**：`verify:pack` 现在主张「不联网」，切换后需要拉四个上游包。缓解：用 pnpm store 的 `--offline`（仓内 `pnpm install` 已把四包与第三方依赖灌进 store），把「离线」重新定义为「离线于 store 缓存」；
  - **供应链**：`@earendil-works` 是上游 scope 且改过一次名。内网交付需在 nexus 代理该 scope（或缓存 tarball），并有 lockfile + 精确版本兜底；万一上游删版本，走 `pnpm patch`/自建镜像；
  - **数据门消失**：`check:model-data` 不再在仓内跑，模型目录改为随上游版本走（确定性由版本号钉住，性质不变）；
  - **`review-llm` 的三个测试文件（29 例）消失**：它们覆盖的是无消费者的代码，用例数下降需要逐条解释而不是当作回归。
- **中性**：
  - wire 字节、产物契约（`reviews_en.json` / `reviews_tips_zh.json` / 审计）、配置面、CLI 旗标面全部不变；
  - 本 ADR 不引入运行时开关或新的用户可见配置键；
  - `packages/review-pi/src/**` 的产品代码除 specifier 外零改动。

## 实施清单

按提交切分，每步独立可回滚；S1 与其余步骤无依赖，可先合。

### S0 基线留痕（不改代码）

- 记录当前基线：`pnpm --filter review-pi test` = 51 文件 / 491 passed + 1 skipped；`pnpm --filter review-llm test` = 3 文件 / 29 例；`pnpm test`（根）= 5 文件；`pnpm typecheck` 0 错；`pnpm --filter review-pi build` 成功；
- 保存一次真实网关基线产物的**结构指纹**（不用存全文）：`findings` 数、`tips` 组数/条数、审计 `ruleSkill[]` 的 key 集合、`usage` 字段集合、`skill bash` 调用次数。S5 用它做对照。

### S1 `review-llm` 删除 → 单包（零行为变化）

| 文件 | 改动 |
|---|---|
| `packages/review-llm/**` | 整目录删除（含 3 个测试文件） |
| `packages/review-pi/package.json` | 删 `"review-llm": "workspace:*"` |
| `packages/review-pi/bin/lib/cli-runtime.js` | `PACKAGE_LEGS` 删 review-llm 一条腿；头部注释同步 |
| `packages/review-pi/src/cli/cli-runtime.test.ts` | `EXPECTED_PACKAGE` 删 `review-llm`（腿数 6 → 5） |
| `packages/review-pi/src/cli/bin.process.test.ts`、`config.process.test.ts` | 期望的腿构建命令表删 `pnpm --filter review-llm build`；`bin.process.test.ts` 的 `beforeAll` 自愈构建 `buildOrder` 同步去掉该命令 |
| `packages/review-pi/tsconfig.build.json` | 删 `"review-llm"` path 与其注释 |
| 根 `package.json` | 删 `dependencies.review-llm`；`build:dist` 去掉 `--filter review-llm build` |
| 根 `tsconfig.json`、`vitest.config.ts` | 注释中关于 review-llm 的表述同步（`conditions: ["source"]` 保留——根 `src/presentation` 测试仍 import `review-pi` 的源码） |
| `.github/workflows/ci.yml` | 删 review-llm 的 typecheck / test 步骤与 build 行 |
| `tests/presentation/translate-projection.test.ts` | 允许名单去掉 `specifier === "review-llm"`，注释改为「呈现层零 LLM 客户端依赖（自持 fetch）」——当前断言是空集成立的假护栏 |

### S2 依赖切换（一次性 codemod + 删包 + lockfile）

| 文件 | 改动 |
|---|---|
| `packages/review-pi/package.json` | 加四个 `@earendil-works/*` 精确依赖；删四个 `@review-agent-pi/*` |
| 全仓存活面约 29 个文件（`packages/review-pi` 26 + 根 `package.json` / `tsconfig.json` / `pnpm-lock.yaml`） | `@review-agent-pi/pi-ai → @earendil-works/pi-ai` 等四条反向替换（`@review-agent-pi/chord` 注意无 `pi-` 前缀）；被删四包目录内的 112 处替换随删包一起消失 |
| 根 `tsconfig.json` | 删 `paths` 中四条内核映射 |
| `packages/review-pi/tsconfig.build.json` | 删 `paths` 中四条内核映射；`tsconfig.json` 的头部注释改写（不再是「vendored 源码进入程序」，而是「上游 d.ts」） |
| `packages/review-pi/tsconfig.json` | 头部注释改写；**可选加严**：`noUncheckedIndexedAccess` / `exactOptionalPropertyTypes` / `allowImportingTsExtensions` 本是「vendored 源码进程序」的让步，切换后可尝试恢复根级严格 flags（先跑一次看违例数，不为加严单独重写产品代码） |
| `packages/{ai,agent,chord,telemetry}/**` | 整目录删除 |
| `packages/review-pi/src/cli/cli-runtime.test.ts` | `EXPECTED_PACKAGE` 的包名改为上游名、标签去掉 `(vendored)`；`renderRefusals` 用例里「未解析腿 → `pnpm build:pi`」改为安装指引（内核腿不再是本仓构建） |
| `packages/review-pi/src/cli/bin.process.test.ts`、`config.process.test.ts` | 自愈构建 `buildOrder` 删 `pnpm build:pi`（内核腿走安装布局，不再参与判鲜） |
| `pnpm-workspace.yaml` | 保持 `packages/*`（此时只剩 review-pi）；`allowBuilds` 不变 |
| `pnpm-lock.yaml` | 重新生成（`pnpm install`） |

### S3 脚本 / 打包面收敛

| 文件 | 改动 |
|---|---|
| 根 `package.json` | 删 `build:pi`；`build:dist` 只剩 review-pi + presentation；`pack:packages` / `verify:pack` / `publish:packages` 语义改为单包 |
| `scripts/pack-packages.mjs` | `PACKAGES` 收为 `["packages/review-pi"]`；拓扑序注释改写 |
| `scripts/verify-pack.mjs` | `SOURCE_PACKAGE_DIRS` 收为一个；第三方依赖 junction 逻辑保留，另把四个上游包从 pnpm store 离线装进 staging（或用 `--offline`） |
| `scripts/prepare-package.mjs` | 断言列表不变；`THIRD-PARTY-NOTICES.md` 的「上游名 → 本仓发布名」对应表改写为「上游包直接作为运行时依赖」 |
| `THIRD-PARTY-NOTICES.md` | 履约表述同步（仍保留 MIT 原文 + 数据出处 + 依赖清单） |

### S4 文档

| 文件 | 改动 |
|---|---|
| `README.md` | 包表（6 → 1）、目录树（删四个包目录）、`build:pi` 相关命令、安装形态；**`:173` 的「provider 参数画像与常量单源」改写** |
| `CONTEXT.md` | 发行形态段、包表、`review-llm` 角色段（删或改写为历史）；**`:172` 的「单源查表（review-llm）」必须改写**——pi 线是单档锁死，画像表从未接线 |
| `docs/使用手册-安装与运行.md` | §2.3 私有 registry（不再需要 scope 映射）、§2.4 六个 tarball → 一个、§2.7 打包、§8.4 排障表的 404/ETARGET 行（**含 `:523` 的「Cannot find module 'review-llm'」**）、§9 usage |
| `docs/adr/0008-*.md` | 加「后续修订（ADR-0035）」：参数画像表 / 退役 id 拒绝 / resolver 环境变量链在 pi 线从未接线；多模型画像若要恢复，按新功能立项 |
| `docs/运行手册-单次检视.md` | 若提到包结构/腿表 |
| `docs/UA_ONBOARDING.md` | **LLM 抽象层** 行与 `review-llm/src/*` 引用、架构图里的包清单 |
| `docs/adr/0009-*.md` | 加「后续修订（ADR-0035）」：vendor 前提改为「默认消费上游 dist，需改内核时走 `pnpm patch`」 |
| `docs/adr/0028-*.md` | 加「后续修订（ADR-0035）」：§1/§2/§4/§6 被取代，§3/§5/§7 保留 |
| `docs/design/Pi 内核定制基线方案.md` | 加文首说明：§2–§6 为历史事实（vendoring 期）；当前形态见 ADR-0035 |

### S5 全门 + 真实网关

见 §验收标准。任一门前红，回退到 §2 的下一个版本重来；不要把「红门」当成「上游差异可接受」。

## 验收标准

1. **依赖面**：`pnpm install` 后 `node_modules/@earendil-works/{pi-ai,pi-agent-core,chord,pi-telemetry}` 在位且版本一致；`node -e` 解析四个包的 `./node` / `./providers/deepseek` 子路径成功。
2. **构建**：`pnpm build:dist` 只构建 `review-pi` + presentation，全绿；`tsc` 全程消费 `.d.ts`（无 TS5097 / TS6059）。
3. **门**：`pnpm typecheck`、`pnpm --filter review-pi typecheck`、`pnpm test`（根 5 文件）、`pnpm --filter review-pi test`（51 文件 / 491 passed + 1 skipped）全绿。用例数变化只允许来自被删的 `review-llm` 测试（3 文件 / 29 例），且逐条说明。
4. **打包**：`pnpm pack:packages` 产出**1 个** tarball；内容面仍含 `dist/cli/main.js` / `bin/review-pi.js` / `presentation/engine-zh.js` / `THIRD-PARTY-NOTICES.md`，不含 `src/**/*.ts`。
5. **安装面**：`pnpm verify:pack` exit 0——bin 腿表在安装布局下四条内核腿全部解析到 `node_modules/@earendil-works/*`；`config init/show`、`builtin` 引擎、tree-sitter wasm、ripgrep 二进制可用。
6. **真实网关**：一次实跑 exit 0，与 S0 的结构指纹逐项一致；不一致处必须给出归因（版本差异 / 断言过时 / 真实回归），真实回归即回退版本。
7. **零残留**：`git grep -n "@review-agent-pi/"` = 0（历史 ADR / 历史报告 / 履约文本中的历史名除外）；`git grep -n "review-llm"` 只命中历史文档。
8. **文档**：§S4 全部落地；ADR-0009 / 0028 的「后续修订」块就位，且本 ADR 补上「执行记录」（实际锁定版本、门结果、真实网关结论）。

## 事实来源（可复核）

| 结论 | 复核方式 |
|---|---|
| 上游四包已发布、0.85.1 存在、latest 1.5.0 | `npm view @earendil-works/pi-ai versions/dist-tags --json`（四包同） |
| tarball 只含 dist、数据 40 条目、子路径齐全 | `npm pack @earendil-works/pi-ai@0.85.1` + `tar -tzf` |
| 依赖面与本仓一致 | `npm view @earendil-works/pi-ai@0.85.1 dependencies` vs `packages/ai/package.json` |
| 锚点与 v0.85.1 的差异面 | GitHub compare API `v0.85.1...6671c604766b3670ed95f405aa7856835d0ca702`（79 commits / 257 files / 四包 src 33 个） |
| 四包源码零定制 | `git log --oneline -- packages/{agent,ai,chord,telemetry}`（只有整树快照 + ADR-0028 两次提交）+ 《Pi 内核定制基线方案》§4/§9 |
| `review-llm` 无消费者 | ①`git grep "review-llm"`（源码只有注释/declaration/tsconfig paths/测试允许名单）；②`dist/**` 内无 `from "review-llm"`（仅 `shared/config` 一条注释）；③`git log -S 'from "review-llm"' --all` 为空；④根 `src/` 仅 import `node:*` + `review-pi` |

---

## 执行记录（2026-11-03）

### 1. 版本判定：0.86.1 → 0.86.0 → 0.85.1

按决策 1 的顺序实际试装，前两个都被**构建门**挡住（不是测试门，是 `tsc` 红）：

| 版本 | 结果 | 失败形态 |
|---|---|---|
| `0.86.1` | ✗ | ①`src/export/transcript.ts:291` 的 `toolResult` 成员被收窄成 `never`（`TS2345`），`:341/349/355/357/363` 连带 `TS2339`；②`src/provider/pi-client.ts:88` `Context` 不可赋给 `TranscriptContext`（`TS2345`）——`TranscriptContext` 是带 `unique symbol` brand 的类型，裸 `Context` 不再被 `deepseekProvider().stream()` 接受；③`:179` 的 model 返回类型不兼容（`TS2322`） |
| `0.86.0` | ✗ | 与 0.86.1 同源的 `TranscriptContext` brand 断裂（`transcript.ts` 的 `never` 收窄 + `pi-client.ts:88`），且安装后 `.pnpm` 里出现**两份 pi-ai**（`@earendil-works+pi-ai@0.86._b859…` = 0.86.0、`…_c904…` = 0.86.1，见下条注） |
| `0.85.1` | ✓ | 构建、typecheck（根 + 包）、测试、`build:dist`、打包、安装面全绿 |

> 0.86.0 那次的两份 pi-ai 是反复切换版本时 pnpm store 的残留，`pnpm install` 已收敛；不作为该版本被拒的理由，列在此处只为说明当时观察到的现象。

**结论**：锁定 **`0.85.1`**，四包同版本成套、精确（不带 `^`）。0.86.x 的 `TranscriptContext` 是一次**有意收窄的公开 API 变更**，要跟进就得改 `review-pi` 的 `Context` 构造方式（新增 brand）——那是独立的适配工作，不属于本次「换依赖来源」的范围，故按判定序退版，不硬改上游契约。

### 2. 严格性欠账（测试侧 32 处，已记账）

内核四包不再有 vendored 源码进入本包程序后，`packages/review-pi/tsconfig.json` 把 `allowImportingTsExtensions` 收回了，但保留两处放宽：

```json
"noUncheckedIndexedAccess": false,
"exactOptionalPropertyTypes": false
```

原因是该 tsconfig 的 `include` 覆盖 `src/**`（含 `*.test.ts` 与 `src/testing` 夹具），其中 32 处**既有测试写法**过不了全量严格：

| 文件 | 处数 | 典型 |
|---|---|---|
| `src/run/review-run.test.ts` | 26 | `TS2532 Object is possibly 'undefined'`（数组下标 / 可选属性） |
| `src/loop/agent-review-loop.test.ts` | 3 | 同上 + `TS2345 string \| undefined` |
| `src/run/mr-boundary-guard.test.ts` | 1 | `TS2532` |
| `src/experiment/run-record.test.ts` | 1 | `TS2379 exactOptionalPropertyTypes`（`auditPath: undefined`） |
| `src/testing/vul4j1-script.ts` | 1 | `TS2532` |

**product 代码不受影响**：`tsconfig.build.json` 把两个 flag 收回到全量严格，`pnpm build:dist` 是 CI 门。这 32 处属于「测试夹具风格清理」，作为独立清理项，不在本次切换里逐条加非空断言（纯噪声、且会把注意力从真关注点引开）。

### 3. vitest 的 `source` 条件必须撤

ADR 的执行清单里只写到「根配置改 alias」，实际执行时**包内配置也必须改**。原因：上游四包也声明了 `source` 条件，且指向**未随 tarball 发布**的 `.ts` 源；全局开 `resolve.conditions: ["source"]` 会让 vitest 去解析 `node_modules/@earendil-works/pi-agent-core/dist/harness/context.js` 里 import 的 `@earendil-works/chord/src/context/index.ts`——文件不存在，8 个 suite 直接 `Cannot find module`。

处置：
- `packages/review-pi/vitest.config.ts`：删掉 `resolve.conditions`（测试 import 全是包内相对路径 + npm 依赖，默认条件即可）；
- 根 `vitest.config.ts`：改为 `resolve.alias` 把 `^review-pi$` 指到 `packages/review-pi/src/index.ts`（root 呈现层测试只 import 类型与少量运行时契约，要跑当前源码而不是陈旧 dist）。

### 4. 腿表（`bin/lib/cli-runtime.js`）的实际落点

结构不改，四条内核腿自动落入「安装布局」分支（只判在位、不判 mtime）：

- label 去掉 `(vendored)` → `pi-ai` / `pi-agent-core` / `chord` / `pi-telemetry`；
- `buildCommand` 由 `pnpm build:pi` 改为 `pnpm install`；
- `renderRefusals` 对 `pnpm install` 打「先安装依赖」，其余仍打「先构建/重建」；
- 自愈构建序（`bin.process.test.ts` / `config.process.test.ts`）只剩 `pnpm --filter review-pi build`——依赖真缺席时由人显式 `pnpm install`（拒跑文案给指引），测试不代跑安装。

### 5. 全门结果（S5）

| 门 | 结果 |
|---|---|
| `pnpm typecheck`（根） | exit 0 |
| `pnpm --filter review-pi typecheck` | exit 0（两处 flag 放宽见 §2） |
| `pnpm build:dist` | exit 0（只构建 `review-pi` + presentation） |
| `pnpm --filter review-pi test` | **51 文件 / 492 passed + 1 skipped**（S0 基线同为 51 / 492+1；ADR 正文验收标准里的「491」是笔误，实际一直是 492） |
| `pnpm test`（根） | **5 文件 / 52 passed** |
| `pnpm pack:packages` | 1 个 tarball：`review-pi-0.1.0.tgz` 284.4 KiB |
| `pnpm verify:pack` | 全绿（「单包发行面可用」） |

用例数不变：删掉的 `review-llm` 测试（3 文件 / 29 例）本来就不在这两个计数里（它的 `test` 脚本由 CI 单列，且 `review-llm` 的测试从未进过 review-pi 的 51 个 suite）。

### 6. 真实网关对照（S0 vs S5）

命令（两次完全相同）：

```text
review --repo .cache/datasets/vul4j-repos/VUL4J-38-ab6cbdc3da
       --mr-diff .cache/datasets/vul4j-diffs/VUL4J-38.diff
       --issue "Vulnerability CVE-2014-4172 (CWE-74) in apereo/java-cas-client. Fixed by https://github.com/apereo/java-cas-client/commit/ab6cbdc3daa451b4fef89c0bd0f4e6568f3aa9ef."
       --rule-skill-zip packages/review-pi/testdata/rule-skills/general-code-review.zip
```

S0 = `f-demo-session-skill-2`（vendored 内核，2026-11-03 08:24）；S5 = `f-s5-regression2`（npm 0.85.1，2026-11-03 09:49）。两次都 exit 0。

**请求面逐字节一致**（这是本次切换「没有改变 wire」的硬证据）：

| 项 | S0 | S5 |
|---|---|---|
| system prompt sha256[:16] | `76372d45fe7352b0` | 同左 |
| tools schema sha256[:16] | `1893dd2c2432b040` | 同左 |
| user 消息 1 / 2 sha256[:16] | `6f0ded71f091adb1` / `f5f3ffc1fc1ae01b` | 同左 |
| wireBody 键与值 | `model` / `stream` / `stream_options` / `max_tokens=32768` / `thinking{enabled}` / `reasoning_effort=high` / 7 个 `review.*` 工具 | 同左 |
| 配置 digest | `d91eaf0ea2b3` | 同左 |

**结构指纹**：

| 项 | S0 | S5 | 判定 |
|---|---|---|---|
| findings 数 | 9 | 11 | 模型采样差异（均 1 轮、未截断；请求面逐字节相同） |
| findings 键集 | 10 键封闭 | 同左 | ✓ |
| tips 文件 | 在场 | 在场 | ✓ |
| tips 组数 / 条数 | 3 / 9 | 2 / 8 | 条数差来自 ADR-0023 的 (file,line) 去重：S5 有 3 处同行多 finding 合并，11−3=8 |
| tips 组键 / tip 键集 | `filePath,reviewTips` / 10 键封闭 | 同左 | ✓ |
| 审计 `usage` 字段集 | `cacheReadTokens,inputTokens,outputTokens` | 同左 | ✓ |
| 审计 `ruleSkill[]` 键集 | `digest,name,source` | 同左 | ✓ |
| 审计 `skillPassLog[]` 键集 | 9 键（`candidateCount,mergedCount,requestCount,round,ruleIds,skill,status,toolCallCount,transcriptFile`） | 同左 | ✓ |
| `phaseLog` 键集 | `0..5` | 同左 | ✓ |
| 工具名集（主循环） | 7 个 `review.*` | 同左 | ✓ |
| rule skill 会话 bash 次数 | 0 | 0 | ✓ |
| rounds / toolCalls / requests | 1 / 19 / 13 | 1 / 27 / 14 | 模型路径差异（非结构性） |

**归因**：所有差异都落在「模型输出内容与它选择的工具调用数」上（temperature 采样 + 单次跑波动，ADR 早已写明「单次结果 ≠ 基线」）；请求面、审计 schema、产物 schema、去重规则全部一致。内核从 vendored `v0.85.1+11d` 换成 npm `0.85.1` 的差异**没有体现在 wire 面**，也没有造成结构回归——**不回退**。

### 7. 一处既存松动（本次不修，记为后续项）

`RULE-CHECK@…` 条目的 `category` 是**模型自由文本**，skill 会话不做大小写/枚举归一。S0 那次模型给的是大写（`ERROR_HANDLING` / `SECURITY`），S5 这次给的是小写（`error-handling` / `input-validation` / `privacy`），于是同一次产物的 `findings[].category` 出现大小写混排。

这与 ADR-0035 无关（`skill-pass` 的解析逻辑没动，`candidate-merge` 的 (file,line,category) 去重键也因此对大小写敏感）。作为独立清理项记录：要么在 skill-pass 解析处把 `category` 归一为大写枚举，要么在 schema 里明确它是自由文本并放开消费侧假设。**不建议**在本次切换里顺手改（会改变既有产物的去重行为）。

### 8. 文档与零残留

- S4 覆盖：`README.md` / `CONTEXT.md` / `AGENTS.md` / `CLAUDE.md` / `docs/使用手册-安装与运行.md` / `docs/运行手册-单次检视.md` / `docs/UA_ONBOARDING.md`；ADR-0008 / 0009 / 0028 各加「后续修订」；`docs/design/Pi 内核定制基线方案.md` 文首加历史说明。
- 额外收口：`.gitignore` 里「packages/ai 工具产物」的注释改写；`docs/render_architecture.py` 与 `docs/png/architecture-call-flow.dot` 标注为 ADR-0024 之前的冻结历史图；`docs/项目问答整理.md` 顶部加时效说明。
- 零残留核对：`@review-agent-pi/` 只剩历史 ADR / 设计基线方案 / 履约文本 / 问答快照中的历史名；`review-llm` 只命中历史文档（ADR-0002/0006/0008/0009/0028、设计文档、历史报告、问答快照、CONTEXT 的 `_Avoid_` 反面清单、UA_ONBOARDING 的「已删除」说明）。源码与配置面为 0。

