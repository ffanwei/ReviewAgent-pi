# ADR 阅读约定

本目录是本仓（pi 内核线）的架构决策记录，编号连续（当前至 0054）。

## 记录纪律

- **ADR 是当时决策的不可变记录**。决策被推翻或收窄时，不改写正文；在该 ADR 顶部加一条
  **后续修订** / **状态注记** 链接到新 ADR，并在新 ADR 里说明取代关系。
- **跨仓 ADR 限定语**：DSH 内核线兄弟仓 [`MustacheXb/ReviewAgent`](https://github.com/MustacheXb/ReviewAgent)
  的 ADR 独立编号，引用时必须写「DSH 线 ADR-XXXX」；裸写「ADR-XXXX」一律指本仓 ADR。
  双 0009 尤其如此（本仓 0009 = pi 内核从 0 重写；DSH 线 0009 = 大 MR 切分）。

## 主要取代链（据各 ADR 顶部注记整理）

| 旧 | 新 | 范围 |
|---|---|---|
| ADR-0002 | ADR-0008 | 「代码层模型准入白名单」部分（画像表 / 自由 id） |
| ADR-0005 / ADR-0006 | ADR-0009 | DSH 内核形态整体退役，Review Runtime 改为基于 pi 从 0 重写 |
| ADR-0011 | ADR-0024 | A–E 配置矩阵、「生产入口 = config E」口径 |
| ADR-0012 | ADR-0014 | 规则 Skill 的注入时机（候选阶段 → Phase 5 之后独立会话） |
| ADR-0019 | ADR-0026 | 呈现引擎的环境变量路径解析 |
| ADR-0024 | ADR-0027 | 产物路径里的实验段（`review-pi-cli` / `runs/vul4j`） |
| ADR-0008 / ADR-0009 / ADR-0028 | ADR-0035 | 评测仪器归属、内核 vendoring、六包发行形态 |
| ADR-0027（决策 2） | ADR-0036 | cwd 只留 `review-result.json` → 另加隐藏的 `.review-pi-session.json` 寻址索引 |
| ADR-0009 / ADR-0010 / ADR-0014 的字节把守手段 | ADR-0038 | 退役「对照 DSH 历史审计真源逐字节相等」；改为结构性质 + 端到端能力断言（产品级逐字节仍保留） |
| ADR-0031（决策 1：打印点） | ADR-0043 | 参数回显从「run 结束后」提前到「开跑前」；内容与 stderr-only 纪律不变 |
| ADR-0017（severity/confidence 分档） | ADR-0052 | `severity` 三档 → 四档；confidence 高/中分界 0.8 → 0.7；新增中文 tips 置信度过滤 |

## 0037 起的新增决策（不逐条列全，只作导航）

| ADR | 主题 |
|---|---|
| [ADR-0037](0037-mcp-progress-reporting.md) | MCP 上报：进度、状态与结果经进度事件流外发 |
| [ADR-0038](0038-retire-byte-gates-for-capability-assertions.md) | 退役字节门：改为结构性质 + 端到端能力断言 |
| [ADR-0039](0039-sharded-review-for-large-mrs.md) | 大 MR 第二期：按文件块分片检视 + findings 合并去重 |
| [ADR-0040](0040-codeintel-language-registry-and-config.md) | 代码智能语言注册表与 `codeintel.languages` 配置（路线 A） |
| [ADR-0041](0041-language-agnostic-symbol-model-and-multi-language-extractors.md) | 语言无关符号模型与多语言提取器（路线 B：TypeScript/JavaScript、Python） |
| [ADR-0042](0042-go-and-cpp-symbol-extractors.md) | Go 与 C/C++ 符号提取器（多语言第二批，新增 `go` / `cpp` 两个语言 id） |
| [ADR-0043](0043-review-args-echo-before-run.md) | 参数回显提前到开跑前（取代 ADR-0031 决策 1 的打印点） |
| [ADR-0044](0044-valueless-rule-skill-flags-are-ignored.md) | 规则包旗标缺值按「未传」处理（忽略但零静默；收窄 ADR-0034 的缺值口径） |
| [ADR-0045](0045-mcp-business-task-tools.md) | MCP 业务 tool：任务生命周期、片级结果与总结上报（在 ADR-0037 事件面上加业务调用层） |
| [ADR-0046](0046-configurable-max-rounds.md) | 检视轮次上限移入配置面（`limits.loop.maxRounds`，缺省 3），最后一轮强制 complete |
| [ADR-0047](0047-tolerant-model-json-extraction-and-parse-failure-visibility.md) | 模型 JSON 回复统一宽松提取（P0）；解析失败经 `phaseLog.parseFailure` 在 stderr 可见（P1） |
| [ADR-0048](0048-offline-trace-replay-and-concurrency-ramp.md) | 离线 trace 回放（指纹匹配、共享回放服务）与进程级并发阶梯（lane 隔离、模拟延迟、CI 门） |
| [ADR-0049](0049-trace-schema-v2-and-upstream-recording.md) | trace schema v2（`toolsVariants` + `toolsRef`）、lane 路径归一化、真网关录制代理；S5 rule-skill 与 S4 分片场景 |
| [ADR-0050](0050-mcp-business-tool-retry-and-timeout.md) | MCP 业务 tool：`mcp.servers.*.timeoutMs` 缺省 60 s，瞬时失败（传输 / 超时 / 5xx）最多 3 次尝试 |
| [ADR-0051](0051-llm-call-retry-and-timeout.md) | LLM 调用分层重试与请求建立超时：Agent 走 pi-ai `maxRetries`，核外一次性调用走 `shared/llm-retry.ts`；缺省 3 次尝试，smoke 不重试 |
| [ADR-0052](0052-tips-four-tier-severity-and-confidence-filter.md) | 检视意见四档严重级（P3→Suggestion）与 `limits.confidence.min` 置信度过滤（仅中文 tips，缺省 0.5） |
| [ADR-0053](0053-mcp-task-tool-fixed-settle-gap.md) | MCP 业务 tool 之间加固定 5 秒沉降间隔（`mrReviewResult`→`saveReviewSummary`、`saveReviewSummary`→`endTask`；临时措施，见待优化清单） |
| [ADR-0054](0054-mcp-business-call-log.md) | MCP 业务调用留痕写入 `<tasks 根>/<taskId>/runs/mcp.json`（四个 tool 的输入 / 输出 / 调用时间，与 session 转录同目录） |

## 历史路径口径（ADR-0035，2026-11-03）

ADR-0035 把内核四包从「仓内源码 vendoring」改回 **npm 上游依赖**
（`@earendil-works/{pi-ai,pi-agent-core,chord,pi-telemetry}`，四包同版本成套、精确锁 `0.85.1`），
并删除 `packages/{ai,agent,chord,telemetry}` 与 `packages/review-llm`，发行面收为单包 `review-pi`。

因此 **0035 之前的 ADR** 里出现的下列写法都是**当时的形态**，今天已不存在：

| 历史写法 | 现在 |
|---|---|
| `packages/{ai,agent,chord,telemetry}/src/...`（`file:line` 引用） | npm 包 `@earendil-works/*`；npm 只发 `dist`，核对行号请回上游 tag `v0.85.1` |
| `@review-agent-pi/*` 包名 | 上游名 `@earendil-works/*`（不再发布，不再用 npm alias） |
| `pnpm build:pi` / 根 `tsconfig.base.json` | 已删除；依赖由 `pnpm install` 落位 |
| `packages/review-llm`（`profileOf` / resolver / 退役清单） | 已删除；pi 线从未接线，当前恒 `deepseek` provider |

这些记录按历史事实读，不改写。**现状**以 [`CONTEXT.md`](../../CONTEXT.md)、
[ADR-0035](0035-upstream-kernel-as-npm-deps-and-single-package.md) 与 `README.md` 为准。
