# R-06b · 全仓召回评测

- Status: TODO
- Branch: `exp-repo-review`
- Created: 2026-11-25

## 问题

全仓检视目前只测了 precision，没有 recall。该仓没有标准的逐行全仓 GT；AACR-Bench 的样本是 diff 级人工评论，且 commit 与本次快照不同，不能直接当全仓 GT。

## 目标（启动时）

- 选一条可复现的召回口径：合成缺陷注入（主）或真实修复回滚（抽样校验）；
- 冻结 `ground-truth.json`（file / line / type / severity / fix）；
- 用与 R-06 相同的快照、模型和分组配置复跑；
- 报 overall / by-severity / by-type recall，以及注入文件 precision；
- 明确声明「注入检出率 ≠ 自然缺陷召回」。

## 范围决定

- 2026-11-25：本轮暂不测 recall，后续可能做。详见 [discussion.md](discussion.md)。
