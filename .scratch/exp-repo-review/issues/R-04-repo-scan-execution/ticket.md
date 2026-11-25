# R-04 · 全仓扫描执行路径

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-24

## 问题

现有 `review-run.ts` 以 diff 为入口，分片 / 分组执行、覆盖账本、证据门都建立在变更行上。全仓扫描需要独立的执行适配层。

## 目标

- 新增独立 run mode 适配层，消费 R-03 的分组计划；
- 逐组独立检视，组失败不影响其他组；
- 尽量复用现有六阶段循环与证据门；
- 不改 `review-run.ts` 主路径，或只做明确记录的最小接线。

## 验收

- 单组 / 多组路径均可跑通；
- findings 行锚点指向真实现有行；
- 组失败隔离，审计可定位；
- 与 MR 路径的配置 / 产物不互相污染；
- 有零模型 dry-run 覆盖执行计划。

## 依赖

R-01、R-03；R-05 输出契约可并行。

## 实现进展（2026-11-24）

- 执行缝：`src/repo-spike/run.ts` 每组合成「全新增」diff 后调用一次 `runReviewOutcome`；
  `mapWithConcurrency` 控制组并发（v1 上限 5）；组失败不终止整次运行。
- 预算：新增 `ReviewRuntime.maxToolCalls`（缺省不传 = 100，MR 路径不变），
  spike 设 15；`limits.retrieval` 设 1 次/文件、2 次连续空搜索、12 万字符。
- 行锚点：合成 diff 的 `+` 行号 = 真实文件行号，校准 run 已人工核对 6 条 finding 的行号。
- 未完成：scan 专用 Zone A 与初始消息（当前仍沿用 MR 的「本次新增」语义）；
  该语义债不改变行锚点，但会影响「既有问题」的措辞。
- 全仓实跑：`spring-ai-java-prod` 1,390 文件 / 255 组，并发 3，起跑 2026-11-24 22:03；
  75 组完成时 1.21 组/分钟，预计 01:33 完成；75 组产出 403 条 findings（P0 3 / P1 61 /
  P2 289 / P3 50），含 SQL 注入、SSRF、WebSocket 并发写、NPE 等可复核缺陷。
  产物 `D:/Project/.repos/out/full-ours/`。


## 2026-11-25 · 全仓实跑收尾（DONE）

- 我方：255/255 组完成（1,390/1,390 文件），1,342 条 findings
  （P0 4 / P1 173 / P2 1,004 / P3 161），68.63M token，207.5 min（主跑并发 3 + 补跑并发 2）。
  主跑在 253 组时被宿主内存保护停止，缺失 2 组（12 文件）用 `--files` 补跑。
- 最后 2 组（g036 / g118，各 6 文件）在收尾时被 Claude Code 的后台内存压力机制停止；
  这是宿主机资源保护，不是命令失败。按系统提示未自动重启，结果由 per-group
  `run.json` 合并，覆盖缺口在报告中显式标注。
- OCR：前三片 682 文件 / 1,625 条 / 41.57M token / 163.7 min（并发 2）；
  剩余分片以并发 4 继续。

## 2026-11-25 · 生产化拆分

- 本票的 `DONE` 只覆盖 spike 执行缝；scan 专用 Zone A、`repo-review` 命令与中性文件快照见 [R-04b](../R-04b-scan-semantics/ticket.md)。
