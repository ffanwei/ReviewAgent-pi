# 0031. review 参数回显：run 结束后把生效参数打到 stderr

**状态**：已接受（2026-11-02，用户要求「在执行 review 后，打印所有传入的参数」）
**关联**：ADR-0030（收尾总结行——本 ADR 在其后追加一块参数回显）、ADR-0016（stderr 运行投影、stdout 单 JSON 文档硬约束）、ADR-0025（配置来源）、ADR-0029（`--mr-diff` / `--mr-json` 二选一）
**跨仓**：本 ADR 为本仓 pi 线序列 0031；DSH 兄弟仓决策须引用全限定语「DSH 线 ADR-XXXX」。
**后续修订**：回显行 `--out` 已由 `--taskId` + `--tasks-dir` 两行取代（ADR-0033）；本 ADR 的机制（打印点、stderr-only、生效值、转义、单点实现）不变。

## Context

一次检视跑完后，stderr 只有一行总结账（ADR-0030），**看不出这次到底收到了什么参数**：

- `--repo` / `--mr-diff` / `--out` / `--rule-skill-*` 是相对路径时，实际解析到哪个绝对路径；
- `--model` / `--config` 没传时，生效值来自配置文件还是用户级缺省；
- `--progress` 没传时，本次到底是开还是关；
- `--issue` 有没有传、内容是什么。

复现一次 run 目前只能回翻 shell history 或审计 `config` 快照；而审计是给机器对账的（JSON 深嵌套、含配置全量），不是「一眼看清输入」。诉求是让一次 run 的**输入面**与输出面（总结行 / stdout / 产物）同样可见。

## Decision

1. **打印点：`runReview` 返回后、呈现投影之前**，紧跟 ADR-0030 的总结行。理由与总结行相同：投影会另发模型请求，参数回显属于「检视本体已完成」的收尾信息，不该被数十秒翻译拖到后面。
2. **只走 stderr**。stdout 是单 JSON 文档契约（ADR-0016 硬约束 1），绝不因回显多出字节；exit 码不受影响。
3. **逐行回显全部 review 旗标 + 派生身份**，顺序固定：`--repo`、`--mr-diff|--mr-json`、`caseId`、`--issue`、`--out`、`--model`、`--config`、`--rule-skill-zip`、`--rule-skill`、`--rule-skill-name`、`--strict-rule-skill`、`--progress`。未传的旗标写 `(未传)`，可重复旗标按传入顺序全列。
4. **值是生效值，不是原始入参**：
   - 路径（`--repo` / MR 输入 / `--out`）按 cwd 解析成绝对路径；
   - `--model` 缺省时打印配置 `model.default` 并标注「（缺省：配置文件 model.default）」；
   - `--config` 缺省时打印用户级配置路径并标注「（缺省用户级路径）」；
   - `--progress` 打印实际开关；缺省自动时标注 stderr 是否 TTY。
5. **`--issue` 用 `JSON.stringify` 转义**：多行议题不会把一条参数拆成多行，日志解析仍是一行一旗标。
6. **不回显秘密**：只碰参数面，不打印 apiKey / baseUrl / 配置文件内容；`config.path` 只是路径。
7. **单点实现**：`cli/args-echo.ts` 的 `formatReviewArgs` 是纯函数（零文件系统），`main.ts` 只负责提供解析后的路径与生效值并写入 stderr。

形态：

```text
review-pi: 本次 review 传入参数
  --repo              /data/repo
  --mr-diff           /data/in/MR-1234.diff
  caseId              MR-1234
  --issue             "修复登录超时"
  --out               /data/reviews
  --model             deepseek-v4-flash（缺省：配置文件 model.default）
  --config            /home/me/.PiAgent/PiAgent.jsonc（缺省用户级路径）
  --rule-skill-zip    rules/java.zip
  --rule-skill        (未传)
  --rule-skill-name   (未传)
  --strict-rule-skill 未启用
  --progress          关（缺省自动：stderr 非 TTY）
```

## Options（为什么不是别的）

- **塞进 stdout JSON**：破单 JSON 文档契约（ADR-0016 硬约束 1），下游解析面被迫多认一个键。否。
- **放在 `runReview` 之前**：失败路径也能看到参数，但用户要的是「执行完后确认这次到底用了什么」；放在前面会被后续进度/错误行冲散，且与总结行不成组。否。
- **只打印显式传入的旗标**：看不到缺省值来源，`--model` / `--config` / `--progress` 的实际生效面仍要猜。否——全列并标注 `(未传)` / 来源。
- **只打印原始入参（相对路径原样）**：`--repo x` 到底指哪个目录仍要靠人脑按 cwd 解析。否——打印解析后的绝对路径。
- **写进审计 `config` 快照**：审计是机器对账面，已有全量配置与 digest；再塞一份人读文本会扩字节面。否。

## Consequences

- **好**：复现一次 run 不必翻 shell history；相对路径与缺省来源一眼可见；参数面与总结行相邻，形成「输入 + 账」的完整收尾；纯函数可单测。
- **坏 / 需要显式认识的刻意偏离**：
  - **非 TTY 批跑 stderr 再多 13 行**（1 行头 + 12 行参数）：日志消费方要按固定前缀 `review-pi: 本次 review 传入参数` 起、到下一条 `review-pi:` 行止筛掉；`--no-progress` 依旧不等于零输出。
  - **路径会进日志**：绝对路径可能含用户名/目录结构；这是「看清输入」的代价，与审计已落的路径同档，不新增敏感面（apiKey / 配置内容仍不出现）。
  - **值只反映本次生效态**：配置文件在 run 期间被改不会反映（配置本就只读一次，ADR-0025）。
- **测试面**：`cli/args-echo.test.ts`（逐行文本、缺省标注、`--mr-json` 标签、`--issue` 多行转义、可重复旗标顺序）；`cli/bin.process.test.ts`（成功 run 后 stderr 含回显头与本次 `--repo` / MR 路径 / `--out`，且 stdout 键集不变、无 key 泄漏）。
