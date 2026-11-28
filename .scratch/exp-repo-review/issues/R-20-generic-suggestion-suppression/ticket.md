# R-20 · 通用检视建议类抑制与 git 仓 trackedOnly 缺省

Status: done
Claimed: 2026-11-28
Branch: `exp-repo-review`
Commit: `ff33194`

## 背景

真实用户反馈：通用检视输出中「可不改的建议」类意见过多，查看成本高。同时，
仓库检视会纳入未被 `.gitignore` 排除的 untracked 文件，而检视过程本身可能
往仓内写文件，导致临时文件被误检。

## 目标

1. 增加配置开关，默认在**通用检视**阶段抑制建议类候选；用户显式传入的规则
   Skill 是重点，其候选不受该抑制影响。
2. git 仓检视默认只枚举已跟踪文件；需要旧口径时可显式关闭。
3. 参数必须能通过 `config init` 生成；`repo-review` 与 MR 检视共用同一能力。

## 方案

### `limits.genericReview.suppress`

```jsonc
"genericReview": {
  "suppress": {
    "severities": ["P3"],
    "categories": ["可维护", "可读性", "可测试性"]
  }
}
```

- 在 Phase 5 候选归一完成后标记命中集合；候选仍进入候选门与全量真源
  `reviews_all` / stdout，只在呈现层（中文 tips / MCP 上报）隐藏。
- 候选合并时命中主候选不占同根因键，避免遮蔽用户规则 Skill 的候选；Skill
  候选天然不在命中集合里。
- `severities` 空数组 = 不过滤；`categories` 空数组 = 只按严重级，不限类别。
- 覆盖补漏候选同一口径；被抑制的补漏 finding 仍回填覆盖账本。
- 审计 / `run.json` 增加 `genericReview`：策略、隐藏总数、按严重级 / 类别计数。
- Skill 会话 system prompt 追加「规则 Skill 优先」尾注；Phase 6 skill 候选核验
  口径明确不得以「只是建议 / 风格 / 文档 / 测试」为由驳回。

### `limits.repoScan.trackedOnly`

- 缺省 `true`：git 仓只用 `git ls-files`；非 git 仓仍走文件系统遍历。
- `false`：恢复 tracked + 未被 ignore 的 untracked（旧行为）。
- `config init` 模板、示例配置、repo dry-run 与设计文档同步。

## 验收

- `pnpm --filter @baize/review-pi typecheck` 通过。
- 包内全量测试：127 files / 1388 passed / 1 skipped。
- `pnpm test:replay`：6/6 PASS（`large-mr`、`rule-skill-single-finding`
  因 skill system prompt 变化重录）。
- 覆盖：generic policy 纯函数、loop 主候选抑制 + Skill 候选保留、补漏抑制、
  repo 模式抑制 + 审计、`trackedOnly` 枚举、config init / parse / 非法值。
- `reviews_all` / stdout / `run.json` 保留全量；中文 tips 与 MCP 上报使用
  presentation findings。repo 集成用例直接断言被抑制的 P3 仍在
  `reviews_all.json`，但 `onGroupReviewed` 上报的 findings 为空。
