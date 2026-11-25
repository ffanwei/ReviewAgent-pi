# R-09 · 持久化编排与总预算

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-25

## 问题

当前 `runRepoSpike` 是单进程：组结果只在内存合并；主跑在 253/255 被宿主内存保护停止后，只能人工 `--files` 补跑。没有 job manifest、断点续跑、失败重试和总 token 预算。

## 目标

- `<out>/job.json`：快照 / 配置 / plan / 规则包 hash、每组 `pending / running / done / failed`、attempts、时间；
- 原子写（temp + rename）；以每组 `runs/<group>/runs/run.json` 为持久结果源；
- `--resume`：校验 hash，跳过 done，重跑 pending / failed；不一致拒绝续跑；
- 临时错误（429 / 5xx / 超时）与永久错误（4xx / auth）分开重试；
- `--max-total-tokens`：达预算停止派发新组，剩余记 `not-reached`；
- 退出码区分完成 / 部分完成 / 全失败。

## 验收

- 跑到一半 kill，`--resume` 后结果与不中断一致；无重复组；
- 失败组自动重试，审计记录 attempts；
- 预算超出一组以内；未派发组在 coverage 中 `not-reached`；
- 不再需要人工 `--files` 补跑。

## 依赖

R-04b、R-05b。

## 范围决定

- 2026-11-25：快速上生产的第三优先级；增量扫描仍暂缓，本任务只保证「全量可续跑」，不做跨轮缓存。

## 实现进展（2026-11-25）

- `job.ts`：`job.json` 清单（jobId / snapshotHash / configHash / planHash / maxTotalTokens / spentTokens / 每组 status + attempts + usage）；原子写（temp + rename）。
- hash：snapshot = 实际送入模型的全部文件内容；plan = 分组键 / 文件集 / 字符量；config = model / baseUrl / runtime / 规则包内容。
- `--resume`：校验 hash，跳过 `done`（从 `runs/<group>/runs/run.json` 重建结果），重跑 `pending / running / failed / budget-exhausted`；hash 不一致拒绝续跑。
- 重试：`--group-attempts`（缺省 2）；只对 429 / 5xx / 超时 / 网络类错误重试，401/403/400/404/配置类不重试。
- 预算：`--max-total-tokens`（含缓存）达到后停止派发新组，未派发组记 `skipped` + `budget-exhausted`，coverage 中为 `not-reached`。
- 退出码：0 完成 / 2 部分完成（失败组或预算停止）/ 1 全部失败；`job.json` 同步 `completed / partial / failed`。
- 验证：全包 1290 passed / 1 skipped；单测覆盖 job 写读 / hash 拒绝 / resume / 预算停止 + resume 继续 / 临时错误重试 / 永久错误不重试；真实 smoke 首跑完成，`--resume` 8.4s exit 0 且无模型请求。
- 口径说明：并发 >1 且设预算时，已派发组会继续完成，预算最多超出「在飞组数」；`attempts` 记在 `job.json`，组内 audit 只保留最后一次尝试。
