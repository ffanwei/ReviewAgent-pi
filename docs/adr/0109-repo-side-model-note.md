# 0109. base / mixed 仓库侧别：把可执行提示注入初始 user 消息

**状态**：已接受（2026-11-19，用户决策）
**关联**：[ADR-0107](0107-skill-get-file-pack-fallback.md)（skill 包内读取；与 repo 侧别无关）、[ADR-0029](0029-mr-input-diff-or-json.md)（MR diff / 文件变更 JSON 输入）、[ADR-0096](0096-phase-json-parse-retry.md)（失败恢复）
**范围**：只改 `--repo` 停在 diff 改前（base）或混合（mixed）侧时的初始 user 消息。`head` / `unknown` 的请求字节、审计、工具行为、产物形状均不变。

## Context

`review.get_file` / `review.search_code` / 符号工具读的是 `--repo` 工作树当前内容，**不对 diff 做叠加**。当 `--repo` 是 diff 的改前（base）侧：

- diff 新增的文件在 repo 里不存在 → `get_file` 报 `cannot be read from the repository snapshot`；
- 修改过的文件存在，但读到的是改前内容；行号与 head 侧可能不一致；
- 删除的文件反而还在；重命名后的新路径不存在；
- `search_code` 搜不到新增符号 / 新增代码，无命中不等于不存在。

`run/repo-side.ts` 已经能确定性判定侧别（base / head / mixed / unknown），但此前只在 stderr 打一行给人看的提醒，**模型看不到**。模型可能反复对新增文件调 `get_file`、把 base 内容当 head 上下文，或把无命中误判成不存在。

同时，大多数生产运行的 `--repo` 已经是 **head 侧**（改后），不能让这个少数场景的提示污染正常请求字节。

## Decision

### 1. 只在 base / mixed 侧注入模型提示

`repo-side.ts` 新增 `formatRepoSnapshotModelNote(record)`：

- `side === "base"` ⇒ 返回 base 提示；
- `side === "mixed"` ⇒ 返回 mixed 提示；
- `head` / `unknown` / `record === undefined` ⇒ 返回 `undefined`（不注入，逐字节保持原样）。

提示内容（中文，与系统提示/阶段指令同语言）：

```text
注意：本会话的 --repo 工作树停在本次 diff 的改前（base）侧。
diff 中新增的文件可能不存在，修改文件读到的是改前内容；变更行以 diff 为准。
review.get_file / review.search_code 无结果不代表文件或符号不存在；不要仅因仓库读取失败而放弃候选。
```

mixed 侧只换第一句为「与本次 diff 的侧别混杂（部分文件可能是改前内容）」，其余相同。

### 2. 注入点 = 初始 user 消息的 extra section

`run/review-pass.ts` 把 `formatRepoSnapshotModelNote(input.repoSnapshotSide)` 与既有 `skillBrief` 一起放入 `buildInitialUserMessage` 的 extra section：

- 顺序：`skillBrief` 在前，侧别提示在后（最后看到）；
- 两者都缺席 ⇒ `extraSection: undefined`，消息与既有逐字节一致；
- 该消息会随 Phase-5 快照进入规则 Skill 会话，因此 skill 也能看到这条提示。

`repoSnapshotSide` 由 `buildPass` 从 `ReviewRunContext` 原样传入 `ReviewPassInput`；分片路径共用同一 run 级判定。

### 3. 不改工具行为

不在宿主侧给 `get_file` / `search_code` 做 diff overlay：新增文件全文已经在 diff 里，修改文件的 head 叠加容易出错；提示让模型自己按 diff 取证即可。

## Options（为什么不是别的）

- **改系统提示词**：会影响所有请求字节与 head 正常路径；放弃。
- **只保留 stderr**：模型看不到，生产已经出现新增文件读不到仍反复调用的情况；放弃。
- **自动 checkout head**：CLI 不应替用户改工作树；CI 侧应自己选对提交。放弃。
- **工具层做 diff overlay**：能力强但实现复杂、易与真实文件内容混淆，且会改变所有 base 侧工具结果；本 ADR 先做最低成本的模型提示。
- **无条件注入提示**：head 是大多数情况，会污染正常请求字节与回放；放弃。

## Consequences

- **正**：base / mixed 侧模型明确知道工具读到的是哪一侧，减少无效工具调用与错误结论；head 路径零变化。
- **负/风险**：base / mixed 侧的请求字节变化，相关回放 trace 需要重新录制；提示是文本约束，不能保证模型一定遵守。
- **中性**：审计 / `run.json` / stdout / 产物形状不变；侧别仍只作旁路观测，不影响退出码；`repoSnapshotSide` 不写入审计。

## 验收标准

1. **base**：初始 user 消息包含“改前（base）侧”“新增的文件可能不存在”“无结果不代表文件或符号不存在”。
2. **mixed**：提示首句为“侧别混杂”，其余与 base 相同。
3. **head / unknown**：初始 user 消息与改动前逐字节相同（不追加任何内容）。
4. **skill 会话**：种子来自 Phase-5 快照，因此也能看到该提示。
5. **分片**：每个片的 `ReviewPassInput.repoSnapshotSide` 都来自同一 run 级判定。
6. **测试**：`pnpm --filter @baize/review-pi test`、`pnpm --filter @baize/review-pi typecheck` 全绿。
