# 0107. 规则 Skill 会话允许 `review.get_file` 读取包内文件

**状态**：已接受（2026-11-19，用户决策）
**关联**：[ADR-0014](0014-rule-skill-review-pass-after-candidates-phase.md)（独立 skill 会话：bash cwd = pack 根）、[ADR-0018](0018-rule-skill-directory-input.md)（目录输入的 run 缓存 pack 根）、[ADR-0020](0020-host-platform-in-skill-prompt.md)（skill 会话的平台提示）、[ADR-0099](0099-tool-code-search.md)（主会话工具面）、[ADR-0106](0106-tips-full-projection-with-unreported-log.md)（tips 全量投影）
**范围**：只改 **skill 会话内** `review.get_file` 的读取来源与 skill 提示词/工具描述。主会话八工具 schema、请求字节、审计、`reviews_all.json`、tips 均不变。

## Context

规则 Skill 包不是只有 `SKILL.md`：`rules/`、`references/`、`scripts/` 等文件常被 `SKILL.md` 引用，skill 需要读取它们才能按规则检视。生产反馈：skill 会话里直接调 `review.get_file("rules/xxx.md")` 失败。

原因：`review.get_file`（`tools/get-file.ts`）只读 `--repo` 工作树（RepoContext），路径也按仓库根做 jail；skill 包文件不在被检视仓库里。现有的包内读取手段只有 `bash`（cwd = pack 根，ADR-0014），但：

- 模型看到 `review.get_file` 这个“读文件”工具，自然会先用它；
- Windows 上 `cat` 等命令可能不存在，`python -c` 读文件对模型不是零成本；
- 失败信息只说 “repository snapshot”，没有指出包内文件该怎么办。

结果是 skill 按规则产出的意见可能因为读不到规则文件而根本不会出现，属于“传入 skill 却没有按 skill 执行”的严重可用性问题。

## Decision

### 1. skill 会话的 toolkit 注入 `skillPackRoot`

`buildReviewToolkit` 新增可选 `skillPackRoot`；`run/review-pass.ts` 的 `skillToolkitFor(seed, skill)` 用 `path.dirname(skill.filePath)` 注入（SKILL.md 所在目录 = ADR-0014 的 bash cwd）。主会话不注入，行为与既有逐字节一致。

### 2. `review.get_file` 的读取顺序

`skillPackRoot` 存在时：

1. `skill://<包内相对路径>`：**强制**读包；
2. 普通相对路径：**先读被检视仓库**；仓库缺失/不可读时回退读包；
3. 两者都失败：有界错误，明确列出两个来源。

路径仍先过 `normalizeRepoPath`（拒绝绝对路径、`..`、空段），再用 `path.resolve` 做 pack 根 jail；输出与错误都只含相对路径，不泄漏 pack 的宿主绝对路径。报头区分来源：仓库 = `File: …`，包内 = `Skill file: …`。

### 3. 提示词与工具描述只改 skill 会话

- `skill-pass-brief.ts` 的会话契约新增一条：包内文件用 `review.get_file` 直接写相对路径（仓库找不到回退包根），或用 `skill://<相对路径>` 强制读包；
- `skill-pass.ts` 在组装工具时仅对 skill 会话覆盖 `review.get_file` 的 description，补同一句说明。

主会话的 `registry.ts` schema 描述、请求字节、测量常量面不动。

### 4. bash 与包根语义不变

`bash` 仍以 pack 根为 cwd（ADR-0014）；本 ADR 只是给 `review.get_file` 增加一条等价读取路径，不改变 bash 的边界、超时或输出预算。

## Options（为什么不是别的）

- **只更新提示词，要求用 bash 读包内文件**：零代码，但模型仍会先试 `review.get_file`；Windows 上 `cat` 不一定可用，`python -c` 读写门槛高。放弃。
- **新增 `review.get_skill_file` 工具**：语义最清晰，但 skill 会话多一只工具、每次请求都多一段 schema，且模型仍可能误用 `review.get_file`；本 ADR 选择不增工具、直接让既有工具工作。
- **普通相对路径优先读包根**：会让 skill 会话里读被检视仓库同名文件时出现歧义（skill 本身也要读 repo 文件）。仓库优先 + `skill://` 强制读包更可预测。
- **允许绝对路径读包**：会把宿主机绝对路径带进模型上下文与工具结果，破坏既有的“不泄漏宿主路径”纪律；放弃。
- **把包内文件全量塞进会话**：token 不可控，规则包可能有大量 references/rules；放弃。

## Consequences

- **正**：skill 直接按 `SKILL.md` 的相对路径读包内文件即可；仓库缺失时自动回退，现有要求 `rules/xxx.md` 的 skill 不需要改写；主会话零变化。
- **负/风险**：skill 会话的请求字节（提示词 + `review.get_file` 描述）变化，`rule-skill-single-finding` 等 skill 回放 trace 需要重新录制；对主会话与其它回放场景无影响。包内与仓库存在同名路径时，普通路径取仓库，取包需 `skill://`。
- **中性**：工具名、schema、result budget、Context Ledger 口径不变；`skill://` 读取的 Ledger 描述带前缀，避免与仓库同路径互相命中。

## 验收标准

1. **回退**：skill toolkit 注入 packRoot，`review.get_file("rules/x.md")` 在仓库缺失时返回 `Skill file: rules/x.md` 与包内内容。
2. **强制读包**：`review.get_file("skill://rules/x.md")` 始终读包；仓库有同名文件也不影响。
3. **仓库优先**：普通路径在仓库存在时仍读仓库（`File:` 头）。
4. **越界**：`skill://../x`、绝对路径被拒绝，错误不泄漏 pack 绝对路径。
5. **主会话**：无 packRoot 时 `skill://` 显式报 “only available in a rule-skill session”；普通路径行为与既有测试逐字节一致。
6. **测试**：`pnpm --filter @baize/review-pi test`、`pnpm --filter @baize/review-pi typecheck` 全绿；skill 会话提示词测试覆盖新增说明。
