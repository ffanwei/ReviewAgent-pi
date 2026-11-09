# 0044. 规则包旗标缺值按「未传」处理（忽略，但不静默）

**状态**：已接受（2026-11-06，用户选择「忽略 + 喊一声」的 B 档）
**关联**：ADR-0034（逗号列表多值输入；本 ADR 收窄其所属旗标的缺值口径）、ADR-0027（规则包只认显式输入 / 零静默）、ADR-0016（stderr 运行投影纪律）、ADR-0043（参数回显打印点）
**范围**：本仓 pi 线 0044。只改 CLI 参数层，不动规则包装载器与任何请求字节。
**后续修订**（2026-11-09）：值位置**给了空串 / 纯空白 / 纯逗号**也按「未传」处理（不再报 `must be a non-empty path list`）；旗标面追加 `--rule`（与 `--rule-skill` 同义）。理由见决策 3 的修订说明。

## Context

`parseFlags` 有一条统一契约：**未知旗标 / 重复旗标 / 值缺席（含值吞旗标）都是用法错误**（`cli/args.ts`），所以 `--rule-skill` 后面没有值时会得到：

```text
review-pi: flag --rule-skill requires a value
<整段 USAGE_TEXT>
exit 1
```

这条契约对 `--repo` / `--mr-diff` / `--taskId` 是恰当的：它们缺值说明命令本身写错了。但规则包旗标（`--rule-skill` / `--rule-skill-zip`）的实际用法不同——它们几乎**总是由脚本按变量拼出来**：

```powershell
review-pi review ... --rule-skill $env:RULES_DIR
```

PowerShell 在变量为空时会把这个参数**整个丢掉**（实测：空串参数被 shell 吞掉，`parseCliArgs` 只看到孤零零的 `--rule-skill`）。于是「这台机器上没设规则包变量」的表现是**整条命令起不来**，而不是「本轮跳过规则包」——CI 模板、跨机器脚本里这个差异会被误读成「工具坏了」。

同时 ADR-0034 的逗号列表归并让缺值只可能出现在两种形态：argv 结束，或下一个 token 就是另一个 `--` 旗标。两者都是「没写值」，不是「写了个错值」。

## Decision

1. **口径只对两个逗号列表旗标改**（`--rule-skill` / `--rule-skill-zip`）：值位置没有可用 token 时，该旗标被**摘掉、等价于未传**，不再报用法错误。落点在 `joinCommaListTokens`（它本来就在向后看一个 token），`parseFlags` 的契约原样保留给其余所有旗标。
2. **零静默**：摘掉的旗标名经 `ReviewCliArgs.emptyRuleSkillFlags` 回传，CLI 在 `runReviewCommand` 最前写一行：
   ```text
   review-pi: --rule-skill 缺少值，已忽略（本轮不装载该包）
   ```
   打印点放在一切早退之前，保证即使这次 run 随后因别的错误退出，「规则包没装载」这个原因也已经在 stderr 里。
3. **空值也按「未传」处理**（2026-11-09 修订）：`--rule-skill ""`、`--rule-skill " , "`、`--rule ""` 不再报 `must be a non-empty path list`，而是与「旗标后面没 token」同口径——摘掉、等价于未传、登记 `emptyRuleSkillFlags` 并提示一行。原判断（「空串是用户确实想表达一个空值」）被推翻：bash 里 `--rule-skill "$dirs"` 在变量为空时**就是把空串传进来**，它与 PowerShell 丢掉整个参数是同一件事；对空串报错等于让 bash 脚本回到「变量没设就整条命令起不来」。`parseRuleSkillList` 仍保留「整值无有效项即错误」的内部防御，但 CLI 解析路径不会再走到它。
4. **落点语义是 N=0**：走「未装载任何规则包」那条既有合法降级（`ruleSkill: []`、`skillPassLog: []`、主检视照常、exit 0）。该提示里的括号文案同步改成「未传或缺值」，否则在缺值场景下会说出「均未给出」这种假话。
5. **其余旗标不变**：`--repo` / `--mr-diff` / `--taskId` / `--issue` 等缺值仍是 `flag <name> requires a value` + exit 1。

## Options（为什么不是别的）

- **A 档：完全静默忽略**（用户最初提出的形态）。否。strict 模式下会走到 `rule-skill.ts` 报 `no rule-skill archive given (pass --rule-skill-zip or --rule-skill <dir>)`——用户明明传了 `--rule-skill`，报错却让他「用 `--rule-skill`」，比现在的错误更难查；非 strict 下则悄悄少一个 skill 视角而退出码/产物全正常，与 ADR-0027 的「取用必须显式授权」及其反向（放弃取用也应显式）冲突。
- **C 档：只把文案写清楚、仍 exit 1**。否。它治的是「看不懂报错」，没治「变量为空导致命令起不来」这个真实故障。
- **D 档：只在调用侧修（`if ($dirs) { … }`）**。仍推荐写进脚本，但 CLI 不能假定所有既有脚本都已改；且「变量为空」在 PowerShell 里连 `--rule-skill ""` 都不会传过来，无法从参数面区分。
- **对所有旗标都放宽缺值**：否。那会吞掉真正的拼写/参数错位（`--issue --taskId x`），是 `parseFlags` 明确要拦的形态。

## Consequences

- **好**：脚本/CI 里「变量没设」从「命令起不来」降级为「照跑，并明说少了规则包」，退出码语义与 N=0 一致；一次误配不再浪费一轮排查。
- **代价**：参数层多了一处「两个旗标特殊」的口径，读代码的人需要知道理由（本 ADR 就是那个理由）；`args.test.ts` 里原先把「缺值即报错」当不变量断言的用例必须改写成新语义。
- **测试面**：`cli/args.test.ts`（末尾缺值 / 值被相邻旗标占位 / `--rule-skill --rule-skill a` 只摘掉前者 / 两旗标都缺值 / 空串按未传处理）；`cli/bin.process.test.ts`（进程面：exit 0 + 那行提示 + 审计 `ruleSkill: []`）。文档面：`docs/使用手册-安装与运行.md`（参数段 + 排障表）、`docs/运行手册-单次检视.md`（N=0 一条与排障表）。
- **与 ADR-0034 的关系**：ADR-0034 的逗号列表与重复旗标语义不变，只是「列表旗标缺值」从「掉进 `parseFlags` 的通用错误」改成「摘除 + 提示」。
