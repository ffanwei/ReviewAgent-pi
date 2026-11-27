# R-19 讨论归档

## 2026-11-27 · 重录策略与长路径缓存根

**问题**：提示词变更后六条 trace 全部失配；rule-skill 场景重录后仍在 verify 阶段 miss。

**结论**：

- 提示词变更只影响请求字节，不影响期望。用旧 trace 的响应按请求顺序作为
  `--upstream`，走官方 `record` 代理路径重新生成请求哈希，最省成本且不改变
  `expect`。
- rule-skill 的 miss 根因是 Windows 长路径回落的技能缓存根
  `os.tmpdir()/rp-rule-skills/<sha256(runsRoot)>` 未被归一化；lane 每次不同，
  hash 就不同。按 lane 的 `runsRoot` 计算并注册 `<rule-skill-cache>` 后稳定。
- 这类「运行期路径」以后都应通过 `addPathRoot` 注册，而不是写进 trace。
