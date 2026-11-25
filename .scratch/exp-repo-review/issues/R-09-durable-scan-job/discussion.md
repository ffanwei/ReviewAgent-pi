# R-09 讨论归档

## 2026-11-25 · 为什么快速上生产必须先做持久化

- 主跑在 253/255 组被宿主内存保护停止，最后 2 组靠人工 `--files` 补跑；这不是可交付的生产运行方式。
- 现有每组 `runs/<group>/runs/run.json` 已经是持久结果，缺的是 job 级状态、hash 校验和续跑入口。
- 决策：v1 先把「全量可续跑 + 总 token 预算」做出来；增量 / 跨轮缓存仍按 R-07 暂缓。
- 重试策略：临时错误有限重试，永久错误直接标记 failed，避免把鉴权 / 配置问题拖成长时间重试。

## 2026-11-25 · 实现落地（DONE）

- `job.json` 是断点真源：每组 status / attempts / usage；结果仍以 `runs/<group>/runs/run.json` 为准，resume 时重建为 `RepoSpikeGroupOutcome`。
- hash 三件套：snapshot（文件内容）、plan（分组/文件集/字符量）、config（model/baseUrl/runtime/规则包内容）；任一变化拒绝 resume。
- 预算停止后不派发新组；已派发组继续完成，因此并发 >1 时最多超出在飞组数。未派发组 -> `budget-exhausted`，由 R-05b 覆盖账本呈现为 `not-reached`。
- 退出码 0 / 2 / 1 分别对应完成 / 部分完成 / 全部失败；`job.json.status` 同步。
- 验证：真实首跑 + resume（8.4s，无模型请求）；单测覆盖预算停止后 resume 继续、临时错误重试、永久错误不重试、hash 变化拒绝。
