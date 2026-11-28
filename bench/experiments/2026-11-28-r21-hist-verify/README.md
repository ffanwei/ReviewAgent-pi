# R-21 历史意见失效上报：真实模型端到端验证

> 运行日期：2026-11-28
> 分支：`exp-repo-review`（实现 commit `7be10d2`，ADR-0122）
> 模型：`deepseek-v4.1-flash`（用户级配置，密钥不入库）
> MCP：本地回环 stub（`initialize` + `tools/call` 记录到 `mcp-calls.jsonl`；仅记录与回 ok，无秘密）

## 验证设计

12 文件临时 git 仓（`repo/`，Python/Go/JS/TS 混合），预埋缺陷：SQL 字符串拼接注入
（`src/db/query.py`）、文件句柄泄漏（`src/io/handler.go`）、硬编码密钥 + 伪签名
（`src/auth/token.js`）等。**两次真实跑**：

- **Run 1（taskId `hist-verify-1`）**：无历史文件——基线行为：18 条意见按文件上报，
  `fullRepoFilerCurrentTips` 发空数组。
- 两次之间做三处变更：SQL 注入**保留不动**；`handler.go` 第 8 行改写为
  `os.OpenFile` 并补 `defer file.Close()`（修泄漏）；`main.py` 第 5 行 print 改到
  stderr（修「错误提示写入 stdout」）；删除 `src/core/engine.py`。
- 构造 `.aireview/history_review_tips.json`（7 条）：101–104 为 PENDING（前三条
  的 `patchLine` / `reviewMsg` 直接取自 run 1 的上报 tips 回放——与平台真实存储
  同构）；105 = INVALIDATED、106 = REJECTED、107 = ACCEPTED（默认状态集只查
  PENDING）。
- **Run 2（taskId `hist-verify-2`）**：读历史文件 → 判定 → `currentTips` 携带清单。

## 结果（全部按设计命中）

`fullRepoFilerCurrentTips` 实际载荷：

```json
{
  "taskId": "hist-verify-2",
  "invalidatedTips": [
    { "tipsId": 101, "reason": "重复" },
    { "tipsId": 103, "reason": "已修复" },
    { "tipsId": 104, "reason": "已修复" },
    { "tipsId": 102, "reason": "文件已删除" }
  ]
}
```

| tipsId | 场景 | 判定路径 | 终态 |
|---|---|---|---|
| 101 | SQL 注入未修，run 2 同文件同代码行再次报出 | 规则硬档（零模型） | `重复`（matchedFindingId=F001） |
| 102 | `engine.py` 已删除 | 规则（零模型） | `文件已删除` |
| 103 | 泄漏已修（行改写 + defer）→ 锚点 edited | LLM 裁决 `fixed`（note：「当前代码第 12 行已新增 defer file.Close()」） | `已修复` |
| 104 | stdout 已修（行改写到 stderr）→ 锚点 gone | LLM 裁决 `fixed`（note：「第 5 行已改为 print(..., file=sys.stderr)」） | `已修复` |
| 105 | INVALIDATED | 准入跳过 | 不上报 |
| 106 | REJECTED | 状态过滤 | 不上报 |
| 107 | ACCEPTED | 状态过滤 | 不上报 |

关键观察：

- **LLM 判得准**：两个真修复都判 `fixed` 且 note 指出修复位置；未修的注入走规则
  零成本命中 `重复`；失效检查未干扰检视本体（run 2 照常报 20 条意见，已修问题
  不再出现）；
- **成本**：裁决车道 3 次调用、3,120 input / 382 output token（`verdictUsage`），
  约检视本体成本 1%；
- **留痕**：`run2/repo-review-result.json`（`historyTips` 摘要：byReason / byVerdict /
  byStatus / verdictCalls / verdictFailed=0）、`run2/history-tips-invalidation.json`
  （逐条明细含 LLM note）、`run2/history-tips-verdicts.json`（判定缓存，续跑复用面）；
- **MCP 顺序契约**：start → 12×report → currentTips → end 两次均不变。

## 文件索引

| 路径 | 内容 |
|---|---|
| `repo/` | 临时仓终态（12 文件 + `.aireview/history_review_tips.json`；不含 .git，两步构造见上） |
| `mcp-calls.jsonl` | 两次 run 的全部 `tools/call`（taskId 可区分） |
| `run2/repo-review-result.json` | run 2 结果（含 `historyTips` 摘要） |
| `run2/history-tips-invalidation.json` | 逐条终态 sidecar（reason / verdict / note / matchedFindingId） |
| `run2/history-tips-verdicts.json` | 判定缓存（原子落盘，续跑按 tipsId 复用） |

## 复现口径

非复跑实验（真实模型输出不可重放）；归档仅作证据。复跑可用
`repo/` 重建两步状态（先 git init 提交「planted problems v1」，再按验证设计变更），
配置需自行提供 reviewer 端点与 MCP server。
