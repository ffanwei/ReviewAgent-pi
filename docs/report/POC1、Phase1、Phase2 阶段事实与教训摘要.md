# POC1、Phase 1、Phase 2 阶段事实与教训摘要

> **历史文献（时效注记）**
> 本文写于评测仪器层与 `runs/**` 留痕仍在的时期。评测仪器层（数据集构造 / 判定链 / 指标聚合 /
> 实验运行器 / 字节门）已于 [ADR-0024](../adr/0024-drop-config-matrix-and-config-identity.md) 删除，
> `runs/**` 自 [ADR-0033](../adr/0033-task-id-output-location.md) 起不入库、旧目录已清理，故文中数字**不可复跑**；
> 内核四包现为 npm 上游依赖 `@earendil-works/*`（精确锁 `0.85.1`，[ADR-0035](../adr/0035-upstream-kernel-as-npm-deps-and-single-package.md)）。
> 现行形态见 [`CONTEXT.md`](../../CONTEXT.md)。

> **用途**：为《基于 Pi 内核的 ReviewAgent 总体架构设计方案》提供事实底座。内容按「对总体架构设计有约束力」组织，不按报告时间线复述。
> **材料范围**：六份一手报告（《POC1 实现报告》《DSH 迁移实现报告》《Phase 2 主数据分析报告》《生产化可行性事实调查》《DSH 指标对齐门报告》《DSH 指标对齐门噪声底报告》）+ ADR-0001～0009 + 《ReviewAgent以DSH内核和PI内核的方案对比分析》（背景）。
>
> **标注约定**：
> - 每条事实后附来源，格式（来源: 文件名 §章节/标题）；`ADR-00xx` 指 `docs/adr/` 下对应编号文件；`§n` 为该文档内章节号。
> - 未加标注的条目均为报告 / ADR **原文结论**；凡属本摘要作者推断的，显式以**【推断】**前缀标出。
> - **时点声明**：《生产化可行性事实调查》描述的是 main @ `a5a06bb`（2026-09-17）快照；本摘要写作时仓库处于 pi-kernel 分支 @ `7208119`（DSH 内核已移除、phase2 数据已迁入本仓）。引用该调查中「当前架构形态」类描述时须注意时点差异（详见 §4.8）。

---

## 1. 已确立且对新架构仍有效的事实

### 1.1 检视效果基线（Phase 2 主数据，三侧 1350 单元）

#### 1.1.1 数据底盘与质量

- Phase 2 主数据 = 30 案 × A–E × 3 rep = 450 单元，三侧齐备（main / noise / dsh 各 450，合计 1350）。（来源: Phase 2 主数据分析报告.md §1）
- 主数据判定链全通：judge 450/450 零 error。（来源: Phase 2 主数据分析报告.md §1）
- #36 噪声对照自洽门 20/20 IN（PASS）。（来源: Phase 2 主数据分析报告.md §1）
- #37 DSH 附录三侧门：格面 20/20 IN，配对符号检验 totalTokens FAIL（p=0.0266）——详见 §1.6.5。（来源: Phase 2 主数据分析报告.md §1/§9）
- 本报告为论文主表与消融叙事的单一数据源；全部表格 T1–T8 由复算脚本一键重放（`pnpm analyze:phase2`），无手抽数字。（来源: Phase 2 主数据分析报告.md §2）

#### 1.1.2 五配置定义与对比主表

配置定义（同一 harness，消息构造策略不同）：

| 配置 | 策略 | 工具 | 角色 |
|---|---|---|---|
| A | Diff-only | 零工具 | 下限对照 |
| B | Zone B + 固定管线确定性预取（Diff → Symbol → Reference → Call Chain） | 零工具 | 预取 vs 主动检索对照 |
| C | 全仓上下文注入 | 7 个 `review.*` 工具 | **协议主锚**（S/A/B 判定基准） |
| D | Minimal + Stable Prefix | 同上 | 稳定前缀最小上下文 |
| E | Ledger + Append-only | 同上 | 追加式账本复用 |

（来源: POC1 实现报告.md §4.2；Phase 2 主数据分析报告.md §5.1 配置定义注）

C/D/E 挂同一套 7 个零构建 `review.*` 工具（get_diff / get_file / get_symbol / find_references / get_call_chain / search_rule / search_history），工具 schema 字节一致（属 Zone A 稳定前缀，C/D/E 对比不被前缀差异污染）。（来源: POC1 实现报告.md §4.2）

五配置主表（main 侧，judge 口径，每配置 90 单元均值）：

| 配置 | lineRecall | linePrecision | lineF1 | totalTokens | cacheHitRate | RIE | CaRC | rounds / toolCalls |
|---|---|---|---|---|---|---|---|---|
| A 零工具 | **0.5008** | 0.7232 | 0.5524 | **22.6k** | 0.3678 | **0.0242** | 18.4k | 1.01 / 0 |
| B 确定性预取 | 0.4671 | **0.7835** | **0.5763*** | 49.9k | 0.8114（热 0.8782） | 0.0105 | 19.8k | 1 / 0 |
| C 全仓注入 | 0.1341 | 0.6349 | 0.5712 | 706.5k | **0.9249** | 0.0014 | 105.1k | 3.3 / 6 |
| D 自主拉取+稳定前缀 | 0.2916 | 0.7226 | 0.6257** | 178.0k | 0.7769 | 0.0055 | 60.5k | 2.32 / 6 |
| E = D + 账本 | 0.2355 | 0.5690 | 0.5196 | 204.6k | 0.7981 | 0.0049 | 63.1k | 2.57 / 6 |

（\* 稳定口径最高；\*\* 名义最高但不作稳定对照，见 §1.1.7。）（来源: Phase 2 主数据分析报告.md §5.1）

#### 1.1.3 A 配置：效率与召回双冠

- A 以 22.6k token/单元取得最高 judge recall（0.5008）与最高效率（RIE 0.0242）。（来源: Phase 2 主数据分析报告.md §1）
- A 的 RIE 0.0242 为 B 的 2.3 倍、C 的 17.3 倍——轻上下文在单缺陷 MR 场景下信息密度碾压全仓注入。（来源: Phase 2 主数据分析报告.md §5.1/§7）
- A 的 CaRC 18.4k，与 B（19.8k）同档，远低于 D（60.5k）/ E（63.1k）/ C（105.1k）。（来源: Phase 2 主数据分析报告.md §7）

#### 1.1.4 B 配置：精度与 F1 冠（生产形态）

- B 以 49.9k token/单元取得最高 precision（0.7835）与最高 judge F1（0.5763，稳定口径）。（来源: Phase 2 主数据分析报告.md §1/§5.1）
- B 的 token 为 C 的 7.1%（49.9k vs 706.5k）；CARC 19.8k 为 C 的 18.8%。（来源: 生产化可行性事实调查.md §3.2）
- B 的确定性预取（固定管线顺序）把缓存命中率拉高 44 个百分点（B 0.8114 vs A 0.3678），是其 precision 优势的机制来源。（来源: Phase 2 主数据分析报告.md §7）
- B 热口径 cacheHit 0.8782，≥ S 级 85% 门槛。（来源: Phase 2 主数据分析报告.md §3.2）
- B 单轮零工具（rounds 1 / toolCalls 0），延迟与成本可预算。（来源: 生产化可行性事实调查.md §3.2）
- B recall 0.4671，仅次于 A，为 C（0.1341）的 3.5 倍。（来源: 生产化可行性事实调查.md §3.2）

#### 1.1.5 C 配置：协议主锚实证全线垫底

- C 是 S/A/B 判定的协议主锚（判据以 C 的比例定义，ADR-0004）——锚的语义是「参照原点」，不是「质量最优」。（来源: Phase 2 主数据分析报告.md §5.4）
- C 实证面在本基准全线垫底：judge recall 0.1341 最低（A 的 27%）、706.5k token/单元最贵（A 的 31 倍）、77% 单元零 finding（69/90）、RIE 0.0014 最低、跨侧 recall 极差 0.1487 最大。（来源: Phase 2 主数据分析报告.md §5.4）
- 论文消融叙事可直接引用：「全仓注入的边际信息收益为负」——全仓注入在 VUL4J 单缺陷 MR 场景把模型淹没，上下文重组成主要噪声源而非有效证据源。（来源: Phase 2 主数据分析报告.md §5.4）
- C 的 cacheHit 0.9249 全场最高，但属「贵上下文的重复读」而非效率（token 基数 14–31 倍）。（来源: Phase 2 主数据分析报告.md §7）

#### 1.1.6 D / E 配置：不稳定与负向增量

- D 不稳定是配置固有属性（#30 定性：网关激进行为 × 自主拉取，双侧重跑均复现）。（来源: Phase 2 主数据分析报告.md §5.5）
- D 跨侧 recall 极差 0.1039（相对差 35%）；名义 F1 最高（0.6257）即属此列，跨侧不可复现，不作稳定对照。（来源: Phase 2 主数据分析报告.md §5.1/§5.5）
- D 单元耗时方差 30min–3h15m（#35 留痕）。（来源: Phase 2 主数据分析报告.md §5.5）
- E 的账本增量（E = D + 账本）方向性为负：recall 三侧一致低于 D（0.2355<0.2916 / 0.2325<0.2364 / 0.2893<0.3403），precision 与 F1 同向；方向判断跨侧稳定可引用，幅度因 D 不稳定不可靠。（来源: Phase 2 主数据分析报告.md §5.1）
- 「账本机制在本基准无正向收益（方向性结论）」。（来源: Phase 2 主数据分析报告.md §5.1）

#### 1.1.7 S/A/B 判定结果与锚塌缩

- S/A/B 判定（锚 = C rep2+ 热口径）三侧逐字一致：**B = S，A/D/E = B，C = BELOW_B**——判定面对内核 / 重跑噪声稳健。（来源: Phase 2 主数据分析报告.md §3.1）
- B 四条 S 级判据全部通过且余量巨大（main 侧 rule 热口径）：RECALL 0.1044 ≥ 0.0087；PRECISION 0.1506 ≥ 0.0556；TOTAL_TOKENS 49.6k ≤ 207.2k；CACHE_HIT_RATE 0.8782 ≥ 0.85。（来源: Phase 2 主数据分析报告.md §3.2）
- **锚塌缩（本报告最重要的 caveat）**：主数据上 C 锚实测塌缩——C 热 recall（rule）main 侧仅 0.0097，逐 rep 单调衰减 0.0500 → 0.0194 → 0.0000（rep3 完全无有效命中）。（来源: Phase 2 主数据分析报告.md §3.3）
- 锚塌缩跨侧复现且幅度大：C 热召回 main / noise / dsh = 0.0097 / 0.0761 / 0.0515（极差 0.0664，7.8 倍）。（来源: Phase 2 主数据分析报告.md §3.3）
- 直接后果：S 级 recall 门槛 = C×90% = 0.0087——「任何能产出少量有效命中的配置都轻松跨过」，B 的 0.1044 是门槛的 12 倍。（来源: Phase 2 主数据分析报告.md §3.3）
- 判读纪律（原文）：B=S 成立的实证内核是「B 热召回超过 C 锚 2.2–10.8 倍（main 10.8× / noise 2.2× / dsh 2.5×）且 token 仅为 C 的 1/14」——B 显著优于 C 是数据事实；但 **S 档的语义是「显著超越一个塌缩的锚」，不是「达到高质量水位」**；论文引用 B=S 时必须连同本注记。（来源: Phase 2 主数据分析报告.md §3.3）
- C 的 BELOW_B 同理是对 C 自身的机械判定（token 判据永不过），非对其工程价值的贬断——但 77% 零 finding、recall 最低、成本最高的实证面独立于判定语义成立。（来源: Phase 2 主数据分析报告.md §3.3/§5.4）
- 若后续论文阶段决定改锚（如以 A 为参照重定义判据），届时另立 ADR。（来源: Phase 2 主数据分析报告.md §12）

#### 1.1.8 判定链的价值来源（rule → judge）

- rule → judge 后 recall 提升：A 2.6× / B 3.7× / C 5.8× / D 4.2× / E 3.4×；precision 提升 2.7–4.8×。（来源: Phase 2 主数据分析报告.md §4.1）
- disagreement 种类合计：FP_RESCUED（rule 判 FP、judge 改判 TP）269 vs TP_OVERTURNED（反向推翻）1——规则粗筛严格偏保守，judge 环节单向救回。（来源: Phase 2 主数据分析报告.md §4.1）
- judge TP 匹配的逐条置信分布：高置信占比 67–71%（A 69.7%、B 67.6%、C 66.7%、D 69.9%、E 71.2%），低置信 ≤5%。（来源: Phase 2 主数据分析报告.md §4.1）
- skipped-no-findings（0 finding 单元，judge 零调用）：A=5/90、B=10/90、C=69/90、D=48/90、E=55/90——C 的 77% 零 finding 率是其实证塌缩的最直接表征。（来源: Phase 2 主数据分析报告.md §4.1）

#### 1.1.9 冷热分层与预热曲线（rule 口径）

冷热分层（main 侧；cold = 每案 rep1，hot = 每案 rep2/rep3 均值）：

| 配置 | 层 | lineRecall | linePrecision | totalTokens | cacheHitRate |
|---|---|---|---|---|---|
| A | cold | 0.1725 | 0.1994（29/30） | 24,449 | 0.3563 |
| A | hot | 0.2067 | 0.3083（30/30） | 21,720 | 0.3736 |
| B | cold | 0.1737 | 0.3462（26/30） | 50,515 | 0.6779 |
| B | hot | 0.1044 | 0.1506（30/30） | 49,573 | 0.8782 |
| C | cold | 0.0500 | 0.3194（6/30） | 738,018 | 0.8908 |
| C | hot | 0.0097 | 0.0556（12/30） | 690,678 | 0.9420 |
| D | cold | 0.1111 | 0.1944（15/30） | 180,390 | 0.7889 |
| D | hot | 0.0497 | 0.1333（24/30） | 176,855 | 0.7708 |
| E | cold | 0.0567 | 0.0909（11/30） | 189,037 | 0.8030 |
| E | hot | 0.0770 | 0.1875（18/30） | 212,431 | 0.7957 |

（precision 括号 = 非空 precision 案数；C 冷层 30 案中仅 6 案产出过任何 finding。）（来源: Phase 2 主数据分析报告.md §5.2）

- 逐 rep 预热曲线（rule 口径 lineRecall）：A 0.1725/0.1716/0.2418（rep3 抬升）；B 0.1737/0.1495/0.0594（带内单调衰减）；C 0.0500/0.0194/0.0000（衰减到零）；E 0.0567/0.0611/0.0929（温和上行）。（来源: Phase 2 主数据分析报告.md §5.3）
- C 的零 finding 率逐 rep 恒定（skipped 24/22/23），衰减不是偶发。（来源: Phase 2 主数据分析报告.md §5.3）
- **B 热召回逐 rep 衰减（0.1737 → 0.1495 → 0.0594）**是生产化必须随 B 携带的 caveat——与 #30「上下文重组 × 跨日部署漂移」不稳定族同向，生产须监控质量漂移。（来源: 生产化可行性事实调查.md §3.2；Phase 2 主数据分析报告.md §5.3）
- 环境敏感性分族：上下文重组族（B/C/D）rule 侧产出对 rep 与运行环境双敏感；A/E（轻上下文/纯文本前缀）稳定（三侧极差 ≤0.057），B 居中；不稳定族从 D 推广为 C/D（C 极差 0.1487 比 D 的 0.1039 更大）。（来源: Phase 2 主数据分析报告.md §5.3/§5.5）

#### 1.1.10 多轮 / 工具开销结论

- 多轮/工具开销在该基准没有转化为 recall/precision 优势，只转化为 token：C/D/E 平均 2.3–3.3 轮、每单元 6 次工具调用；A/B 单轮零工具（rounds ≈1）。（来源: Phase 2 主数据分析报告.md §7）

### 1.2 评测方法学（新架构必须原样继承的仪器口径）

1. **数据集总设计（逆补丁法五源）**：Defects4J 逆补丁构造 ~100（主集）；Vul4J ~30（高险子集，US15：v4-pro 模型消融）；Multi-SWE-bench Java ~30（仅 C/E 对照）；clean MR ~50（阴性对照，每 Finding 计 1 FP）；MCR-Bench（判定校准参照）。（来源: POC1 实现报告.md §4.4）
2. **Phase 2 实际主数据集**：30 案 VUL4J（`data/vul4j/target-cases.json`；物化仓 base 态 + 原生 diff + 原生英文 issue）。（来源: Pi 内核从零实现方案.md §5.1）
3. **判定链四级**：原生真值 → 规则粗筛 → LLM judge → 10% 人工抽检（种子 `poc1-human-review-2026`，FNV-1a32 确定性分层）。（来源: POC1 实现报告.md §4.5）
4. **judge 协议**：`glm-5-3-260814`，temperature 0.2 / top_p 0.95 锁定。（来源: Phase 2 主数据分析报告.md §9）
5. **judge 调用规模**：三侧 263 / 252 / 291 次（一次判过）+ 11 次失败重试；格式 error（glm 偶发非法 JSON）34 条全部删留痕重跑恢复至 0。（来源: Phase 2 主数据分析报告.md §8/§9）
6. **S/A/B 判据（ADR-0004，协议未改）**：S 级四判据 = Recall ≥ C×90% ∧ Precision ≥ C×100% ∧ Token ≤ C×30% ∧ Cache Hit ≥ 85%（均取 rep2+ 热口径均值）；A 档 = Recall ≥ C×80% / Token ≤ C×30% / Cache Hit ≥ 80%；B 档 = Recall ≥ C×70% / Token ≤ C×50%。（来源: ADR-0004「Consequences」）
7. **S 级判据的两条设计理由**：Precision ≥ 锚保证「质量不掉」是完整的（检出与精确双侧），防档位被策略性降 Recall / 降报数冲线；不设 Tool Calls ≤ C×30% 门槛——锚 C 为全仓注入，自主检索需求天然最低、工具调用基数低，×30% 阈值结构性不可达。（来源: ADR-0004）
8. **锚可用性与保守判定**：锚可用性（NOT_EVALUABLE）以 Recall / Total Tokens 为准；锚 Precision 缺失时 S 级 Precision 判据按未通过处理（保守降至 A 档判定），不升级 NOT_EVALUABLE。（来源: ADR-0004「Consequences」）
9. **指标口径纪律**：rule 口径（规则直接产出的行级指标）与 judge 口径（judge 裁定 TP/FP 后）严格区分——S/A/B 判定用 rule 口径热数据（ADR-0004 协议），五配置主表用 judge 口径每配置 90 单元均值。（来源: Phase 2 主数据分析报告.md §2）
10. **token 双口径**：totalTokens 为含缓存读口径（input + cacheRead + output）；计费口径 billed = input + output；双口径并列报告。（来源: Phase 2 主数据分析报告.md §7/§9）
11. **方差两类分开引用**：跨 rep σ（误差棒）与跨侧极差（环境敏感性）；C 的跨 rep σ 反而最小（recall 0.0337）恰因产出贴地——σ 小不等于稳定优，引用时须带均值。（来源: Phase 2 主数据分析报告.md §6）
12. **指标族**：RIE（recall per 1k billed token，上下文效率）、CARC（每正确检出的 token 成本，含工具成本）、CE / RCE；锚定「C 全仓注入」的相对比例体系。（来源: POC1 实现报告.md §4.5；Pi 内核从零实现方案.md §5.1）
13. **人工抽检未闭合**：46 表单 / 214 条目已生成（分层 disagreement 18 / agreement 28 / no-judge 0；FINDING 66 + MISSED_TRUTH 148），人工逐条裁定未执行，judge vs 人工一致性量化为空；不以自动化替代（协议第四级的存在意义即打破 judge 单点）。（来源: Phase 2 主数据分析报告.md §10）
14. **人工抽检回收路径已备（零新代码）**：裁定誊入 TSV 后可量化 ① FINDING 条目人工 TP ∩ judge TP 占比（judge 精度校准）② MISSED_TRUTH 人工 FN 确认率（漏检下界校准）③ 分层对比。（来源: Phase 2 主数据分析报告.md §10）
15. **Claude Code 外部参照**：同仓同 diff 同目标跑 Claude Code，归一化后经同一 metrics 管线以伪配置位 `claude-code` 单列评分；**verdicts 恒 null、显式排除在 S/A/B 之外**（模型不可同源，跨配置比较无意义）；ADR-0009 拍板保留（测量装置一部分）。（来源: POC1 实现报告.md §4.6；ADR-0009「决策」）
16. **T13 历史注记**：POC1 期外部参照本机 claude CLI 经代理后端回报 MiniMax-M3（非 Claude 系模型），已如实留档——外部参照的模型族不保证，隔离要求（不进主判定）是硬的。（来源: POC1 实现报告.md §8）
17. **预算预估兑现**：#32 立项窗（计费 19–27M / 含缓存读 84–113M）三侧双口径均落窗内：main 24.03M / 104.55M、noise 24.25M / 101.39M、dsh 24.18M / 110.54M（计费三侧相互差 <1%，大盘可复现）。（来源: Phase 2 主数据分析报告.md §9）
18. **judge 信封口径**：可复算下界 = judged 调用数 × 32768（#39 模型族感知容量），三侧 ≤8.62M / ≤8.26M / ≤9.54M（合计 ≤26.4M）；引用时须注明与含 prompt 估算口径（≤9.6M 级）的差别。（来源: Phase 2 主数据分析报告.md §9）
19. **事故损耗单列**（不在 canonical 预算内）：main 并发事故 ≈7.3M + noise 外杀重跑 ≈0.16M + dsh 事故与 judge 重试 ≈0.2M，合计 ≈7.7M。（来源: Phase 2 主数据分析报告.md §9）
20. **断点续跑与事故韧性（工程已验证）**：外部杀进程 4 次（main 期 2 + noise 1 + dsh 1），全部同 id 重启无损续跑（resumed 精确衔接、零重复执行；dsh 第三次外杀后 executed=26 / resumed=424）。（来源: Phase 2 主数据分析报告.md §8）
21. **canonical 数据零污染的实证**：main 并发事故 136 次重复执行（586 审计 − 450 留痕，全部在事故窗口前置跑），≈7.3M 计费 token 单列，canonical 零污染。（来源: Phase 2 主数据分析报告.md §8）
22. **其他运行事件**：待机冻结（Modern Standby 3 次）以 keep-awake guard 根治；max-tokens 截断 2 次（dsh，占执行尝试 ≈0.4%）瞬态重跑成功、失败不留 record 不污染数据面。（来源: Phase 2 主数据分析报告.md §8）
23. **执行窗与间隔**：main 38.7h / noise 14.4h / dsh 8.0h；main→noise 0.97h、noise→dsh 0.78h、main→dsh 16.16h——噪声对照在 48h 时点纪律窗内启动。（来源: Phase 2 主数据分析报告.md §8）

### 1.3 数据与审计真源位置（当前仓库实况，pi-kernel 分支 @ 7208119）

1. **phase2 评测数据已迁入本仓**（P0，2026-09-18 完成）：`runs/phase2-{main,noise,dsh}` 三侧各 450 记录 + `runs/phase2-smoke`（5 单元，analyze T5 消费）+ `runs/phase2-dsh-t{1..5}`（audit 真源）+ `.cache/datasets`（30 物化仓，516M / 71,478 文件），合计 ≈1.8G（robocopy /E /MT，时间戳保留）。（来源: Pi 内核从零实现方案.md §9「P0 执行注记」）
2. **迁移验收实测**：三侧 rep 记录各 450 + smoke 5；t 系 audit 恰 450 份（每单元一份）；`plan.json` 三侧同构（`deepseek-v4-flash` / verifier off / 5 configs / 3 reps / judge `glm-5-3-260814`）；`pnpm analyze:phase2` exit 0，T1 三侧判定逐字一致（B=S / C=BELOW_B / A·D·E=B）、T5 三侧 EXEC 合计 72.46M 落 #32 估算窗；git 零影响（runs/** 与 .cache/ 均 gitignored）。（来源: Pi 内核从零实现方案.md §9）
3. **字节门对照物**：t 系 audit 的审计 JSON 含 `requests[]`，每条带 `model / effort / messages / tools / wireBody` 全量序列化请求体——pi 线 P2 字节门的对照真源，「不需要复用任何旧代码即持有测量契约」。（来源: Pi 内核从零实现方案.md §5.2/§9）
4. **audit 真源不可只拷记录不拷 audit**——`phase2-dsh-t*/audit/**` 随 runs 一并迁入。（来源: Pi 内核从零实现方案.md §9）
5. **s\* 系列不迁**（`phase2-main-s1..5` / `phase2-noise-s1..8`，≈720M）：analyze 不消费，属 #30 噪声底证据数据，留主工作仓 `D:\xubao\code\AI4SE\ReviewAgent` 只读参照，需要时可补拷。（来源: Pi 内核从零实现方案.md §9）
6. **auditPath 重定位约定**：phase2-dsh 记录的 `auditPath` 字段是绝对路径（实测指向主工作仓），迁入后 P2 门工具以「实验根相对路径」重定位，**不改写记录本体**。（来源: Pi 内核从零实现方案.md §9）
7. **主工作仓地位**：保持只读参照（pi 参考仓 `reference_project/pi` 同理）；本仓此后是唯一活跃工作仓。（来源: Pi 内核从零实现方案.md §9）
8. **POC1 期对照数据同在本仓**：`runs/poc1-vul4j-gateway`（r1 基线，45 单元 + 83 份审计，38 单元双审计为声底证据）、`runs/poc1-vul4j-gateway-r2`（#30 噪声底跑）、`runs/dsh-vul4j-gateway`（#29）、`runs/dsh-gateway-smoke-r3`。（来源: DSH 指标对齐门报告.md §7；DSH 指标对齐门噪声底报告.md §9；本仓 `runs/` 目录实况）

### 1.4 生产化事实（Config B 拍板与实测）

1. **生产检视形态已拍板 = Config B**（2026-09-17）：零工具 + Zone B 与固定管线确定性预取（Diff → Symbol → Reference → Call Chain），无 ledger、无全仓注入、无自主检索；运行形态 `{ toolsEnabled: false, prefetch: true, fullRepo: false, stablePrefix: false, ledger: false }`。（来源: 生产化可行性事实调查.md §3.1）
2. **不设风险升级门**：高风险 MR 同样走 B 平推；升级门保留为后续可选杠杆。（来源: 生产化可行性事实调查.md §3.1）
3. **拍板原文一句话**：「B 是数据站得住的生产形态（三侧 S 级、precision/F1 双冠、成本有界、FP 天然安全）；上线前必须补四件事——MR 边界护栏、输出语言决策、模型迁移门（若换模型）、质量回流日志；骨架裁剪与风险自适应预取等第一批生产数据后再动。」（来源: 生产化可行性事实调查.md §3.1）
4. **B 形态单次评审实测**（真实网关，2026-09-17，生产形态 CLI）：单轮 6 请求、0 工具调用；耗时 94.7s（VUL4J-1）/ 204.6s（VUL4J-33 第 2 次）；与 Phase 2 均值（49.9k 总口径 / CARC 19.8k）同量级。（来源: 生产化可行性事实调查.md §7.4）
5. **单次评审 token 实测**：VUL4J-1 inputTokens（未命中）12,786 / output 9,175 / cacheRead 20,480 / findings 0；VUL4J-33 第 2 次 input 10,923 / output 17,784 / cacheRead 27,904 / findings 3；计费口径约 20~32k token。（来源: 生产化可行性事实调查.md §7.4）
6. **响应非确定性的生产实例**：同一单元 VUL4J-33 两次运行 findings 同为 3，但 output tokens 15,014 vs 17,784——与 #29/#30 归因一致（现状不传 temperature，采样为 provider 缺省档）。（来源: 生产化可行性事实调查.md §7.4）
7. **生产 KPI 口径**：应采用绝对口径（如人工接受率），不用相对 C 的比例（S 级语义随锚塌缩失真）。（来源: 生产化可行性事实调查.md §3.2）
8. **上线前必须四件事**（均有方案、均未实现未立票，2026-09-17 时点）：
   - ① **MR 边界护栏 v1**：POC1 验证域仅 ≤10 文件、diff ≤2K 行；超界 MR 照常执行但 `ReviewOutcome` 顶层加 `domainWarning`（消费端可降级呈现「AI 检视受限」）。（来源: 生产化可行性事实调查.md §3.3）
   - ② **输出语言决策 + 配置化**：Zone A SYSTEM_PROMPT 锁英文（`All review output must be in English`），企业场景大概率需中文；`outputLanguage` 成配置项、Zone A 字节按语言分序列；换语言后须抽样质量验证（S 级结论不自动迁移到中文输出）。（来源: 生产化可行性事实调查.md §3.3）
   - ③ **模型迁移 runbook**（若生产换模型）：B 质量结论锚定 `deepseek-v4-flash` 不自动迁移；流程 = smoke 冒烟 → 30 案子集 × B × 1 rep 与基线在噪声带内对比（复用 #30 对称 max σ 方法）→ 指标分口径（ADR-0008）。（来源: 生产化可行性事实调查.md §3.3）
   - ④ **质量回流日志 v1**：**生产没有 judge**（判定链是研究侧设施）——生产质量唯一持续信号源是 Finding 处置回流（accept / reject / defer + 评论者 + 时间落库，runId 关联审计）；KPI = 人工接受率（绝对口径）；数据结构为 Phase 6（CWD 知识生产链路）预留。（来源: 生产化可行性事实调查.md §3.3）
9. **第一批生产数据之后的优化项**（数据支撑，暂不动）：阶段 4（Context Retrieval）确定性空转裁剪 ≈ CARC 的 5~10% + 1/6 延迟（B 零工具下该阶段每单元白烧一个完整 LLM 请求）；风险自适应预取深度（低风险省 Reference + Call Chain 两层）≈ CARC 的 15~20%（阈值须生产数据标定，VUL4J 全高危不可标）；同仓 MR 批量调度（零模型侧改动，见 §3.5.8）。（来源: 生产化可行性事实调查.md §3.3）
10. **骨架修改的协议决策 = 保守路线**：生产先原样上冻结形态（六阶段全跑）→ 跑完第一批真实 MR → 再裁阶段 4 + 标定阈值 → 裁剪后做一次对齐验证（修改形态 × B × 30 案 × 3 rep 与冻结 B 在对称 max σ 带内对比，#30 方法）；激进路线被评估为损失首批生产数据与冻结形态的可比性。（来源: 生产化可行性事实调查.md §3.4）
11. **骨架裁剪的代价机制**：裁阶段 4 等骨架改动会改变 Zone C 字节——生产形态与实验冻结形态分叉，生产指标不再与 A–E 数据直接可比；六阶段骨架是 ADR-0006 定义的内核形态（注：ADR-0006 已历史化，该分叉机制本身仍成立）。（来源: 生产化可行性事实调查.md §3.4）
12. **持续观察项（不立票，进生产监控）**：B 热召回衰减类漂移（按 Risk Class / 目录 / 时间切片监控）；`temperature=0` 复现性的缓存键验证（低置信、先验证再动）；风险升级门（B→D/E 切换）保留可选杠杆。（来源: 生产化可行性事实调查.md §3.3）
13. **项目定位**：「基于 DeepSeek Harness 的低 Token、高质量代码检视 Agent……终点是落地到企业内部代码托管平台的 MR 检视」；双重身份（AI4SE 研究项目 + 生产系统）。（来源: 生产化可行性事实调查.md §1.1）
14. **路线图覆盖**：POC1 / Phase 1 / Phase 2 覆盖 V0.1（Minimal Context）与 V0.2（Cache-Efficient）核心命题——Phase 2 数据即「验证 Context 假设」「验证 Cost 假设」的实证；V0.3 / V0.5 / V1.0 无对应交付。（来源: 生产化可行性事实调查.md §2.5）

### 1.5 POC1 证明的运行时工程事实

1. **薄 harness 可完整实现全部检视纪律**：六阶段固定骨架（Change Understanding → Risk Classification → Context Decision → Context Retrieval → Deep Reasoning → Evidence Verification），阶段内检索由模型在预算内自主完成。（来源: POC1 实现报告.md §4.1）
2. **硬上界**：`max_rounds = 5` / `max_tool_calls = 6`，单次检视成本有界。（来源: POC1 实现报告.md §4.1）
3. **Evidence Gate**：Finding 必须带证据链方可输出。（来源: POC1 实现报告.md §4.1）
4. **审计落盘**：每次请求的可重放字节、工具调用日志、阶段日志、拒绝留痕。（来源: POC1 实现报告.md §4.1）
5. **零框架依赖形态**：TypeScript ESM / Node 24 / pnpm 10.30.3 / vitest，依赖仅 3 个（ripgrep、tree-sitter 双件）——零 DSH 依赖；LLM 调用为自写的纯 OpenAI 兼容 HTTP 客户端（字节级控制的前提）。（来源: POC1 实现报告.md §4.1）
6. **质量基线**：987/987 测试全绿、typecheck 0 错误、覆盖率 90.7% lines / 88.5% branches / 95.4% functions（阈值 80%）；规模 298 文件 +53,950 行（83 提交）。（来源: POC1 实现报告.md §5/§6）
7. **Zone A/B/C 分区纪律（Cache Engine 的实现基础）**：Zone A（角色、政策、工具 schema、输出 Schema、Severity、Evidence Policy）session 内字节稳定；Zone B（Repo Identity / Map / Symbol Index / Project Rules）静态确定性构造、不经过 LLM、不依赖构建；Zone C（会话内追加内容）append-only。（来源: POC1 实现报告.md §4.3）
8. **Cache Break 原因分类观测**：相邻请求字节前缀分歧检测 → SYSTEM_PROMPT_CHANGED / TOOL_SCHEMA_CHANGED / MODEL_CHANGED / CONTEXT_REORDERED 四分类留痕，纯观测零字节改动。（来源: POC1 实现报告.md §4.3）
9. **跨会话预热曲线**：metrics 聚合层逐 repIndex 分层均值（rep1..repN），ConfigSummary.warmupCurve + Dashboard 一节。（来源: POC1 实现报告.md §4.3）
10. **实验运行器能力**：五配置 × 数据集 × 重复跑批，单元级 `(source, caseId, configId, rep)` 断点续跑 + 损坏记录上报（corruptRecordFiles，不静默丢弃）+ `--report-only` 零调用重建 + Dashboard。（来源: POC1 实现报告.md §4.6）
11. **零构建静态代码智能的天花板（既知限制）**：tree-sitter-java（签名级符号提取）+ ripgrep（词法引用匹配）；`find_references` 为名字级匹配（重载 / override 存在误报漏报），`get_call_chain` 降级为 1~2 层名字级引用链；实验内各配置共享同一工具精度，配置间对比有效性不受影响。（来源: ADR-0003「Consequences」；POC1 实现报告.md §4.1）
12. **零构建选择的理由**：企业落地场景检视目标只提供静态源码快照（无构建环境、不可编译），编译器级索引（scip-java / jdt-ls）在目标部署不可用。（来源: ADR-0003）

### 1.6 Phase 1 证明的验收方法学事实

1. **双层验收门模式成立且内核无关**：确定性纪律门（fake LLM、零网络、进 CI——Zone A 字节稳定 / 无变更零 Cache Break / 审计可重放 / 六阶段骨架与两上界 / Evidence Gate，presets 覆盖 A–E，全部从主缝观测）+ 指标对齐门（真实网关重跑对照）。（来源: DSH 迁移实现报告.md §4.7）
2. **DSH 线纪律门结果**：44/44 绿进 CI；零网络强制落 `Socket#connect` + `globalThis.fetch` 双点；RED/GREEN 对即变异证据。（来源: DSH 迁移实现报告.md §4.7）
3. **响应非确定性是协议固有属性**：POC1 自身同单元双审计 38 对（同 harness 同日同配置同 rep）全部 request 1 逐字节一致、首个分歧全部始于 assistant 消息——与 POC1↔DSH 的分歧模式完全相同。（来源: DSH 指标对齐门报告.md §4.4）
4. **非确定性摆幅量化**：14 对结构匹配完整对——findings 0↔3、输出 token 至 5.9×；另 24 对含中断尝试，rounds 摆幅最高 1↔5；自门检验 POC1 自身 28 次完整尝试 totalTokens 11/28 出自身 ±1σ 带、cacheHitRate 9/28 出带。（来源: DSH 指标对齐门报告.md §4.4）
5. **±1σ 单侧带检验力不足（已定案）**：门把 POC1 自身都判不过——正向 1 OUT / 反向 3 OUT（同一对数据带取自哪侧结论就变，方向依赖）；DSH 的 2 OUT 落在噪声底量级内、OUT 格与自身重跑无一重叠。（来源: DSH 指标对齐门噪声底报告.md §1/§3/§5）
6. **单元配对偏差证据**：DSH 四指标均值 |Δ| 全部 ≤ POC1 自身重跑（lineRecall 0.1500 vs 0.1889、linePrecision 0.2854 vs 0.3281、totalTokens 180,727 vs 190,456、cacheHitRate 0.0974 vs 0.0991）；recall / precision 上 DSH 偏差更小的单元占 62–76%——单元层面 DSH 与「又一次 POC1 运行」统计不可区分。（来源: DSH 指标对齐门噪声底报告.md §4.1）
7. **跨日部署漂移的效应量与运行时互换同量级**：rounds 混合比三侧连续位移（多轮单元 r1 21 / r2 15 / DSH 10，均值 2.31 → 1.67 → 1.49，r2 恰落在中间）；token 总账 r1 11,287,939 / r2 8,405,766（0.74×）/ DSH 8,749,984（0.78×）——「换运行时后 token 变省」的表象实为跨日部署漂移。（来源: DSH 指标对齐门噪声底报告.md §4.2/§4.3）
8. **D 塌缩与运行时无关的证明**：r2 的 D lineRecall 0.0556→0.0000（9 单元全零真阳性）、totalTokens 0.42×，比 DSH 的 D（recall 0.0370、0.50×）更狠——「自主拉取 × 网关激进行为」是 D 配置固有不稳定。（来源: DSH 指标对齐门噪声底报告.md §4.5）
9. **最终判定**：对称 max σ 修订口径下 DSH 19/20 IN（唯一 OUT 为基线 n=2 统计无效格 C/linePrecision）、自身重跑 20/20 IN——「DSH 内核接管实验主数据无系统偏差证据」。（来源: DSH 指标对齐门噪声底报告.md §3.4/§5）
10. **检验力随样本量升级后结论翻转的先例**：#29/#30 时代 45 单元配对检验 p=0.5 零检验力；Phase 2 450 单元检出 DSH 与 POC1 的 with-cache 口径 +5.7%（110.54M vs 104.55M，配对符号检验 totalTokens FAIL p=0.0266），格面仍 20/20 IN、计费口径持平 +0.6%——「结论翻转（检验力升级）」。（来源: Phase 2 主数据分析报告.md §11/§9）
11. **σ 估计稳定性**：n=9 的 σ 估计跨次摆幅可达 3.7×（D totalTokens σ 193,816→51,962）；若保留格级 ±1σ 判定需 n≥15–20，或转配对判据（无需 config 级 σ）。（来源: DSH 指标对齐门噪声底报告.md §6）
12. **DSH 线对齐门成本**：#29（DSH 45 单元 ≈9.0–9.2M token）+ #30（r2 45 单元 8.4M token）合计真实网关消耗 17.2M token。（来源: DSH 指标对齐门报告.md §6；DSH 指标对齐门噪声底报告.md §8）

---

## 2. DSH 内核路径暴露的问题与教训（导向 ADR-0009「从零重写」）

**决策链背景**：《ReviewAgent以DSH内核和PI内核的方案对比分析》以「可扩展性 / 长期演进」为前置给出 DSH-first 结论（「DSH 主内核，Pi 做对照」+ Review Runtime Adapter 层）；用户随后追加前提「不考虑 ReviewAgent Runtime 的扩展复用」；可行性分析结论 Pi 70 / DSH 30；2026-09-18 拍板反转——pi fork（锚定 `6671c604`）为基座、Review Runtime 从 0 重写，DSH 内核移除、其数据降为 Runtime Benchmark 对照。（来源: ADR-0009 决策背景；ReviewAgent以DSH内核和PI内核的方案对比分析.md §10）

以下教训逐条列出（均为报告 / ADR 原文，含出处；对 pi 架构的含义若为推断则标【推断】）：

### L1. 「共享模块源」迁移姿态的包袱——双客户端、双序列化器、parity 票

- DSH 线把 POC1 代码作为共享模块源做内核迁移（ADR-0005 姿态），导致 POC1 直连客户端与 DSH wire 序列化器长期并存。（来源: ADR-0009「Considered Options」）
- 为钉双包字节一致，需要 wire parity fixtures（`tests/llm/wire-parity.test.ts`，7 用例覆盖两档画像 × 自由 id × 工具 / 多轮形态，进纪律门）。（来源: ADR-0006 实现注记 #45）
- `DEFAULT_MODEL` 双包各自单源（DSH 侧落 review-policy，root 侧落 plan.ts），一致性靠 runner 透传 + 回传漂移断言维持。（来源: ADR-0006 实现注记 #45）
- 凭据角色名环境变量双包收敛是专项工作（`REVIEWER_*` 双名探测序两包单源）。（来源: ADR-0006 实现注记 #45）
- ADR-0009 明言：「复用约束解除后，DSH 线『共享模块源』的历史包袱（双客户端、双序列化器、parity 票）不必继承」。（来源: ADR-0009「Considered Options」）
- 【推断】对 pi 架构的含义：被测侧单一 LLM 客户端（pi-ai），judge 走 review-llm 是仪器分离而非双客户端——不再需要任何 parity 票。

### L2. 内核默认组装面与 Zone A 字节纪律正面冲突

- dsh-base 携带 session-title-llm（额外 LLM 调用）、typert 三件套、user-questions、jobs、遥测等组装件（`--dump-config` 实测）。（来源: ADR-0006「Considered Options」）
- Zone A 字节纪律要求「组装进 prompt 的每一行都可知」——被迫放弃 dsh-base、以 sdk-minimal 式显式最小树（llm / session / session-projection / system-prompt / tools / agent / agent-loop / session-persistence-jsonl / cmdline + 核内插件，10 行组装）绕开。（来源: ADR-0006；DSH 迁移实现报告.md §3）
- 【推断】教训：内核的「全家桶」默认面越丰富，字节纪律的裁剪成本越高——新架构选内核时应把「默认组装面可完全掌控」作为硬标准。

### L3. 自定义执行模型 = 无人区

- `setFactory` 替换 DSH 的 agent-loop 等于实现整个 Agent 驱动面（inbox 管理、turn/step 事件、session 维护），且零生产示例。（来源: ADR-0006「Considered Options」）
- 被迫走「标准 agent-loop + 策略驱动器」路线：驱动器独占阶段指令推进权（一阶段 = 一 turn，阶段内工具循环 = turn 内 steps），模型无法自行推进阶段。（来源: ADR-0006；DSH 迁移实现报告.md §4.1）
- 【推断】教训：内核宣称「可替换 loop」与「替换 loop 有生产先例」是两回事；本项目需要的六阶段强制骨架最终靠自写驱动器实现，内核层只是宿主。

### L4. SDK 通用协议脸与专用检视协议冲突

- SDK jsonrpc-server 的 session/prompt 脸为每个 sessionId 另建走自由 agent-loop 的 agent，与策略驱动器（代码级强制六阶段）正面冲突。（来源: ADR-0006 实现注记 #27）
- kernel-host 被迫改为协议层桥接：直接在 sdk-protocol 的 `JsonRpcLineTransport` 上暴露 `review/run` + `shutdown`，wire 层 100% SDK 件。（来源: ADR-0006 实现注记 #27；DSH 迁移实现报告.md §3）
- 教训：长驻实验通道必须是「检视专用方法面」而非通用 session 协议，否则绕不开内核自由 loop。

### L5. 文档层认知与实测行为的系统性偏差——「实现注记驱动的形态修正」成为常态

Phase 1 十二票中至少五处正文结论被实测推翻或修正（报告 §3 明列）：

- npm 消费线（0.1.2-rc.1）无 `dsh` 二进制 → CLI 为 node 进程直跑锁定版 review profile（「spawn 锁定版」的字面形态被实测修正，版本锁定语义不变）。（来源: DSH 迁移实现报告.md §3）
- 「工具开/关是组装级差异、config 字段表达不了」被 #20 实现推翻——工具 schema 挂请求 `tools` 字段（Zone A 外），开关收敛到 `ReviewPolicyConfig` 政策字段。（来源: DSH 迁移实现报告.md §3；ADR-0006 实现注记 #20）
- `MAX_TOOL_CALLS` 强制点 = 预分发 `ToolGuard`（同步守卫，语义等价），非正文所述 `tools/execute` 包裹层。（来源: DSH 迁移实现报告.md §3；ADR-0006 实现注记 #20）
- 预算拒绝物化为 `Error:` 工具错误结果（POC1 为 `SKIPPED:` 消息 + 强制收尾）——对 ADR-0005 1:1 姿态的登记偏离。（来源: DSH 迁移实现报告.md §3；ADR-0006 实现注记 #20）
- Zone B 注入顺序文档层无明确答案，靠 walking skeleton 首票字节断言落锤（多连 inject 按调用序进入首条 followup claim 批，请求 1 布局与 POC1 逐字节对齐）。（来源: DSH 迁移实现报告.md §3/§4.4；ADR-0006 实现注记 #22）
- 【推断】教训：对外部内核的每一项机制假设都必须实测落锤，认知摩擦成本随「内核机制面」面积线性增长——从 0 重写后该成本面收敛为自己写的代码。

### L6. 版本锁定线的持续摩擦

- 实际依赖 npm 锁定线：`@deepseek-ai/dsh-sdk-protocol@0.1.2-rc.1` + `packages/review-dsh` 的 10 个 `@deepseek-ai/*` 包全部 0.1.2-rc.1 锁定。（来源: 生产化可行性事实调查.md §1.3）
- 本地 reference（0.1.5-alpha.1）仅作机制阅读对照、不是实际依赖；两线偏差须逐项登记《DSH 内核机制偏差清单》。（来源: 生产化可行性事实调查.md §1.3/§4）
- DSH 处于 developer preview，官方明示 compatibility-breaking changes 风险。（来源: ReviewAgent以DSH内核和PI内核的方案对比分析.md §8；ADR-0005）
- 前沿包（goal / plan / todo / preset / boot / bundle / host / api…）npm 线未发布——「前沿特性不可用」为锁定线既知约束。（来源: 生产化可行性事实调查.md §4）

### L7. 内核契约边沿的竞态窗口成为宿主长期携带的约束

- followup 落在 kick 收尾微任务窗口被吞 → 会话死锁；该竞态在 0.1.2-rc.1 与 0.1.5-alpha.1 逐字同在（内核契约边沿而非版本回归）。（来源: 生产化可行性事实调查.md §4）
- 规避方式 = review-runtime 驱动器在每个 turn/end 后、下一条 followup 前 `await agent.whenIdle()`（标准节拍）。（来源: 生产化可行性事实调查.md §4）
- 携带义务：**升级 DSH 版本时须重跑 Zone A/B 纪律门确认窗口行为未变**。（来源: 生产化可行性事实调查.md §4）
- 【推断】教训：内核异步语义边沿是隐形契约；pi fork 在手则可直接读改源码而非绕行（ADR-0009 的 fork 姿态即为此）。

### L8. 子进程 / 长驻进程形态的缺陷族与「竞争类缺陷不可测」边界

- 真实网关冒烟一次揭出三个进程边界缺陷（全数修复，缺一不可跑全量）：① bin 上溯定位（编译树层级假设失效 → host 子进程秒死 MODULE_NOT_FOUND）；② EPIPE 容错（对已死进程的 shutdown 写入打到断管，未处理会炸掉 runner 本体）；③ 真实 API 级 turn 预算（缺省 10s 单 turn 上界对真实网关 thinking 30–90s+ 首轮即炸；修复 = `REAL_LLM_TURN_TIMEOUT_MS = 900_000`，容一整次单请求 600s 超时重试周期）。（来源: DSH 迁移实现报告.md §4.7；ADR-0006 实现注记 #29）
- Windows libuv teardown 竞争：满载复现 ~2/54 触发 libuv 断言 fail-fast 0xC0000409；修复 = `exitGracefully`（置 exitCode 等事件循环排干 + 协议宿主自毁 stdin + 8s unref 兜底强退）。（来源: ADR-0006 实现注记 #29）
- 竞争类缺陷的验证边界（如实声明）：EPIPE 容错与优雅退出**无确定性单测**（按 ~2/54 失败率设计的竞争写不出「稳定红」）——行为契约由进程级测试锁定，竞争本身以复现循环验证（修复前 2/54 崩 → 修复后 54/54 干净）。（来源: DSH 迁移实现报告.md §6）
- 【推断】对 pi 架构的含义：A/B 零工具配置自研 controller 直驱 pi-ai stream、无需 agent-loop（Pi 内核从零实现方案.md §4），实验 runner 若进程内直连则整类进程边界问题消解；若保留长驻进程则须原样继承 turn 预算护栏与优雅退出纪律。

### L9. 指标对齐门的三轮演进学费

- v1 单侧 ±1σ 门判「不过」（#29，池化口径 18/20 IN、2 OUT）。（来源: DSH 指标对齐门报告.md §1）
- 诊断跑 #30（45 单元重跑，8.4M token）量出噪声底、定性为门的检验力问题，留下五条门协议修订建议。（来源: DSH 指标对齐门噪声底报告.md §6）
- ADR-0007 把修订落成管线代码（票 #31），v2 协议成型。（来源: ADR-0007）
- 学费：#29 + #30 合计真实网关消耗 17.2M token，其中相当部分是为校准门协议本身支付的。（来源: DSH 指标对齐门噪声底报告.md §8）
- 教训：验收门协议必须先经噪声底校准再用于判定；pi 线直接复用 v2（第三轮应用），不再付该学费。（来源: Pi 内核从零实现方案.md §5.3）

### L10. DSH 原生机制全程贡献为零

- 1:1 迁移纪律下 compaction seam / `ctx.toolResultPruner` / session seed-fork / request-header 事件全部后置为独立消融票（每票带 before/after 指标），**未开工**。（来源: DSH 迁移实现报告.md §9；ADR-0005「Considered Options」）
- 内核相对 POC1 薄 harness 的机制增量（compaction、session-query、session-projection 等能力边界）在本项目实际用不上。（来源: ReviewAgent以DSH内核和PI内核的方案对比分析.md §4；DSH 迁移实现报告.md §9）
- 【推断】这是「不考虑扩展复用」前提下 DSH-first 论证失效的核心：DSH 的优势项（插件组合、可扩展 seam、原生机制、企业安全控制）恰好都不是本项目消费的面。

### L11. CI 工程债实例

- compile-freshness 测试（#45 引入的 bin mtime 判鲜检查）间歇失败：main 最近 5 次 push 有 4 次 FAILURE（2026-09-17 时点），typecheck 三包与 discipline-gate 均绿、失败仅在 suites 的 `Test (review-dsh)` 步骤。（来源: 生产化可行性事实调查.md §5.3）
- 失败为时序 / 环境敏感：本机与 CI 失败的子测试不同，非确定性行为；且无 open issue 跟踪。（来源: 生产化可行性事实调查.md §5.2/§5.3）
- 事实注记：该测试属 `packages/review-dsh/tests/bin/`，已随 DSH 内核移除而不再存在于 pi-kernel 分支。（来源: 生产化可行性事实调查.md §5.2 失败文件路径；ADR-0009「决策」）
- 教训：bin 编译产物新鲜度门是脆弱设计，pi 线引入任何「编译产物在位检查」时应吸取。

### L12. 工作量对照（ADR-0009 的经济账）

- DSH 迁移 2 天 12 票：`packages/review-dsh` 25 src 文件 3,502 行 + 24 测试文件 4,365 行——但以 POC1 冻结件 1:1 复用为前提（contracts / codeintel / prefetch / SYSTEM_PROMPT / metrics 管线 / 判定链 / dashboard 全部直接复用）。（来源: DSH 迁移实现报告.md §5）
- ADR-0009 评估：从 0 面 ≈ 6k 行内核 + 1k 集成；仪器 ≈ 10k 行平移基本不动——「比 DSH 线省（装置 / 方法 / 文档 / 数据全在）」，净成本集中在 P2 字节纪律与 P5 真跑。（来源: ADR-0009「Consequences」；Pi 内核从零实现方案.md §7）
- pi 原语面已逐项实测确认：agent-loop 钩子（`shouldStopAfterTurn` / `transformContext`）、`Model.baseUrl`、`onPayload` wire 捕获。（来源: ADR-0009「Considered Options」；Pi 内核从零实现方案.md 文首一句话结论）

---

## 3. 对 Pi 新架构仍然成立的需求与约束

### 3.0 既有架构决策的效力状态（总表）

| 既有决策 | 对 pi 线的关系 | 来源 |
|---|---|---|
| ADR-0005（DSH 迁移姿态）/ ADR-0006（DSH 内核形态） | 转为历史记录，被 ADR-0009 取代 | Pi 内核从零实现方案.md §8 |
| ADR-0007（对齐门协议 v2） | 复用，第三轮应用（POC1↔DSH 之后的首个新对照） | Pi 内核从零实现方案.md §8 |
| ADR-0008（被测模型可换 + 分口径指标） | 接入面语义继续有效；被测侧 wire 序列化由 pi-ai 承担（画像语义等价）；judge 侧不变 | Pi 内核从零实现方案.md §8 |
| ADR-0003（零构建静态代码情报） | 纪律不变——codeintel 从 0 重写但保持零构建 / tree-sitter 静态生成 | Pi 内核从零实现方案.md §8 |
| ADR-0004（S 级判据） | 不变 | Pi 内核从零实现方案.md §8 |
| ADR-0002（模型钉扎语义） | 已被 ADR-0008 收窄；保留缓存计量理由 / 可比性主张 / 账号级缓存特性 | ADR-0002 状态注记 |
| Config B 生产形态（2026-09-17 拍板） | 不变（内核无关层） | Pi 内核从零实现方案.md §8 |
| 《Pi 内核定制基线方案》 | §1–§6（fork 接线 / 分歧清单 / 验证结果 / 已知限制）继续有效；§8 增量适配姿态由 P0–P5 取代 | Pi 内核从零实现方案.md §8 |

### 3.1 成本与质量目标

1. **原始命题**：以 20~30% 的 Context/Token 成本获得 80~90% 的检视质量、Cache Hit ≥ 85%——「低 Token、高质量代码检视 Agent」的立项目标，需一套能对同一批 MR 在不同上下文 / 缓存策略下做受控对比的 harness。（来源: POC1 实现报告.md §1）
2. **Phase 2 实证（B 形态达成情况）**：token 49.6k = C 207.2k 的 24%（≤ C×30% 达标）；热口径 cacheHit 0.8782（≥ 85% 达标）；recall 0.1044 = C 的 10.8 倍（≥ C×90% 达标）。（来源: Phase 2 主数据分析报告.md §3.2）
3. **「80~90% 质量」以 C 为参照已因锚塌缩失真**——S 级语义是「显著超越一个塌缩的锚」，不是「达到高质量水位」。（来源: Phase 2 主数据分析报告.md §3.3）
4. 【推断】绝对质量水位（「80~90% 检视质量」的绝对含义）未经人工校准闭合（§1.2.13），新架构方案的质量目标表述应区分「相对 C 达标（已实证）」与「绝对水位（待人工抽检回收 / 生产人工接受率）」两层。
5. **生产 KPI 应采用绝对口径（人工接受率），不用相对 C 的比例**。（来源: 生产化可行性事实调查.md §3.2）
6. **单次检视延迟与成本有界（B 形态实测）**：单轮 6 请求、约 1.5~3.5 分钟、计费口径约 20~32k token。（来源: 生产化可行性事实调查.md §7.4）
7. **评测预算量级**：phase2 一轮三侧计费 72.46M / 含缓存读 316.48M + judge 信封合计 ≤26.4M + 事故损耗 ≈7.7M；pi 侧 P5 真跑量级与 phase2-dsh 一轮相当（计费 ~24M 级 + judge 网关成本）。（来源: Phase 2 主数据分析报告.md §9；Pi 内核从零实现方案.md §7）

### 3.2 评测与验收契约（对照实验的立身之本）

1. **Tier 1 协议一致（字段级，必须）**——对齐对象 = `runs/phase2-dsh/plan.json`（实测）：30 案 VUL4J（`data/vul4j/target-cases.json`；物化仓 base 态 + 原生 diff + 原生英文 issue）；矩阵 A–E × 3 reps = 450 单元；被测模型 `deepseek-v4-flash`；Verifier off；判定链四层 + judge `glm-5-3-260814` + S/A/B 判级（ADR-0004）；指标 CE / RCE / RIE / CARC（ADR-0008 分口径）；RunRecord schema 原样（analyze / gate 脚本须能原样消费两侧数据）。（来源: Pi 内核从零实现方案.md §5.1）
2. **token 口径归一是 P1 硬票**：DSH 实测 usage 形状 `{inputTokens, outputTokens, cacheReadTokens}`（样本 3830/17038/5376）↔ pi-ai usage 字段映射 + 已知记录断言。（来源: Pi 内核从零实现方案.md §5.1/§6 R2；ADR-0009「Consequences」）
3. **Tier 2 字节纪律（分层）——A/B 必须字节一致**：零工具配置下请求体全部由自研组装层产出，应与 DSH 审计逐字节相同；字节真源已实测确认（`runs/phase2-dsh-t{1..5}/audit/**` 的 `requests[].wireBody`）——不需要复用任何旧代码即持有测量契约。（来源: Pi 内核从零实现方案.md §5.2；ADR-0009「决策」）
4. **Tier 2——C/D/E 语义一致而非字节一致**：工具 schema 的 wire 序列化由客户端 SDK 完成（DSH 线 = dsh-sdk-protocol，pi 线 = pi-ai），构造上不可能字节相同——「这不是缺陷而是内核效应本身」，先例 = phase2 main↔dsh 对照（POC1 走 review-llm 序列化，同样不字节一致）；处置沿用：工具语义等价 + 稳定前缀纪律 + 对齐门兜底。（来源: Pi 内核从零实现方案.md §5.2；ADR-0009「Considered Options」）
5. **双门验收，第三轮应用**：确定性纪律门（字节 / 审计断言，零网络）+ 指标对齐门（#30 对称 max σ 带，ADR-0007）——「POC1↔DSH 对照锻造的迁移验收协议，内核无关；pi 是同一协议换被测对象」。（来源: Pi 内核从零实现方案.md §5.3）
6. **ADR-0007 v2 门协议要点（硬约束）**：
   - 格判定用**对称 max σ 带**——带宽取两侧样本 σ 的较大者、中心为基线均值，方向无关（|Δmean| ≤ maxσ 在两侧对称成立）。（来源: ADR-0007）
   - **最小样本护栏**——任一侧 n < 3 的格标 `INSUFFICIENT_SAMPLE` 不判定（不 FAIL），把统计无效格显式挡在判定面外。（来源: ADR-0007）
   - **单元配对符号检验（精确二项，α=0.05）为主判据**（噪声对照在场时）——按单元键跨侧配对、平局剔除计数、仅显著更差方向 FAIL；配对 PASS 的指标其带外格不触发 FAIL（带外 = 检验力问题），NOT_TESTED / 噪声缺席时回落格判定；配对 FAIL 恒 FAIL。（来源: ADR-0007）
   - **advisory 面**：样本量建议（judged n < 15，取最小侧 n）与时点配对预警（两侧执行窗区间距离 > 48h）。（来源: ADR-0007 及实现注记 #31）
   - #29 遗留单侧带**并列报告**不删除（协议变更可见性 + 历史回放锚定）；门不进 CI（输入是真实网关留痕）。（来源: ADR-0007）
7. **DSH 侧结论不自动迁移**：换内核与换模型同理——pi 侧须独立跑 450 单元 + judge；DSH 侧数据已存在，不重跑。（来源: Pi 内核从零实现方案.md §5.3）
8. **变量隔离**：judge 链继续走 review-llm（仪器冻结，重写仪器会引入判定漂移，科学增益为零）；被测侧 LLM 客户端 = pi-ai；唯一变量 = 内核。（来源: ADR-0009「决策」「Considered Options」；Pi 内核从零实现方案.md §3.2）
9. **模型非确定性应对协议**：3 reps + 配对检验 + σ 带（phase2 既有经验，已被协议解决）。（来源: Pi 内核从零实现方案.md §6 R7）
10. **cache 命中差异属内核效应，报告单列**：序列化方言不同 → prefix cache 命中率不同；`cacheReadTokens` 单列口径呈现，不与质量结论混排。（来源: ADR-0009「Consequences」；Pi 内核从零实现方案.md §6 R3）
11. **时点纪律**：对照跑与基线跑应紧邻执行——#30 证明跨日部署漂移的效应量与运行时互换同量级（r1↔r2↔DSH 隔 3–4 天，漂移同时进入两侧对照）。（来源: DSH 指标对齐门噪声底报告.md §6；ADR-0007）
12. **测量常量面 / 内核变量面的切分（ADR-0009 对对照实验前提的显式化）**——常量面（byte / 行为一致，不许漂移）：Zone A 系统提示词、Zone B 仓库结构图、MR 呈现、预取管线输出（config B）、六阶段 Review Loop 语义、Finding/Evidence 契约与各纪律门、判定链（四层 + glm-5.3 + S/A/B）、指标公式（CE/RCE/RIE/CARC）与 RunRecord、数据集（30 案 VUL4J + 物化仓）；变量面（被比较量，从 0 重写）：Agent 状态与事件模型、工具调用协议与 wire 序列化、LLM 客户端（pi-ai 取代双客户端）、会话与审计投影机制、前缀组装与缓存命中的实现路径。（来源: Pi 内核从零实现方案.md §2；ADR-0009「Consequences」）

### 3.3 审计与可观测性要求

1. **审计四件套（POC1 起的契约）**：每次请求的可重放字节、工具调用日志、阶段日志、拒绝留痕。（来源: POC1 实现报告.md §4.1）
2. **可重放字节的采集点**：审计的可重放字节只能来自持有 wire 序列化的一方（DSH 线证据：适配器在 wire 序列化处捕获每次请求的精确 body）。（来源: DSH 迁移实现报告.md §4.2；ADR-0006「Considered Options」）
3. **审计投影的字段契约**：pi 事件流 → `AuditFileContent` 投影，字段对齐 DSH 审计 `requests[].{model, effort, messages, tools, wireBody}`；RunRecord schema 原样，analyze / gate 原样消费。（来源: Pi 内核从零实现方案.md §4/§5.1）
4. **usage 聚合在场语义**：可选字段「定义即在，含 0」——「网关回报 cached_tokens: 0」是有信息量的记账，不应在内核侧被吞掉；工具成本计价留在核外（`toolCallLog` 即账本，`computeToolCostTokens` 直接消费）。（来源: ADR-0006 实现注记 #22）
5. **`toolCalls` 记账语义**：= 实际发生数（执行 + 失败，被拒不计）；被拒调用全量留痕 `toolCallLog`；耗尽记 `truncationReasons=["TOOL_BUDGET_EXHAUSTED"]` 与发生阶段 phaseLog note。（来源: ADR-0006 实现注记 #20；DSH 迁移实现报告.md §4.3）
6. **截断语义**：轮循环耗尽 → `truncated=true` + `TRUNCATION_MAX_ROUNDS`；truncated 是 record 语义的收敛标注，进入指标管线而非失败。（来源: ADR-0006 实现注记 #21/#26）
7. **凭据纪律**：key 绝不落代码、日志与审计；manifest / 审计留痕 model + baseUrl；`.env.local` 自动装载（已有非空环境变量优先、装载摘要只报键名不回显 key、缺失启动报错给清单）；角色命名 `REVIEWER_API_KEY` / `REVIEWER_URL` 与 `JUDGE_API_KEY` / `JUDGE_URL`（旧 `DEEPSEEK_*` / `OPENAI_*` 别名，新名优先）。（来源: 生产化可行性事实调查.md §7.1；ADR-0008「决策」）
8. **运行器韧性要求**：单元级断点续跑（同 id 重启无损恢复，已工程验证）；损坏记录上报不静默丢弃；`--report-only` 零调用重建报告；失败单元错误帧隔离、宿主进程存活（若保留长驻形态）。（来源: POC1 实现报告.md §4.6；Phase 2 主数据分析报告.md §8；DSH 迁移实现报告.md §4.6）
9. **真实网关护栏**：turn 级止损预算（DSH 线经验值 900s = 容一整次单请求 600s 超时重试周期；POC1 无此护栏属缺失项，「把真挂死单元的止损压在 15 分钟内」）。（来源: ADR-0006 实现注记 #29；DSH 迁移实现报告.md §4.7）
10. **配置真源与诚实标注**：A–E 配置表真源 = 冻结 `CONFIGS`（spec #1），preset 注册表逐字段对照测试锁定；`deriveConfigId` 逐字段遍历回环；组装期 pairwise 互斥（杂交形态 fail fast）——「审计与 runId 携带的形态标签必须与实际装配一致」。（来源: DSH 迁移实现报告.md §4.5；ADR-0006 实现注记 #25）

### 3.4 模型与网关接入要求

1. **契约边界**：只承诺 OpenAI-compatible（`/chat/completions` + Bearer），不做多协议适配层——企业网关均为 OpenAI 兼容形态，适配层是无真实消费者的投机泛化。（来源: ADR-0008「决策」）
2. **自由模型 id + 参数画像表**：model 经 CLI flag 传任意 id（`flash` / `pro` 别名保留，退役 id 拒绝）；画像三维度——① thinking 字段序列化（deepseek-* → enabled + reasoning_effort high；其余不发）② completion 信封（glm-* → 32768，默认 8192，deepseek-* 不序列化 max_tokens）③ usage 能力声明（缓存计量有无）；未知模型回落保守默认画像（不发 thinking、标准信封、不假设缓存计量——新模型至少不 400、不静默截断）。（来源: ADR-0008「决策」）
3. **golden bytes 硬门槛**：DeepSeek 默认路径请求字节逐字节不变——`tests/deepseek/golden-bytes.test.ts` 锁定缺省模型请求字节；画像分派只作用于已知非 DeepSeek 前缀与显式自定义 id。（来源: ADR-0008「决策」）
4. **指标按 provider 能力分口径**：Cache-Hit-Rate 只在画像声明缓存计量的模型间可比，无计量记 N/A（null）不记 0（未知 ≠ 0，误报 0 污染跨模型对比）；CARC 恒可算，无计量时 cached 记 0 = 全输入按未命中计价的保守上界（方向性安全，真命中率越高真实成本只会更低）；RIE / Recall / Precision 走标准 usage 字段不受画像影响；分析层按 model 分组、不跨模型混比。（来源: ADR-0008「决策」）
5. **function calling 依赖面**：`review.*` 工具要求被测模型支持 function calling，不做无工具降级模式；400 类错误映射为可诊断信息。事实注记：Config B 生产形态零工具，该约束实际作用于 C/D/E 评测配置。（来源: ADR-0008「Consequences」；生产化可行性事实调查.md §3.1）
6. **judge 异构判定约束**：judge 与被测不同源——以被测模型为对照系（精确同 id 或同已知 provider 家族）；同源 + 双侧官方端点启动即拒（exit 2，不烧检视预算）；任一侧自定义接入点在场降级 warning（异构性转为实验者责任）。（来源: ADR-0008「Consequences」）
7. **企业网关 P0 七条（不满足阻塞接入）**：M1 OpenAI 兼容非流式 `/chat/completions` + Bearer；M2 usage 字段完整上报（缓存计量至少一族字段，未命中显式 0 而非缺省）；M3 请求体原样透传不改写字节；M4 function calling 完整往返（工具名接受 `^[a-zA-Z0-9_-]+$`）；M5 模型 id 可诊断、不静默路由；M6 错误语义稳定 + 软错误已耗 usage 回报；M7 调用级账单 / usage 日志（对账兜底——客户端只拿得到响应 usage，judge 链等未逐调用落盘的消费者必须有网关侧账单）。（来源: 生产化可行性事实调查.md §7.2）
8. **P1 七条（影响成本与指标质量）**：S1 缓存同步建立（或预热窗口可配置 / 可查询）；S2 缓存命中粒度披露（块大小 / 对齐规则）；S3 token 计数确定性（同内容请求方差 <1%）；S4 reasoning token 单列计量；S5 部署版本披露 + 同 id 不换权重；S6 usage 原文随调用可取；S7 一网关多模型族路由口径一致。（来源: 生产化可行性事实调查.md §7.2）
9. **网关开放缺口**：并发上限 / 配额管理——需网关团队另行提供容量说明（本系统实验高峰为多单元并行调用）。（来源: 生产化可行性事实调查.md §7.2/§7.5）
10. **网关实测差异基线（火山网关 vs 官方，同 45 单元对照）**：网关总量为官方 1.68~1.73 倍，方向因配置而异——A/B 网关更省（0.67~0.72×）、D 更贵（2.72×，rounds 官方 1 → 网关 4）。（来源: 生产化可行性事实调查.md §7.3）
11. **网关差异归因四项**：① 同名 id 不同部署版本（网关实为 `deepseek-v4-flash-ga-260731`，最大影响项）；② 缓存基础设施差异（官方即时全前缀命中；网关异步预热 45~90s + 1024-token 块对齐，轻前缀快速循环配置 cacheHit 84.8%→40.4%，−44pt）；③ usage 字段族差异（已被客户端双读适配）；④ 计量噪声（同内容请求 ±8% 抖动）。已排除：请求被网关改写（双包 wire parity 钉死逐字节一致）。（来源: 生产化可行性事实调查.md §7.3）
12. **网关侧数据缺口**：官方侧只有 3-case 小样本（Phase 2 只跑过网关）；judge 链 token 无精确计量（只有信封上界）；响应侧原始 usage JSON 不落盘；reasoning token 未进采集契约。（来源: 生产化可行性事实调查.md §7.3）
13. **换端点 / 换模型先冒烟**：`review-agent smoke` 形态（双探针：最小补全 + 最小工具调用，人话诊断 + 退出码，探针走生产画像序列化）；模型迁移验证流程见 §1.4.8 ③。（来源: 生产化可行性事实调查.md §7.1/§3.3）
14. **pi 侧接入事实（已核实）**：`Model.baseUrl` 是数据字段（pi-ai openai-completions 直接吃）；内建 `deepseek-v4-flash` 条目改 baseUrl 指向网关（模型在 v0.85.1 目录快照内）；fork 在手，最坏打小补丁——P1 冒烟验证。（来源: Pi 内核从零实现方案.md §4/§6 R4）

### 3.5 检视策略与生产形态约束

1. **Config B 生产形态不因重写改变**（内核无关层）。（来源: Pi 内核从零实现方案.md §4/§8）
2. **零构建静态代码智能纪律不变**：codeintel 从 0 重写但保持零构建 / tree-sitter 静态生成——生产约束是「只有静态源码快照」（无构建环境、不可编译）。（来源: Pi 内核从零实现方案.md §8；ADR-0003）
3. **Evidence Gate 与预算上界语义**：Finding 必须带证据链；`MAX_ROUNDS` / `MAX_TOOL_CALLS` 为冻结常量硬上界（「单次检视成本有界」是骨架约束，不可配置）。（来源: POC1 实现报告.md §4.1；ADR-0006 实现注记 #21）
4. **六阶段骨架语义属测量常量面**（阶段结构见 DSH 审计 `phaseLog`）——pi 线 A/B（零工具）由自研 controller 直驱 pi-ai stream（无需 agent-loop），C/D/E 走 pi-agent-core `Agent` + agentLoop 钩子（`shouldStopAfterTurn` 控轮次、`transformContext` 控上下文，`packages/agent/src/agent-loop.ts`/`hooks.ts` 已核实）。（来源: Pi 内核从零实现方案.md §2/§4）
5. **MR 验证域**：POC1 验证域仅 ≤10 文件、diff ≤2K 行；大 MR 切分 v2（按文件组切分 → 合并去重）单独立项未启动。（来源: 生产化可行性事实调查.md §3.3/§3.5）
6. **部署侧降本杠杆（零模型侧改动）**：同仓 MR 批量调度——B 总口径命中率 0.8114 在同仓聚集下趋近热口径 0.878+；Zone B 前两节跨 MR 字节相同，前缀分歧点在 Symbol Index 节内部。（来源: 生产化可行性事实调查.md §3.3）
7. **C3 知识第 4 预取层（CWD 缺陷模式库）**：语料空时与现状字节兼容；依赖 Phase 4 知识语料生产链路（DTS 挖掘 → 模式抽取，未开工）——形态决策现在锁定。（来源: 生产化可行性事实调查.md §3.3）
8. **退役时点约束**：`src/` 运行时模块（loop / run / tools / zoneb / codeintel / contracts / finding / audit / shared / fake，≈5.5k）在 P2 字节门绿、P4 runner 接缝切换前是活依赖（期望生成器 + `src/deepseek` 是实验 CLI 缺省客户端，不可先弃），退役于 P4 同批；仪器面（judge / metrics / dataset / experiment / sampling / calibration / gate / reference / review-llm，≈10k）长期保留。（来源: Pi 内核从零实现方案.md §3.4）

### 3.6 工程纪律

1. **测试主缝**：LLM client 边界可编程 fake；常规门零网络、零真实 LLM；真实网关路径不进 CI。（来源: POC1 实现报告.md §6；生产化可行性事实调查.md §5.1）
2. **观测纪律**：验收断言从内核公共脸观测（fake 捕获的请求字节 / 导出审计与结果对象），不窥探内核内部状态、插件私有结构或驱动器内部变量。（来源: DSH 迁移实现报告.md §6）
3. **覆盖率门**：src/ 全局 80% 阈值（POC1 基线 90.7% lines / 88.5% branches / 95.4% functions）。（来源: POC1 实现报告.md §6）
4. **golden bytes 纪律**：发布数字 / 默认路径字节进夹具即锚，协议回退在测试面变红；σ 算术用精确夹具（如 n=2 样本 std = 偏差 × √2）免手算。（来源: ADR-0008「决策」；ADR-0007 实现注记 #31）
5. **零网络强制的收口点（DSH 线先例）**：`Socket#connect` + `globalThis.fetch` 双点拦截——不放行 loopback 则门内断言全 fake；拦截同时是「断网模拟」与「断言放大器」。（来源: ADR-0006 实现注记 #28）
6. **Claude Code 外部参照保留**（`src/reference`，测量装置一部分）。（来源: ADR-0009「决策」）
7. **实验 runner 接缝**：runner `executeUnit` 的可替换执行点已预留注释（P4 kernel 执行缝 + 450 单元矩阵，断点续跑协议复用）。（来源: Pi 内核从零实现方案.md §7 P4）

---

## 4. 已被放弃或仅历史参考的旧结论（新方案不可误引用）

1. **ADR-0005（DSH 迁移姿态）/ ADR-0006（DSH 内核形态）——已转历史记录**：两 ADR 文首均有 2026-09-18 状态注记——DSH 线已按其完成使命并归档，对现行代码不再有约束力；保留价值 = DSH 侧数据与审计格式的解读依据（各实现注记仍可解释 phase2-dsh 数据）。（来源: ADR-0005/0006 状态注记；ADR-0009「Consequences」）
2. **「DSH 主内核，Pi 做对照，不要二选一锁死」+ Review Runtime Adapter 层（统一接口 + DSH/Pi 双实现）——已被推翻**：对比分析 §10 的 DSH-first 论证以「可扩展性 / 长期演进」为前置；用户追加前提「不考虑 ReviewAgent Runtime 的扩展复用」后论证失效（可行性分析 Pi 70 / DSH 30），ADR-0009 拍板从 0 重写而非适配层。（来源: ReviewAgent以DSH内核和PI内核的方案对比分析.md §10；ADR-0009）注意：对比分析中对 DSH / Pi 能力面的事实性描述（如 Pi 无内建权限系统、pi-ai 多 Provider 覆盖、DSH developer preview 状态）仍是有效参考，被推翻的是其选型结论与 Adapter 层建议。
3. **「Phase 1 迁移时 POC1 代码直接复用」（ADR-0001 Consequences / POC1 报告 §8.4）——DSH 线已按此完成，pi 线不再适用**：pi 线现有实现代码不导入，整体降为两个角色——评测装置（冻结平移）与期望生成器（P2 字节门离线对照源），P4 后退役。（来源: POC1 实现报告.md §8；ADR-0009「决策」）
4. **ADR-0002 的「代码层模型准入白名单」——已被 ADR-0008 部分取代**：保留为有效部分的只有缓存计量选择理由（per-request cached/uncached 计量与 1/30 价格差）、实验内锁定同一模型的可比性主张、账号级缓存特性（best-effort、闲置数小时至数天清除、跨会话前缀复用需 ≥2 次共享请求）；「主力锁定 deepseek-v4-flash」语义收窄为实验对比缺省主力与别名锚。（来源: ADR-0002 状态注记及实现注记 #43；ADR-0008）
5. **#29 原始判定「门不过」（±1σ 单侧带，18/20 IN、2 OUT）——已被定性为门的检验力问题**：#30 证明 ±1σ 门把 POC1 自身都判不过（正向 1 OUT / 反向 3 OUT，方向依赖），DSH 的 2 OUT 落在噪声底量级内、格不重叠；最终判定 = 对称 max σ 口径下 DSH 19/20 IN（唯一 OUT 为统计无效格），「DSH 内核接管实验主数据无系统偏差证据」。**引用对齐门结论必须用 ADR-0007 v2 口径；#29 单侧带仅作历史锚并列报告，不进任何新验收。**（来源: DSH 指标对齐门报告.md 文末注记；DSH 指标对齐门噪声底报告.md §5；ADR-0007「Consequences」）
6. **「Phase 2+ 策略改进自此可在 DSH 内核上进行」及后置消融票——已历史化**：ADR-0009 后 pi 线是新主线，DSH 数据降为对照基线侧（「pi 负责把 ReviewAgent 做出来，DSH 数据作为 Runtime Benchmark 对照」）；DSH 原生机制消融票（compaction seam / `ctx.toolResultPruner` / session seed-fork / request-header 事件）随 DSH 内核移除而失效（本就未开工）。（来源: DSH 迁移实现报告.md §9；ADR-0009 决策背景）
7. **「C = 质量主锚 / 接近全量上下文的检视质量」的隐含定位——协议锚未改但实证锚已塌缩，不可当目标位引用**：ADR-0004 判定协议仍以 C 为参照原点（若改锚须另立 ADR），但 Phase 2 实证 C 全线垫底（77% 零 finding、recall 最低、成本最高、跨侧最不稳）；「全仓注入的边际信息收益为负」；引用 B=S 必须连同锚塌缩注记（S 级语义 = 显著超越一个塌缩的锚）。（来源: Phase 2 主数据分析报告.md §3.3/§5.4/§12）
8. **《生产化可行性事实调查》的「当前架构形态」描述——main @ a5a06bb（2026-09-17）时点快照，已过时**：其 §1.2 的 pnpm monorepo + 双运行时 + 双 CLI、`packages/review-dsh`、CI discipline-gate 作业、compile-freshness CI 红灯等，均属 DSH 线形态；pi-kernel 分支已移除 `packages/review-dsh`、`--kernel` 缝、`@deepseek-ai/dsh-sdk-protocol` 依赖与 CI discipline-gate 作业（字节纪律改由 root golden bytes 断言携带，pi 线 P2 票以「对照 DSH 审计」形式重建纪律门）。该调查中的**差距清单、网关要求、token 数据、实测结果不受时点影响，仍然有效**；仅架构形态类描述须按 ADR-0009 后状态重读。（来源: 生产化可行性事实调查.md §1.2/§5.3；ADR-0009「决策」）
9. **「D 配置名义 F1 最高（0.6257）」——不可作为结论引用**：跨侧不可复现（跨侧 recall 极差 0.1039，相对差 35%），Phase 2 报告明文「不以 D 为稳定对照做任何对比结论」。（来源: Phase 2 主数据分析报告.md §5.5）
10. **「E 配置（Context Ledger / Append-only）带来复用与降本收益」的机制预期——已被实证否定（方向性）**：E recall 三侧一致低于 D，precision 与 F1 同向，「账本机制在本基准无正向收益」；新架构不应默认包含 ledger 机制并预期收益。（来源: Phase 2 主数据分析报告.md §5.1）
11. **#29 n=9 小样本 advisory（4 条）——已被 450 单元主数据消解**：小样本警示在 Phase 2 全部消失。（来源: Phase 2 主数据分析报告.md §11）
12. **计划书 V0.x 序列对照——仅路线图参考，非事实承诺**：V0.3（知识引擎）/ V0.5（研发流程接入：GitLab/GitHub/Code Review Platform/CI-CD、Quality Gate 分级阻断、本地 Review）/ V1.0（企业平台化）无对应 issue 或交付；项目实际演进与计划书并非一一对应（Evidence Gate 提前在 POC1 落地，知识层后移为「第一批生产数据之后」依赖项）。（来源: 生产化可行性事实调查.md §2.5）
13. **Phase 2 报告 §13 的数据路径表（「本机留痕，不入仓」）——已被 P0 数据迁移超越**：phase2 三侧数据 + audit 真源 + 物化仓已迁入本仓（§1.3）；s\* 分片与「主工作仓为唯一数据位」的旧表述仅适用于迁移前。（来源: Phase 2 主数据分析报告.md §13；Pi 内核从零实现方案.md §9）
14. **POC1 报告 §8.1「小样本 Benchmark 试跑（未执行）」——已由后续阶段补齐**：网关口径实验（commit `30d7e16`，45/45 单元）与 #29/#30/Phase 2 补齐，不再是遗留项。（来源: 生产化可行性事实调查.md §2.1）

---

## 附：本摘要未覆盖的相邻文档（供架构方案另行取用）

- 《Pi 内核定制基线方案》§1–§6（fork 接线、分歧清单、验证结果、已知限制）——pi 四包基座事实，仍有效；其 §8 增量适配姿态由 P0–P5 取代。（来源: Pi 内核从零实现方案.md 文首文档链/§8）
- 《pi 内核可行性分析》（决策背景，Pi 70 / DSH 30）、《Config B 生产化方案——差距分析、推荐路线与修改建议》《ReviewAgent 企业内部模型网关接入需求规格》《DeepSeek 官方 API 与火山引擎网关 token 消耗对比分析》《VUL4J 评测方案与数据复制指南》《Pi 内核从零实现方案》——本摘要仅经由一手报告转引其结论，架构方案如需原始细节应直读原文。
- pi 版本序注意：`v0.9.x` tag 是 2025 旧线，`0.85.x` 才是 2026 当前线；ai 包模型数据锁 v0.85.1 tarball 快照。（来源: Pi 内核定制基线方案.md §9，经记忆转引——引用前建议回原文核对）
