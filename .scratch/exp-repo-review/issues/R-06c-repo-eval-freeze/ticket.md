# R-06c · 仓级冻结评测集（R-06 v2 建议）

- Status: TODO
- Branch: `exp-repo-review`
- Created: 2026-11-26

## 问题

R-06 是单仓、单快照、单次对照，只测了 precision 抽样，没有逐行全仓 GT，也没有召回；
它不能作为版本回归或对外可复核的“标准集”。公开基准（AACR-Bench、iterF91）都是
MR / diff 级，不能换算成仓级成绩。需要定义一套**冻结、可复跑、可版本比较**的仓级评测集。

## 目标（启动时）

- 固定仓库、commit、检视范围与配置；
- 固定 GT（文件 / 行 / 类型 / 严重级 / 修复）；
- 固定判官 rubric、抽样规则与随机种子；
- 固定运行器与产物格式；
- 产出冻结基线与回归门禁；
- 明确区分 precision、recall、coverage、成本四类指标。

## 冻结项

| 项 | 内容 |
|---|---|
| 仓库与版本 | 仓库列表 + 精确 commit SHA |
| 检视范围 | 生产文件、语言、include/exclude、预期文件数 |
| GT | `file / line / type / severity / fix` |
| 运行配置 | 模型 ID、网关、温度、轮数、分组、工具预算、并发 |
| Prompt / Skill | system prompt、六阶段、规则 Skill 的 hash |
| 判官 | 模型、rubric、抽样规则、种子 |
| 基线 | 每 case 的 findings、coverage、token、耗时、P/R/F1 |
| 运行器 | 固定版本评测脚本 |

任一冻结项变化即升版本（v2 → v2.1），不得静默改题。

## 标准答案来源

不存在“全仓所有真实缺陷”的绝对全集；参考真值必须构造并声明适用范围。

| 来源 | 答案怎么来 | 保真度 | 用途 |
|---|---|---|---|
| 真实修复回滚 | 选历史 bug-fix commit，`git apply -R` 回滚修复；GT = 回滚 hunk | 最高 | 主召回集 |
| 合成缺陷注入 | 在真实文件中注入已知缺陷；GT = 注入点 + 类型 + 修复 | 中高 | 分类型召回、长尾 |
| 人类 PR 评论 | 用 reviewer 在 diff 上的评论作 GT（如 AACR-Bench） | 中 | 召回下限，不是全集 |
| 静态分析 / 漏洞库 | Semgrep / CodeQL / SpotBugs / VUL4J / CVE fix 作候选，人工确认 | 中 | 候选池 |
| 专家审计 | 人工逐文件标注 | 高（局部） | 抽样校验 |

精度不需要全仓缺陷全集：对每条 finding 单独判定 `VALID / INVALID / UNCERTAIN`；
覆盖率按文件清单对账；召回必须有构造 GT，报告时必须写“注入/回滚集上的召回”，
不得表述为“自然全仓召回”。

## 建议的首版结构

```text
repo-review-eval-v2/
  manifest.json              # 版本、仓库 SHA、文件数、hash
  cases/<repo>/
    scope.json               # 检视范围与排除规则
    ground-truth.json        # 注入/回滚缺陷清单
    baseline/
      metrics.json
      findings.jsonl
  configs/default.jsonc
  judge/rubric.md
  runner/run.mjs
```

建议三层 GT：

- 真实修复回滚：40–60 条；
- 合成注入：60–100 条；
- 人类 PR 评论：现有可用样本；
- 负样本：30–50 个确认干净文件，用于误报率。

## 标注质量协议

- 每条 GT 至少两人独立标注，分歧第三人仲裁；
- 标注者不知道哪些是注入、哪些是自然缺陷；
- 行号允许 ±N，但根因必须一致；
- GT 不进入被测仓库；注入代码不得带 `BUG` / `FIXME` 提示；
- GT 改动必须升版本。

## 不做

- 不把 R-06 的单次数字写成产品级准确率；
- 不与 iterF91 / AACR 的 MR 指标混报；
- 不把“注入检出率”写成“自然缺陷召回率”；
- 不在本轮改代码、schema、workflow 或评测脚本。

## 验收（启动后）

- 冻结集 manifest 与 GT 入库或固定 artifact；
- 同配置复跑结果可重复；
- 基线 P/R/F1、coverage、token、耗时齐全；
- 回归门禁可执行；
- 报告明确 GT 来源、构造方法、适用范围与局限。

## 依赖

R-06（已完成对照口径）、R-06b（召回口径先验证可行）。

## 当前决定

2026-11-26：仅记录方案，**暂不启动**。不新增代码、不建评测脚本、不改现有评测流程。
