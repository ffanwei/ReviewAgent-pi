# 0018. 规则 Skill 支持「已解压目录」输入（`--rule-skill`）

**状态**：已接受（2026-10-30，用户经三项口径决策）；**扩展 ADR-0014 的输入形态**（该 ADR 决策 1 的「单位 = 多个 zip」不变，新增并列单位）
**关联**：ADR-0014（规则 skill 会话——输入形态由「只有 zip」扩为「zip 与已解压目录共存」）、ADR-0012（规则 Skill 注入的原始口径）、ADR-0017（tips 导出消费规则包目录——本 ADR 让「规则包目录」成为一等输入）、ADR-0009（内核/核外边界）、CONTEXT.md（规则技能执行器）
**跨仓**：本 ADR 为本仓 pi 线序列 0018；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

ADR-0014 的装载链路只认 zip：`--rule-skill-zip`（可重复）或 `<repo>/.review-rules/*.zip`。实测把**目录**传给 `--rule-skill-zip` 的后果是：

- 非 strict：`stat` 只判存在（`fileExists` 不区分文件/目录），随后 `readFile(目录)` 抛 `EISDIR`，该包沦为一条降级记录，**根本不跑 skill 会话**，run 照常 exit 0；
- strict：`rule skill unavailable: failed to read rule-skill archive (EISDIR: ...)`，exit 1。

规则包的**真源本来就是目录**（`testdata/rule-skills/general-code-review/`：`SKILL.md` + `rules/*.md` + `scripts/*`），zip 只是打包产物（且 `**/*.zip` 被 gitignore，新 clone 必须重建）。开发迭代规则包时反复「改目录 → 重打包 → 跑」是纯摩擦；同时 ADR-0017 的核外 tips 已经在读**解压后的规则包目录**取 `rules/*.md` frontmatter，两条链路对「规则包目录」的认知也应统一。

## Decision

1. **新增 `--rule-skill <dir>`，值为已解压目录**，可重复；与 `--rule-skill-zip` **共存**，装载顺序 = **先全部 zip（CLI 序），再全部目录（CLI 序）**。不引入跨参数的交错排序——顺序规则一句话可预测，也不用改造参数解析器。
2. **复制到 run 缓存，不原地当 pack 根**：目录先审计 → 按内容哈希 → `cp` 到 `<cacheRoot>/dir-<digest>/` → 写 `.rule-skill-ready` → 走与 zip **完全相同**的 `loadSkills` 链路。与 zip 同档的理由：两次 run 互不干扰；skill 的 `bash` 工具会往 pack 根写东西，绝不能污染用户源码目录；诊断路径可脱敏为缓存目录相对形态。
3. **缓存键 = 目录内容哈希**（递归收集相对路径、POSIX 化、排序后依次喂 `<rel>\0<bytes>\0`，sha256），前缀 `dir-` 与 zip 的「归档字节 sha256」分开。内容一变就是新目录，绝不会读到旧副本；缓存语义与 zip 同档（命中即跳过复制）。
4. **审计口径不放水**：目录形态复用 `verifyExtractedTree`（label = `rule skill directory`）——**符号链接、非普通文件、总字节超上限一律拒绝**，降级路径与 zip 一致；`--strict-rule-skill` 下抛 `rule skill unavailable: ...`。目录不是绕过安全审计的后门。
5. **审计 `RuleSkillAudit` 增可选键 `kind?: "dir"`**：仅目录形态输出；zip 形态省略该键，**历史审计字节不变**。`source` 的取值规则不变（仓库相对 POSIX；越界时原样 POSIX 化），`digest` 位置不变（目录形态 = 内容哈希）。
6. **`<repo>/.review-rules/` 不扩子目录发现**：约定目录仍只认 `*.zip`（ADR-0014 决策 1 不变）。目录形态只走显式 `--rule-skill`，避免「zip + 目录混装」时的排序歧义。
7. **显式目录在场时，约定目录缺席不再算整体失败**：`locateZipCandidates` 的「找不到 zip」只在**没有任何显式目录**时才生效。否则「只想跑一个本地目录、但仓库里没有 `.review-rules/`」会在 strict 下无谓抛错。
8. **目录不存在 / 不是目录 ⇒ 降级**（`rule-skill directory not found` / `rule-skill path is not a directory`），与 zip 的读取失败同档；strict 才抛。
9. **非 F 配置照旧忽略**：`--config A–E` 不装载、不审计，旗标虽被解析但不生效（`config.ruleSkill === false`）。

## Options（为什么不是别的）

- **原地当 pack 根（零拷贝）**：改完立刻生效、无复制成本。但 skill 的 `bash` 会写进用户源码目录，且目录只读时直接失败；两次 run 的缓存/可写假设也被打破。放弃。
- **按 argv 交错装载（`zip` 与 `dir` 严格按命令行出现序）**：最符合直觉，但要改造参数解析成「一条有序列」，并把顺序语义写进审计比对基准；收益仅是「顺序好看」。放弃。
- **两个参数互斥**：不用解释混合顺序，但「内置 zip + 本地改写目录」这种常见叠加做不了。放弃。
- **对目录留空 `digest`**：`digest: ""` 已是约定的**降级占位**，留空会被误读成装载失败，也失去缓存键。改用内容哈希。
- **只按 mtime 判目录变化**：跨平台不稳定、复制后不可复算；内容哈希可复现、可解释。
- **`.review-rules/` 也自动发现子目录**：会让「目录 + zip 混装」的装载序变成隐藏规则，且约定目录的语义从「投放 zip」变成「投放任意形态」。放弃（需要时用显式旗标）。

## Consequences

- **正**：改规则包目录后直接跑，不再重打包；zip 与目录两条路径共用同一审计/降级/装载链路，成功与失败的可观测面一致；ADR-0017 的 `ruleId` 白名单与装载输入统一到「规则包目录」这一概念。
- **负/风险**：
  - **复制成本** O(目录字节) 每次内容变化；规则包体积在 MiB 级，可接受。
  - **缓存增长**：内容每变一次多一个 `dir-*` 目录，无 GC（与 zip 缓存同档问题，未在本 ADR 引入新解法）。
  - **审计可比性**：目录形态多一个 `kind` 键、`digest` 语义与 zip 不同（内容哈希 vs 归档字节），跨形态的 `digest` 不可直接比较——`kind` 即区分依据。
  - **未校验 zip 与目录内容等价性**：同一规则包「zip 装载」与「目录装载」会得到不同 `digest`，这是设计使然，不是缺陷。
- **中性**：不新增环境变量；不进 A–E 主矩阵；skill 会话仍属非测量档。

## 验收标准

1. `pnpm --filter review-pi test` 全绿（含目录形态：与 zip 逐字段等价、`source.kind === "dir"`、内容哈希缓存 `dir-<digest>`、目录内容变更换缓存、符号链接被拒、strict 抛错、zip + 目录顺序）。
2. `--rule-skill` 可重复；与 `--rule-skill-zip` 共存时审计 `ruleSkill[]` 顺序 = 全部 zip 后全部目录。
3. 目录形态 `ruleSkill[].kind === "dir"`；zip 形态无 `kind` 键（历史审计字节不变）。
4. 目录装载成功后 `skillPassLog` 有对应行（不是"传了但没生效"）；`--strict-rule-skill` 下装载失败 exit 1。
5. 被检仓库**零写入**：目录内容只读，副本与缓存全在 `<out>` 下。
