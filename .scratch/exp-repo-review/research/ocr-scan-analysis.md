# OCR 全仓扫描（`ocr scan`）对照分析

> 研究日期：2026-11-24
> 源码：`D:\Project\open-code-review`（以当前工作区为准）
> 目的：为 `exp-repo-review` 的 R-01 / R-02 / R-03 / R-04 / R-06 提供设计输入
> 一句话结论：**可学习它的确定性筛选、单文件会话、预算护栏、失败开放与断点续跑；不能照搬它的「整文件塞入 + 每文件固定 7 轮 + 超大文件直接跳过 + 批间串行 + 无覆盖账本」。**

---

## 1. 事实基线（源码核对）

### 1.1 流水线

```text
ocr scan
  → git ls-files（tracked + untracked，完整 .gitignore 语义；非 git 目录则 Walk）
  → Lstat / 2 MiB 字节上限 / 8 KB 二进制嗅探 / 读取整文件内容
  → 确定性过滤：binary / secret / user exclude / user include / 扩展名白名单 / 默认排除路径
  → token 过滤：文件 tokens > 80% × MAX_TOKENS 则跳过（不切块）
  → 预估算（粗粒度）
  → 分批：默认 by-language，50 文件/批
  → 批次串行；批内并发（默认 8）；每文件一个子任务
       → 可选 PLAN_TASK（大文件）→ MAIN_TASK 工具循环 → code_comment
  → 每批结束：可选 DEDUP_TASK（≥4 条评论）
  → 全部结束：可选 PROJECT_SUMMARY_TASK
  → session finalize
```

### 1.2 关键常量（`internal/config/template/scan_template.json`）

| 常量 | 值 | 含义 |
|---|---:|---|
| `MAX_TOKENS` | 58,888 | 单文件会话的上下文上限 |
| `MAX_COMPLETION_TOKENS` | 16,384 | 单次补全上限 |
| `MAX_TOOL_REQUEST_TIMES` | 60 | 单文件工具轮次上限 |
| `MAX_FILE_SIZE_BYTES` | 2 MiB | 内存保护上限 |
| `BATCH_STRATEGY` | `by-language` | 批分组键 |
| `BATCH_SIZE` | 50 | 每批文件数 |
| `PLAN_MODE_LINE_THRESHOLD` | 200 | 达到行数才跑 PLAN_TASK |
| `DEDUP_MIN_COMMENTS` | 4 | 批内去重触发门槛 |
| 并发 | 8 | `--concurrency`，批内 |
| 单任务超时 | 15 min | `--timeout` |
| 压缩阈值 | 60% 异步 / 80% 同步 | `internal/llmloop/compression.go` |
| 连续空轮上限 | 3 | `internal/llmloop/loop.go` |

> 注：`docs/analysis/ocr-architecture-and-review-pipeline.zh-CN.md` §12 写 `PLAN_MODE_LINE_THRESHOLD = 50`，与当前 `scan_template.json` 的 **200** 不一致；以源码 JSON 为准。

### 1.3 关键源码

| 主题 | 位置 |
|---|---|
| 全仓编排 / 选择 / 派发 / 预算门 | `internal/scan/agent.go` |
| 分批策略 | `internal/scan/batch.go` |
| 成本估算 | `internal/scan/estimate.go` |
| 文件枚举与读取 | `internal/scan/provider.go` |
| 预览（零模型） | `internal/scan/preview.go` |
| 扫描提示词 | `internal/config/template/scan_template.json` |
| CLI 装配 | `cmd/opencodereview/scan_cmd.go` |
| 工具循环 / 压缩 / 宽限轮 | `internal/reviewtask/task.go`、`internal/llmloop/*` |
| 行号解析（整文件） | `internal/model/scan.go`（`AsDiff` 注入 `NewFileContent`） |

---

## 2. 可学习的设计（按价值排序）

### 2.1 确定性筛选是一等公民，且有零模型预览

- 过滤顺序固定：binary → secret → user exclude → user include → 扩展名 → 默认排除路径 → 体积 → token。
- 每个被排除文件都有**稳定原因**；`--preview` 走与真实运行完全相同的选择逻辑，不创建 session、不发模型请求。
- 值得直接采用：我们的 R-02 应输出同样的「文件 → 可检视 / 跳过原因」账本，并先做 `--preview` 等价物。

### 2.2 单文件会话 + 整文件在提示词里

- 一个文件一个独立对话；整文件内容放首条 user 消息，后续轮次只追加工具结果。
- 明确要求：**不要 `file_read` 再读当前文件**；每个 finding 最多 2–3 次上下文工具；能批量就一次 `code_comment`；没有新问题立即 `task_done`。
- 好处：上下文以文件大小为界，不会随仓库规模膨胀；工具只用于跨文件补充。
- 值得采用：我们按 unit（文件 / 函数块）建会话；整块内容进稳定前缀；工具纪律写进 system prompt。

### 2.3 规则按文件解析，只注入相关部分

- `SystemRule.Resolve(path)` 按文件路径取规则，而不是把全量规则塞给每个文件。
- 这是低成本的 token 优化，也减少无关规则干扰。
- 我们已有规则 Skill，但需要补「按文件 / 模块选择规则子集」的确定性路由。

### 2.4 大文件先做轻量 Plan

- 文件 ≥ 200 行且启用时，先跑一次 `PLAN_TASK`：只输出 summary + ≤5 个 checkpoints（focus / lines / why），不调工具。
- Plan 失败 fail-open，用 `(no pre-scan plan...)` 哨兵继续主任务。
- 价值：用一次小调用换取主循环的注意力聚焦；成本约为该文件主循环的 1/7。
- 注意：**OCR 没有给出 Plan on/off 的准确率 A/B 证据**。我们必须自己测，不能默认它有效。

### 2.5 预算护栏：预估算 + 逐文件前瞻 + 部分结果

- 运行前粗略估算：`(fileTokens + 2,000) × 7 轮 + 700 × 7`，加上 plan / dedup / summary。
- 派发前逐文件检查：`已用 + 下一文件估算 > budget` 就停止后续派发；在飞任务仍跑完。
- 命中预算时仍发布部分结果，退出码通常为 0；只有全部选中文件都失败才非 0。
- 值得采用：预算命中必须**显式留痕 + 覆盖损失报告**，不能静默。

### 2.6 全线 fail-open

- Plan 失败 → 无 Plan 继续；Dedup 失败 / JSON 不合法 → 保留原始评论；Summary 失败 → 跳过；行号重定位失败 → 保留原定位。
- 单一辅助阶段失败不吞掉整次扫描。
- 值得采用，但要补一条：**fail-open 的每一步都要进审计**，否则「没降级」和「降级了但没记录」无法区分。

### 2.7 断点续跑与批内检查点

- 每文件指纹 = `review_mode + path + content` 的 SHA-256；resume 直接复用已完成的评论。
- 每批去重后记录 checkpoint；同文件组用 canonical 结果，跨文件组保留每个文件的原始评论，避免一个文件失效抹掉另一个文件的发现。
- 局限：指纹**不包含配置、规则、模型、提示词版本**，换规则或换模型仍会复用旧结果。我们的 R-07 必须补全依赖哈希。

### 2.8 并发原语

- 批内信号量 + 每文件 goroutine + 每文件超时 + 失败隔离；全失败才整体报错。
- 评论后处理另有 worker pool，批结束前 `Await`，保证去重输入完整。
- 结果按批/文件路径归组，不依赖完成顺序。
- 可复用：我们的 `runPasses` 已有「有界并行 + 结果按片序返回 + 片级回调串行」的成熟实现，直接迁移到 scan 的 unit 执行即可。

### 2.9 提示词缓存亲和

- 每个任务会话用 `SessionTaskKey(session, task, path)` 作为缓存亲和键；批次按语言聚合，让同语言文件在时间上相邻。
- 值得采用：缓存命中率要作为一等指标记录（cache read / write tokens），否则无法判断「整文件多轮」是否真的省钱。

---

## 3. 局限与不能照搬

| OCR 的做法 | 后果 | 我们的做法 |
|---|---|---|
| 文件 tokens > 80% 上限就**整文件跳过** | 大文件 / 单体文件零覆盖，而真实缺陷常在大文件 | 按符号 / 函数**切块**，带重叠；切块上限内优先高风险符号，其余标 `not-reached(budget)` |
| 每文件固定按 7 轮估算预算 | 3 轮完成的文件被高估（约 2.3×），20 轮的文件被低估；预算门可能过早停 | 按 tier 设轮次上限；用实际轮次分布校准；预算用「预留 + 释放」而非固定估算 |
| 批间串行 | 批尾 worker 空转；去重屏障等最慢文件；大批次尾延迟可达 10–20% | 全局 worker 池跨 unit 调度；去重 / 汇总放到 barrier 之后，独立阶段 |
| 去重只在批内 | 跨语言 / 跨目录的重复发现残留 | 确定性同文件 ±N 行聚类 → 跨文件语义聚类（只对候选簇调模型） |
| scan 无 manifest / 覆盖账本 | 「审过没发现问题」与「根本没审」无法区分 | 复用覆盖账本：文件 × 区域 / 符号，三态 candidate / no-issue / not-reached(cause) |
| 枚举时把所有文件内容读进内存 | 大仓内存峰值高（`ScanItem.Content` 全量驻留） | 按 unit 惰性读取；枚举只保留路径与元数据 |
| resume 指纹不含配置 / 规则 / 模型 | 换规则或模型后复用陈旧结论 | 指纹 = 内容 + 规则 Skill + 配置 + 模型 + 提示词版本 |
| 没有增量扫描 | 每次全量重扫 | 内容哈希 + 依赖哈希的 unit 缓存 |
| 整文件多轮依赖 prompt cache | 网关不支持缓存时成本爆炸 | 分层：低风险 unit 单轮结构化；仅高风险 / 有候选的 unit 多轮 |
| 规则只注入，不核对是否执行 | 模型可能整段忽略规则 | 规则 → 检查项回执（checked / no-issue / candidate），进覆盖账本 |

---

## 4. 我们的方案建议

### 4.1 准确率优先

1. **覆盖账本从 diff 扩展到全仓**：分母 = 文件 × 区域（函数 / 类 / 顶层块）。每个区域必须有 `candidate` / `no-issue` / `not-reached(cause)` 之一；不允许静默成功。
2. **大文件切块而不是跳过**：确定性符号大纲 → 按函数 / 类切块（带 3–5 行重叠）→ 每块独立检视 → 按符号合并。块数超上限时按风险排序，剩余标 `not-reached(budget)`。
3. **确定性上下文包（Context Pack）**：每个 unit 注入 2–4k tokens 的模块上下文——目录树、导出符号签名、直接调用方 / 被调用方、相关测试路径。这是全仓扫描相对单文件检视的最大增量，也比让模型自己 `code_search` 更省 token、更稳定。
4. **候选优先、验证其次**：每 unit 先做一次结构化扫描，输出 candidate 或显式 no-issue；只对 candidate 做证据核验 / 独立证伪。比开放式 7 轮探索更可控，也天然产生覆盖回执。
5. **证据门保持强制**：file / line / quote 至少一条可在 head 侧全文定位；纯中文描述不算代码证据。OCR 的行号滑窗 + LLM 重定位可以作为 fail-open 兜底，但不能替代确定性接地。
6. **全局去重**：先确定性聚类（同文件 ±2 行、同规则、同根因标题），再对跨文件候选簇做一次保守的语义合并；合并前后数量与成员进审计。

### 4.2 Token 节省

1. **分层检视（tiering）**：
   - T0 排除：二进制、生成物、vendor、lockfile、minified、超大非源码；原因入账。
   - T1 低风险：小文件 / 文档 / 配置 / 简单工具；单轮结构化输出 + 0–1 次工具。
   - T2 普通源码：2–3 轮，允许跨文件工具，候选回执。
   - T3 高风险：安全敏感路径、并发 / 序列化、公共 API、超大 / 高复杂度、近期高频变更；完整循环 + Plan + 证伪。
   - 每条 tier 规则必须确定性、可审计；准确率按 tier 分别验收，不能只看总量。
2. **单 unit 单会话 + 稳定前缀**：system prompt + 规则子集 + 上下文包 + unit 内容放前缀；工具结果只追加。记录 cache read / write tokens。
3. **轮次上限与早停**：按 tier 设 `maxRounds`；连续空轮、无候选、`task_done` 立即停。不要照搬固定 7 轮。
4. **Plan 只在需要时**：大文件 / 高复杂度才跑 Plan；普通文件用确定性符号大纲替代。Plan 的有效性必须用 A/B 证明。
5. **预算双阈值**：
   - 软阈值（如 70%）：把剩余低优先级 unit 降级为单轮或标 `not-reached(priority)`；
   - 硬阈值（100%）：停止派发，发布部分结果 + 覆盖损失报告。
   - 按确定性优先级顺序消耗预算，保证先砍低价值 unit，而不是像 OCR 按语言 / 目录顺序随机截断。
6. **惰性读取**：枚举只拿路径 / 大小 / 语言；执行到 unit 时才读内容，控制内存峰值。
7. **去重 / 汇总按需**：评论数低于门槛不调模型；项目总结默认关闭或仅在评论数 ≥ N 时生成。

### 4.3 并发

1. **全局 unit 调度器**，不做批间串行：固定 worker 池 + 优先级队列；review 阶段完全并行。
2. **阶段解耦**：`review（并行）→ barrier → dedup / merge / summary（按簇并行或串行）`。批只作为统计 / 缓存局部性的提示，不作为执行屏障。
3. **自适应并发**：按 429 / 5xx / p95 延迟做 AIMD 或令牌桶；每个 provider 独立限流；失败重试带抖动。
4. **确定性输出**：每个 unit 结果按 unit id 存放，合并时按 path / 行号排序；并发度 1 / 8 / 16 下结果集必须一致。
5. **故障隔离**：单 unit 超时 / 失败不影响其他 unit；全失败才整体失败；每 unit checkpoint 支持续跑。
6. **内存与背压**：worker 池大小与在飞 unit 的内容大小同时受限；大 unit 先切块再入队。

### 4.4 续跑与增量

- unit 指纹 = `content hash + rule skill hash + config hash + model id + prompt version`。
- 缓存按 unit 存「结论 + 覆盖回执 + 证据」；任一依赖变化即失效。
- 续跑报告 reused / rerun / skipped 数量与原因。

### 4.5 输出

- findings：file / line / severity / confidence / evidence / rule。
- tips：按文件 / 区域分组，不依赖「变更行」。
- 覆盖报告：文件数、区域数、candidate / no-issue / not-reached(by cause)、按 tier 的覆盖率。
- 项目总结：可选；默认确定性生成的统计摘要，LLM 总结仅在评论数达阈值时启用。
- 显式标记 `scan` 形态，不复用 MR 评论语义。

---

## 5. 量化模型（用于预算与验收）

### 5.1 单文件 token 估算

OCR 的估算公式（`internal/scan/estimate.go`）：

```text
main = (fileTokens + 2,000) × 7 + 700 × 7
plan = (fileTokens + 2,000) + 400   // 仅 ≥200 行且启用
```

| 文件 tokens | 无 Plan 估算 | 有 Plan 估算 | 实际 3 轮 | 估算/实际 |
|---:|---:|---:|---:|---:|
| 5,000 | 53,900 | 61,300 | 23,100 | 2.33× |
| 10,000 | 88,900 | 96,300 | 38,100 | 2.33× |
| 47,000（接近 80% 上限） | 347,900 | 355,300 | 149,100 | 2.33× |

结论：

- 固定 7 轮对「快速完成」的文件系统性高估，预算门会过早截断；
- 对「长尾多轮」文件则低估；
- 1,000 个 5k-token 文件的全仓成本约 **5,400 万 tokens**（无 Plan），必须靠分层、单轮化、缓存与增量把它压下来。

### 5.2 并发的批尾损失

50 文件/批、8 并发、平均单文件耗时 T：

- 理想批耗时 = 50T / 8 = 6.25T；
- 实际受最慢文件与批屏障影响，接近 7T；
- 20 批的批尾空转约 `(7−6.25)T × 20 = 15T`，相对 125T 约 **12%**；
- 文件耗时重尾时更差。全局 worker 池可以消掉这部分损失。

---

## 6. 实验与验收

### 6.1 准确率

- 全仓 GT（R-06）：VUL4J 快照 / 注入缺陷的全仓版本；冻结样本与仓库版本。
- 指标：P / R / B；按文件大小档（<200 / 200–1k / 1k–5k / 5k+ 行）、按 tier、按语言分别报告。
- 覆盖：`not-reached` 比例与原因分布；大文件切块覆盖率；规则回执覆盖率。
- 消融：Plan on/off；工具 0/2/5 次；切块 vs 跳过；分层 vs 不分层；确定性上下文包 on/off；全局去重 vs 批内去重。

### 6.2 Token

- tokens / file、tokens / finding、input/output 拆分、cache read/write、Plan 占比、去重占比。
- 轮次分布（p50/p90/max）；预算命中率与覆盖损失。
- 目标：在 B 不回退 >X pp 的前提下，tokens / file 比 OCR 基线低 Y%；先用 OCR 的公开行为做基线，再用我们自己的实现对照。

### 6.3 并发

- 墙钟 vs 并发度（1/4/8/16）；429 / 5xx 率；p95 单 unit 延迟。
- 并发度 1 与 8 的结果集必须一致（确定性）。
- 故障注入：单 unit 超时、单批失败、provider 限流。

### 6.4 回归门禁

- 同 token 预算下 recall 回退 ≤ 阈值；
- `not-reached(budget)` ≤ 阈值；
- 大文件（>5k 行）覆盖率 ≥ 阈值；
- 并发结果一致率 100%。

---

## 7. 对应 R 任务

| R 任务 | 从 OCR 吸收 | 我们的增量 |
|---|---|---|
| R-01 契约 | 输入 / 过滤 / 预览 / 预算 / 部分结果语义 | 覆盖账本、scan 形态标记、行锚点 |
| R-02 文件枚举 | `git ls-files` + untracked、二进制嗅探、2 MiB、排除原因、preview | 惰性读取、语言 / 风险分类、tier 初判 |
| R-03 分组预算 | 文件数 + 字符双上限、确定性排序、预算前瞻 | 符号切块、优先级队列、预算预留 / 降级 |
| R-04 执行 | 单 unit 会话、工具纪律、Plan、宽限轮、超时、失败隔离 | 全局 worker 池、候选回执、证据门、上下文包 |
| R-05 输出 | 评论 JSON、项目总结、warnings | 覆盖报告、tips 分组、scan 形态 |
| R-06 评测 | 预估算 / 实际用量口径 | 全仓 GT、分 tier / 文件大小档、消融 |
| R-07 增量 | resume 指纹 | 配置 / 规则 / 模型 / 提示词全依赖哈希 |
| R-08 合并 | —— | 共享文件最小化、group 原语后抽 |

---

## 8. 附：OCR 的关键取舍一句话

- **用确定性工程换 token 和稳定性**：选文件、分组、过滤、行号、预算都先确定性做，模型只做判断。
- **用整文件上下文换召回**：单文件全量入 prompt，跨文件靠工具。
- **用覆盖完整换精确率**：README 自己承认相对通用 Agent 是「召回换精确率」；scan 模式更偏向覆盖。
- **代价**：超大文件跳过、批间串行、批内去重、无覆盖账本、估算粗糙。

我们的目标不是复刻它，而是：**保留它的确定性骨架和失败开放，用覆盖账本、切块、分层、上下文包、全局调度和全依赖指纹，把准确率、token 与并发同时做上去。**
