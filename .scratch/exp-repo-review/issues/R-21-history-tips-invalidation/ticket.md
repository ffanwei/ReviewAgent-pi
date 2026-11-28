# R-21 · 历史意见失效上报（repo 模式）

Status: done
Claimed: 2026-11-28
Branch: `exp-repo-review`

## 背景

R-10 的 `fullRepoFilerCurrentTips` v1 恒发空数组（ADR-0117：不处理历史意见失效）。
平台侧在检视开始前把历史检视意见放进工作区
（`<repoRoot>/.aireview/history_review_tips.json`），本次检视完成后应把其中
已失效 / 与本次重复的意见 tipsId 上报平台。

## 输入契约

- 文件：`<repoRoot>/.aireview/history_review_tips.json`，裸 JSON 数组；
- 条目字段（只用这些）：`id`（→ tipsId，数字字符串转 number）、`status`
  （PENDING / ACCEPTED / REJECTED / INVALIDATED）、`filePath`（仓根相对）、
  `lineNum`（正整数）、`patchLine`（上次上报的 code 源码行，可能带 `+`/`-`
  diff 前缀）、`reviewMsg`（意见文本）；
- 其余键（taskId / suggestions / vulnerabilityType / level / subcategory /
  ruleId / networkZone / createDate）忽略；
- `patchLine` 是我们上次上报的 `code` 经平台存储转换回环——锚点语义即
  「上次引用的代码行」。

## 判定矩阵（方案核心）

结构约束：位置匹配（patchLine ≡ finding 引用的当前源码行）成立 ⟹ 锚点
exact——「位置命中」只可能出现在 exact 行，矩阵无重叠。

| # | 锚点 | 同文件配对信号 | 谁判 | 结果 |
|---|---|---|---|---|
| 1 | exact | 位置命中 ∧ 文本过线（硬档） | 规则 | 失效「重复」 |
| 2 | exact | 位置命中 ∧ 文本不过线 | LLM | 裁决定 |
| 3 | exact | 无位置命中，文本相似 ≥ 软阈 | LLM | 裁决定 |
| 4 | exact | 无任何配对信号 | 规则 | 保留 |
| 5 | edited | 文本相似 ≥ 软阈 | LLM | 裁决定 |
| 6 | edited | 无配对信号 | LLM（变更信号） | 裁决定 |
| 7 | gone | 文本相似 ≥ 软阈 | LLM | 裁决定 |
| 8 | gone | 无配对信号 | LLM（变更信号） | 裁决定 |

文件层（先行）：文件不在磁盘 / tracked → 规则失效「文件已删除」；
not-reached（枚举跳过 / 组失败 / 预算 / `--files` 范围外 / resume 未覆盖）→
规则保留。准入层：INVALIDATED 恒跳过；status ∉ 配置集跳过；id / lineNum
非法计 invalid 条目。

锚点分类：exact（trim 后精确行存在）→ 无变更信号；edited（编辑距离 ≤ k
的近似行存在）/ gone（无任何近似行）→ 有变更信号。

## LLM 语义裁决（`semanticVerdict.enabled`，默认 true）

- 「必要情况」= 锚点有变更信号（edited/gone）或存在配对疑问（#2/#3）；
- 接 `invokeStructured`（既有 Structured Output 统一入口：json_schema 约束
  解码 → json_object 降级 → 有界修复重发），verdict → reason 单点映射；
- 四值裁决：`fixed`（失效「已修复」）/ `duplicate`（失效「重复」）/
  `persist`（保留 + 召回信号留痕）/ `unclear`（保留）；
- 输入按文件分批装配：候选条目 + 该文件本次已上报 findings + 代码窗口
  （±30 行 / 单窗口 4k 字符 / ≤6k 字符小文件整读 / 单次 24k / 30 条）；
- 每条候选**恰好一次**裁决尝试（无预算截断）；调用失败（重试耗尽）→
  该批保守保留（fail-open，粒度 = 单批），下轮扫描自动补判；
- 保守偏置写进提示词；漏答按 unclear、幻觉条目忽略。

## 时机与持久化

- 判定随组流水线化：组完成 → MCP 上报 → 入队判定任务（不阻塞下一组），
  判定 worker 并发 2（可升 4）；
- 成功结果原子落盘 `<out>/history-tips-verdicts.json`（`.part` + rename），
  键 tipsId；**失败不落盘**（续跑天然重试）；只复用「仍存在 ∧ 组 done」条目；
- 连带红利：done 组判定已落盘，续跑不需要从 run.json 全量 findings 重建
  presentationFindings（原重建方案作废）；
- 收尾 drain → 合并（内存 + 落盘）→ 单次 currentTips → endTask。

## 上报

- 单次 `fullRepoFilerCurrentTips({ taskId, invalidatedTips })`，不分批；
- reason 中文枚举：`文件已删除` / `重复` / `已修复`；wire 恒 string
  （verdict→reason 单点映射、LLM note 进 sidecar，备未来 reason 改用模型结论）。

## 配置

```jsonc
"limits": {
  "repoScan": {
    "historyTips": {
      "statuses": ["PENDING"],              // 默认；ACCEPTED/REJECTED 可显式加入
      "semanticVerdict": { "enabled": true } // LLM 语义裁决开关
    }
  }
}
```

- 枚举校验：PENDING/ACCEPTED/REJECTED；INVALIDATED 写入 → ConfigError；
  空数组 = 不检查；大小写敏感；
- 两键进 `config init` 模板 + `PiAgent.example.jsonc`（字节一致）+ 解析
  校验测试；旧配置不写块走内置缺省。

## 故障语义（硬性不变量）

> 失效判定是收尾链里优先级最低的一环。任何失败最多「这批不判」，绝不影响
> 检视结果、产物落盘、endTask、退出码。

- 无 MCP / MCP 建连无效（reporter null）→ 整个失效检查跳过（含 LLM 车道），
  历史文件存在时 stderr 一行；无状态降级不算无效；单次调用失败走 fail-open；
- 判定计算整体包防御性 try/catch，出口只有「列表或空列表」；
- 自愈：保留的意见状态不变，下一轮全仓扫描重新遇到、重新裁决。

## 留痕

- `repo-review-result.json` 摘要：total / checked / skippedInvalidated /
  invalidEntries / kept / invalidated / byReason / byVerdict / byStatus；
- sidecar `<out>/history-tips-invalidation.json`：逐条
  `{ tipsId, reason, matchedFindingId?, verdict?, note?, 相似度分数 }`。

## 其他纪律

- `.aireview/` 恒排除出 repo 枚举（`EXCLUDED_DIRS`），与 trackedOnly 无关；
- dry-run 零模型，判定任务不建队；
- 裁决用量走 usage 账本（one-shot purpose），不挤占 maxTotalTokens；
- 内部常量不进配置面：窗口 ±30 行 / 4k / 6k / 24k / 30 条 / worker 并发 2；
  Jaccard 硬档下限 0.3 / 软阈 0.5（待真实数据回校，sidecar 记分数）。

## 验收（2026-11-28 完成，commit 7be10d2）

- 判定核心单测 26 条：准入归一（INVALIDATED 跳过 / 状态过滤 / id 与
  lineNum 校验 / filePath 归一）/ 锚点三态 / 配对信号与矩阵 8 行 /
  reason 映射；
- 裁决契约单测 6 条：合法 verdicts、duplicate 必须带合法
  matchedFindingId（否则解析失败 fail-open）、幻觉条目忽略、坏回包
  重发后失败、超上限拆批（每条都判）、提示词窗口装配；
- 编排单测 9 条：硬档零模型定案 + sidecar 落盘、fixed/persist 终态、
  调用失败 fail-open、开关关闭零调用、end-sweep 文件已删除与
  not-reached、续跑缓存复用（零重付 LLM）、续跑无缓存补判、
  finalize 异常防御壳；
- 进程级端到端 2 条：夹具仓副本 + history 文件 → currentTips 携带
  中文 reason 清单 + result 摘要 + sidecar + stderr 留痕；MCP 未启用
  → 整个失效检查跳过 + 一行留痕；
- `config init` 模板含两键且与示例配置字节一致（config.process 既有
  测试覆盖）；historyTips 配置单测（默认 / 可配 / INVALIDATED 拒绝 /
  大小写敏感）；
- `.aireview/` 枚举排除单测；full-repo-lifecycle 携带清单单测；
- 全包 130 files / 1435 passed / 1 skipped；`pnpm test:replay` 6/6
  （裁决走 one-shot 车道，agent trace 零影响）。

## 验收（原验收清单）

- 纯函数单测：条目准入 / 锚点分类（exact-edited-gone）/ 矩阵各路径 /
  相似度与编辑距离边界 / reason 映射 / 合并复用（tipsId 去重、组 done 校验）；
- 裁决契约测试：json_schema 形状、四值枚举、漏答 / 幻觉条目 / 部分非法
  条目处置、修复重发路径；
- 进程级 stub：history 文件存在 + MCP stub → 四工具顺序不变，
  `currentTips` 携带 invalidatedTips；MCP 关闭 → 跳过 + 一行 stderr；
  开关关闭 → LLM 候选保留留痕；调用失败 → fail-open 不碰退出码；
- `config init` 模板含两键且与示例配置字节一致；
- 回放零影响（裁决走 one-shot 车道，不进 agent 主循环请求）；
- 全包测试 + `test:replay` 6/6。
