# 0028. 发行形态 A：npm 多包（scope 化内核四包 + 两个产品包）

**状态**：已接受（2026-10-31；ADR-0025 / 0026 / 0027 落地后的分发批次）
**关联**：ADR-0009（pi 内核从 0 重写）、ADR-0024（仓收窄为 Review CLI 产品仓）、ADR-0025（用户级 JSONC 配置）、ADR-0026（引擎路径与判档单源）、ADR-0027（产物路径与规则包信任边界）
**跨仓**：本 ADR 为本仓 pi 线序列 0028；DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

ADR-0024 把仓收成「一次检视」的产品 CLI，ADR-0025–0027 把配置面、产物面与输入面收到可交付状态；但**代码能跑 ≠ 能装上跑**：

1. **包名不是我们的**：vendored 四包沿用上游名 `@earendil-works/{pi-telemetry,chord,pi-ai,pi-agent-core}`。这些 scope 属于上游，本仓既无发布权限，也不应冒充上游发布定制件。
2. **两个产品包标了 `private`**：`review-pi` / `review-llm` 只在 workspace 内可见（`workspace:*` 链接），装不到用户机器上。
3. **仓内吃源码、安装形态必须吃 dist**：`exports.source` 条件让仓内 vitest / typecheck 直接读 `src/*.ts`；npm 安装方只会拿 `dist`。两种形态必须由同一个包名承载，而不是两套 specifier。
4. **包里有非 TS 资产**：`review-pi` 的 `presentation/`（中文投影制品）、`packages/ai/dist/providers/data`（模型目录）、`tree-sitter-java` 的 wasm、`@vscode/ripgrep` 的二进制、`THIRD-PARTY-NOTICES.md`（MIT 履约文本在仓根，不在包内）。
5. **Windows 的 CRLF shebang 会被 `pnpm pack` 直接拒绝**（`ERR_PNPM_BIN_CRLF`），Unix 上 `/usr/bin/env node\r` 也找不到解释器——发布物必须由版本库固定行尾，而不是靠开发者本机设置。

分发形态有三个候选：**A. npm 多包**、**B. 单包 bundle**、**C. `private` + `file:` / git 依赖**。本 ADR 采纳 A。

## Decision

### 1. 发布六个包，两个 scope

| 包名 | 版本 | 角色 |
|---|---|---|
| `@review-agent-pi/pi-telemetry` | `0.85.1` | 上游 telemetry 定制件 |
| `@review-agent-pi/chord` | `0.85.1` | 上游 chord 定制件 |
| `@review-agent-pi/pi-ai` | `0.85.1` | 上游 pi-ai 定制件（含 39 个 provider 模型数据） |
| `@review-agent-pi/pi-agent-core` | `0.85.1` | 上游 agent 定制件 |
| `review-llm` | `0.1.0` | LLM 接入共享缝（产品依赖） |
| `review-pi` | `0.1.0` | Review CLI（`bin: review-pi`，唯一面向用户的入口） |

- **内核四包版本锁 `0.85.1`**：它表达「这是上游 v0.85.1+11d 的定制件」，升级上游锚点时跟着升，不与产品版本混同。
- **两个产品包独立 `0.1.0`**：产品形态还在演进，版本号跟产品走。
- `review-pi` 的 `engines` 为 `>=22.19.0`（与 pi 内核一致）；`review-llm` 同步。

### 2. specifier 一改到底，不用 npm alias

仓内所有 `import` / `tsconfig paths` / vitest alias / bin 腿表都写成**发布名**：

```ts
import { ... } from "@review-agent-pi/pi-ai";        // 不是 @earendil-works/pi-ai
import { ... } from "@review-agent-pi/pi-agent-core";
```

- **为什么不用 alias**（`"@earendil-works/pi-ai": "npm:@review-agent-pi/pi-ai@..."`）：运行时会出现两个包名指向同一份代码，types 解析、pnpm dedupe 与上游同步都要多一层翻译；且上游 scope 不是我们的，把它留在真源里等于永远无法干净发布。
- **代价（明写）**：上游 cherry-pick 的冲突面从「构建接线」扩大到「import 行」。同步上游时按《Pi 内核定制基线方案》§9 的流程处理，specifier 重写在同一步完成。
- 一次 codemod 覆盖 112 个文件（源码 / 测试 / `package.json` / tsconfig / vitest 配置 / bin 腿表 / 根 `build:pi` 脚本）。

### 3. `exports` 三条件 + 发布面

每个包的 `exports` 条目固定三条：

| 条件 | 目标 | 消费者 |
|---|---|---|
| `types` | `./dist/*.d.ts` | 安装方的 tsc |
| `source` | `./src/*.ts` | 仓内 vitest / typecheck（`customConditions` 不含 `source` 时自动落到 `import`） |
| `import` / `default` | `./dist/*.js` | 运行时 |

外加 `"./package.json": "./package.json"`（工具读包元信息）。

- **tarball 不含 `src`**：`files` 只列 `dist`（+ `README.md`；`review-pi` 另含 `bin` / `presentation` / 履约文本）。源码留在仓内，发布物是「可执行制品 + 类型声明」。
- 发布物的 `exports.source` 仍指向未随包发出的 `src/*.ts`：默认解析器不选用该条件（Node 默认 `import` / `default`），只有显式开启 `source` 条件的仓内工具链才会命中；因此它不影响安装方。
- `chord` 的 `src/delta/README.md` 是上游文档而非源码，打包时允许随包（不属于源码泄漏）。

### 4. `review-pi` 的发布面与 `prepack`

`files` = `dist` / `bin` / `presentation` / `THIRD-PARTY-NOTICES.md` / `README.md`。

`prepack`（`scripts/prepare-package.mjs`）做两件事：

1. 把仓根 `THIRD-PARTY-NOTICES.md` 复制进包目录（npm tarball 不能引用包根之外的文件，而履约文本是四包与产品包共用的）；
2. **断言** dist / bin / presentation / 履约文本全部在位——缺产物就人话报错并指向 `pnpm build:dist`。

打包必须是**确定性 + 离线**的：`prepack` 不隐式触发构建。复制的 notices 被 `.gitignore` 忽略，不入库。

### 5. LF shebang 由版本库固定

`.gitattributes`：

```gitattributes
* text=auto
packages/review-pi/bin/** text eol=lf
scripts/** text eol=lf
```

`pnpm pack` 对 CRLF shebang 报 `ERR_PNPM_BIN_CRLF`；这是发行物的硬约束，不能留给本机 git 配置。

**属性不是充分条件**：`.gitattributes` 只在**检出/写入**时生效，旧工作区里已经落地的 CRLF 不会被 `git pull` 重写（git 认为 blob 内容没变）。于是会出现「属性写对了、`git ls-files --eol` 显示 `i/lf w/lf`、打包仍报 CRLF」——实际是别的 bin 文件或做过本地改动的文件行尾漂移。处置分两层：

1. **兜底（自动）**：`prepack`（`scripts/prepare-package.mjs`）检查 `packages/review-pi/bin/**/*.js`，凡首行以 `#!` 开头且带 CR 的文件，整文件重写为 LF，并在 stdout 打一行提示（不静默改工作区）。
2. **拦截（手动）**：`pnpm verify:pack` 在**安装布局**里再读一次 `bin/review-pi.js` 首行，带 CR 直接失败并给出重检命令，避免「Windows 自测通过、Unix 上跑不起来」。

根治仍是按属性重检：`rm -rf packages/review-pi/bin && git checkout -- packages/review-pi/bin`。

### 6. 构建 / 打包 / 验证 / 发布四段分离

```bash
pnpm build:dist        # build:pi → review-llm → build:presentation（产物齐全）
pnpm pack:packages     # 6 个 tarball → .artifacts/tarballs/（拓扑序）
pnpm verify:pack       # 离线安装布局冒烟（不联网、不发布）
pnpm publish:packages  # pnpm build:dist && pnpm -r publish（人工确认 registry/凭据）
```

`verify:pack` 的做法：把 tarball 解到临时 `node_modules/`（模拟 npm 安装布局），再按包 junction 仓内已安装的第三方依赖（只借依赖，不借源码），断言：

1. tarball 内容面（dist / bin / presentation / 履约文本；不含 `src/**/*.ts`）；
2. bin 腿表在安装布局下能定位全部运行时腿，main 入口能跑到用法提示；
3. `config init` / `config show --json` 在安装布局下可读可写；
4. `presentation.engine = "builtin"` 解析到包内 `presentation/engine-zh.js`；
5. `tree-sitter-java` wasm 与 ripgrep 二进制在安装布局下可用。

**包名不在脚本里写死**：`verify-pack.mjs` 从各包 `package.json` 派生包名，换 scope 只改包清单。

### 7. scope 可换，形态不换

`@review-agent-pi` 是当前选择的占位 scope。换到公司 registry 的 scope 时，真源仍是六个 `package.json` 的 `name` 与全仓 specifier（一次 codemod）。本 ADR 固定的是**多包形态 + 三条件 exports + 发布面 + 四段流水线**，不固定 scope 字面量。

## Options（为什么不是别的）

- **B. 单包 bundle（ncc / esbuild 打成一个大文件）**：产物小、安装简单，但丢失 `source` 条件与源码可调试性；内核四包本来有独立测试面（上游测试作为信号采集），打成黑盒后升级与定位都变差；`review-pi` 的 presentation / wasm / 二进制还要额外处理。放弃。
- **npm alias 保留上游名**：运行时双名、types 双解析，且上游 scope 不是我们的，无法作为长期真源。放弃。
- **`private` + `file:` / git 依赖分发**：没有 registry，版本不可解析，安装要 git 凭据，`npm i -g` 不可用——对「装完就能跑」的产品形态不够。放弃。
- **发布到上游 `@earendil-works` scope**：无权限，也不应冒充上游发布定制件。放弃。
- **把 `src` 一起发**：tarball 变大、`source` 条件失去意义，且让安装方可能运行未编译源码。放弃。

## Consequences

- **正**：
  - `npm i -g review-pi` 即可用，不再需要 clone 仓；
  - 六个包可独立升级、独立复用；内核定制件与产品包的版本语义分开；
  - 仓内开发仍吃 `source` 条件（vitest / typecheck 读源码），安装方吃 `dist`，同一个包名承载两种形态；
  - 打包、验证、发布三段可分别重跑；安装面冒烟不需要网络与 registry。
- **负/风险**：
  - **上游同步冲突面扩大**到 import 行（§2）；同步上游时需重跑 specifier 重写；
  - `pnpm-lock.yaml` 按新包名重写，首次 `pnpm install` 会重建 workspace 链接；
  - `pnpm -r publish` 会执行各包 `prepublishOnly`（内核四包 `clean && build`），发布前必须 `pnpm build:dist`；
  - Windows 上 `pnpm pack` 必须经 shell（`pnpm.cmd` + `shell: true`），打包脚本已处理；
  - 发布顺序依赖 pnpm 的拓扑序（默认行为），不能 `--parallel`；
  - 包内 `repository` 字段仍指向上游仓（履约与出处），产品包的 `repository` 指向本仓。
- **中性**：
  - wire 字节、产物契约（`reviews_en.json` / `reviews_tips_zh.json` / 审计）、配置面（ADR-0025/0026/0027）全部不变；
  - 本 ADR 不引入运行时开关或新的用户可见配置键。

## 验收标准

1. **构建**：`pnpm build:dist` 全绿（`build:pi` → `review-llm` → `build:presentation`）。
2. **打包**：`pnpm pack:packages` 产出 6 个 tarball；`review-pi` 的 tarball 含 `dist/cli/main.js`、`bin/review-pi.js`、`presentation/engine-zh.js`、`THIRD-PARTY-NOTICES.md`，且不含 `src/**/*.ts`。
3. **安装面**：`pnpm verify:pack` exit 0——bin 腿表 + main 入口、`config init/show`、`builtin` 引擎、tree-sitter wasm、ripgrep 二进制在安装布局下全部可用。
4. **specifier 归一**：产品代码与配置中 `@earendil-works/` 为零（历史 ADR / 历史报告 / 履约文本中的上游名除外）。
5. **门**：`pnpm --filter review-pi test`、`pnpm test`、`pnpm typecheck` 全绿。
6. **文档**：README / 运行手册 / `CONTEXT.md` 记录安装形态、发布命令与包表；`THIRD-PARTY-NOTICES.md` 明确「上游名 → 本仓发布名」的对应关系。
