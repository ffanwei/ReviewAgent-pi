# R-20 讨论归档

## 2026-11-28 · 用户反馈「建议类太多」

**反馈**：用户试用后认为通用检视的建议类意见过多；用户显式传入的 Skill 应作为
检视重点，尽量按 Skill 要求保留。

**结论**：

- 不按标题关键词（「建议」「可以」「考虑」）猜测，避免误杀真实缺陷；只按
  `severity` + `category` 做确定性抑制。
- 抑制放在**候选阶段**（Phase 5 完成、skill 候选追加之前），让
  `reviews_all.json`、中文 tips、MCP 上报口径同时收敛，且不需要给 Finding
  增加来源字段。
- 默认只压 `P3` 且 `category ∈ {可维护, 可读性, 可测试性}`，保留 P3 的安全 /
  可靠性 / 性能意见；`severities` 清空即可完全关闭。
- 全局 `limits.severity.min` 维持 `P3`，不用它承担此需求，避免连带丢弃规则
  Skill 的 P3 tips。
- 规则 Skill 会话增加「Skill 优先」尾注，Phase 6 候选核验也不得以「只是建议 /
  风格 / 文档 / 测试」为由驳回。用户显式配置的 confidence / severity 阈值仍然
  生效（它们是用户主动选择，不属于通用检视缺省）。

## 2026-11-28 · untracked 文件与检视写文件

**问题**：git 仓检视原先枚举 tracked + 未被 ignore 的 untracked；检视过程可能
往仓内写文件，临时复制进来的文件也可能被检视。

**结论**：新增 `limits.repoScan.trackedOnly`，git 仓缺省 `true` 只枚举已跟踪
文件；需要旧口径时配置 `false`。非 git 仓不受影响。
