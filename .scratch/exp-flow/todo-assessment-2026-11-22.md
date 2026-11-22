# exp-flow TODO 复盘（2026-11-22）

> 依据：`map.md`、`docs/design/检视流程合理性评估-OCR对照与历史Session证据.md`（§4/§7/附录 D）、
> `docs/report/` 历史评测、F-01–F-07 的归档数据与本轮新增的 S10/S20 A/B。
> 结论只针对剩余 `TODO`（F-08–F-15），并给出新增项建议。

## 一、逐项结论

| ID | 任务 | 结论 | 依据 | 建议动作 |
|---|---|---|---|---|
| F-08 | 检索预算 + 重叠区间 Ledger | **保留，升为当前第一优先** | 历史 12 run：Ledger 命中 0–1 次；`search_code` 21 次中 15 次零命中（71%）；48 个读取文件 22 个未被 finding/evidence 引用（46%）。S20 compact：Phase 4 占 173/271 请求（64%） | 拆成 F-08a（区间 Ledger，纯确定性）与 F-08b（检索预算/零命中即停）；F-10、F-12 作为 F-08b 的实验臂并入，不再单独立项 |
| F-09 | 输出校准：confidence 0.3；范围外 `scope` 标注 | **保留，拆两步** | VUL4J 10 例：`confidence≥0.5` 相对 `≥0` 丢 2/19 真值、精准度 51.5%→50.0%；范围外 11 条中 8 条真实（§4.6） | F-09a 先把默认 `confidence.min` 0.5→0.3（离线可验证）；F-09b 把越界 finding 改为 `scope: "outside-diff"` 标注而非丢弃，需产品口径与契约变更 |
| F-10 | Phase 5/6 按需读取 | **调整：并入 F-08** | 157 次工具调用中 Phase 5 仅 1 次、Phase 6 为 0；Phase 4 是绝对成本中心 | 不单独做；在 F-08b 中加一臂「Phase 4 预算 + Phase 5 定向取证」，与现状 A/B |
| F-11 | 多轮语义：边际收益停止 + 硬上界 | **建议 DROPPED** | 12/12 历史 run `rounds=1`；F-06 已 DROPPED（无独立补扫）；F-01b 的覆盖补漏已提供显式第二遍 | 保留 `maxRounds` 硬上界；不做通用“无新增即停”，除非未来默认机制真的会产生多轮 |
| F-12 | 确定性预取 | **调整：并入 F-08b 实验臂** | `resolveChangedFileSymbols` 无运行时调用方，需先补 head 侧 `newSpansOf`；只有“投机读取”假设，无 A/B | 不单列 P2；F-08 证明需要时再做 prefetch 臂，验收看 hit rate 与工具调用 |
| F-13 | 大 diff severity 区分度复核 | **建议关闭（未复现）** | 用 v3 归档离线复算：大 diff P1 命中 54.2%、P2 34.3%、P3 32.1%；小 diff P1 40%、P2 38.2%、P3 21.4%——并非“全部 3–4%” | 不改 severity；把结论记入 map 后置 DONE/DROPPED；P0 样本仅 1/6 条，结论只覆盖 P1–P3 |
| F-14 | `search_rule` / `search_history` 可见性 | **建议 DROPPED（有条件）** | 生产 toolkit 默认不注入 knowledge 语料时这两个工具不可见；历史 24 次、约 111 字符/次来自带语料的配置 | 只有产品决定引入 knowledge 语料时才重开；当前不作为流程任务 |
| F-15 | delivery / platform 闭环 | **保留，拆四块** | C2 阈值/退出码、C3 manifest/CI、preview、resume/PR 原生是四种不同风险 | 拆 F-15a 覆盖阈值 + 退出码、F-15b manifest/CI 复用（优先）；F-15c preview；F-15d resume/PR 原生暂缓（无需求证据） |

## 二、建议新增

| ID 建议 | 任务 | 优先级 | 依据 | 验收 |
|---|---|---|---|---|
| F-16 | 评测方法学：成对多轮 + 置信区间 | P1 | F-07 S10 两对复本方向相反（−9.9pp / +14.1pp），同臂跨 run 波动 10–14pp；judge 输出确定，多 judge 轮不解决运行方差 | 固化脚本/报告模板：每次 A/B 至少两对 run、报 bootstrap CI、同时给 token/墙钟/工具调用；后续任务不得用单次运行宣称结论 |
| F-17 | 一次性调用输出鲁棒性（推理模型） | P1 | F-05 回放：1536 token 下 13/103 解析失败（content 为空/截断）；4096 + 一次重试后降为 0；tips/repair/verifier 共用 one-shot 层 | 统一检测 `finish_reason=length`/空 content，预算感知重试一次，审计记 parse-fail/重试计数；单测覆盖 |
| F-18 | 覆盖补漏是否默认开启 | P1 | F-01b v3：B 0.453 vs arm A 0.387，但 token +6%、补漏候选精度约 26.7%（v1）；当前 `coverage.repair.enabled=false`；F-04/F-05/F-07 后默认面已变 | 在当前默认（compact + evidence off）下重跑迭代集，比较 P/R/B、token、补漏精度；给出默认值决策 |
| F-19 | Replay trace 维护与门禁 | P2（但立即可做） | F-07 改阶段提示词后 `test:replay` 六场景全 FAIL；已用 canned 语料重录 5 个，`large-mr` 需真网关重录，仍 FAIL | 重录 large-mr；在 CI/PR 模板中加入“改提示词必须重录 trace”；门禁恢复 6/6 |
| F-20 | 证据策略默认值（warn vs off） | P2 | F-04 默认 off、F-05 不接主路径；grounding 目前只在显式开启时可见 | 评估 `limits.evidence.mode=warn` 作为默认（只计数不拒绝）是否可接受；run.json 暴露 unverified 比例供下游选择 |

## 三、排序建议

1. **F-19（立即）**：恢复 replay 门禁，`large-mr` 重录；这是 F-07 落地的收尾。
2. **F-08a 区间 Ledger**（确定性、零模型），随后 F-08b 检索预算/定向取证 A/B。
3. **F-09a confidence 0.3**（离线可算，低风险），再谈 F-09b scope 标注。
4. **F-16 评测方法学**：作为 F-08/F-18 的前置，避免再用单次运行下结论。
5. **F-18 覆盖补漏默认化**与 **F-17 输出鲁棒性**并行评估。
6. **F-15a/b**（阈值 + manifest）按产品需求插入；F-15c/d 暂缓。
7. F-10/F-12 不再单独立项；F-11/F-13/F-14 关闭或条件关闭。

## 四、附带发现

- `map.md` 的 Changelog 缺 F-05/F-06/F-07 三行；F-07 的 `DONE` 是在 `large-mr` replay 未绿的情况下收口的，
  建议在 F-19 完成后补记验收状态。
- F-07 修改提示词后，历史 replay trace 全部失效（已有记忆条目），这次再次复现；应把“重录 trace”
  写成任务模板的一部分，而不是每次靠事后发现。

## 五、执行结果（2026-11-22 收官批次）

- F-08b：默认检索预算 3/4/40 万；S20 复本 270→254 请求、token 6.75M→5.95M、B −0.7pp（CI 跨 0）；
  区间账本按 3.7% 重叠测量放弃。
- F-09a：confidence 默认 0.3；v3 离线：0.5 砍 26 条含 6 TP，0.3 全保留。
- F-17/F-20：one-shot 截断重试、evidence 默认 warn 落地。
- F-18：coverage repair 保持默认关闭（B +3.65pp 不显著、墙钟 +30%）。
- F-19：replay 6/6（large-mr 真网关重录）。
- F-16：`compare_arms.py` 已用于本批 A/B。
- F-10/F-12 已并入 F-08；F-11/F-13/F-14 已 DROPPED。
