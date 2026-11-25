# 全仓检视实测：ReviewAgent-pi vs OpenCodeReview（OCR）

**状态**：定稿（数据已回填）
**分支**：`exp-repo-review`
**日期**：2026-11-24 / 2026-11-25
**跟踪**：`.scratch/exp-repo-review/map.md` · `R-06`
**方案说明**：[`全仓检视-方案说明.md`](全仓检视-方案说明.md) / `.pdf`

---

## 1. 目的

在同一个 Java 仓库快照上，用两种工具各自做一次**无 diff 全仓检视**，回答三个问题：

1. **耗时**：全仓跑完要多久？并发 5 时能否接受？
2. **Token**：总 token、未命中输入、输出、缓存命中各是多少？
3. **准确率**：产出中有多少是真问题？用模型做初步判定，并给出可复核的样例。

本文只报全仓结果，**不**把 iterF91 / AACR 的 MR 指标换算成全仓成绩。

---

## 2. 仓库与快照

| 项 | 值 |
|---|---|
| 仓库 | [`alibaba/spring-ai-alibaba`](https://github.com/alibaba/spring-ai-alibaba) |
| commit | `17e26ff6fe951d605771c1845229ca3edb043634`（`--depth 1`） |
| 总 Java | 1,607 文件 / 249,222 行 |
| 生产 Java（两工具共同检视面） | **1,390 文件 / 192,785 行** |
| 测试 Java（缺省排除） | 217 文件 / 56,437 行 |
| 快照 | `D:/Project/.repos/spring-ai-java-prod`（由上述 commit 的 `*.java` 去测试目录重建，独立 git 快照） |

选择理由：

- Java 为主，AACR-Bench 历史样本中出现过（`alibaba/spring-ai-alibaba`）；
- 生产代码约 19 万行，全 Java 约 25 万行，量级接近 30 万行目标；
- 有真实业务/框架代码（graph-core、agent-framework、admin、studio），不是纯夹具。

> 说明：用户目标是「30 万行左右业务代码」。本仓总 Java 24.9 万行；生产代码 19.3 万行。选择它而不是 30.9 万行的 Dubbo，是为了把单次全仓对照控制在可完成的时间内（OCR 侧文件数少 44%）。

---

## 3. 工具与配置

| 项 | ReviewAgent-pi | OCR |
|---|---|---|
| 版本 | `exp-repo-review@0380ed7` | `open-code-review v1.14.3 (f6379f71)` |
| 命令 | `review-pi repo-spike`（R-04 产品化前的探针） | `ocr scan` |
| 模型 | `deepseek-v4.1-flash`（同一网关） | `deepseek-v4.1-flash`（同一网关） |
| 并发 | 3 组（实测 3 组稳定；上限 5） | 分片 2 → 5 子任务（受总并发 5 约束） |
| 轮次 / 预检 | `--max-rounds 1`，工具尝试 15/20 次封顶 | `--no-plan`（跳过逐文件 PLAN） |
| 去重 / 总结 | 无（findings 合并去重） | 保留 DEDUP，`--no-summary` |
| 规则 | 未装载规则 Skill（裸检视） | 内置 `java.md` 等系统规则 |
| 分组 | `directory`，6 文件/组，60k 字符/组 | `by-language`，默认 50 文件/批 |
| 测试文件 | 缺省排除 | 缺省排除 |

> 两侧都做了成本控制：我方 1 轮、OCR 跳过 PLAN 与项目总结。OCR 保留 DEDUP 以给它最好的去重条件。

---

## 4. 方法

### 4.1 运行

- 同一快照、同一模型、同一时间窗；
- 我方先跑（并发 3）；OCR 分片推进：与并行阶段用并发 2，我方结束后余片用并发 5；任一时刻总并发 ≤ 5；
- 原始产物：
  - 我方：`D:/Project/.repos/out/full-ours/repo-spike-result.json` + `runs/*/runs/run.json`
  - OCR：`D:/Project/.repos/out/ocr-shards/merged.json` + `shard-*.json`
  - 判官：`D:/Project/.repos/out/judge-full-*.json`
- OCR 分片：按顶层模块切成 7 片（`admin-server-start` / `admin-server-core` /
  `admin-server-runtime` / `graph-core` / `agent-framework` / `examples` /
  `starters+studio+sandbox`），每片仍按语言 50 文件/批；总并发受 5 约束。

### 4.2 模型判官

对每条 finding / comment：

1. 取仓库文件头部 40 行（imports / 类声明）+ finding 行 ±30 行（OCR 取 `start_line`–`end_line`）；
2. 输入 finding 文本、证据、代码上下文；
3. 判定模型输出 `VALID` / `INVALID` / `UNCERTAIN`：
   - `VALID`：代码支持该断言，且修复能避免真实缺陷（bug / 安全 / 资源泄漏 / 数据丢失 / 并发危险 / 实质性误导）；
   - `INVALID`：风格、命名、格式、Javadoc 完整性、缺测试、推测性建议，或代码不支持；
   - `UNCERTAIN`：上下文不足但断言可信。
4. Precision = `VALID / (VALID + INVALID)`；`UNCERTAIN` 单列，不计入分母。

采样：按**严重级分层**轮转取样，我方取 100 条，OCR 取 150 条（若某档不足则全取）；同时报整体与分档 precision。

### 4.3 召回

本轮**不测召回**：全仓没有逐行 GT。合成缺陷注入的召回实验留到 R-06b；本文只报精度与可复核样例，避免把「没测」写成「召回高/低」。

---

## 5. 结果

### 5.1 规模与耗时

| 指标 | ReviewAgent-pi | OCR |
|---|---|---|
| 检视文件 | **1,378 / 1,390**（253/255 组；2 组被后台内存压力中止） | **1,388 / 1,390**（2 文件被默认路径规则排除） |
| 组 / 批 | 255 组（完成 253） | 7 片 / 31 批 |
| 墙钟 | **204 min（并发 3）** | **285 min 分片执行**（+36 min 等待空档 = 321 min 总跨度；1–3 片并发 2、4–7 片并发 4） |
| 失败组 | **0 失败**；2 组因宿主内存保护未完成 | **0 失败** |
| findings / comments | **1,331 条**（P0 3 / P1 170 / P2 998 / P3 160） | **3,561 条** |

> OCR 全量实测：1,388 文件 / 3,561 条 comments / 95.51M token（input 89.60M，output 5.91M，cache 79.31M，未命中 10.29M）/ 285 min 分片执行（另 36 min 等待空档）；折算约 68.8k token/文件、2.57 条/文件。

### 5.2 Token

| 指标 | ReviewAgent-pi | OCR |
|---|---|---|
| 未命中输入 | **5.58M** | **10.29M** |
| 缓存命中输入 | **56.90M** | **79.31M** |
| 输出 | **5.50M** | **5.91M** |
| 总 token（含缓存） | **67.97M** | **95.51M** |
| 每千行 token | **352.6k（总）/ 28.9k（未命中）** | **495.4k（总）/ 53.4k（未命中）** |

口径说明：

- 我方 `inputTokens` 是**未命中缓存**的输入；`cacheReadTokens` 单列。
- OCR `input_tokens` 含缓存命中，`cache_read_tokens` 单列；`total_tokens = input + output`。
- 为可比，表中同时给「未命中输入」与「总 token（含缓存）」；不要只拿 OCR 的 `total_tokens` 对比我方的 `inputTokens`。

### 5.3 准确性（模型判官）

| 指标 | ReviewAgent-pi | OCR |
|---|---|---|
| 抽样 | **100** | **150** |
| VALID | **68** | **79** |
| INVALID | **16** | **36** |
| UNCERTAIN | **16** | **35** |
| Precision（VALID / 已决） | **0.81** | **0.69** |

### 5.4 可复核样例

校准组（10 个文件）的人工核对：

| 工具 | 文件:行 | 断言 | 核对 |
|---|---|---|---|
| 我方 | `CompileConfig.java:326` | 拷贝构造器漏拷 `recursionLimit`，派生配置递归上限静默重置为 100 | 代码中拷贝构造器逐字段赋值，确实没有 `recursionLimit`；真实 |
| 我方 | `CompileConfig.java:331` | 拷贝构造器共享同一个 `lifecycleListeners` 双端队列，派生配置污染原配置 | 构造器直接赋值引用；真实 |
| 我方 | `CompileConfig.java:286` | `withLifecycleListener` 用 `offer` 入有界队列，满 25 个后静默丢弃 | 需核对字段容量；字段为 `LinkedBlockingDeque` 容量常量，断言成立 |
| 我方 | `GraphResponse.java:56` | 无参构造器未初始化 `metadata`，元数据读写会 NPE | 无参构造器为空，三参构造器才赋值；真实 |
| 我方 | `HasMetadata.java:74` | `getMetadataAndRemove` 假定 `metadata()` 返回可变 Map，不可变实现会抛 `UnsupportedOperationException` | 默认方法直接 `m.remove`；真实 API 风险 |
| 我方 | `GraphRunner.java:59` | `resultValue()` 永远为空：continuation 使用了新的 `AtomicReference` | 需结合 `MainGraphExecutor` 核对；判官标 UNCERTAIN，保留待复核 |
| OCR | `GraphLifecycleListener.java:39` | Javadoc 缺 `@param config` | 事实成立，但属文档完整性；判官 INVALID |

> 结论：我方的 6 条中至少 5 条是真实代码缺陷；OCR 的 42 条中大量是 Javadoc / 风格类，模型判官判为 INVALID。

全量运行中的 P0/P1 样例（253 组）：

| 文件:行 | 断言 |
|---|---|
| `SandboxManager.java:137` | Python 沙箱 `allowAllAccess(true)`，用户脚本可越权访问宿主文件/进程/网络（已验证） |
| `AESCryptUtils.java:34` | AES 密钥硬编码为 `public static final`，可解密全部已存 API Key（已验证） |
| `RequestContextThreadPoolWrapper.java:236` | 使用 `ThreadPoolExecutor` 但未 import，server-core 无法编译（已验证） |
| `SqlTools.java:59` | `getSchema` 用字符串拼接表名执行 SQL，存在 SQL 注入 |
| `FileManager.java:154` | `getMediaTypeFromUrl` 对未校验的外部 URL 直接发起连接，存在 SSRF |
| `VoiceAgentAudioWebSocketHandler.java:147` | WebSocket 会话被多个响应式线程并发 `sendMessage`，未串行化 |
| `WorkflowAgentExecutor.java:43` | `execute/streamExecute` 返回 null，上游 `postHandle` 会 NPE |
| `BasicAgentExecutor.java:442` | 多模态 data URI 的 mimeType 解析与 base64 解码错误 |
| `AppComponentManager.java:158` | 取 START/End 节点直接 `get(0)`，缺失即 `IndexOutOfBoundsException` |

这些是可以在代码中逐条复核的实质缺陷，不是风格意见。

OCR 的 high/critical 也有真实缺陷（判官 VALID）：

| 文件:行 | 断言 |
|---|---|
| `GlobalExceptionHandler.java:154` | 异常处理把全部请求头（含 Authorization/Cookie/API-Key）与完整 body 写入日志，凭证泄漏 |
| `AgentSchemaController.java:85` | workspace ID 硬编码为 `"1"`，破坏多租户隔离 |
| `AppChatController.java:109` | `doOnNext` 在 `onErrorResume` 之前，错误回复不会发给 SSE 客户端 |
| `AppComponentController.java:504` | `getAppComponentByCode` 可能返回 null，后续直接解引用 |

> 两侧都能找到真实缺陷；差别在噪声比例与成本，而不是「一个能用一个不能用」。

---

## 6. 分析

### 6.1 精度分层：噪声集中在低严重级

我方全量（100 条，严重级分层）：

| 严重级 | VALID | INVALID | UNCERTAIN | Precision |
|---|---:|---:|---:|---:|
| P0 | 3 | 0 | 0 | 1.00 |
| P1 | 28 | 0 | 5 | 1.00 |
| P2 | 22 | 2 | 8 | 0.92 |
| P3 | 15 | 14 | 3 | 0.52 |
| **合计** | **68** | **16** | **16** | **0.81** |

OCR 全量（1,388 文件，150 条）：

| 严重级 | VALID | INVALID | UNCERTAIN | Precision |
|---|---:|---:|---:|---:|
| critical | 32 | 0 | 6 | 1.00 |
| high | 23 | 0 | 15 | 1.00 |
| medium | 17 | 10 | 10 | 0.63 |
| low | 7 | 26 | 4 | **0.21** |
| **合计** | **79** | **36** | **35** | **0.69** |

OCR 全量 3,561 条 comments 按严重级：low 1,012 / medium 1,736 / high 741 / critical 72；按类别：bug 2,114 / security 162 / maintainability 916 / documentation 147 / performance 151 / style 57。它不是只会报文档问题，但 low+medium 占 77%，低档噪声占比很大。

OCR 的高严重级断言并不弱：critical / high 两档在 150 条抽样中全部 VALID（55/55），包含「拷贝构造器漏 `recursionLimit`」「`GraphResponse` 无参构造器 `metadata` 为 null」「`GraphRunner.resultValue()` 引用错位」等我方也命中的真实缺陷。问题在**低严重级**：low 档 precision 只有 0.21，medium 0.63；low+medium 共 2,748 条（占 77%），把整体精度拉到 0.69。若消费方只取 high/critical，OCR 的 precision 为 1.00，但覆盖面收窄到 813 条。

我方的噪声同样集中在 P3：P0–P2 的已决样本 53/55 为 VALID（0.96），P3 只有 0.52。全量整体 0.81。产出密度 0.97 条/文件，低于 OCR 的 2.57 条/文件；若同样只取 P0–P2，我方 1,171 条（占 88%）、precision 0.96；OCR 只取 high/critical 是 813 条（占 23%）、precision 1.00。

### 6.2 Token 差异来自哪里

- 我方每组合成一份「全新增」diff，**整文件内容只进一次上下文**；六阶段共享同一前缀，缓存命中高。全量实测约 **49.3k token/文件**（含缓存）、**4.05k 未命中输入/文件**。
- OCR 每个文件独立 agent 循环，工具调用与关联文件读取重复进上下文；即使 `--no-plan`，全量实测约 **68.8k token/文件**、**7.41k 未命中输入/文件**。
- 差距不是数量级，而是约 **1.40x 总 token / 1.84x 未命中输入**；我方同时少产出约 2.7x 的 findings/comment。
- 我方组级候选门（Evidence Gate / 位置门）在写 findings 前拦截，减少输出与后续上下文；OCR 没有等价门，comment 直接落盘。

### 6.3 失败与超时

- 我方：253/255 组完成；最后 2 组（g036 / g118，各 6 文件）在收尾时被 Claude Code 的后台内存压力机制停止。这是**宿主资源保护**，不是模型超时或检视失败；按系统提示未自动重启，缺口 12 文件（0.9%）在 coverage 中标注。
- OCR：各 shard 均 `status=success`；DEDUP 在 shard 1 的第 4/7 批、shard 2 的第 2/4 批、shard 4 的第 1/2 批解析失败并保留原始 comments，因此 OCR 的 comment 数偏高。
- 两侧都没有出现模型超时导致的整组失败。

### 6.4 扩展性

- 两侧都是文件数线性；墙钟 ≈ 文件数 × 单文件成本 / 并发。
- 我方成本可按组预算（文件数 × 字符数 / 工具次数 / 轮次）显式封顶；OCR 的 `--max-tokens-budget` 是全局检查点，不能阻止单文件 agent 循环膨胀。
- 全仓并发上限受网关与工作集约束；本次实测我方 3 组 + OCR 2 子任务可稳定共存（总并发 5）。

---

## 7. 局限

- 单仓、单模型、单次运行；没有重复实验方差。
- 只测精度，不测召回。
- 我方是 `repo-spike` 探针，不是最终 `repo-review`；提示词仍是 MR 语义（合成「全新增」diff），会把既有问题说成「本次新增」，但不影响行锚点与缺陷判断。
- OCR 跳过了 PLAN 与 PROJECT_SUMMARY，结果不代表其默认全功能配置；DEDUP 在 shard 1 的第 4/7 批、shard 2 的第 2/4 批、shard 4 的第 1/2 批解析失败并保留原始 comments，可能抬高 OCR 的 comment 数与噪声。
- 模型判官与检视模型同源，存在同偏好偏差；样例需人工复核。
- 生产代码 19.3 万行，低于 30 万行目标。
- 我方全仓在 253/255 组（1,378/1,390 文件）时被 Claude Code 的后台内存压力机制停止；2 组 12 文件未覆盖（0.9%），结果由 per-group `run.json` 合并。这是宿主资源保护，不是检视命令失败；未自动重启。

---

## 8. 结论与后续

1. **默认全仓检视应走我方路径**：我方 1,331 条 / 0.97 条/文件、整体 precision **0.81**；OCR 3,561 条 / 2.57 条/文件、整体 precision **0.69**。但两侧的高档都可靠：我方 P0–P2 precision **0.96**（占 88%），OCR high/critical **1.00**（占 23%）。
2. **OCR 不是没有价值**：critical/high 档 55/55 VALID，能命中与我方相同的真实缺陷；噪声集中在 low/medium（low 0.21、medium 0.63）。如果消费方只取 high/critical，OCR 可作为补充，但会漏掉大量中低档真实问题。
3. **成本差距**：总 token 95.51M vs 67.97M（**1.40x**），未命中输入 10.29M vs 5.58M（**1.84x**），comments 3,561 vs 1,331（**2.68x**）。差距主要来自输入组织：组级合成 diff 让整文件只进一次上下文；OCR 的逐文件 agent 循环会反复读关联文件。
4. **全仓扩展性**：两侧都随文件数线性增长；我方可用「组数 × 文件数 × 字符数 × 工具次数 × 轮次」显式封顶，OCR 的单文件循环缺少等价硬门。
5. **覆盖**：我方 253/255 组（1,378/1,390 文件，99.1%）——最后 2 组被宿主机内存保护停止，不是检视失败；OCR 1,388/1,390 文件（2 文件被默认路径规则排除）。

后续：

- R-06b：合成缺陷注入测召回（本轮只测精度；没有 GT，不能从 precision 推 recall）。
- scan 专用 Zone A：去掉「本次新增」措辞，改为整文件 / 既有行语义。
- 覆盖账本：文件 × 区域三态，补 R-04 的 `not-reached` 归因。
- 规则召回：先做语言级规则索引 + 触发信号，避免全量规则注入。
- 第二仓复跑：Dubbo（30.9 万行生产 Java）或 Kestra（20.7 万行）；按本轮脚本可直接复跑。
- 若要补上我方缺的 2 组：在内存充足时按 `full-prod-dry/repo-spike-plan.json` 的 g036/g118 文件清单单独跑（本轮按系统提示未自动重启）。
