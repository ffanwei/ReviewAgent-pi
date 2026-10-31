# 黄金基准（golden fixtures）

测量常量面的字节真源，提取自 DSH 线 t-series 审计记录（测量产物，而非源码转写）：
按原文 / `content` 字节落文件，未做任何改写。

ADR-0024 之后本目录只保留**单一形态**（工具驱动 + Context Ledger + 规则 Skill）
仍在消费的常量；配置矩阵、预取注入与 A/B 字节门的对照真源已随矩阵一并删除。

## 文件清单

| 文件 | 内容 | 案例相关性 |
| --- | --- | --- |
| `system-prompt.txt` | Zone A 系统提示（2317 字节，跨 MR 字节稳定） | 案例无关 |
| `phase-1.txt` … `phase-6.txt` | 六阶段指令消息（"Phase N of 6 - <名称>." 起头） | 案例无关 |
| `mr-message-vul4j-1.txt` | VUL4J-1 的 MR 用户消息 | 案例相关 |
| `vul4j-1.diff` | VUL4J-1 的统一 diff（自 MR 消息 ```diff 围栏内字节提取；空上下文行为单空格） | 案例相关 |
| `reply-{1..5}-vul4j-1.txt` | DSH 线六请求回复 1–5（离线全链脚本的回复语料） | 案例相关 |
| `review-tools-dsh.json` / `review-tools-wire-dsh.json` | 七工具定义的点分名 / wire 名对照真源 | 案例无关 |

## 提取源

B 线族（`mr-message` / `reply-*`）：
`runs/phase2-dsh-t1/audit/vul4j/VUL4J-1/B/rep-1/audit/20260914T180846.922-B-VUL4J-1.json`。
源审计 gitignored（本机 runs/ 目录；迁移自 DSH 兄弟仓 phase2 实测），历史报告见
`runs/**/REPORT.md`。

## 纪律

- 这些文件是**测量常量**：pi 内核线的组装面必须与之字节一致（`loop/phases.test.ts`、
  `loop/messages.test.ts`、`zonea/system-prompt.test.ts` 等断言逐字节相等）。
- 修改任何一份文件都需要显式变更记录（它们不是可自由调参的测试数据）。
- 案例无关文件（system-prompt、phase-N）用于一切组装测试；案例相关文件
  仅用于 VUL4J-1 全链对照，且依赖根仓 `data/` 的同源快照。
