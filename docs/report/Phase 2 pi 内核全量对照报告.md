# Phase 2 pi 内核全量对照报告（P5b：对齐门 + 独立判级 + 对照）

> **历史文献（时效注记）**
> 本文写于评测仪器层与 `runs/**` 留痕仍在的时期。评测仪器层（数据集构造 / 判定链 / 指标聚合 /
> 实验运行器 / 字节门）已于 [ADR-0024](../adr/0024-drop-config-matrix-and-config-identity.md) 删除，
> `runs/**` 自 [ADR-0033](../adr/0033-task-id-output-location.md) 起不入库、旧目录已清理，故文中数字**不可复跑**；
> 内核四包现为 npm 上游依赖 `@earendil-works/*`（精确锁 `0.85.1`，[ADR-0035](../adr/0035-upstream-kernel-as-npm-deps-and-single-package.md)）。
> 现行形态见 [`CONTEXT.md`](../../CONTEXT.md)。

> **文首声明**：本报告是 issue #11（P5b）的正式对照报告——pi 内核全量真跑（`runs/phase2-pi`，450 单元，#17）对 DSH 线基线的**对齐门判定 + S/A/B 独立判级 + 四侧对照**。评价维度与读法对齐 DSH 线报告《Phase 2 主数据分析报告》（DSH 兄弟仓 [`MustacheXb/ReviewAgent`](https://github.com/MustacheXb/ReviewAgent) `docs/report/`；跨仓限定语纪律：该报告为 DSH 线口径，其 §3.3 锚塌缩、§5.1 九维度为本报告的章节对齐锚点）。
> **正式性**：判级为 pi 侧独立跑出（判级锚 = 配置 C rep2+ 热口径）；对齐门判定**如实报告为 FAIL**（§5）。DSH 侧结论不自动迁移到 pi 线（§4.2）。
> 日期：2026-10-19。分析对象：pi 内核（`packages/review-pi`，本仓 ADR-0009 从 0 重写）首组 450 单元全量数据，对照本仓 P0 迁移的三侧 DSH 线数据。

## 1. 概述与一句话结论

**对齐门 FAIL（如实）——pi 内核与 POC1 薄 harness 基线存在系统性形态分歧，且分歧面与 DSH 内核对 POC1 的分歧面不同**：格判定 16 IN / 4 OUT（OUT 全部是 cacheHitRate）；配对符号检验 linePrecision / totalTokens PASS、lineRecall / cacheHitRate FAIL。FAIL 的语义不是「pi 更差」而是「pi 的逐单元 recall 波动与缓存形态显著超出 POC1 重跑噪声底」——方向读数见主表（§6）：pi 侧 recall 全线更高（C 0.5393 vs 基线 0.1341）、token 更低（C 368.0k vs 706.5k）、轮次更少（C 1.19 vs 3.30）。**这是本仓立项问题「架构有效还是内核有效」的全量级实证：A（零工具）侧四侧大体同构，C/D/E（工具循环）侧形态分歧显著——内核是大变量。** S1 两条超预期观察在全量上守住：C 反转守住（R2 收口）、E−D 小正增益（案集敏感限定维持）。

## 2. 复算路径（无手抽数字声明）

本报告 §4–§11 表格的全部数字由两条命令从 runs/ 留痕与门 JSON 锚点机器重放（复算范式对齐兄弟仓 `analyze-phase2.ts`；可测计算在 `src/experiment/p5b-compare.ts`，12 单测覆盖）：

```bash
# 对齐门（ADR-0007 第三轮应用；2026-10-19 跑出，判定落 .cache/gate-phase2-pi.json）
pnpm alignment-gate -- --baseline runs/phase2-main --candidate runs/phase2-pi --noise runs/phase2-noise --out .cache/gate-phase2-pi.json

# 四侧对照表 T1–T9（本报告 §4–§11 全部表格的来源）
pnpm analyze:p5b
```

数据源：`runs/{phase2-pi,phase2-main,phase2-noise,phase2-dsh}/report.json` + 各侧 450 份执行 record + 门 JSON。判级由实验 runner 在判定阶段自动产出（算法 `src/metrics/verdict.ts`，单测覆盖），本报告从 report.json verdicts 阶段直接读取复算。例外口径（正文已标出处、非重放产物）：§7.3 序列化方言机制数字引自 S1 报告 §6 逐案实测；§10 pi 运行事件账（~9M）引自 `runs/phase2-pi/REPORT.md`（该留痕已随运行产物清理，不入库）。

## 3. 四侧内核身份（「DSH 侧」分层表述纪律）

| 侧 | 内核 | 角色 |
|---|---|---|
| phase2-pi | **pi 内核**（`packages/review-pi`，本仓 ADR-0009 从 0 重写） | 被测候选 |
| phase2-main | **POC1 薄 harness 内核** | 对齐门基线（DSH 线主数据） |
| phase2-noise | **POC1 薄 harness 内核**（同基线重跑） | 噪声底（门配对检验对照） |
| phase2-dsh | **DSH 内核** | 内核效应参照（DSH 线附录侧） |

本仓 S1 报告所称「DSH 全量参照」即 phase2-main（POC1 内核主数据）；DSH 内核数据在 phase2-dsh。引用历史结论必须区分这两层——「DSH 侧 C 崩溃 13.4%」是 POC1 内核现象；DSH 内核侧 C judge recall 0.2828（同为塌缩形态、程度不同）。三侧 DSH 线数据为本仓 P0 迁移拷贝（md5 与 DSH 仓原位一致，已验证）。

## 4. 独立判级（S/A/B，锚 = 配置 C rep2+ 热口径）

### 4.1 判级分布（四侧并列）

| config | pi | main | noise | dsh |
|---|---|---|---|---|
| A | B | B | B | B |
| B | **B** | S | S | S |
| C（anchor） | BELOW_B* | BELOW_B | BELOW_B | BELOW_B |
| D | B | B | B | B |
| E | B | B | B | B |

锚可用性：pi anchor=C available=true；四侧 outcome 逐字一致 = **false**（唯一分歧格 = B）。

\* C 为 anchor 自比：token 判据（≤ 锚 × 30%）对自身永不过——机制性结果，非质量缺陷（#17 REPORT 同款注记）。

### 4.2 锚面与锚坍缩注记（强制）

| 侧 | anchor available | recall | precision | totalTokens | cacheHitRate |
|---|---|---|---|---|---|
| **pi** | true | **0.2468** | 0.3014 | 373.9k | 0.856 |
| main | true | 0.0097 | 0.0556 | 690.7k | 0.942 |
| noise | true | 0.0761 | 0.1611 | 604.4k | 0.9414 |
| dsh | true | 0.0515 | 0.1409 | 763.6k | 0.9464 |

（rule 口径 rep2+ 热口径；判级输入面。）

- **pi 侧锚未坍缩**（rule 热 recall 0.2468，居五配置最高）；**main/dsh 侧锚塌缩**（0.0097 / 0.0515）——DSH 主报告 §3.3「最重要的 caveat」的 pi 版对照。锚 recall 趋零使 recall/precision 门全放行、判级退化为 token 门 + 缓存门：main/noise/dsh 的 B=S 是**锚塌缩产物**（B 热缓存 0.86–0.88 过 0.85 绝对门 + token 门机械通过），不是「B 在 DSH 侧更优」的证据。
- **DSH 侧判级结论不自动迁移**：pi 侧判级在锚活着（0.2468）条件下跑出——B 的 S 档判负余量 recall −4.8pp（0.1745 vs 门 0.2221）、precision −0.5pp（0.296 vs 0.3014），见 §4.3。B=B（pi）与 B=S（DSH 三侧）的分歧不是质量分歧，是**锚状态分歧**。
- C 的 BELOW_B 在四侧一致且均为机制性（token 判据对自身永不过）。

### 4.3 pi 侧 B 配置判据明细（判负余量）

| grade | metric | value | threshold | pass |
|---|---|---|---|---|
| S | RECALL | 0.1745 | 0.2221 | ❌ |
| S | PRECISION | 0.296 | 0.3014 | ❌ |
| S | TOTAL_TOKENS | 58.3k | 112.2k | ✅ |
| S | CACHE_HIT_RATE | 0.7581 | 0.85 | ❌ |
| A | RECALL | 0.1745 | 0.1975 | ❌ |
| A | TOTAL_TOKENS | 58.3k | 112.2k | ✅ |
| A | CACHE_HIT_RATE | 0.7581 | 0.8 | ❌ |
| B | RECALL | 0.1745 | 0.1728 | ✅ |
| B | TOTAL_TOKENS | 58.3k | 187.0k | ✅ |
| B | CACHE_HIT_RATE | 0.7581 | — | ✅ |

（B 档无缓存判据，threshold 空即不参与判定。）

## 5. 对齐门判定（ADR-0007 第三轮应用，如实报告）

判定：**FAIL** —— 格判定：16 IN / 4 OUT / 0 样本不足 / 0 缺失；配对检验：2 PASS / 2 FAIL / 0 NOT_TESTED；主判据否决带外格 0 个（配对 PASS 的指标）。

### 5.1 格判定（修订 = 对称 max σ 带；遗留 = #29 单侧带）

| config/metric | 修订 | 遗留 |
|---|---|---|
| A/lineRecall | IN | IN |
| A/linePrecision | IN | IN |
| A/totalTokens | IN | IN |
| A/cacheHitRate | **OUT** | OUT |
| B/lineRecall | IN | IN |
| B/linePrecision | IN | IN |
| B/totalTokens | IN | IN |
| B/cacheHitRate | IN | IN |
| C/lineRecall | IN | **OUT** |
| C/linePrecision | IN | IN |
| C/totalTokens | IN | IN |
| C/cacheHitRate | **OUT** | OUT |
| D/lineRecall | IN | IN |
| D/linePrecision | IN | IN |
| D/totalTokens | IN | IN |
| D/cacheHitRate | **OUT** | OUT |
| E/lineRecall | IN | IN |
| E/linePrecision | IN | IN |
| E/totalTokens | IN | IN |
| E/cacheHitRate | **OUT** | OUT |

### 5.2 配对符号检验（噪声对照在场时为主判据）

| metric | pairs | worse/better/ties | p(更差方向) | 判定 |
|---|---|---|---|---|
| lineRecall | 178 | 118/60/272 | <0.0001 | **FAIL** |
| linePrecision | 80 | 42/38/93 | 0.3688 | PASS |
| totalTokens | 450 | 238/212/0 | 0.1193 | PASS |
| cacheHitRate | 449 | 361/88/1 | <0.0001 | **FAIL** |

时点配对：candidate-baseline **221h** / noise-baseline 1h（阈值 48h，**超阈预警**）。

advisories（门原文）：
- 协议修订可见：C/lineRecall 遗留单侧带判 OUT、对称带判 IN（#30 噪声底修订）
- 时点配对预警：candidate-baseline 221.0h、noise-baseline 1.0h > 48h——跨日部署漂移可能同时进入两侧对照（#30 §4.2/§4.3）

### 5.3 FAIL 语义分解（不粉饰，也不误读）

- **lineRecall FAIL**：pi 逐单元 recall 与基线之差显著大于 POC1 重跑噪声底自身之差。符号检验只看幅度不看方向——主表方向读数（§6）：pi recall 全线更高（C 差 4 倍）。**这是 recall 形态的内核分歧实证，不是劣化**。
- **cacheHitRate FAIL + 4 格 OUT（A/C/D/E）**：两层成因——(a) 网关前缀门时段漂移（基线 2026-09-12–14 vs pi 2026-09-23–25，时点 221h 超阈；#18 已收口：网关策略随时段变，跑前探针留痕「门参数时段漂移」）；(b) pi 序列化方言（§7.3）。两者在现有数据下无法完全分解（§12 U1）。
- **totalTokens PASS / linePrecision PASS**：token 账面与 precision 形态在配对意义上对齐——pi 的 token 优势（更低）幅度未超噪声底量级。
- 门定位：ADR-0007 对齐门验证「同协议同案上两内核产出可对照数据」，FAIL = 形态分歧的正式记录。与 DSH 线附录门（DSH 内核 vs POC1 基线，totalTokens FAIL；DSH 线 ADR-0007 第三轮）对照：**两个新内核对 POC1 呈现不同差异面——DSH 内核差异集中 token，pi 内核差异集中 recall 形态 + 缓存**。这本身是「内核是大变量」的第三组证据。

## 6. 九维度主表（judge 口径每配置 90 单元均值；行 = config × 侧）

| config | side | lineRecall | linePrecision | lineF1 | totalTokens | cacheHitRate | rie | carc | toolCalls | rounds |
|---|---|---|---|---|---|---|---|---|---|---|
| A | **pi** | 0.5547 | 0.7478 | 0.5868 | 25.8k | 0.0747 | 0.0226 | 24.5k | 0 | 1 |
| A | main | 0.5008 | 0.7232 | 0.5524 | 22.6k | 0.3678 | 0.0242 | 18.4k | 0 | 1.01 |
| A | noise | 0.4776 | 0.7546 | 0.5685 | 20.5k | 0.3711 | 0.0281 | 16.5k | 0 | 1 |
| A | dsh | 0.4786 | 0.763 | 0.5507 | 21.4k | 0.3701 | 0.0264 | 17.3k | 0 | 1.01 |
| B | **pi** | 0.4937 | 0.7131 | 0.5571 | 59.5k | 0.734 | 0.0078 | 30.9k | 0 | 1.02 |
| B | main | 0.4671 | 0.7835 | 0.5763 | 49.9k | 0.8114 | 0.0105 | 19.8k | 0 | 1 |
| B | noise | 0.4202 | 0.7397 | 0.5286 | 50.6k | 0.7832 | 0.0087 | 21.0k | 0 | 1.01 |
| B | dsh | 0.4217 | 0.741 | 0.5468 | 49.4k | 0.7919 | 0.0096 | 19.9k | 0 | 1 |
| C | **pi** | **0.5393** | 0.6585 | 0.5696 | 368.0k | 0.8322 | 0.0014 | 71.3k | 6 | 1.19 |
| C | main | 0.1341 | 0.6349 | 0.5712 | 706.5k | 0.9249 | 0.0014 | 105.1k | 6 | 3.3 |
| C | noise | 0.2162 | 0.7069 | 0.6326 | 618.3k | 0.9148 | 0.0017 | 96.3k | 6 | 2.92 |
| C | dsh | 0.2828 | 0.6083 | 0.5657 | 675.6k | 0.911 | 0.0011 | 93.6k | 6 | 2.2 |
| D | **pi** | 0.5789 | 0.6087 | 0.5581 | 126.1k | 0.6014 | 0.0043 | 54.0k | 6 | 1.04 |
| D | main | 0.2916 | 0.7226 | 0.6257 | 178.0k | 0.7769 | 0.0055 | 60.5k | 6 | 2.32 |
| D | noise | 0.2364 | 0.6667 | 0.5797 | 223.4k | 0.7845 | 0.0063 | 69.2k | 6 | 2.7 |
| D | dsh | 0.3403 | 0.666 | 0.5993 | 226.1k | 0.7964 | 0.0049 | 66.0k | 6 | 1.82 |
| E | **pi** | **0.5962** | 0.6184 | 0.557 | 125.2k | 0.6048 | 0.004 | 56.3k | 6 | 1.02 |
| E | main | 0.2355 | 0.569 | 0.5196 | 204.6k | 0.7981 | 0.0049 | 63.1k | 6 | 2.57 |
| E | noise | 0.2325 | 0.7075 | 0.6243 | 213.8k | 0.7965 | 0.0055 | 66.5k | 6 | 2.7 |
| E | dsh | 0.2893 | 0.6504 | 0.5387 | 255.7k | 0.797 | 0.0039 | 71.9k | 6 | 2.03 |

（配置定义与 DSH 报告 §5.1 同款：A/B 零工具，B = A + Diff→Symbol→Reference→Call Chain 固定管线预取；C/D/E 同一套 7 个 review.* 工具——C 全仓注入 / D 自主拉取+稳定前缀 / E = D + Context Ledger 账本。）

读数要点（S1 §4 叙事的全量版）：

- **A（零工具）四侧大体同构**：recall 0.55/0.50/0.48/0.48、RIE 0.0226/0.0242/0.0281/0.0264、token 25.8k/22.6k/20.5k/21.4k——内核不是变量的正面证据，增强对 C/D/E 侧差异归因于内核的信心。
- **C 反转守住（#17 R2 收口）**：pi 0.5393 vs main 0.1341 / noise 0.2162 / dsh 0.2828——三个非 pi 内核侧同为塌缩形态。「全仓注入边际收益为负」（DSH 线报告 §5.4）在 pi 内核下不成立，该结论是**内核条件性**的。
- **E−D 账本增量（#17 R3）**：judge recall +1.7pp（0.5962 vs 0.5789）；热口径 token +14%（129.5k vs 113.4k，rule rep2+，见 §8）——方向为正、幅度小，**案集敏感限定维持**（S1 三口径三方向教训，§12 U3）。
- **轮次分歧**：pi C/D/E 1.19/1.04/1.02 vs main 3.30/2.32/2.57、dsh 2.20/1.82/2.03——pi 单轮直驱形态（S1 六阶段一轮直驱观察的全量确认）。

## 7. 内核效应单列（issue #11 指定单列口径）

### 7.1 recall 形态与产出密度（全线差异，非 POC1 特有）

| 侧 | runCount | judged | skipped-no-findings | error | 零 finding 率 |
|---|---|---|---|---|---|
| **pi** | 450 | 426 | 24 | 0 | **5.3%** |
| main | 450 | 263 | 187 | 0 | 41.6% |
| noise | 450 | 252 | 198 | 0 | 44.0% |
| dsh | 450 | 291 | 159 | 0 | 35.3% |

pi 内核在该评测集上 finding 产出密度显著更高（5.3% vs 35.3–44.0%），**含 DSH 内核侧在内全线成立**——是 C/D/E recall 分歧的底层（S1 §4「产出密度是全线差异的底层」的全量确认）。

### 7.2 循环结构（rounds / token）

pi C/D/E rounds ~1.0–1.2 vs main 2.3–3.3 / dsh 1.8–2.2（§6）；C totalTokens 368.0k vs main 706.5k / dsh 675.6k。pi 的评审循环更早收敛，且收敛伴随更高 recall——形态差异不是单纯更快，是行为模式不同。

### 7.3 序列化方言（C/D/E 差异的机制底座；S1 §6 实测，全量表为其聚合投影）

- **思考链回传**：pi-ai 将 DeepSeek 思考链以 `reasoning_content` 字段随 assistant 消息回传后续请求（wire 字节 ~6× 膨胀；火山网关 tokenize 跳过该字段——零 token 成本，#18 三方对账收口）。DSH 线 wire 契约无该字段（POC1 契约注记）。
- **请求数由 agent 行为驱动**：S1 3 案实测 pi C/D/E 请求数 = 10/18/9 vs POC1 15/15/34——「语义一致而非字节一致」的内核效应面（DSH 线 ADR Tier 2 预定）；全量聚合投影即 §6 rounds 分歧。
- **缓存命中的 pi−基线差**（D/E 热口径 −17~−19pp，§8）混合网关时段效应与方言效应，现有数据下不可完全分解（§12 U1）。

## 8. 冷热分层（rule 口径；rep1 冷单列 vs rep2+ 热主口径）

| config | side | 冷 cacheHit | 热 cacheHit | 冷 tokens | 热 tokens |
|---|---|---|---|---|---|
| A | **pi** | 0.0705 | 0.0768 | 26.2k | 25.6k |
| A | main | 0.3563 | 0.3736 | 24.4k | 21.7k |
| A | noise | 0.3047 | 0.4043 | 18.9k | 21.3k |
| A | dsh | 0.2937 | 0.4084 | 20.1k | 22.1k |
| B | **pi** | 0.6857 | 0.7581 | 62.0k | 58.3k |
| B | main | 0.6779 | 0.8782 | 50.5k | 49.6k |
| B | noise | 0.6258 | 0.862 | 49.1k | 51.3k |
| B | dsh | 0.6612 | 0.8572 | 48.4k | 49.8k |
| C | **pi** | 0.7846 | 0.856 | 356.2k | 373.9k |
| C | main | 0.8908 | 0.942 | 738.0k | 690.7k |
| C | noise | 0.8616 | 0.9414 | 646.3k | 604.4k |
| C | dsh | 0.8401 | 0.9464 | 499.7k | 763.6k |
| D | **pi** | 0.5919 | 0.6062 | 151.4k | 113.4k |
| D | main | 0.7889 | 0.7708 | 180.4k | 176.9k |
| D | noise | 0.7784 | 0.7875 | 234.4k | 217.9k |
| D | dsh | 0.7916 | 0.7988 | 223.9k | 227.3k |
| E | **pi** | 0.6018 | 0.6062 | 116.5k | 129.5k |
| E | main | 0.803 | 0.7957 | 189.0k | 212.4k |
| E | noise | 0.8085 | 0.7906 | 260.6k | 190.3k |
| E | dsh | 0.7639 | 0.8135 | 185.6k | 290.7k |

- **A/pi 冷热同低（0.0705 / 0.0768）**——A 缓存低是**结构性**的（网关前缀门 × 六阶段小请求，#18 结论在冷热维度复核成立）；对照 main/dsh A 热 0.37–0.41。
- B–E 四侧均有正常 warm-up（冷 < 热）；pi 热口径 cacheHit 系统性低于 main/dsh 5–19pp（D/E 最大）。
- 判级锚与 §6 E−D 热口径 token 读数（129.5k vs 113.4k）出自本面热列（judge 口径 totalTokens 不分冷热，两口径各自成立）。

## 9. 跨 rep σ 与跨侧极差（两个口径，分开引用）

### 9.1 跨 rep σ（#36 误差棒口径：按 (case,config) 分组 3-rep 样本 σ、null 剔除、≥2 有效 rep、对 30 案取均值；rule 口径）

| config/metric | pi | main |
|---|---|---|
| A/lineRecall | 0.0841 | 0.1842 |
| A/linePrecision | 0.1727 | 0.2824 |
| A/totalTokens | 4.6k | 6.2k |
| A/cacheHitRate | 0.0334 | 0.13 |
| B/lineRecall | 0.1277 | 0.1034 |
| B/linePrecision | 0.1713 | 0.2156 |
| B/totalTokens | 7.0k | 7.7k |
| B/cacheHitRate | 0.065 | 0.1283 |
| C/lineRecall | 0.0952 | 0.0337 |
| C/linePrecision | 0.1719 | 0.0776 |
| C/totalTokens | 129.9k | 287.4k |
| C/cacheHitRate | 0.0616 | 0.0381 |
| D/lineRecall | 0.1501 | 0.1055 |
| D/linePrecision | 0.1616 | 0.1964 |
| D/totalTokens | 43.9k | 110.8k |
| D/cacheHitRate | 0.075 | 0.0781 |
| E/lineRecall | 0.0917 | 0.0889 |
| E/linePrecision | 0.1294 | 0.1218 |
| E/totalTokens | 34.8k | 124.2k |
| E/cacheHitRate | 0.06 | 0.068 |

注记：main C/lineRecall σ 0.0337 < pi 0.0952，但 main C 是塌缩形态（41.6% 零 finding 固定 0 拉低 σ）——**塌缩格的 σ 天然低，跨侧 σ 对比在塌缩格上不可直接解读为「更稳定」**（§12 U5）。pi C/totalTokens σ 129.9k < main 287.4k，与轮次更少、行为更收敛一致。

### 9.2 跨侧极差（四侧 max−min；描述性统计，不做检验；任一侧缺失 → —）

| config | lineRecall | linePrecision | lineF1 | totalTokens | cacheHitRate | rie | carc | toolCalls | rounds |
|---|---|---|---|---|---|---|---|---|---|
| A | 0.0771 | 0.0398 | 0.0361 | 5.3k | 0.2964 | 0.0055 | 8.1k | 0 | 0.0111 |
| B | 0.0734 | 0.0705 | 0.0477 | 10.2k | 0.0774 | 0.0027 | 11.0k | 0 | 0.0222 |
| C | **0.4052** | 0.0986 | 0.0669 | 338.5k | 0.0927 | 0.0005 | 33.9k | 0 | 2.1111 |
| D | 0.3424 | 0.1139 | 0.0676 | 100.0k | 0.195 | 0.002 | 15.2k | 0 | 1.6556 |
| E | 0.3636 | 0.1385 | 0.1047 | 130.5k | 0.1933 | 0.0016 | 15.5k | 0 | 1.6778 |

C lineRecall 极差 0.4052 为九维度最大单格——内核效应幅度的直观呈现。A 行在 9 维中 5 维极差最小（linePrecision/lineF1/totalTokens/carc/rounds，toolCalls 并列 0）——与 §6 A 同构读数一致；两个例外：cacheHitRate 极差 0.2964 为五配置最大（网关时段 + 前缀门效应，U1），rie 极差 0.0055 亦最大但属量级效应（A 的 rie 水平本身高一个量级，见 §6 A 行四侧 0.0226–0.0281）。lineRecall 极差最小者是 B（0.0734）。

## 10. 预算总账（双口径 + cacheRead 单列）

| 侧 | billed | withCache | cacheRead（单列） | judge 信封上界 |
|---|---|---|---|---|
| **pi** | **21.32M** | **63.42M** | 42.09M | 13.96M |
| main | 24.03M | 104.55M | 80.52M | 8.62M |
| noise | 24.25M | 101.39M | 77.14M | 8.26M |
| dsh | 24.18M | 110.54M | 86.36M | 9.54M |

（billed = input + output；withCache = + cacheReadTokens——ADR-0009 Consequences：报告单列 cacheReadTokens，不与质量结论混排。judge 信封上界 = judgedCount × 32,768，#39 glm 系推理模型 completion 上界；judge 链为仪器成本未入被测账，与 DSH 报告口径一致。）

pi 侧 billed 21.32M 与 withCache 63.42M 均为四侧最低——更低 token 账（§6）与更低缓存命中的净效果仍是总账最低。pi 运行事件账（中断/恢复/双跑浪费 ~9M 网关侧额外消耗，未计入 record 总账）见 `runs/phase2-pi/REPORT.md`（该留痕已随运行产物清理，不入库）。

## 11. 执行窗

| 侧 | 首 | 末 |
|---|---|---|
| **pi** | 2026-09-23T06:52:42Z | 2026-09-25T13:01:38Z |
| main | 2026-09-12T11:14:53Z | 2026-09-14T01:55:21Z |
| noise | 2026-09-14T02:53:38Z | 2026-09-14T17:18:04Z |
| dsh | 2026-09-14T18:04:46Z | 2026-09-15T02:02:56Z |

pi 与基线相隔 9 天（门时点口径 221h，超 48h 阈值）——§5 cacheHitRate FAIL 与 §12 U1 的时段限定即源于此。noise 与 main 相邻 1h（门基线-噪声底自洽性的时点前提，DSH 线 #36）。

## 12. 不确定性陈述（诚实清单）

- **U1 时点 221h 超阈**：pi 与基线相隔 9 天，网关前缀缓存策略随时段变已实证（#18 三时点探针 + #17 跑前探针留痕「门参数时段漂移」）——**cacheHitRate 的全部跨侧对比（§5.2 FAIL、§6 cache 列、§8、§9.2 A 行）必须带时段限定**，不能全归因内核。pi−基线缓存差（−17~−19pp）中网关时段效应与序列化方言效应（§7.3）不可分解。
- **U2 门方向盲**：配对符号检验判幅度不判方向；lineRecall FAIL 的方向读数来自 §6 主表（pi 更高），不是门输出。门的 FAIL/IN/OUT 语义是「形态对齐」不是「质量优劣」。
- **U3 案集敏感**：E−D +1.7pp 幅度小；S1 曾三口径三方向（pi-s1 强正 / dsh-s1 正 / DSH 全量负）。全量 n=90/配置已是最强证据，但方向结论仍带案集限定。
- **U4 judge 仪器**：glm-5.3 判定链四侧同链同口径，但 judge 口径的绝对值不可独立验证——46 份人工抽检表单（`runs/phase2-pi/human-review/forms.json`，humanReviewRate 0.1）**待执行**，是 judge 口径的外部校准层，也是本报告判级与 recall 读数的最大未闭合不确定性。
- **U5 σ 解读限定**：塌缩格（main C）σ 天然低（零 finding 固定 0），§9.1 跨侧 σ 对比在塌缩格上不可直接解读。
- **U6 判级敏感**：B 的 S 档 recall 判负余量 −4.8pp，与锚 C 跨 rep σ（0.0952，§9.1）同量级——判级对锚波动敏感；B=B 不是对「B 稳健非 S」的强断言。
- **U7 锚口径单一**：判级锚 = C rep2+ 热口径 rule 口径（spec user story 29）；judge 口径下 C recall 0.5393 并非 pi 侧最高（E 0.5962 / D 0.5789 / A 0.5547 更高）。锚选择是协议决定，判级语义依赖该选择。
- **U8 n<3 护栏未触发**：四侧全部格子样本充足（90/配置、450/侧），门无 INSUFFICIENT_SAMPLE 判定；本报告不涉及小样护栏情形。

## 13. 结论分级（可引用性）

**正式可引用**：

1. **pi 独立判级**：A=B、B=B、C=BELOW_B（机制性，非质量缺陷）、D=B、E=B——锚可用（0.2468）条件下的独立产出，与 DSH 三侧判级（B=S 锚塌缩产物）不可直接互比。
2. **对齐门判定 FAIL**：16 IN / 4 OUT（OUT = A/C/D/E cacheHitRate）；linePrecision / totalTokens PASS、lineRecall / cacheHitRate FAIL——pi 与 POC1 基线形态分歧的正式记录；与 DSH 内核侧差异面不同（token vs recall 形态+缓存），「内核是大变量」的第三组证据。
3. **C 反转守住**：pi C judge recall 0.5393，三个非 pi 内核侧 0.1341 / 0.2162 / 0.2828 同为塌缩形态——「全仓注入边际收益为负」是内核条件性结论，不迁移到 pi 内核（S1 R2 正式收口）。
4. **产出密度全线差异**：pi 零 finding 率 5.3% vs 35.3–44.0%（含 DSH 内核侧）。
5. **token 形态对齐 + 总账最低**：totalTokens 配对 PASS；pi billed 21.32M / withCache 63.42M 四侧最低。

**带限定可引用**：

- cache 列全部对比（时段限定 U1）；
- E−D 小正增益（案集敏感 U3）；
- 跨 rep σ 对比（塌缩格限定 U5）；
- 轮次/请求数差异（语义一致而非字节一致，Tier 2 内核效应面）。

**advisory（描述性，不做检验结论）**：

- 跨侧极差（§9.2）；
- DSH 三侧 B=S 判级（锚塌缩产物，不迁移、不引用为质量证据）。

## 14. 来源与产物索引

- pi 侧数据：`runs/phase2-pi/`（#17 全量真跑；运行留痕 `runs/phase2-pi/REPORT.md` 已随运行产物清理，数据 gitignored）
- 三侧 DSH 线数据：本仓 `runs/phase2-{main,noise,dsh}/` P0 迁移拷贝（md5 与 DSH 仓原位一致）；原仓 `MustacheXb/ReviewAgent` 同名目录
- 门与复算：`scripts/run-alignment-gate.ts`（门 CLI）→ `.cache/gate-phase2-pi.json`（判定锚点）；`scripts/analyze-p5b.ts`（本报告全部表格源）+ `src/experiment/p5b-compare.ts`（可测计算，12 单测）
- 协议：`deepseek-v4-flash` @ REVIEWER_URL 网关 / verifier off / judge `glm-5-3-260814` 经 review-llm / humanReviewRate 0.1 / seed `poc1-human-review-2026` / kernel=pi——与 DSH 线 `phase2-main` 逐字段一致
- 章节对齐：DSH 线报告 §3.3（锚塌缩）/ §5.1（九维度）——跨仓限定语纪律：DSH 线口径；本仓 S1 报告《Phase 2 pi-S1 五配置对照报告》（advisory 前置，其 §7 风险表 R1–R4 在本报告全部收口）
