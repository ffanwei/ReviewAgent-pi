# 0027. 产物路径与留痕收口：`mr` 段、去 `experimentId`、cwd 单名副本、审计 `~/` 归一、规则包只认显式输入

**状态**：已接受（2026-10-31；ADR-0025 落地后的收口批次之一）
**关联**：ADR-0010（语言钉英文 + 核外翻译）、ADR-0013（转录与意见导出）、ADR-0014（规则 Skill 会话）、ADR-0017（分组意见与 cwd 副本；本 ADR 修订其「双名双写」）、ADR-0018（规则 Skill 目录输入）、ADR-0022（`reviews_zh.json` 停产）、ADR-0025（用户级配置与审计 `config` 快照）
**修订**：ADR-0012 / ADR-0014 / ADR-0018 / ADR-0024 中「`<repo>/.review-rules/*.zip` 自动扫描」一条；ADR-0017 决策 14 的「cwd 双名副本」一条；ADR-0025 的「审计快照记绝对路径」一条
**跨仓**：本 ADR 为本仓 pi 线序列 0027；DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

ADR-0024 把仓收窄成 Review CLI 产品仓、ADR-0025 把配置收到用户级之后，产物面与规则包的输入面还留着**实验期词汇与实验期假设**：

1. **路径里带着评测史**：`<out>/review-pi-cli/runs/vul4j/<caseId>/rep-1/`。`vul4j` 是历史数据集名，`review-pi-cli` 是 CLI 的实验标识——单次检视根本没有「实验」这个维度，多一层只让路径更长，还让「这次是什么」需要翻译。
2. **cwd 里写两份同内容文件**：`reviews_tips_zh.json`（原名）+ `review-result.json`（下游约定名）。两个同内容文件放在一起，读者必须先知道哪个是权威；而权威其实在 run 目录里。
3. **审计快照写死机器路径**：`config.path` 与 `values` 里的绝对路径原样落盘。审计是**可归档的留痕**，同一份 run 换台机器就不可读；这是 ADR-0025「可反查」目标的反面。
4. **规则包默认从被检视仓库里捡**：`<repo>/.review-rules/*.zip` 自动装载。规则包会指挥 skill 会话的 `bash` 工具执行进程——等于「被检视仓库可以在检视方机器上默认带代码执行」。对一个「可以指向任意仓库」的产品 CLI，这是默认开启的信任越界，也是与 ADR-0025「秘密离开工作树」不一致的攻击面。

## Decision

### 1. 产物路径：`mr` 段，去掉 `experimentId` 层

```text
<out>/runs/mr/<caseId>/rep-1/            # reviews_en.json / reviews_tips_zh.json
<out>/runs/mr/<caseId>/rep-1.json        # RunRecord
<out>/runs/mr/<caseId>/session-<runId>.json
<out>/audit/mr/<caseId>/rep-1/audit/<runId>.json
<out>/.cache/rule-skills/<digest>/       # 规则包解压缓存
```

- `vul4j` → `mr`：一次检视就是一条 MR，数据源维度不再借用数据集名。`ExperimentSource` 类型收窄为 `"mr"`（保留 `runs/<source>/` 这一级：它是「哪些产物属于同一类输入」的稳定位置，未来接其他输入形态不必再改布局）。
- **删掉 `experimentId` 层**：CLI 不再有实验标识，`CLI_EXPERIMENT_ID` 一并删除。
- **不做旧目录兼容**：不探测、不迁移、不读旧 `review-pi-cli/` 与 `vul4j/` 目录。旧 run 作为历史记录原样留在盘上；本版只写新布局。
- 布局逻辑单源在 `experiment/run-record.ts`（`runDirPath` / `runRecordPath`），`run/review-run.ts` 与本包外调用都走它，防记录与产物漂移。

### 2. cwd 副本只留 `review-result.json`

- run 目录里的 `rep-<N>/reviews_tips_zh.json` 是**真源**；
- cwd 只写下游约定名 `review-result.json`（内容逐字节相同），不再写原名副本；
- cwd 属用户目录（可能只读、可能落在 git 仓库根），写入**永不抛错**：失败只进 stderr，检视照常 exit 0；
- 本次不产 tips ⇒ 主动删除 cwd 里的陈旧副本，**含旧版本写过的原名 `reviews_tips_zh.json`**——「文件存在 ⇒ 是本次的」必须成立。

### 3. 审计配置快照的家目录归一化

`configSnapshot(config, { home })`：给 `home` 时，`path` 与 `values` 里所有绝对路径字符串把家目录前缀折叠成 `~/...`（POSIX 分隔符）。

- **只有审计路径传 `home`**：审计是可归档留痕，不该绑定机器；
- **`config show` / `config show --json` 不传**：用户看的是自己机器的真实路径；
- 折叠只认「确在该 home 之下」的绝对路径；越界路径原样保留（不猜）。

### 4. 规则包只认显式输入（Rule-Skill Trust）

- **不再扫描 `<repo>/.review-rules/`**：没有 `--rule-skill-zip` / `--rule-skill` 就是没有规则包（`ruleSkills = []`），stderr 一行提示、exit 0；`--strict-rule-skill` 在这种情况下报错。**不新增「允许扫描」开关**——需要规则包就给显式路径。
- 装载顺序不变：先全部 zip、再全部目录（各自按 CLI 顺序）；目录仍先审计符号链接 / 非普通文件 / 总字节，再复制进 run 缓存。
- **配置目录与文件权限收紧**：`config init` 创建 `~/.PiAgent/` 用 `0700`；写配置文件后显式 `chmod 0600`（`writeFileSync` 的 `mode` 只在创建时生效，`--force` 覆盖既有 `0644` 文件不会自动修好）。读取侧「宽于 0600 只警告」不变。

### 5. 缺配置的一行提示（与 ADR-0026 同批）

`review` / `smoke` 在配置文件不存在时打一行 stderr，不改变退出码。详见 ADR-0026。

## Options（为什么不是别的）

- **保留 `vul4j` 段**：它是数据集名，不是产品概念；产品 CLI 产出「一次 MR 的检视」，路径里写评测史属于泄漏内部词汇。放弃。
- **保留 `experimentId` 层（比如固定写 `review-pi-cli`）**：单次检视没有实验维度，保留只会让所有路径多一级同名目录，并诱导「以后还要按实验分目录」的误读。放弃。
- **提供旧目录兼容读取（同一 `<out>` 同时认两种布局）**：兼容层会长期存在，且「读到的是上一版产物」比「找不到」更难排查。明确破坏、文档写清。放弃。
- **cwd 继续双写**：两个同内容文件在前，读者要猜权威；下游只读 `review-result.json`，原名副本从无消费者。放弃。
- **cwd 写原名、不写 `review-result.json`**：破坏既有下游约定。放弃。
- **审计保留绝对路径，另加 `home` 字段**：字段多了，归档可读性没有变好；折叠成 `~/` 才是「换机器仍可读」。放弃。
- **扫描改「默认关 + 新增 `--scan-repo-rule-skills` 开关」**：为一条默认不该开的能力加旗标，等于把「被检视仓库能否在你的机器上执行代码」做成长期选项。需要时给显式路径即可。放弃。
- **配置目录保持默认权限（`0755`）**：目录可列名、文件 `0644` 可读，秘密文件的「只警告」兜底太薄。放弃。

## Consequences

- **正**：
  - 路径短一级、词汇是产品词汇（`runs/mr/<caseId>`）；
  - cwd 只有一个副本且真源位置明确；
  - 审计可跨机器归档阅读；
  - 「被检视仓库默认触发代码执行」的信任越界消失；
  - 秘密文件在 POSIX 上默认 `0600`，`--force` 也能修好旧权限。
- **负/风险（破坏性变更）**：
  - **旧路径不再被写入**：依赖 `<out>/review-pi-cli/runs/vul4j/...` 的脚本、看板、笔记必须改到 `<out>/runs/mr/...`；旧 run 仍可人工查阅。
  - **`<repo>/.review-rules/` 投放不再生效**：仓库里放规则包的人会看到「未装载任何规则包」提示，必须改用 `--rule-skill-zip` / `--rule-skill`。这是**有意的**默认收紧，ADR-0012/0014/0018 的自动扫描口径被本 ADR 修订。
  - **cwd 里旧版留下的 `reviews_tips_zh.json` 会被删除**（下次不产 tips 时）；依赖该名字的下游应改读 `review-result.json`。
  - 审计快照里 `config.path` 变成 `~/.PiAgent/PiAgent.json`；按绝对路径做机器匹配的脚本需要自行展开。
- **中性**：
  - 转录 / 审计 / 意见导出的**内容契约**不变（键序、字段、`runId` 形态都不动）；
  - 规则 Skill 会话、候选合并、审计 `ruleSkill[]` / `skillPassLog[]` 语义不变。

## 验收标准

1. **布局**：一次 CLI 检视后，`<out>/runs/mr/<caseId>/rep-1.json`、`<out>/runs/mr/<caseId>/rep-1/reviews_en.json`、`<out>/audit/mr/<caseId>/rep-1/audit/<runId>.json` 全部在位；`<out>/review-pi-cli/` 与 `runs/vul4j/` 不出现；`RunRecord.source === "mr"`（`run-review-artifacts.test.ts`、`bin.process.test.ts`）。
2. **cwd 副本**：配置引擎并跑一次 ⇒ cwd 有 `review-result.json`、**没有** `reviews_tips_zh.json`，前者与 `rep-1/reviews_tips_zh.json` 逐字节相同；不产 tips 的 run ⇒ 两者都被清掉（`bin.process.test.ts`、`reviews-tips-zh.test.ts`）。
3. **审计归一**：审计 `config.path` 为 `~/.PiAgent/PiAgent.json` 形态，`values` 中的 home 下绝对路径同样折叠；`config show` 仍打印真实绝对路径（`config.test.ts`）。
4. **规则包信任**：仓库里放了 `.review-rules/*.zip` 但未给显式旗标 ⇒ 不装载、一行提示、exit 0；`--strict-rule-skill` ⇒ 错误信息为「no rule-skill archive given (pass --rule-skill-zip or --rule-skill <dir>)」；显式 zip / 目录仍正常装载（`rule-skill.test.ts`、`bin.process.test.ts`）。
5. **权限**：`config init` 后目录 `0700`、文件 `0600`；`--force` 覆盖一个 `0644` 文件后仍为 `0600`（POSIX；`config.test.ts`）。
6. **文档**：README / 运行手册 / `CONTEXT.md` 不再把 `review-pi-cli/`、`runs/vul4j/`、cwd 双名副本、`.review-rules` 自动扫描写成现行行为（历史 ADR 与历史报告除外）。
7. **门**：`pnpm --filter review-pi test`、`pnpm typecheck`、`pnpm test` 全绿。
