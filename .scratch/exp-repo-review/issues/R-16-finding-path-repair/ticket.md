# R-16 Finding 路径修复

- Status: `DONE`
- 优先级：P0
- 分支：`exp-repo-review`

## 问题

生产全仓检视中，模型给出的 finding `file` 有几个字符错误（如 `util` → `utli`）。
下游按原路径读源码行失败，`buildShardReport` 以「code 不允许编造」跳过该条 tip，
平台侧显示「找不到源码行」，意见丢失；覆盖账本也把真实文件记成 `not-reached`。

## 方案

- 新增 `finding/path-repair.ts`：在 pass 收口、回填覆盖账本之前修 `Finding.file`；
- 已知文件全集：全仓 = 本组送检文件；MR = 本遍 diff 变更文件；
- 精确 → 宽松（大小写 / `\` / `./` / NFC）→ 有界编辑距离（≤12:1、≤24:2、其余:3）；
- 唯一最佳才修；平局、扩展名不同、绝对路径 / `..` 一律不修；
- 修复后的 findings 用于 coverage、`reviews_all.json` 与 MCP 报文；
  留痕写 `audit.pathRepairs`。

## 验收

- `finding/path-repair.test.ts` 9 例（精确 / 宽松 / 拼写 / 平局 / 扩展名 / 安全边界）；
- `repo-spike/run.test.ts`：`src/utli/helper.ts` → 结果 / coverage / reviews_all
  全部落到 `src/util/helper.ts`，`run.json` 有 `pathRepairs`；
- 全包 **1338 passed / 1 skipped**（123 个测试文件）；build / typecheck 通过。

## 决策记录

`docs/adr/0120-finding-path-repair.md`。

## 已知边界

- MR 默认 `findingScope` 若已把错路径候选判为 `file-not-in-diff`，修复发生在
  其后，无法挽回；本修复主要覆盖全仓路径。
- 不做全仓文件树模糊搜索；只在已知全集内修。
