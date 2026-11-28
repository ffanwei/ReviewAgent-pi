# 0122. 仓级检视的历史意见失效上报（fullRepoFilerCurrentTips 落地）

**状态**：已接受（2026-11-28）
**关联**：[ADR-0117](0117-full-repo-mcp-reporting.md)（全仓上报四工具——本 ADR 填它的 currentTips v1 空位）、[ADR-0113](0113-stage-compression.md)（Structured Output 既有）、ADR-0086（生命周期 facade 模式）
**范围**：只影响 `repo-review`；MR / PR 路径零改动（PR 四工具没有失效上报位）。
**任务**：R-21（`.scratch/exp-repo-review/issues/R-21-history-tips-invalidation/`）。

## Context

ADR-0117 把 `fullRepoFilerCurrentTips` 定为 v1 恒发空数组（不处理历史意见失效）。
平台侧随后给出闭环需求：检视开始前把历史检视意见放进工作区
（`<repoRoot>/.aireview/history_review_tips.json`，条目含 `id` / `status` /
`filePath` / `lineNum` / `patchLine` / `reviewMsg` 等字段），检视完成后把已失效
或与本次重复的意见 `tipsId` 上报，`reason` 为 string。

关键数据事实：repo 检视上报的 `code` 被平台存储为 `patchLine`——历史条目的
`patchLine` 就是**上次上报引用的源码行**（可能带 `+`/`-` diff 前缀）。锚点匹配
因此是同引擎回环：路径、行号、单行 code 口径全部同构。

## Decision

### 1. 判定矩阵：规则层 + LLM 语义裁决层

结构约束：位置匹配（`patchLine` ≡ 本次 finding 引用的当前源码行）成立 ⟹ 锚点
必为 exact——「位置命中」只出现在 exact 行，矩阵无重叠，每条意见恰一路径。

| 锚点 | 配对信号 | 谁判 | 结果 |
|---|---|---|---|
| exact | 位置命中 ∧ 文本 Jaccard ≥ 0.3（硬档，最优匹配） | 规则 | 失效「重复」 |
| exact | 位置命中但文本不过线 | LLM | 裁决定 |
| exact | 无位置命中但同文件文本 ≥ 0.5（软档） | LLM | 裁决定 |
| exact | 无任何配对信号 | 规则 | 保留 |
| edited（行被改仍近似）/ gone（行没了） | 任意 | LLM | 裁决定 |

文件层先行：文件不在磁盘 → 规则失效「文件已删除」；not-reached（组失败 /
预算 / `--files` 范围外 / resume 未覆盖）→ 规则保留。锚点三态（exact / edited /
gone）里 edited、gone 是「变更信号」——按「必要情况下必须 LLM 参与」的产品
策略，**模糊锚点不自动保留**（否则轻量修复永远到不了裁决）。文本相似度复用
`finding-key.ts` 的字符二元组 Jaccard（与候选门同根因去重同口径）。

**排除规则**：「复审过但没再报」不是失效信号（召回不足，不可拿 recall 赌
误杀）；exact + 无信号是唯一免模型保留。

### 2. LLM 语义裁决（`semanticVerdict.enabled`，默认开）

- 「必要情况」操作定义：锚点有变更信号（edited / gone）**或**存在配对疑问；
- 一次性结构化调用（无会话 / 无工具 / 不多轮），接 `invokeStructured`
  （Structured Output 统一入口：json_schema 约束解码 → json_object 有界降级 →
  解析失败修复重发一次），purpose `history-verdict`（usage 账本独立来源）；
- 四值裁决 `fixed` / `persist` / `duplicate` / `unclear`，保守偏置进提示词
  （宁可 persist/unclear 不误 fixed；`persist` 记为召回信号留痕）；
- 读文件的是装配方（CLI 从磁盘读、切代码窗口注入 ±30 行 / 小文件 ≤6k 整读）；
  模型拿不到旧快照与上游代码——persist 兜底是有意的视野边界；
- **每条候选恰好一次裁决尝试，无预算截断**（用户硬性要求「每条历史意见都
  判断过」）；条目 / 上下文超上限**拆批**不跳过；失败（重试耗尽）→ 该批
  保守保留，失败不落盘（续跑天然重试）。

### 3. 时机与持久化：判定随组流水线化

组完成 → `fullRepoReportReviewResult`（平台可见优先）→ 入队判定任务（不阻塞
该 worker 取下一组；判定池并发 2）。正确性依据：repo 分组里一个文件只属于
一个组，其 findings / 覆盖在该组完成时即齐。

成功结果原子落盘 `<out>/history-tips-verdicts.json`（键 tipsId）；续跑只复用
「仍存在 ∧ 组 done」条目——done 组判定已落盘，**续跑无需从 run.json 全量
findings 重建呈现集**（原 filterGenericSuggestions 重建方案随之作废；仅
「续跑组无缓存需补判」的边缘路径仍走呈现重建）。收尾 drain → 合并 → 单次
`currentTips` → `endTask`（上报位置由服务端契约钉死）。

### 4. 上报与配置

- reason 中文枚举：`文件已删除` / `重复` / `已修复`；wire 恒 string，
  verdict → reason 收口在单点映射，LLM 裁决 `note` 进 sidecar 备未来晋升为
  模型结论文本；单次全量上报（不分批）；
- `limits.repoScan.historyTips`：`statuses`（默认 `["PENDING"]`；
  ACCEPTED / REJECTED 可显式加入，INVALIDATED 恒被枚举校验拒绝）
  + `semanticVerdict.enabled`（默认 true）；两键进 `config init` 模板；
- `.aireview/` 恒排除出 repo 枚举（`EXCLUDED_DIRS`），与 trackedOnly / 功能
  启用无关——历史意见输入目录不进检视面。

### 5. 故障语义（硬性不变量）

失效判定是收尾链里优先级最低的一环：任何失败最多「这批不判」，绝不影响
检视结果、产物落盘、`endTask`、退出码。`finalize` 出口只有列表或空列表。
无 MCP / 建连无效（reporter null）→ 整个失效检查跳过（含 LLM 车道——判定
结果的唯一消费者是 currentTips 上报，没有目的地不烧裁决 token）；无状态降级
不算无效。防御收口：仍无终态的条目一律保留（`unresolved`）。

## Consequences

- 正面：平台历史意见闭环；误失效被三层保守设计压住（两道门 + 规则层不
  猜语义 + LLM 保守偏置）；判定零额外模型成本（规则层）+ 有界语义成本
  （仅变更信号 / 配对疑问进 LLM）；续跑零重复裁决成本；replay 零影响
  （裁决走 one-shot 车道，不进 agent 主循环请求）；
- 负面：漏失效是安全方向的误差（上游修复行未变 → persist 保留）；判定
  语义成本随 history 文件规模线性（入口开关是唯一成本旋钮，无运行中静默
  截断）；文本阈值（0.3 / 0.5）与编辑距离预算为拍的初值，待 sidecar 相似度
  分数回校；
- 回放 / 测试：六场景 trace 不受影响（进程级与单测覆盖矩阵、裁决契约、
  fail-open、续跑复用、MCP 携带清单）。
