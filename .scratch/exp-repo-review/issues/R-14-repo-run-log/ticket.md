# R-14 全仓运行日志

- Status: `DONE`
- 优先级：P1
- 分支：`exp-repo-review`

## 问题

全仓命令只有 stderr，宿主停止 / 终端关闭后没有可复盘每一步（枚举、分组、每组进度、
MCP 上报、收尾）的现场；MR 路径已有 `review-pi.log`，全仓缺失。

## 方案

- 在 `cli/main.ts` 的 repo-review / repo-spike 分发前打开运行日志，早于 dry-run
  分支与配置装载；
- 路径与 review 同布局：`<out>/runs/review-pi.log`（`<out>` 缺省
  `<tasks 根>/<taskId>`，`--out` 可覆盖）；
- 复用 `cli/run-log.ts`：`writeSync` 同步追加，stderr 全量镜像（进度 / 告警 /
  失败原因），日志头写版本与 taskId；
- dry-run 同样写入（计划也是执行过程）；打开失败只告警，不影响检视与退出码；
- 未捕获异常的堆栈继续走 `activeRunLog.detail()`（进程退出前关闭 fd）。

## 验收

- 进程级 dry-run：`<out>/runs/review-pi.log` 存在，含版本头、taskId、dry-run 计划行；
- 进程级真跑（MCP stub）：日志含 `fullRepoReportReviewResult` 上报行；
- 全包 1325 passed / 1 skipped；`pnpm build` 通过。

## 不做

- 不改 `request-timeline.jsonl` 的写入机制（已知缺口：全仓并发组共用一个进程级
  sink，会导致组间串写 / 空文件；需要时另行立票）；
- 不把日志放进每组目录（组内已有 audit / transcript）。
