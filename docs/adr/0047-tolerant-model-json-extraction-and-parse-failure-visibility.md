# 0047. 模型 JSON 回复统一宽松提取；解析失败在 stderr 可见（P0 / P1）

**状态**：已接受（2026-11-07，用户直接决策）
**关联**：ADR-0006（六阶段骨架——本 ADR 不改阶段语义）、ADR-0014（规则 Skill 会话复用候选解析）、ADR-0037 / ADR-0045（MCP 上报；后者的一次性报文解析）、ADR-0039（分片检视的聚合审计）

## Context

Phase 5（候选）与 Phase 6（裁决）的解析只做两步：整串 `JSON.parse`、有围栏就整体剥掉再 `JSON.parse`。真实模型输出经常不是「纯 JSON」：

- `Here is the result:\n```json … ``` `（前置白话）
- ` ```json … ``` \nHope this helps!`（后置白话）
- 裸 JSON + 后置白话
- 两个围栏块
- 输出被 `max_tokens` 截断

这些输入全部解析失败，结果是 **0 候选 / 0 裁决 + 静默推进**：没有重试（有界推进是有意语义），但失败只写进审计 `phaseLog[].note`，用户 stderr 看不到「这一轮候选全丢了」。

仓里另有一处宽松提取（`cli/one-shot-llm.ts` 的 `extractJsonObject`，服务 `mrReviewResult` 报文），但它取「第一个平衡对象」。模型先给格式示例、后给真结果时，会**静默取到示例**（`tips: []`），把整片 findings 报成「没意见」——比失败更危险。

三类失败还有三种可见度（主循环只在审计 / skill pass 进 `degradedReason` / 报文进 stderr），排查时容易误判。

## Decision

### 1. 统一提取器（P0）

新建 `src/shared/model-json.ts`，Phase 5 / Phase 6 / 规则 Skill 会话 / 报文生成共用：

```text
extractModelJson(text, { preferKey }):
  1. 整串 JSON.parse（纯 JSON / 纯数组，保持旧语义）
  2. 剥首尾围栏后再整串 JSON.parse
  3. 花括号配平扫描（字符串、转义、嵌套安全）收集所有完整对象
     - 有 preferKey：取「含该键的最后一个对象」（避开示例对象陷阱）
     - 无匹配：取最后一个最外层对象（由调用方判定 missing-key）
```

- `preferKey`：候选 = `candidates`，裁决 = `verdicts`，报文 = `tips`。
- 失败分级：`empty` / `truncated` / `not-json` / `missing-key`；不抛异常。
- 保持「不重试、有界推进」：Phase 5/6 解析失败仍是空结果 + 继续，skill pass 解析失败仍记 `failed/parse`。
- 修掉旧宽松提取器的两个坑：白话里先出现不成 JSON 的 `{…}` 不再直接 `null`；示例对象不再优先于真结果。

### 2. 解析失败可见（P1）

- `PhaseRecord` 新增**可选**字段 `parseFailure?: { expected: "candidates" | "verdicts"; kind }`；只在失败时出现，成功 run 的审计形状逐字节不变。
- 主循环把解析失败写进该字段（`note` 保留原英文诊断，含 "JSON" 字样供 grep）。
- CLI 在收尾摘要之后按 `phaseLog` 打 stderr 一行，**不改退出码**：

  ```text
  review-pi: [r1 phase5] 候选解析失败（not-json），本轮 0 候选；详见审计 phaseLog
  ```

- 分片模式：聚合审计只收集带 `parseFailure` 的相位记录（诊断，不是正文）；无失败时仍为 `[]`，单片/成功路径零漂移。

## Options（为什么不是别的）

- **解析失败重试一次**：改六阶段「每阶段恰好执行一次」的语义，属 P2，需单独决策；本 ADR 不做。
- **只放宽 `parseJsonReply`、不做分级原因**：stderr 只能说「失败了」，无法区分截断/缺键；分级成本很低。
- **继续用「第一个平衡对象」**：示例对象陷阱会静默丢数据，比解析失败更不可接受。
- **把失败直接写 stderr（loop 层）**：分层污染；CLI 是唯一 stderr 出口。用可选审计字段 + CLI 汇总保持分层。

## Consequences

- **正**：前后白话、多围栏、示例对象不再丢整轮结果；失败可在 stderr 直接看到；一次性报文解析也避开示例陷阱。
- **负/风险**：宽松提取可能把「本不该当作回复」的对象识别为回复——由 `preferKey` 与「最后一个」规则收窄；最坏情况仍由候选门逐条校验兜底。
- **中性**：六阶段指令、wire 字节、工具 schema、分片边界、退出码均不变；成功 run 的审计/产物零漂移。

## 验收标准

1. **输入矩阵**：纯 JSON / 纯围栏 / 围栏+前置白话 / 围栏+后置白话 / 裸 JSON+后置白话 / 两个围栏块 / 白话含花括号 / 字符串含 `{}` 与转义 / 示例对象+真结果 / 截断 / 空回复 / 缺目标键——各有单测。
2. **主循环**：Phase 5 输出 `not a JSON reply at all` ⇒ 6 次请求、0 候选、`phaseLog[4].parseFailure = { expected: "candidates", kind: "not-json" }`（不重试）。
3. **示例陷阱**：Phase 5 先给 `{"candidates":[]}` 再给真候选 ⇒ 真候选进入 gate。
4. **可见性**：进程级测试断言 stderr 含上述一行、退出码 0、审计带 `parseFailure`。
5. **公开解析 API**：`parseJsonReply` / `parseCandidatesReply` / `parseVerificationReply` 的既有失败语义（空结果 + note，不抛异常）不变；skill pass 的 `degradedReason` 仍含 "JSON"。
6. **全量验证**：`pnpm -r typecheck`、`pnpm --filter @baize/review-pi test`、`pnpm test` 全绿。
