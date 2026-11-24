# R-06 · 全仓评测集与基线

- Status: DOING
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

