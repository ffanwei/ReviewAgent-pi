# 0022. 停产 `reviews_zh.json`，中文交付物只留 `reviews_tips_zh.json`

**状态**：已接受（2026-10-30，用户要求「有 tips 就够了」）
**关联**：ADR-0010（英文产出 + 核外翻译投影）、ADR-0013（转录与意见导出产物族，本 ADR 收窄其 zh 一项）、ADR-0017（分组意见，本 ADR 把它升为唯一中文产物）、ADR-0021（呈现模型）
**跨仓**：本 ADR 为本仓 pi 线序列 0022；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

中文侧原本落两份文件（都只由 CLI 核外投影产出、同目录同 rep）：

| 文件 | 内容 | 消费方 |
|---|---|---|
| `reviews_zh.json` | `reviews_en.json` 信封 + 译好的 `title`/`description` + 投影留痕三键 | 人读 / 下游若要「完整中文 findings」 |
| `reviews_tips_zh.json` | 按文件分组的 10 键 tips（ADR-0017） | 人读 / 下游工单 |

实际使用中两份是**同一份投影的两种排版**，且交互消费方几乎只用 tips：

- tips 每条已经含 `review`（title。description）、`severity`、`category`、`lineNum`、`code`、`suggestion`、`source`、`ruleId`、`confidence`——够定位、够改；
- zh 的增量只有「全量 `evidence`、原始 `rule` 字符串、数值 `confidence`、runId 等信封字段」，需要这些的场合直接看 `reviews_en.json`（英文真源，恒产）或 stdout（已译）；
- 两份文件的生命周期要各维护一遍（写 / 陈旧清除 / 写失败判失败），成本常在。

## Decision

1. **不再写 `reviews_zh.json`**。CLI 的 zh 落盘块整段删除；`reviews-zh.ts` 只保留**陈旧清理**（`REVIEWS_ZH_FILENAME` + `removeStaleReviewsZh`），`buildReviewsZhExport` / `writeReviewsZh` 删除。
2. **投影本身照旧**。stdout 的 `findings` 仍是中文并带 `presentation` 留痕（`language` / `terminologyVersion` / `findingLinks`）——zh 文件停产不等于放弃留痕，留痕改由 stdout 承担。`reviews_tips_zh.json` 仍由同一次投影结果产出，**不为写文件多调网关**。
3. **陈旧 zh 一律清除（每次 run）**：不再区分「投影成功/降级」，因为本版本永远不产它。只动**本次 run 的 `rep-<N>/`**，绝不跨 rep；有遗留时 stderr 留一行人话。
4. **tips 的失败语义不变**（ADR-0017）：形状非法 ⇒ 无中文文件 + stderr 一行 + exit 0；**写盘 IO 失败 ⇒ exit 1**（产物即契约）；cwd 便捷副本失败 ⇒ 警告 + exit 0。
5. **`reviews_en.json` 不受影响**：仍是恒产英文真源、按 rep 覆盖重写。需要结构化中文（`evidence` / 原始 `rule` / 数值 `confidence`）时看 stdout。
6. **`reviews_zh.json` 只是停产，不是删除契约**：旧 run 里的文件不会被追溯删除（只清本次 rep），下游若依赖它需要自行迁移到 tips 或 stdout。

## Options（为什么不是别的）

- **保留 `reviews_zh.json`、只把 tips 当默认**：等于维持两份生命周期，正是本次要省掉的东西。
- **把 zh 的信封/留痕塞进 tips**：会破坏 ADR-0017 的「严格 10 键封闭」与「顶层严格 `{files}`」——下游按 10 键做校验的地方全部要改，收益只是少一次文件读取。放弃。
- **改成 `--no-zh` 之类的开关**：多一个旗标、多一条分支、多一组测试矩阵，而需求是「不需要这个文件」。放弃。
- **把 `evidence` 加进 tips 当第 11 键**：同上，破坏 10 键封闭；ADR-0017 的字段映射是下游契约。
- **顺手把 `suggestion` 改成本地规则生成**：与本次无关，且 tips 的 `suggestion` 口径（核外 LLM 生成）刚落地。放弃。

## Consequences

- **正**：
  - 中文产物从两份变一份，生命周期/陈旧清理/写失败判定都只剩一条路径；
  - 少一次 `writeFile` 与一份需要 gitignore 的文件（`runs/**` 本已忽略，但用户目录副本少一次机会）；
  - stdout 与文件不再可能「一个中文一个英文」地互相矛盾（只有 stdout 与 tips，且都由同一次投影产出）。
- **负/风险**：
  - **丢结构化中文**：`evidence`、原始 `rule`、数值 `confidence`、`runId/rep/model` 信封字段不再有中文文件承载；需要这些就落回 `reviews_en.json`（英文）。
  - **下游迁移**：任何解析 `reviews_zh.json` 的脚本需要改读 `reviews_tips_zh.json` 或 stdout 的 `presentation` 键。
  - **历史目录不一致**：同一个 `<out>` 里，旧 run 有 zh、新 run 没有——以「本次 run 的 rep 目录」为准。
- **中性**：不新增旗标/环境变量；检视请求字节、审计、RunRecord、`reviews_en.json` 零改动；exit code 契约不变。

## 验收标准

1. 配了引擎的 run：`rep-1/reviews_en.json` 存在、`rep-1/reviews_tips_zh.json` 存在、`rep-1/reviews_zh.json` **不存在**；stdout findings 中文且带 `presentation`（language / terminologyVersion / findingLinks）。
2. 未配引擎 / 投影降级：两份中文产物都不产，exit 0，stderr 有降级原因。
3. 预置陈旧 `reviews_zh.json` + `reviews_tips_zh.json`：本次 run 后两者都被清除，`reviews_en.json` 保留，stderr 各有一行。
4. tips 形状非法：无中文文件，exit 0，stdout 仍中文，stderr 有「本次未产分组意见」。
5. tips 写盘失败（路径被占成目录）：exit 1、stdout 干净、错误人话含 `reviews_tips_zh.json`。
6. 网关请求数不因本 ADR 变化（仍为六回合 + 投影自身的翻译/建议调用）。
