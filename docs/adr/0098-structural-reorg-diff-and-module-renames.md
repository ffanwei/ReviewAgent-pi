# 0098. 模块结构重整：统一 diff 解析层、解环与目录改名

**状态**：已接受（2026-11-17，用户决策）
**关联**：[ADR-0009](0009-rewrite-review-runtime-on-pi.md)（pi 线从 0 重写，目录遗留自此继承）、[ADR-0024](0024-single-review-form-and-retire-evaluation.md)（评测仪器层退役，`experiment/` 与 `zoneb/` 已成历史名词）、[ADR-0035](0035-upstream-kernel-as-npm-deps-and-single-package.md)（发行面单包）、[ADR-0091](0091-retire-presentation-layer.md)（呈现层退役，根层 `src/` 清空）
**范围**：只动包内目录 / 模块边界与解析实现的组织方式；**不改** CLI 参数、stdout / stderr 字节、退出码、产物格式、审计 / 转录 / MCP 报文、模型请求字节。`index.ts` 的公开导出面不变。

## Context

结构盘点发现四类问题（2026-11-17）：

1. **unified diff 解析有 5 份实现**：`run/mr-input`（块切分）、`run/mr-boundary-guard`（严格度量）、`run/repo-side`（两侧块比对）、`gate/diff-scope`（新侧区间）、`analysis/diff-analysis`（旧侧区间）。同一套 `@@` 与路径词法（含 git 引号 + 八进制解码）各写一遍，口径靠 ADR 纪律对齐而不是共享类型。
2. **模块间环依赖**（运行时）：`loop ↔ knowledge`、`loop ↔ gate`、`codeintel ↔ analysis`（当时的 `zoneb`）、`shared → codeintel / observability`。
3. **目录名与现行语义脱节**：`zonea/`（只有系统提示词）、`zoneb/`（静态分析）是 DSH 线术语；`experiment/` 只剩生产用的 `run-record`（评测层已于 ADR-0024 删除）。
4. **根层残留**：`src/presentation` 退役后（ADR-0091），根 `src/` 为空但 tsconfig / vitest / coverage 仍指向它；根 `package.json` 仍依赖 `@baize/review-pi` 却无任何 import；README 的开发段仍在描述已删除的 `build:presentation`；`src/e2e` 只被自己的测试引用；`dist/` 构建不清理，已删模块的旧产物会被 `files` 白名单打进 tarball。

## Decision

### 1. 统一 diff 解析层（`src/diff/`）

新增四个视图，共享 `paths.ts` / `hunk.ts` 的路径与 hunk 语法：

| 视图 | 用途 | 语义 |
|---|---|---|
| `blocks.ts` | 预过滤 / 分片装箱 | 文件块切分，字节保真（块文本 join 还原输入） |
| `parse.ts` | repo 侧别 / 区间范围 | 宽松解析，按 hunk 头计数游走体行，产出两侧内容行 |
| `scan.ts` | 符号求交 | 头扫描，不消费体行（容忍数据集体行与计数不一致） |
| `measure.ts` | 边界护栏 / 收尾总结 | 严格「可完整游走」度量，结构疑点一律返回 null |

五个原消费方改为只读这些视图；`run/mr-input` 的旧导出路径（`splitDiffIntoFileBlocks` / `DiffFileBlock` / `normalizeDiffPathForRegex`）保留 re-export，调用方与测试无需同步改名。

### 2. 解环（运行时依赖图无环）

- `loop/parse.ts` → `shared/parse.ts`；`loop/request-progress.ts` → `shared/request-progress.ts`：断开 `loop ↔ knowledge`。
- `gate` 不再引用 `loop`（`VerificationVerdict` 随 parse 下沉到 `shared`）：断开 `loop ↔ gate`。
- `codeintel/language-support.ts` → `analysis/language-support.ts`（extractor 注册表属于分析层）；`codeintel/scan-defaults.ts` → `shared/scan-defaults.ts`：断开 `codeintel ↔ analysis`。
- 语言 id 清单移到 `contracts/languages.ts`：`shared/config.ts` 装载期校验不再依赖实现层。
- `shared/one-shot-llm.ts` → `provider/one-shot-llm.ts`：`shared` 不再引用 `observability`。

结果：`contracts` / `diff` 是零依赖叶子；`shared` 只依赖 `contracts`；`codeintel` 不再依赖分析层。

### 3. 目录改名（跟随现行语义）

| 旧 | 新 |
|---|---|
| `zonea/system-prompt.ts` | `loop/system-prompt.ts` |
| `zoneb/` | `analysis/` |
| `experiment/run-record.ts` | `run/run-record.ts` |
| `shared/one-shot-llm.ts` | `provider/one-shot-llm.ts` |
| `loop/parse.ts` | `shared/parse.ts` |
| `loop/request-progress.ts` | `shared/request-progress.ts` |
| `codeintel/language-support.ts` | `analysis/language-support.ts` |
| `codeintel/scan-defaults.ts` | `shared/scan-defaults.ts` |

`Zone A / Zone B` 作为**概念术语**保留在 `CONTEXT.md`（稳定前缀 / 稳定中层），但代码目录不再使用方位名。

### 4. 根层与构建清理

- 删除根空目录 `src/`；根 `tsconfig.json` / `vitest.config.ts` 只覆盖 `tests/`；根 `package.json` 删除未使用的 `@baize/review-pi` workspace 依赖。
- 删除 `src/e2e/`（只被自己的测试引用）与 `cli/one-shot-llm.ts` 兼容壳（测试随实现移到 `provider/`）。
- `build` 先清空 `dist/` 再编译，杜绝已删模块的旧产物进入 tarball。
- README 开发段按现行形态重写（`build:presentation` / `presentation` 白名单 / 9 项 prepack 校验均已不存在）。

### 5. 大文件拆分（纯结构迁移）

- `cli/main.ts`（1148 → 888 行）：片级上报编排 → `cli/shard-report.ts`；阶段账本与 `buildStageBreakdown` → `cli/stage-clock.ts`。
- `shared/config.ts`（1921 → 967 行）：通用校验工具 → `shared/config-schema.ts`；限额类型 / 缺省值 / 解析 → `shared/config-limits.ts`；MCP 类型 / 键集 / 解析 → `shared/config-mcp.ts`。`config.ts` 保留装载 / 校验 / 快照与公开 re-export，原有 import 路径不变。

## Options（为什么不是别的）

- **只抽公共正则**：路径词法与「按计数游走」才是分歧来源；只共享正则仍会各自长出不同的边界行为。否。
- **让 `diff-analysis` 复用 `parse.ts`**：数据集里的手工逆补丁常出现体行与计数不一致，体行游走会把下一个文件头吞成体行；保留独立头扫描视图（`scan.ts`）是语义要求，不是偷懒。
- **把 `one-shot-llm` 留在 `shared` 并拆 `observability`**：需要把 timeline recorder 再切一层，改动面更大；一次性模型调用本来就是 provider 层职责。否。
- **直接把 `zoneb` 改成 `analysis` 而不解环**：目录名好看了，但 `shared → codeintel → analysis` 的反向依赖仍在，层次依旧无法从目录判断。否。
- **保留根 `src/presentation` 兼容路径**：ADR-0091 已整层删除，留空目录只会误导。否。

## Consequences

- 运行时依赖图无环（`contracts` / `diff` 叶子，`shared` 仅依赖 `contracts`），新人可以从目录判断层次。
- 包内 import 路径发生变化；`index.ts` 公开导出与 `run/mr-input` 的旧导出路径保持不变。
- 新增 `src/diff/**` 单测（块保真、宽松解析、头扫描、严格度量边界），原 5 个消费方的测试全部保留并通过。
- 历史 ADR / 设计文档里的 `zoneb/` / `experiment/` 路径按**当时形态**读，不改写；现状以本 ADR、`CONTEXT.md` 与 README 为准。
