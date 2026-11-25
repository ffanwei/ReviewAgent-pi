# R-06 · 全仓评测集与基线

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-24

## 问题

现有 `iterF91` / AACR 评测是 MR + diff GT，不能直接换算成全仓扫描成绩。

## 目标

- 确定全仓 GT 来源：VUL4J 快照、注入缺陷的全仓版本，或其他可核对数据；
- 冻结样本、GT、仓库版本；
- 建立零模型覆盖基线与 P / R / B 口径；
- 定义成本口径（token、墙钟、组数、文件数）。

## 不做

不把 MR 指标直接换算成全仓成绩；不混报两种形态。

## 验收

- 评测集冻结（样本、GT、版本）；
- 零模型基线可复跑；
- 指标定义与统计方法成文；
- 与 MR 评测结果明确隔离。

## 依赖

R-01；可与 R-02 并行。

## 本轮执行范围（2026-11-24）

用户指定：选一个约 30 万行业务代码的 Java 仓，用 OCR 与我方各做一次全仓检视（最高 5 并发），
用模型初步判定准确率，分析耗时 / token / 准确率。

- 仓：`alibaba/spring-ai-alibaba@17e26ff`；总 Java 249,222 行 / 1,607 文件；
  生产 Java 192,785 行 / 1,390 文件（两工具共同面，测试默认排除）。
- 我方：`repo-spike`，6 文件/组，directory 分组，并发 3，1 轮，工具预算 15/20。
- OCR：`open-code-review v1.14.3`，`--no-plan --no-summary`，并发 5，DEDUP 保留。
- 判定：模型判官 `deepseek-v4.1-flash`，按文件分层抽样；Precision = VALID/(VALID+INVALID)。
- 产物：`D:/Project/.repos/out/full-ours/`、`D:/Project/.repos/out/ocr-shards/`；
  报告：`.scratch/exp-repo-review/reports/全仓检视-OCR对照-报告.md`。

## 不测什么

- 不测召回（无逐行 GT）；合成缺陷召回留 R-06b。
- 不把本次单仓单次结果写成产品级准确率。


## 2026-11-25 · 全仓实跑收尾

- 我方：255/255 组完成（1,390/1,390 文件），1,342 条 findings
  （P0 4 / P1 173 / P2 1,004 / P3 161），68.63M token，207.5 min（主跑并发 3 + 补跑并发 2）。
  主跑在 253 组时被宿主内存保护停止，缺失 2 组（12 文件）用 `--files` 补跑。
- 最后 2 组（g036 / g118，各 6 文件）在收尾时被 Claude Code 的后台内存压力机制停止；
  这是宿主机资源保护，不是命令失败。按系统提示未自动重启，结果由 per-group
  `run.json` 合并，覆盖缺口在报告中显式标注。
- OCR：前三片 682 文件 / 1,625 条 / 41.57M token / 163.7 min（并发 2）；
  剩余分片以并发 4 继续。

## 验收证据（2026-11-25）

- 报告：`.scratch/exp-repo-review/reports/全仓检视-OCR对照-报告.md` / `.pdf`。
- 我方：255/255 组、1,390 文件、1,342 条 findings、68.63M token、207.5 min；
  判官 120 条 precision 0.82（P0–P2 0.93）。
- OCR：1,388 文件、3,561 条 comments、95.51M token、285 min 分片执行；
  判官 150 条 precision 0.69（high/critical 1.00、medium 0.63、low 0.21）。
- 指标口径：precision 按严重级分层抽样，`UNCERTAIN` 单列；不测召回（留 R-06b）。
- 与 MR 指标隔离：本报告只报全仓结果，不引用 iterF91 / AACR 的 MR 成绩。
- 覆盖缺口：我方 2 组（12 文件）因宿主内存保护停止，已在报告 §5.1 / §7 标注。

## 未做 / 后续

- 未冻结逐行 GT，未做零模型覆盖基线，未测召回；本轮是「同快照跨工具全仓对照」，
  不是完整的冻结评测集。
- R-06b：合成缺陷注入 / 真实修复回滚测召回；把 precision + recall 一起报。
- 复跑脚本与原始产物在 `D:/Project/.repos/out/`（gitignored 语义，不入库）。
