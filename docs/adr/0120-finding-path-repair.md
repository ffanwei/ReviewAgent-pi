# 0120. Finding 路径修复：按已知文件全集修正少量字符错误

**状态**：已接受（2026-11-25）
**关联**：[ADR-0061](0061-every-diff-file-reported-before-summary.md)（每文件必报）、[ADR-0119](0119-report-every-file-when-skipped.md)（按文件上报）
**范围**：只在 pass 收口处修 `Finding.file`；不改提示词、不改 `Finding` 契约其余字段、不改候选门。

## Context

生产全仓检视出现一条意见：模型给出的 `file` 路径有几个字符写错（例如目录
`util` → `utli`）。下游按该路径读源码行失败，`buildShardReport` 按
「code 不允许编造」跳过这条 tip，平台侧表现为「找不到源码行」，意见丢失。
全仓模式 `findingScope` 关闭，错误路径不会在候选门被提前拦住。

## Decision

1. 新增**确定性路径修复**（`finding/path-repair.ts`），在 `review-pass` 拿到
   agent 结果后、回填覆盖账本 / 组装报文之前执行；
2. 已知文件全集：
   - 全仓 = 本组实际送检文件（`fileSnapshot`）；
   - MR = 本遍 diff 的变更文件；
3. 匹配顺序：
   - 精确匹配 → 不动；
   - 宽松匹配（`\` → `/`、去 `./`、大小写、Unicode NFC）→ 唯一命中才修；
   - 宽松不中 → 有界编辑距离：路径长度 ≤12 最多 1 字符、≤24 最多 2、其余最多 3；
     且扩展名必须一致；
4. 只有**唯一最佳**才修；平局、候选为空、扩展名不同都保持原样；绝对路径 /
   盘符 / `..` 段一律不修（安全边界优先）；
5. 修复后的 finding 用于覆盖账本、`reviews_all.json`、MCP 报文与合并结果；
   修复留痕写入 `audit.pathRepairs`（`{ from, to, distance }`，只在非空时出现）。

## Consequences

- **正**：少量字符错误不再导致意见在报文阶段静默丢失；覆盖账本也从「未触达」
  恢复为 `candidate`；修复是确定性的、可审计的。
- **负 / 风险**：
  - 模糊匹配存在误挂风险；用「唯一最佳 + 扩展名一致 + 距离上限」收敛，宁可
    不修也不猜；
  - 修复发生在 pass 收口，MR 默认 `findingScope` 若已把错路径候选判为
    `file-not-in-diff`，该候选在修复前就被丢弃——本 ADR 对全仓路径有效，
    MR 侧只覆盖未被范围门拦截的候选；
  - 不改模型提示词；不保证修复所有形态（如整段目录缺失、路径长度变化过大）。
- **不做**：不做全仓文件树模糊搜索（只在已知全集内）；不修 `evidence` 文本里
  的路径；不把修复当成候选门的一部分。

## 验收

- `finding/path-repair.test.ts`：精确 / 宽松 / 拼写 / 平局 / 扩展名 / 安全边界；
- `repo-spike/run.test.ts`：候选 `src/utli/helper.ts` → 结果、覆盖账本、
  `reviews_all.json` 全部落到 `src/util/helper.ts`，`run.json` 有 `pathRepairs`；
- 全包测试与 build / typecheck 通过。
