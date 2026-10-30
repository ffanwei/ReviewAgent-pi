# 0017. 分组式检视意见导出（核外呈现产物 `reviews_tips_zh.json`）

**状态**：已接受（ADR-0013 的 zh 一项已由 ADR-0022 收窄：`reviews_zh.json` 停产，本 ADR 的 tips 成为唯一中文产物；tips 与 zh 的「弱耦合」随之表述为「与 stdout 呈现弱耦合」；字段映射追加「同文件同行去重」（ADR-0023））（2026-10-30，用户经 grill-with-docs 四轮逐项决策 Q1–Q23）；**修订 ADR-0014 的 `rule` 字段口径**（见决策 5）
**关联**：ADR-0010（检视输出恒英文 + 核外翻译投影——本 ADR 是它的第二个消费产物）、ADR-0013（`reviews_en.json` / `reviews_zh.json` 产物族与生命周期）、ADR-0014（规则 skill 会话——本 ADR 改其输出契约的一个字段）、ADR-0009（内核/核外边界）、CONTEXT.md（检视意见导出）
**跨仓**：本 ADR 为本仓 pi 线序列 0017；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

下游要一份**按文件分组、带中文改法建议**的检视意见：

```json
{ "files": [ { "filePath": "a.java", "reviewTips": [
  { "code": "...", "review": "...", "suggestion": "...", "category": "Security",
    "subcategory": "SQL Injection", "severity": "Major", "ruleId": "1",
    "lineNum": 72, "source": "SonarQube", "confidence": "Medium" } ] } ] }
```

把它与现状对齐后暴露四个断点：

1. **目标结构装不下 `id` / `title` / `description` / `evidence`**，而这四项恰是判定链（judge 卡片、`screening` 硬校验、`disposition` 的 `findingId`）与 Evidence Gate 的支点。
2. **severity 档数不一致**：现状 `P0–P3` 四档（`system-prompt.ts:39-43`，P3 = Info），目标只有三档。
3. **`source`（SonarQube/CheckStyle）/ `ruleId`（纯数字）/ `subcategory` 在本仓没有真源**——本仓是 LLM 读 MR 做语义检视，不跑静态扫描；规则包的规则 id 形如 `GEN-SQL-001`，且**传不到 Finding**（`skill-pass-brief.ts` 原先把 `rule` 强制写成包名）。
4. **中文 `review`/`suggestion` 与 ADR-0010「检视输出恒英文」冲突**。

因此必须先定「这是谁的产物」：改内核契约（换尺子）还是核外呈现（加一份投影）。

## Decision

1. **定位：新增核外产物，不动内核**。`Finding` 契约、Zone A 系统提示词字节、golden、`reviews_en.json`、审计、`RunRecord`、stdout 呈现、judge/screening/disposition 全部零改动。新产物只是 ADR-0010 投影的第二个出口。
2. **文件名与生命周期**：`reviews_tips_zh.json`，与 `reviews_zh.json` **同目录**（`.../<configId>/rep-<N>/`）、同生命周期——未配引擎 / 投影降级 ⇒ 不产 + 删除本次 `rep-<N>/` 的陈旧文件；落盘 IO 失败抛错（与 en/zh 同档）。另在**进程 cwd** 留一份便捷副本（两个名字，见决策 14），那一路失败不判失败。
3. **与 zh 弱耦合**：tips 文档**形状非法或缺席只折损这一份产物**——zh 照常落盘与呈现、stdout 不变、exit 0，stderr 一行原因。理由是 tips 的 schema（10 键严格封闭 + 枚举）比 zh 严得多，不该让它拖累已算出的 zh。
4. **结构严格封闭**：顶层只有 `{ files }`（无信封；出处由同目录 zh 与路径承担）；`files[]` **只含有意见的文件**、按 finding 首见序；`reviewTips[]` 按 `lineNum` 升序（同行保持 finding 源序，稳定排序）；**零 finding 照产 `{"files": []}`**（「本次没发现问题」本身是结论）。
5. **`ruleId` 的真源 = 规则包 frontmatter id（修订 ADR-0014）**：skill 会话输出契约的 `rule` 由「恒为 skill 名」改为「优先填命中规则的 `id`（如 `GEN-SQL-001`）；无法归因到单条规则时退回 skill 名」。这是**非测量档**（ADR-0014 明示 skill 会话不属测量常量面），Zone A 字节不动。落地口径：
   - 内核不解析规则文件；核外拿到**规则包解压目录**后读 `rules/*.md` frontmatter 建白名单；
   - `tip.ruleId` **只在白名单内**才填，否则空串——即用户原话「没有就用空字符串」在**产物层**实现（Finding 层的 `rule` 不能为空串：`finding-schema.ts` 的 `checkString` 会判 `SCHEMA_INVALID`）；
   - `common-reviewer` 恒空串（`Finding.rule` 里 `CORRECTNESS-001` 这类是模型自造标签，不是规则包真 id）。
6. **`source` 是结构性判定**：finding id 以 `RULE-CHECK@` 开头 ⇒ `rule-reviewer`，否则 `common-reviewer`（id 模板单源 `skill-pass-brief.ts:20`）。**不看配置**——否则 config F 主会话自己发现的问题会被误标成规则命中；skill 会话失败/降级时自动全落 `common-reviewer`。
7. **`subcategory` 恒空串**：仓内无真源（规则包 frontmatter 的 `category` 是 `injection` 这类风格标签，且不随 Finding 传出）；按用户决策不做猜测或额外生成。
8. **`code` 由 CLI 按 `--repo` + `file:line` 抽原文整行并 `trim()`**；`Finding.line` 是「MR 应用后的行号」而 `--repo` 正是应用后的工作树，两者天然对齐。取不到（文件不在仓 / 越界 / 读失败）⇒ 空串，**绝不编**。引擎保持零源码文件系统访问（源码行走 `codeByFinding` 注入）。
9. **`suggestion` 是新增生成行为（不是翻译）**：每条 finding 一次网关调用（提示词含 `file`/`line`/`code`/`review`，要求一条可执行中文改法，信息不足给空串）；**并发上限 4、单次 90s、失败或空响应 ⇒ 空串**，不阻断落盘；模型 id 复用 `REVIEW_PI_PRESENTATION_MODEL`（缺省 `deepseek-v4-flash`），不新增环境变量。
10. **`review` = 中文 `title` + `。` + 中文 `description`**（复用同一次 zh 投影结果，零额外调用；空侧退化）。
11. **字段映射表（单源）**：

| 键 | 取值 | 来源 |
|---|---|---|
`code` | 源码该行（`trim`） | CLI 按 `--repo` 读；失败 ⇒ `""` |
`review` | `title` + `。` + `description` | zh 投影结果 |
`suggestion` | 中文可执行改法 | 核外逐条生成；失败 ⇒ `""` |
`category` | `Finding.category` **原值**（`CORRECTNESS` / `ERROR-HANDLING` …） | 零失真透传，不做词表归一 |
`subcategory` | `""` | 无真源 |
`severity` | `P0→Fatal`、`P1→Major`、`P2→Minor`、`P3→Minor` | P3 折进 Minor，不丢条 |
`ruleId` | 规则包 frontmatter id（白名单内）；否则 `""` | 决策 5 |
`lineNum` | `Finding.line` | MR 应用后行号 |
`source` | `rule-reviewer` / `common-reviewer` | 决策 6 |
`confidence` | `≥0.8 High`、`≥0.5 Medium`、`<0.5 Low` | 数字 → 三档；非有限数按 Low |

12. **引擎协议扩展**（`cli/presentation-projection.ts` 单源）：入参新增 `codeByFinding`（键 = finding id）与 `rulePackDirs`；返回新增 `tips`。CLI 缝做**严格校验**（顶层 `{files}`、每 tip 键集恰好 10 个、枚举值域），坏形状只产 `tipsProblem` 不产文件。
13. **纯映射与生成分离**：`Finding → tip` 的确定性映射（`src/presentation/tips.ts`）零网络零文件系统，可逐键单测；网络只出现在 `engine-zh.ts` 的装配面（与 ADR-0010 的「翻译算法留核外」同构）。
14. **执行目录副本（`--out` 之外的第二落点）**：同一份内容再写一份到**进程 cwd**（即「这条命令跑在哪」），并用两个名字：原名 `reviews_tips_zh.json` + 下游约定名 `review-result.json`，两份逐字节相同。口径：
    - **选 cwd 而非 `--repo`**：不写回被检视仓库（仓内既有纪律），且不要求 `--repo` 可写；也不写 `--out`（那里已有 run 产物目录，副本的意义是「在眼前」）。
    - **永不抛错**：cwd 可能只读、可能是系统目录、目标名可能被占——写失败只 stderr 一行警告，**exit 仍 0**。检视本体已成功，便捷副本不配把整次运行判失败。
    - **跟着清**：本次不产 tips（未配引擎 / 投影降级 / 形状非法）⇒ 两份陈旧副本一并删除，使「目录里有就是本次的」成立；删除失败同样只警告。
    - **不建目录、不扫目录**：cwd 必然存在，凭空 `mkdir` 越权；只碰这两个固定名字，绝不删除其他文件。
    - 已知风险：若 cwd 恰好是某个 git 仓库根，副本会出现在 `git status`（使用方可自行在 `.gitignore` 忽略）；这是「在眼前」换来的代价，故选 cwd 时已明示。

## Options（为什么不是别的）

- **让内核直接产出目标结构（替换 Finding）**：要动 10 字段契约 + 冻结提示词 + 三层守门 + `reviews_en.json` + judge + screening + disposition，等于换尺子（ADR-0009/0002），历史 runs 与 golden 全红。
- **换掉但在内核保留双向适配层**：两套映射长期并存，任一侧漂移就静默错配。
- **严格 10 键且不保留任何回溯锚点**：产物无法回连判定链（judge / baseline / 审计对账全断）——被否；改为「严格 10 键 + 同目录 zh 承担出处」。
- **`source` 照抄 `SonarQube`/`CheckStyle`**：本仓不跑静态扫描，填这两个值等于告诉下游一件没发生的事。改用「规则命中 vs 模型推理」，这恰是对照实验最想知道的信号。
- **`ruleId` 用纯数字 `"1"/"2"/"3"`**：仓内没有这种编号，只能编。改用规则包真 id。
- **`subcategory` 由模型再生成一次**：再乘 N 次调用买一个无真源字段，被否。
- **把 `suggestion` 当翻译做**：没有源文本可译，做不到；只能新生成（故有决策 9 的成本）。
- **tips 与 zh 强耦合（形状坏就整体降级）**：会把已经算好的 zh 一起拖下水。

## Consequences

- **正**：产物直接可用（按文件分组 + 中文改法 + 规则归因）；内核零改动，字节门与 504 条内核测试不受影响；映射表是可单测的纯函数；规则归因从「包名」升级为「规则 id」，与 `skillPassLog.ruleIds` 字段注释原意对齐；执行目录副本让下游无需知道 `runs/` 布局即可直接读 `./review-result.json`。
- **负 / 需要显式认识的刻意偏离**：
  - **config F 的模型行为会变**（`rule` 填法），F 的历史召回/精度可比性需重测。
  - **审计 `skillPassLog.ruleIds`** 从包名变为规则 id（更准，但与历史 run 不可比）；`Finding.rule` 对规则会话命中项随之变。
  - **每条 finding 多一次网关调用**（30 案全开 ≈ +120 次）；单条失败只留空串。
  - **`subcategory` 永远为空**、`code` 可能为空（取不到源码行时）——这是「宁可空，不编」的代价。
  - **cwd 里会多出两个文件**（`reviews_tips_zh.json` / `review-result.json`），从仓库根跑检视时它们会出现在 `git status`；写失败只警告不回滚，故「cwd 里有」是尽力而为的便利，不是契约。
  - **P3 折叠**：`Minor` 桶里同时装着「可能的边缘 bug」与「文档 nit」，若要区分只能回读 `reviews_en.json` 的 `severity`。
- **中性**：不触碰请求字节、不进字节门/语义等价门/上线门；根侧 runner 无投影缝，故不产本产物（与 zh 一致）。
