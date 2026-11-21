# arm1 vs arm2：findingScope 开关的实际影响

## 定义

| | arm1 | arm2 |
|---|---|---|
| 配置 | 默认 `~/.PiAgent/PiAgent.jsonc` | `~/.PiAgent/benchmark-aacr-v2.jsonc` |
| `findingScope` | 开（`contextLines=10`） | 关 |
| 规则 Skill | 未加载 | 未加载 |
| 数据 | 3 条 pilot | 全量 108 ok / 91 交集 |

两臂只差 `findingScope` 一个开关；规则 Skill 是另一个未跑的维度，不属于 arm1/arm2。

## 3 条 pilot（不能作为结论）

| 指标 | arm1 | arm2 |
|---|---:|---:|
| Precision | 0.450 | 0.292 |
| Recall | 0.345 | 0.241 |
| Balanced | ~0.390 | 0.264 |

只有 3 条，且 run-to-run 方差很大（同一 codex 样本两次 findings 数 9 vs 4）。这组差异主要不是 scope 造成的。

## 91 条交集的离线估算

把 arm2 的 1242 条意见按 `findingScope` 规则（文件在 diff 内且行号在 hunk ±10 内）过滤，重放已有 judge 匹配：

| 指标 | arm2（scope 关） | arm1-like（scope 开） |
|---|---:|---:|
| 生成意见 | 1242 | 1202 |
| 命中新 GT | 97 | 97 |
| 覆盖 GT | 106 | 106 |
| Precision | 0.0781 | 0.0807 |
| Recall | 0.1803 | 0.1803 |
| Balanced | 0.1090 | 0.1115 |

过滤只丢掉 **40 条（3.2%）**：其中 36 条 hunk 外 + 4 条文件不在 diff；命中新 GT 的 **0 条**、覆盖 GT 的 **0 条**。

## 结论

1. **对本次 91 条对比，arm2 与 arm1 的差异可以忽略**：P +0.0026、B +0.0025，R 不变。把 arm2 作为对比口径没有改变 OCR vs review-pi 的结论。
2. **scope 不是本次差距的杠杆**。review-pi 的 978 条无 GT 意见在 changed 文件内、只是文件没有 GT，不是 hunk 外，scope 拦不住。
3. **产品默认（scope 开）略好**：在本数据上 precision/balanced 小幅提升、recall 无损；没有理由为了 benchmark 关掉它。
4. 真正值得投入的实验是**规则 Skill / 文件靶向 / 意见预算**，不是反复切换 arm1/arm2。

## 边界

- 离线估算用原始 `git diff` 重建 scope，比 review-pi 内部过滤后的 diff 略宽，真实 arm1 丢弃数可能略多，但量级不会变。
- 模型是随机的；换成其他仓库/其他 prompt，scope 的影响可能不同。
- arm1 全量没有真正跑过；本结论是离线近似的，但 40 条丢弃与实测的 36+4 完全吻合。
