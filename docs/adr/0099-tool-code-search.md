# 0099. 八工具面：新增 `review.search_code`（仓库快照文本检索）

**状态**：已接受（2026-11-17，用户决策 D1–D6）
**关联**：[ADR-0012](0012-project-rules-as-rule-skill-injected-at-candidates-phase.md)（被测量侧「工具面零改动」）、[ADR-0014](0014-rule-skill-review-pass-after-candidates-phase.md)（skill 会话工具面）、[ADR-0038](0038-retire-byte-gates-for-capability-assertions.md)（退役逐字节金样）、[ADR-0090](0090-chinese-native-review.md)（中文原生检视）
**范围**：本仓 pi 线 0099。主会话工具面由七工具扩为八工具；skill 会话由「七工具 + bash」扩为「八工具 + bash」。其余运行时语义、配置面、审计键集不变。

## Context

现有七个 `review.*` 工具的全部入口都要求模型**已经知道符号名或路径**：

- `get_symbol` / `find_references` / `get_call_chain` 按简单名查询；
- `get_file` 要求完整仓库相对路径；
- 没有文本检索、没有按文件名发现。

当模型只掌握字面线索（配置键、错误文案、日志消息、字符串常量）时，唯一路径是猜路径再 `get_file`，或直接放弃检索。ADR-0014 的「工具面零改动」是以评测仪器为优先的决策，但它不应成为「缺少基本检索能力」的理由。

## Decision

1. **新增 `review.search_code`**（wire 名 `review_search_code`），插入 `REVIEW_TOOL_ORDER` 的 `get_call_chain` 之后、`search_rule` 之前；两个占位检索工具保持末尾。
2. **参数**（canonical 键序 `caseSensitive, glob, limit, query, regex`）：
   - `query`（必填）：文本或正则；
   - `regex`（可选，缺省 false）：true 时按 **ripgrep 默认 Rust regex** 解释（不使用 `-P`，不依赖 PCRE2 编译选项；不支持 lookaround / 反向引用）；
   - `caseSensitive`（可选，缺省 false）；
   - `glob`（可选字符串数组）：支持 `!` 负向；拒绝绝对路径与 `..`；反斜杠归一、去重排序；
   - `limit`（可选，1–200，缺省 50）。
3. **范围**：整个仓库快照，排除 `codeintel.excludeGlobs`；不做 diff 范围限制（D1）。
4. **输出**：头部 `Search "<query>" (<flags>): N match(es) in M file(s)`；每条 `path:line: text`，按 `(file, line, text)` 排序；单行超 200 字符截断。零命中固定文案 `no matches.`。
5. **截断**：每文件 20 条（`--max-count`）+ 全局 `limit`；两种截断都追加显式提示；字符预算走 `applyLineBudget`（head），预算提示行之后仍保留条数截断提示。
6. **Ledger**：登记为 `evidence`，标识 = 工具名 + 有界 query + 标志 + 排序后的 glob。同一语义不同参数顺序命中同一条目。
7. **失败语义**：空 query / 非法 glob / 非法正则 / 超时均为有界错误文本；错误不泄漏宿主绝对路径；超时提示收窄查询或加 glob。
8. **提示词引导（D6）**：system prompt 增加一句「已知符号名优先结构化工具，只有字面线索才用 `search_code`」——随本 ADR 记录 system prompt 字节变化。
9. **不加 `find_files`（D5）**：先观测 `search_code` 的调用模式，文件发现能力另行评估。
10. **配置面不变**：`limit` 缺省/上限、每文件上限、行截断为模块常量；超时复用 `limits.timeouts.ripgrepMs`；不新增 ADR-0025 配置键。

## Options（为什么不是别的）

- **扩展现有工具**（给 `find_references` 加 pattern、给 `get_symbol` 加前缀匹配）：不加工具位、tools 段字节不变，但会毁掉「符号引用」与「文本搜索」的语义边界，模型难以理解；否决。
- **只加 `find_files`**：schema 更小，但解决不了「定位一段代码」的主诉求；暂缓。
- **git grep（对齐 open-code-review）**：复用 git 依赖、per-file `--max-count` 与 pathspec 语义成熟，但本仓已有 `@vscode/ripgrep`，跨平台与速度更好；否决。
- **`-P` PCRE 正则**：模型更熟悉 lookaround，但依赖二进制编译选项；否决。

## Consequences

- **工具面字节变化**：主会话与 skill 会话的 tools 段都多一个工具；Zone A 的逐字节冻结按 ADR-0038 的结构断言继续成立（每个 schema 自身仍 canonical）。
- **回放轨迹失效**：`testdata/traces/*.json` 的 `toolsDigest` 全部变化，`pnpm test:replay` 必须重录：
  - 5 个 canned 场景可离线重录（record → expect-from-run → 更新场景 → once 自检）；
  - `large-mr` 需真网关重录（不能离线重造）。
  - 重录同时清理了两类历史漂移：旧 trace 里残留的 oneshot 交互（当前代码在这些场景不再发起），以及 `core-no-finding` 场景 expect 与 `no-finding` 语料不一致（旧 expect 含一条 finding，重录后为 0）。
  - `large-mr` 的期望 findings / tips 按本次真网关录制的产物重新钉定（真模型非确定，这是录制流程的既有语义）；重录后为 19 interactions（18 review + 1 oneshot）、47 条 findings、9 组 tips。
- **上下文成本**：每次请求多一个工具 schema（约百余 token）。
- **不解决的边界**：不做文件名发现；不提供跨文件 diff；快照侧别（base/mixed）仍无 side 参数。

## Verification

- `tools/registry.test.ts` 八工具与 canonical 键序；
- `tools/search-code.test.ts`：字面/正则/大小写/glob/负向 glob/校验/零命中/limit/每文件上限/预算/Ledger/非法正则/超时/确定性；
- `loop/agent-review-loop.test.ts`、`run/review-run.test.ts`、`run/mr-boundary-guard.test.ts`、`knowledge/skill-pass.test.ts` 的工具名数组；
- `pnpm test:replay` 六场景全绿。
