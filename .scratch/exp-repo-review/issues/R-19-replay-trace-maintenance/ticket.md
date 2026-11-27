# R-19 · 离线回放 trace 维护

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-27
- Commit: `8653f8b`

## 问题

改 system prompt 后，六条 replay trace 的请求哈希全部失配，`test:replay` 6/6 失败。
另外 `rule-skill-single-finding` 在 Windows 长路径下每次运行都 miss：规则 Skill
缓存根回落到 `os.tmpdir()/rp-rule-skills/<runRootHash>`，该路径不在 `<lane>` 下，
没有归一化。

## 处理

- 用旧 trace 的响应序列作为确定性上游，走官方 `record` 路径重录六条 trace；
  模型响应、工具面与场景期望保持不变，只刷新请求字节。
- `lane.mjs` 按本 lane 的 `runsRoot` 计算回落的缓存根并注册
  `<rule-skill-cache>` 占位符；`requestNormalization.placeholders` 同步登记。
- `test:replay` 六场景恢复 6/6 PASS。

## 验收

- `pnpm test:replay`：6/6 PASS。
- trace 的 `response` 与 `toolsVariants` 逐条与重录前一致（core-no-finding 已逐条核对；
  其余场景由 `record` 的 `served=n/n` 与重放自检保证）。
