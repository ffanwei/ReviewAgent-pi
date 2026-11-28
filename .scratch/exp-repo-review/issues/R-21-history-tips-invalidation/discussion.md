# R-21 讨论归档

## 2026-11-28 · 需求与数据契约

**需求**：仓级检视完成后，检查历史检视意见（检视前已放入
`<repoRoot>/.aireview/history_review_tips.json`），把已失效或与本次重复的
tipsId 经 `fullRepoFilerCurrentTips` 上报。填 R-10/ADR-0117 留下的 v1 空位。

**样例数据**（用户提供）：裸 JSON 数组；字段 `id`（"1" 数字字符串）、
`status`（PENDING/ACCEPTED/REJECTED/INVALIDATED）、`filePath`、`lineNum`、
`patchLine`、`reviewMsg`、`suggestions`、`vulnerabilityType`、`level`、
`subcategory`、`ruleId`、`networkZone`、`createDate`。只用前六个语义
（suggestions 起也不用）。

**关键回环事实（用户确认）**：repo 检视上报的 `code` 被平台转换存成
`patchLine`——它就是上次上报引用的源码行（可能带 `+`/`-` 前缀，存储格式）。
锚点匹配因此是「自己人对自己的回合」；样例 `ruleId` 是平台规则体系，
与我们的 `rule` 不同源，**不能**当匹配信号。

**状态语义**：INVALIDATED = 已上报过失效，恒不再检查（写入配置列表
装载期报错）；默认只查 PENDING；ACCEPTED（人工采纳，误失效代价最高）与
REJECTED（平台侧可能已不展示）可显式加入检查集但非默认——配置注释说明。

## 2026-11-28 · 判定规则与保守门

三规则起步：`file-removed`（文件不在磁盘/tracked）、`anchor-missing`
（引用行在当前文件中不存在）、`duplicate`（与本次已上报意见同文件 ±5 行
+ 文本 bigram Jaccard，复用 finding-key 口径）。

两道保守门：
- **覆盖门**：anchor/duplicate 判定只对本次实际检视过的文件
  （coverage = candidate/no-issue）；not-reached（组失败 / 预算 / `--files`
  范围外 / resume 未覆盖）→ 保留——本次无新信息。局部补跑天然安全。
- **呈现门**：duplicate 只对**实际已上报给平台**的 tips 集合判定，避免
  「新意见被 genericReview 抑制没上报、却把旧意见失效」两头落空。

排除规则：**「复审过但没再报」不是失效信号**（recall 不足，拿召回率赌误杀
不可接受）——留给 v2 模型裁决的地界，sidecar 先量化。

## 2026-11-28 · LLM 参与策略（用户拍板）

用户策略：**必要情况下必须 LLM 参与（有开关）**——确定性给不出答案但存在
失效信号的地带发语义裁决；`enabled: false` = 中间地带保守保留只留痕，
不是退化成确定性硬判。

四值裁决 `fixed` / `persist` / `duplicate` / `unclear`，保守偏置进提示词，
`unclear` 为缺省保守值。

## 2026-11-28 · 边角压力测试（四轮）

1. **同行两个问题、第二次只报新的**：击穿「硬档 code 相等 ≈ 零误判」——
   code 相等证明**同一位置**，不是**同一问题**。修正：硬档 = 位置匹配
   ∧ 问题匹配（文本 Jaccard ≥ 低阈值下限 0.3）；位置命中但文本不过线 →
   降级进 LLM 配对裁决。逐条最优匹配（允许多旧对一新）。
2. **同行两问题、旧的这次修了**：修复改写行 → gone → LLM → fixed（主路径）。
   暴露缺口：**模糊锚点自动保留会拦掉轻量修复**——按「必须 LLM 参与」
   策略，模糊档从决策层降级为信号分类：edited 也进 LLM。
3. **修复在别处、行原样**：LLM 代码窗口看不到上游修复 → persist/unclear →
   保留（可辩护：上游防护被重构掉问题就复活）。
4. **误报分析**（用户问「不用 LLM 会不会很多误报」）：分规则看，只有
   anchor-missing 有真风险（代码变 ≠ 问题没）；确定性先削最大误报源
   （模糊档保住轻改），残余中间地带交给 LLM。

## 2026-11-28 · 穷举矩阵（终版）

结构约束：位置匹配成立 ⟹ 锚点 exact（矩阵无重叠、每条恰一路径）。
8 行矩阵 + 文件层 2 行 + 准入层，见票。进入 LLM 的充分条件（「必要情况」
操作定义）：锚点有变更信号（edited/gone）或存在配对疑问。
唯一免模型保留：exact + 无配对信号。

## 2026-11-28 · LLM 调用形态与解析失败

- **one-shot 结构化调用**（无会话 / 无工具 / 不多轮），与收尾总结、
  coverage-repair verify 同车道；**读文件的是我们**——装配期从磁盘读、
  切窗口注入，模型不读文件。
- 代码窗口：edited → 模糊行；gone → 老 lineNum 现位置；配对疑问 → 老/新
  两窗口合并。±30 行 / 单窗口 4k 字符 / 小文件（≤6k）整读 / 单次 24k /
  30 条。
- 视野边界（有意）：无旧快照（只有 patchLine 一行）、无上游代码——
  persist 兜底。
- **解析失败重试 = 当天新增的 Structured Output 统一入口**
  （`invokeStructured`，commits 327b67f/2b225f6/83b4b71）：三层——传输
  （截断翻倍重发 / json_schema→json_object 有界降级）、解析修复（重发一次
  带错误 + 畸形回包截 32k）、失败分级契约（与会话阶段解析同源）。
  裁决车道是第 4 个调用方，零新解析代码。

## 2026-11-28 · 时机与持久化（用户提议，采纳）

判定**随组流水线化**（用户提议）：组完成 → MCP 上报 → 入队判定任务
（不阻塞该 worker 下一组），worker 并发 2；收尾 drain → 合并 → 单次
currentTips → endTask（上报位置被服务端契约钉死，动不了）。

正确性依据：repo 分组一个文件只属于一个组，其 findings / 覆盖在该组完成
时即齐——逐批判定无跨组依赖。

本地持久化（用户提议「本地 json 或内存」）：成功结果原子落盘
`<out>/history-tips-verdicts.json`（键 tipsId，复用条件 = 仍存在 ∧ 组 done），
失败不落盘（续跑天然重试）。**连带红利**：done 组判定已落盘，续跑无需
从 run.json 全量 findings 重建 presentationFindings（原
filterGenericSuggestions 重建方案作废）。

## 2026-11-28 · 封版参数（用户逐项拍板）

| 项 | 决定 |
|---|---|
| reason 词表 | 中文枚举 `文件已删除` / `重复` / `已修复`；wire 恒 string，verdict→reason 单点映射，LLM note 进 sidecar 备未来晋升为模型结论 |
| 状态集默认 | `["PENDING"]`；ACCEPTED/REJECTED 可显式加入（注释说明）；INVALIDATED 恒非法 |
| 上报分批 | 暂不分批，单次全量；量大再在传输层加循环 |
| 调用上限 | **删除预算截断**（用户要求「每条历史意见都判断过」）：每条 LLM 候选恰好一次尝试；单调用内部的超时/重试/批切分保留；成本护栏 = 输入规模 + 入口开关，无中途静默截断 |
| MCP 缺失/无效 | 建连层 reporter null → 跳过所有 MCP 上报 + 整个失效检查（含 LLM 车道）；无状态降级不算无效；单次失败走 fail-open |
| 配置生成 | 两新键进 config init 模板 + 示例配置（字节一致）+ 校验测试；旧配置走内置缺省 |
| `.aireview/` | 恒排除出 repo 枚举（EXCLUDED_DIRS），与 trackedOnly / 功能启用无关 |
