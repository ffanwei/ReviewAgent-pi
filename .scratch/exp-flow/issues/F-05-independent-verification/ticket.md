# F-05 独立证伪核验

- Status: `DONE`（回放结论：不接主路径）
- 优先级：P0
- 分支：`exp-flow`
- 对应问题：P0-5、V3
- 讨论归档：[discussion.md](discussion.md)
- 验收证据：`bench/experiments/2026-11-22-f05/README.md`（103 条 unverified 全量回放 + F-04 组合表）

## 目标

对候选 finding 开独立模型会话，只给 finding + 行号附近的文件片段，尝试证伪；只在该片段能明确支持“缺陷成立”时 pass。默认先 `warn`，保护性主题 fail-open，不做多轮循环。

## v1 范围

- 新模块 `gate/independent-verifier.ts`：一次 one-shot 请求/候选，返回 `pass/reject/uncertain` + reason；失败/超时/解析失败 fail-open。
- 配置 `limits.verification`：`enabled`（默认 false）、`mode`（warn/drop）、`scope`（unverified/all/high-risk）、`maxCandidates`、`maxTokens`。
- 审计 `verificationAudit`：requests/failed/pass/reject/uncertain/usage。
- **先做离线回放**：用历史 v3 的 320 findings（优先 F-04 unverified 103 条）跑核验器，与已有 judge 标签比对，估拒绝率、误杀率、token。
- 回放结果确认后再决定是否接入主路径与 live A/B。

## 不做

- 不做多轮“问到通过/拒绝为止”；一次调用 + 至多一次解析重试。
- 不改主检视 wire 请求、工具 schema、提示词。
- 不默认启用；不默认 drop。

## 验收

- 回放：核验器拒绝项中 FP/TP 比例、GT 损失、token 有数据；
- 失败路径 fail-open；理由可审计；
- 全包测试 + build；
- 若接入主路径：小规模 live A/B，P/R/B、噪声率、R 损失 ≤2pp。

## 回放结果（2026-11-22）

- 103 条 F-04 `unverified` 全量：flash 44 pass / 2 reject / 57 uncertain（240k token）；
  pro 54 pass / 0 reject / 49 uncertain（283k token）；0 请求失败、0 解析失败。
- reject 稀少且 TP/FP 各半 → 不能作 drop 门；pass 精度 33–34%（子集基线 29.1%），弱区分度。
- F-04 drop + F-05 pass 返场后 B 27.9%（flash）/ 28.4%（pro），仍低于 baseline 29.8%。
- 判定：模块保留但默认 off、不接主路径；下一轮先扩证据窗口（片段/多文件）再评估。

