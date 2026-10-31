# 0024. 删除 A–E 配置矩阵与 `configId` 身份维度，仓库收窄为 Review CLI 产品仓

**状态**：已接受（2026-10-31，用户经 grill 逐项决策 Q1–Q12；实现分 5 个提交落地；其中「无 `--config` 旗标」一条由 [ADR-0025](0025-user-config-file.md) 废止）
**关联**：ADR-0009（pi 内核从 0 重写）、ADR-0010（语言钉英文 + 核外翻译）、ADR-0012（规则 Skill 以 config F 承载）、ADR-0013（转录与意见导出）、ADR-0014（skill 会话在候选后）、ADR-0016（运行进度投影与冻结键集）、ADR-0017 / 0022 / 0023（中文呈现产物）
**废止**：ADR-0011（生产入口 = config E 的切流决策）、ADR-0012（F 的「伪配置位」身份）、ADR-0016 中「stdout 键集含 `configId`」「审计键集冻结含配置维度」两条
**跨仓**：本 ADR 为本仓 pi 线序列 0024；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
**后续修订**：[ADR-0027](0027-runs-layout-and-rule-skill-trust.md)（2026-10-31）——本 ADR 保留的「实验目录名 `review-pi-cli` / `runs/vul4j`」一并删除，产物路径改为 `<out>/{runs,audit}/mr/<caseId>/`；本 ADR 的删除范围（A–E、`configId`、评测仪器层）不变。

## Context

本仓最初是「pi 内核线 × 五配置（A–E）受控实验 + 四层判定链」的**对照实验仓**：`configId` 是实验自变量，被写进 `RunRecord`、审计、转录文件名、`reviews_en.json` 信封、stdout、目录段与 `runId`；root 侧另有约 16.7k 行评测仪器（dataset / experiment / judge / metrics / reference / sampling / gate / calibration / instrument）与其测试、脚本，按 `configId` 分组产出 S/A/B 判定。

实际使用中，产品形态已经收敛为**唯一一种**：E 基线 + 规则 Skill（原 config F）。A–E 的其余四档不再被运行，评测能力也不再被使用；与此同时，`configId` 作为一个恒为 `"F"` 的身份维度仍在制造四类成本：

1. **传参成本**：每条命令都要写 `--config F`，写错即报错；`--rule-skill*` 在 A–E 下「被解析但不生效」，存在静默失效面。
2. **产物噪音**：`runId` / 审计文件名 / 转录文件名 / 目录树各带一段无信息量的配置标签，排障与归档时需一直忽略它。
3. **契约包袱**：`configId` 被 ADR-0016 列为冻结产物的一部分，任何相关改动都要先写 ADR；而它已不承载任何区分能力。
4. **仓库定位漂移**：README / AGENTS.md 自称「同评测集、同冻结判定链的跨内核对照仓」，但对照实验已不再运行，仓库的实际产出是「一次检视 → 英文 findings + 中文分组意见」。

## Decision

1. **删除 `--config` 旗标**。缺省即唯一形态（规则 Skill 检视）；任何 `--config` 一律按未知旗标报错，不做兼容 no-op。
2. **`configId` 一次删净**，覆盖全部承载面：
   - `ReviewRunInput.configId`、`RunResult.configId`、`RunRecord.configId`、`AuditFileContent.configId`、`TranscriptInfo.configId`、`ReviewsEnvelope.configId`；
   - stdout 键集；
   - 目录段（runs 树与审计树）；
   - `runId` 段与审计文件名；
   - 转录文件名段（及其在 `skillPassLog[].transcriptFile` 的回指值）。
3. **历史 run 不兼容、不迁移、不读取**。入库的 8 份 `runs/**/REPORT.md` 保留为历史事实记录；本地未跟踪的旧 run 数据不做兼容层，也不写迁移脚本。
4. **规则 Skill 输入面全保留**：`--rule-skill-zip`（可重复）、`--rule-skill <dir>`（可重复）、`--rule-skill-name`、`--strict-rule-skill`，以及 `<repo>/.review-rules/*.zip` 自动扫描。
5. **无规则包 ⇒ 照跑**：装不到任何规则包时照常完成检视，stderr 输出一行提示，exit 0；`--strict-rule-skill` 仍保留「装不到就 fail fast」的强制语义。
6. **删除 disposition 子命令与整套处置库**（`disposition/**`、`--decision`、`dispositions.json`）。它只服务评测轮次的人工判定归档，身份元组本身也以 `configId` 为键。
7. **删除字节门与 A–E e2e**：`bytegate/**`、`vitest.config.gate.ts`、`test:gate` 脚本、`testdata/golden` 中服务于 A/B/C 的 golden、A–E 矩阵 e2e 冒烟。字节门依赖的 A–E 历史真源已不可再生。
8. **root 评测仪器层整块删除**：`src/{dataset,experiment,judge,metrics,reference,sampling,gate,calibration,instrument}`、`scripts/**`、`tsconfig.experiment.json`、`tsconfig.migration-gate.json` 及其测试；root 只保留 `src/presentation/**`（核外中文呈现引擎）。
9. **共享类型单源**：`Finding` / `RunResult` / `ToolCallRecord` 由 `review-pi` 包公开导出，`src/presentation/**` 从该包导入，不再保留 `src/instrument/contracts` 副本。
10. **新产物布局去掉配置段**（保留 `rep-<N>` 重跑语义）：
    ```
    <out>/<experimentId>/runs/vul4j/<caseId>/rep-<N>.json
    <out>/<experimentId>/runs/vul4j/<caseId>/session-<ts>-<caseId>.json
    <out>/<experimentId>/runs/vul4j/<caseId>/rep-<N>/reviews_en.json
    <out>/<experimentId>/runs/vul4j/<caseId>/rep-<N>/reviews_tips_zh.json
    <out>/<experimentId>/audit/vul4j/<caseId>/rep-<N>/audit/<ts>-<caseId>.json
    runId = <ts>-<caseId>
    ```
11. **审计 `ruleSkill[]` / `skillPassLog[]` 保留**。它们是规则 Skill 的**执行证据**（装了什么包、每轮 skill 会话的请求/工具/候选/合并/失败阶段），不是配置身份；删掉会失去「规则包到底有没有生效」的排障能力。
12. **仓库定位改为「pi 内核线的 Review CLI 产品仓」**，`AGENTS.md` / `README.md` / 根 `package.json` 的 `description` 一起改写；跨仓 ADR 限定语纪律保留。

## Options（为什么不是别的）

- **只收窄 CLI、保留运行时矩阵与评测层**（约 6 个文件，零风险）：传参成本消失，但 5 个配置分支、`configId` 身份与 16.7k 行评测代码原地留存，仓库仍自称对照实验仓——问题只被藏起来。放弃。
- **删 A–E，但保留恒为 `"F"` 的 `configId` 字段与目录段**（零兼容代价）：产物不变，确实不需要 supersede 冻结契约。但字段永不承载区分信息，且「配置 ↔ 仪器一一对应」的原理由（ADR-0012）已随评测层消失；留着等于把刚删的维度换个名字。放弃。
- **只删字段、保留 `F/` 目录段**：历史目录可直接对照，但字段与路径不同步会产生「目录里有配置、记录里没有」的半截身份，且 disposition / bytegate 的二次查找仍要改。放弃。
- **保留 disposition、只去掉其 `configId` 键**：能保住人工判定归档能力，但它是评测轮次的工具（KPI 按 finding 跨 rep 汇总），在产品仓里没有消费方；维护它需要跟着 runs 树布局走。放弃（需要时从历史 tag 取回）。
- **保留字节门、改为「F(N=0) 对比历史 E 真源」**：形式上还能跑一次，但历史真源依赖已删除的 A–E 执行路径，且产品形态的请求字节已无常量基线可对；留着就是僵尸测试。放弃。
- **把 `src/presentation/**` 整体搬进 `packages/review-pi/src/`**：目录更整齐，但要改引擎加载路径、`build:presentation` 产物位置与 `.env.local` 的 `REVIEW_PI_PRESENTATION_ENGINE`。收益不抵改动面。放弃（保留「核外翻译引擎、独立编译产物」定位）。

## Consequences

- **正**：
  - 命令面唯一：`review-pi review` 不需要任何形态旗标，规则 Skill 就是产品本身；
  - 身份只有一个：`runId = <ts>-<caseId>`，文件名、目录、记录三处对齐，排障不再需要跳过配置段；
  - 仓库自述与实际产出一致（Review CLI 产品仓）；
  - 删除约 16.7k 行评测生产代码 + 2.5k 行脚本，CI 与依赖面同步收缩。
- **负/风险**：
  - **跨仓对照定位作废**：与 DSH 内核线「同评测集、同冻结判定链」的对照不再能在本仓复跑；`docs/report/**` 与 `runs/**/REPORT.md` 里的历史结论降级为**不可复跑的记录**，需要评测能力时从历史 tag 或 DSH 仓取回。
  - **历史产物不可读**：旧 `runs/**` 的 `rep-<N>.json` / 审计 / 转录带 `configId` 段，新代码既不读取也不迁移；`runs/` 本地数据与 disposition store 需人工清理或另存。
  - **冻结契约被 supersede**：ADR-0016 的 stdout 键集与审计键集声明失效；ADR-0011 / 0012 的 E 切流与 F 伪配置位决策失效。
  - **请求字节基线消失**：原「F(N=0) 与 E 逐字节相同」的断言随 E 删除而消失，今后请求字节的回归只能靠单测与进程测试，不再有跨配置常量对照。
  - **进程测试需重写**：现有 24 条 CLI 进程用例建立在 config B 的「六回合纯文本」回放上，必须改为 F 形态（tool_call → tool_result 的 SSE 序列）；这是本次改动最大的单点工作量。
  - **构建顺序收紧**：`build:presentation` 依赖 `review-pi/dist` 的 `Finding` / `RunResult` / `ToolCallRecord`，必须先构建 `review-pi`；`tsconfig.presentation.json` 钉死 `rootDir: "src"` 以防产物路径漂移。
- **中性**：
  - `--out` 缺省仍是 `review-pi-output`，实验目录名仍是 `review-pi-cli`（都不含配置语义）；
  - `rep-<N>` 覆盖语义、转录每 run 独立留档、`reviews_en.json` 全量 findings 均不变。

## 验收标准

1. **命令面**：`review-pi review` 不带任何形态旗标即可运行；任何 `--config` 均被拒绝（未知旗标错误）。
2. **产物**：配了呈现引擎的一次 run 产出 `reviews_en.json` + `reviews_tips_zh.json`（形状合法、tips 按同文件同行去重）、stdout 无 `configId` 键、exit 0；runId / 审计文件名 / 转录文件名中不含配置段。
3. **无规则包**：不带规则包照跑，stderr 一行提示，exit 0；带 `--strict-rule-skill` 时 fail fast。
4. **静态验证**：`pnpm typecheck`、`pnpm --filter review-pi build`、`pnpm build:presentation`、`pnpm --filter review-pi test`、`pnpm test` 全绿；全仓 grep 归零 `configId`、`--config`、`CONFIGS`、`disposition`、`bytegate`（历史 `docs/report/**`、`runs/**/REPORT.md`、`docs/design/**`、`docs/项目问答整理.md` 除外）。
5. **历史不动**：入库的 8 份 `runs/**/REPORT.md` 与 `docs/report/**` 内容零改动。
