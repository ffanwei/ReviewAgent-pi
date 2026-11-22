# F-05 讨论归档

> 票与验收在 [`ticket.md`](ticket.md)；任务总表在 [`../../map.md`](../../map.md)。

## 2026-11-22 · 开工与回放口径

- F-05 = 语义证伪；F-04 = 确定性接地，二者互补。F-04 回放显示 `drop` 会误杀约 32%，因此 F-05 先做离线回放，不直接接入主路径。
- 验证对象：v3 iterF91 320 findings；优先 F-04 `unverified` 的 103 条（接地失败的语义真伪最值得看）。
- 回放方式：每条 finding 一次 one-shot 调用；输入 = finding + 行号附近文件片段；输出 = pass/reject/uncertain。
- 判定：与已有 judge 标签按 `(file, line)` 对齐，统计被拒绝项里 TP/FP、GT 覆盖损失、token。
- 模型：先与检视同档 `deepseek-v4.1-flash`；若误杀高，再试 `deepseek-v4-pro` 做对照。
- 循环纪律：一次调用 + 至多一次解析重试；uncertain 不重复追问。
- 成本上界：320 条全量约 0.5–0.8M token；只跑 103 条约 0.15–0.25M；F91 baseline 53.1M，占比 <1.5%。

## 2026-11-22 · 分类修正与 pilot 重跑

- 首轮 pilot 出现 `reject` 且 reason 以 `uncertain:` 开头：排查发现源码里的判定正则被写成了字面退格符（`/^uncertain\x08/i`，粘贴/转义事故），要求 `uncertain` 后紧跟 0x08，永远不匹配。改为 `/^uncertain:/i` 后源码与 build 产物一致（全仓扫描无其它 0x08 残留）。
- 首轮 pilot 的 5 个 reject 作废（不是模型行为，是分类 bug）；首轮 pro 的 3 个“解析失败”也随 maxTokens 1024→1536 消失。
- 重跑 pilot（前 10 条 unverified，concurrency 2，maxTokens 1536，无请求失败/解析失败）：
  - `deepseek-v4.1-flash`：2 pass / 8 uncertain / 0 reject；
  - `deepseek-v4-pro`：3 pass / 7 uncertain / 0 reject。
- 观察：unverified 子集本身多是“接地失败/依赖跨文件上下文”的 finding，给 80 行片段后验证器大多判“片段不足”，而不是轻易判 reject——保守方向符合 fail-open 纪律；但若最终 reject 率过低，`drop` 模式在 unverified 子集上几乎没有作用，接入主路径前需要用 `scope=all` 子集确认它对确定接地项是否还有区分度。

## 2026-11-22 · 全量 103 条回放结论

- 修完分类与 token 预算后全量重跑（max_tokens 4096、解析失败最多重发一次；0 请求失败 / 0 解析失败）：
  - flash：44 pass / 2 reject / 57 uncertain，240k token；
  - pro：54 pass / 0 reject / 49 uncertain，283k token。
- reject 极少（2 / 0 条），而且 flash 的两条 1 TP 1 FP——**把 F-05 当 drop 门没有价值**。
- pass 有弱区分度：flash pass 精度 15/44=34.1%、覆盖 17/39 GT；pro 18/54=33.3%、覆盖 21/39 GT；子集基线精度 29.1%。
- 与 F-04 组合（320 全量口径）：F-04 drop 全部 unverified 后 B 29.8%→25.5%；再加 F-05 pass 返场，flash B 27.9%、pro B 28.4%，仍低于 baseline；37 个被 F-04 丢掉的 GT 只找回 17–21 个。
- 瓶颈判断：不是提示词/模型档位，而是**输入只有 80 行单文件片段**；uncertain 里还压着 12–14 TP，说明“片段不足”是真瓶颈。
- 决策：F-05 模块保留（默认 off、不接主路径）；本轮不写 ADR、不做 live A/B。下一轮若继续，先解决证据窗口（更大片段或多文件上下文）再谈 drop/返场。
- 证据：`bench/experiments/2026-11-22-f05/README.md`（结论与组合表）、`replay-report.md`（原始表）、`full-{flash,pro}.json`、`rescue-{flash,pro}.json`。


