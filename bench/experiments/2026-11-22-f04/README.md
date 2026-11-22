# F-04 证据接地：历史回放

## 方法

用编译后的 `groundFindingEvidence`（`minMatchChars=30`）核对已有审计里的 findings；文件文本取 `git show <head_commit>:<file>`；零模型、零写回。

- v3：`iterF91 baseline-f91-v3-20261121`，320 findings。
- 旧版：`bench/aacr-bench-v2/results`（0.6.1 时期），1489 findings。
- 脚本：`eval_grounding.mjs`。

## 结果

| 批次 | findings | grounded | unverified | unverifiable |
|---|---:|---:|---:|---:|
| v3 | 320 | **217（67.8%）** | **103（32.2%）** | 0 |
| 旧版 | 1489 | 1022（68.6%） | 463（31.1%） | 4 |

## 解读

- `unverified` 不等于“编造”。大量 evidence 是：
  - 引用另一个文件/行段（`client/src/Components/Table/index.jsx:43-47`）；
  - 纯中文描述（“说明这里缺少 permissions”）；
  - 多行/省略号/中文追加，模块的窗口匹配仍可能定位不到。
- 因此 `drop` 模式在历史数据上会排除约 **32%** 的 findings，风险过高；默认必须是 `off`，推荐先用 `warn` 收集分布并人工抽查。
- 真正低风险的是文件/行号硬违规：v3 为 0；旧版行号越界约 5.7%、文件越界 6 条。

## 建议

1. 默认 `off`；A/B 时先 `warn`。
2. 人工抽查 v3 的 103 条 unverified，区分“改写”与“编造”。
3. 只有在误杀率可接受后，才考虑对 `drop` 开启，或只对“文件/行号硬违规 + 无任何证据”硬拒。

## warn 与 drop 的离线效果

warn 不改变 findings，只写 `evidenceGrounding` 计数；drop 会移除 unverified。用 v3 已有 judge 标签重算：

| 方案 | 生成 | precision | recall | balanced |
|---|---:|---:|---:|---:|
| baseline / warn | 320 | 0.3812 | 0.2449 | **0.2982** |
| drop unverified | 217 | **0.4286** | 0.1820 | 0.2555 |

- drop 会移除 103 条，其中 **29 条是 precision 命中**、**37 个 GT 覆盖丢失**。
- precision +4.7pp，但 recall −6.3pp、balanced **−4.3pp**。
- 结论：warn 只增加可见性，零输出损失；drop 当前不划算，应作为“未接地”信号（降置信 / 交给 F-05），而不是硬丢。
- 脚本：`drop_impact.mjs`；结果：`drop-impact.json`。
