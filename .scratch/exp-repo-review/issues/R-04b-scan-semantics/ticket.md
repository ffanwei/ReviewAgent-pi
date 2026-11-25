# R-04b · scan 语义与产品命令

- Status: TODO
- Branch: `exp-repo-review`
- Created: 2026-11-25

## 问题

R-04 按 spike 形态验收：`repo-spike` 把每个文件合成为「全部新增」unified diff，并沿用 MR 系统提示词。生产不能把既有代码说成「本次新增」；模型消息里出现 `new file mode` / `--- /dev/null` 与「只报本次 diff 新增行」自相矛盾。

## 目标

- 新增 `review-pi repo-review`，`repo-spike` 保留为别名；
- `ReviewRunInput` 增加 `reviewMode?: "diff" | "repo"`，缺省 `diff`；
- repo 模式用中性文件快照消息（`=== path ===` + 内容），不向模型展示 diff 头；
- 新增 scan Zone A：整文件、既有行、只报可复核缺陷；不复用 MR 的「本次新增 / 不要报既有问题」措辞；
- 审计 `source=repo-scan`；输出 `repo-review-result.json`；
- MR 系统提示词逐字节不变，`test:replay` trace 不受影响。

## 验收

- 模型可见消息不含 `new file mode` / `--- /dev/null`；
- 20 组 A/B：输出「本次新增」0 次；precision 不回退超过 5%；token 增幅 ≤10%；
- MR 全包测试与 `test:replay` 不变；
- dry-run 仍零模型、零配置。

## 依赖

R-01、R-04；与 R-05b 并行，先冻结 `repo-review-result.json` schema。

## 范围决定

- 2026-11-25：快速上生产的第一优先级；不包含覆盖账本（R-05b）与持久化（R-09）。

## 实现进展（2026-11-25）

- 命令：新增 `review-pi repo-review`；`repo-spike` 保留为别名（缺省输出目录分别是 `repo-review-out` / `repo-spike-out`）。
- 输入语义：`ReviewRunInput.reviewMode: "diff" | "repo"`（缺省 diff）；`fileSnapshot` 进 `ReviewPassInput`，初始消息改用 `buildRepoInitialUserMessage`（`=== path ===` + 内容，无 `new file mode` / `--- /dev/null` / `Unified diff`）。
- 提示词：新增 `SCAN_SYSTEM_PROMPT`；`SYSTEM_PROMPT` 未改一个字节。新增 `SCAN_PHASE_INSTRUCTIONS` / `SCAN_PHASE_ORDER`，Phase 1 为 Code Understanding；repo 模式忽略 compact，避免 MR 指令混入。
- 审计/产物：`run.json` 与 `reviews_all.json` 的 `source = repo-scan`；结果写 `repo-review-result.json`，过渡期兼容写 `repo-spike-result.json`；plan 同理。
- 验证：全包 `1275 passed / 1 skipped`；真实 1 组 smoke（2 个 Java 文件）通过，审计确认 system prompt 含「仓库快照」且不含「本次 diff」，phaseLog 六阶段为 Code Understanding 起头。
- 待办：20 组 A/B（旧 spike 语义 vs 新 scan 语义）——统计「本次新增」出现次数、precision 是否回退 >5%、token 是否增幅 >10%。
