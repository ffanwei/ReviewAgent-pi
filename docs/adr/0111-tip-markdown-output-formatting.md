# 0111. 上报 tips 的 Markdown 段落确定性格式化（B 方案）

**状态**：已接受（2026-11-20，用户决策：先做输出面 B）
**关联**：[ADR-0090](0090-chinese-native-review.md)（tips 随候选直接产出）、[ADR-0106](0106-tips-full-projection-with-unreported-log.md)（tips 全量投影）、[ADR-0052](0052-tips-four-tier-severity-and-confidence-filter.md)（tips 过滤）、[ADR-0104](0104-summary-output-sanitization-and-truncation.md)（同为输出面守门，处理的是总结）
**范围**：只改 `mrReviewResult.reviewTips` 与 `reviews_tips_zh.json` 的 `review` / `suggestion` 文本段落；不改模型请求字节、候选归一化、Phase 6、`code`、Finding schema、上报字段集或退出码。

## Context

Phase 5 / 规则 Skill 的候选示例与系统提示只要求 `tips.review` / `tips.suggestion` 是“中文 Markdown”，示例本身写成一行：

```json
"tips": {
  "review": "[缺陷类型] 未判空的用户对象解引用。影响评估：请求路径抛 NPE。",
  "suggestion": "[重构思路] 判空后走缺省分支。代码示例：`if (user == null) { return; }`"
}
```

模型照示例输出，整条意见在平台渲染成一段：

```text
[缺陷类型] 文件句柄泄漏。影响评估：fd 耗尽。[重构思路] 加 defer。代码示例：`defer f.Close()`
```

链路上没有任何地方会补换行：

- `candidate-normalize.ts` 的 `normalizeTips` 只 `trim()`；
- `report-payload.ts` 原样取 `tips.review` / `tips.suggestion`；
- `agentReviewTipFromUnknown` 只校验非空，不校验 Markdown 段落；
- JSON / MCP 传输保留 `\n`，但模型没有产出 `\n`。

直接改提示词会改变主会话请求字节（测量常量面）并需要重录回放；在终检里强制换行又会让不满足的意见被跳过，降低上报覆盖率。

## Decision

### 1. 在输出面做确定性断段

新增 `cli/tip-format.ts`：

- `formatTipReview(text)`：`review` 中若 `影响评估` / `[影响评估]` 前没有换行，补一个 `\n\n`；
- `formatTipSuggestion(text)`：`suggestion` 中若 `代码示例` / `[代码示例]` 前没有换行，补一个 `\n\n`；标签后同一行还有内容时，把内容移到下一行（fenced code block 从行首开始）；
- 已有换行（包括单换行）保持原样；
- 不增删文字、不改写标签、不改 `code`、不改其他字段；
- 幂等：重复调用不会叠加空行。

例：

```text
[缺陷类型] 文件句柄泄漏。影响评估：fd 耗尽。
→
[缺陷类型] 文件句柄泄漏。

影响评估：fd 耗尽。
```

```text
[重构思路] 加 defer。代码示例：`defer f.Close()`
→
[重构思路] 加 defer。

代码示例：
`defer f.Close()`
```

### 2. 应用点

- **MCP**：`cli/shard-report.ts` 在 `mrReviewResult` 发送前对每条 `reviewTips` 做格式化；
- **本地 tips**：`cli/unified-tips.ts` 的 `toUnifiedTip` 组装 12 键时做同样格式化；
- 两处共用 `cli/tip-format.ts`，保证平台与 `reviews_tips_zh.json` 文本一致。

### 3. 不改的地方

- 不改变 Phase 5 / Phase 6 / skill 会话请求字节；
- 不改 `reviews_all.json` 里的 `Finding.tips` 原文（它仍是候选产出的原始值）；
- 不改变 `code` 单行约束；
- 不改变上报字段集、过滤链、覆盖率补报与退出码。

## Options（为什么不是别的）

- **只改提示词示例**：治本但改变主会话请求字节，需要 ADR + 重录回放；且模型仍可能不遵守。留作后续提示词优化，不作为本次修复。
- **终检强制要求 `\n`，不满足就跳过**：会提高“平台未收到”的数量，和 ADR-0106 的完整可见方向相反；否。
- **在候选归一化阶段格式化**：会让格式化后的 tips 进入 Phase 6 skill 候选清单，改变请求字节；且 `reviews_all.json` 也会被改写。否。
- **正则删除“思考痕迹”或重写内容**：模型措辞无穷，规则易腐坏；本次只做标签前的段落断点。否。

## Consequences

- **正**：平台与本地 tips 的 `review` / `suggestion` 至少按 `影响评估` / `代码示例` 分段；模型请求字节、候选流、Phase 6 全部不变；格式化幂等、可测试。
- **负/风险**：
  - 只能保证两个常见标签前有段落；其他自定义 Markdown 排版仍由模型决定；
  - 若模型使用不同措辞（如“影响分析”“示例代码”），不会被格式化，需要扩充标签表；
  - `reviews_all.json` 的 `tips` 仍是原文，与两个输出面可能不同。
- **中性**：字段集、长度上限、过滤与上报顺序不变；格式化不改变 `reviewTips` 条数。

## 验收标准

1. 一行 `review` 含 `影响评估` → 输出在标签前有 `\n\n`。
2. 一行 `suggestion` 含 `代码示例` → 输出在标签前有 `\n\n`，且标签后的内容另起一行；fenced code block 从行首开始。
3. 已有换行的文本原样保留；重复格式化不叠加空行。
4. 方括号标签 `[影响评估]` / `[代码示例]` 同样支持。
5. 标签在开头或无标签的文本不被改写。
6. MCP `mrReviewResult.reviewTips` 与 `reviews_tips_zh.json` 都经过同一格式化。
7. `code` 仍为单行；请求字节、审计 / `run.json` / stdout 键集不变。
8. `pnpm --filter @baize/review-pi test`、`pnpm --filter @baize/review-pi typecheck` 全绿。
