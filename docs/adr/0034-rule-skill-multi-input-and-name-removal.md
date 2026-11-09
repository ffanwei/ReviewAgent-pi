# 0034. 规则包多值输入（逗号列表）与 `--rule-skill-name` 移除

**状态**：已接受（2026-11-03，用户决策）
**后续修订**：缺值口径由 [ADR-0044](0044-valueless-rule-skill-flags-are-ignored.md) 收窄——本 ADR 所属的两个逗号列表旗标（`--rule-skill` / `--rule-skill-zip`）「传了但没给值」不再报用法错误，改为按未传处理并打一行提示；逗号列表与重复旗标语义不变。
**关联**：ADR-0014（多规则包 = 多个 zip、CLI 顺序）、ADR-0018（`--rule-skill <dir>` 目录形态并列）、ADR-0027（规则包只认显式输入）、ADR-0031（参数回显）
**跨仓**：本 ADR 为本仓 pi 线序列 0034；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
**后续修订**（2026-11-09）：新增 `--skill <dir>`（初名 `--rule`，同日更名为 `--skill`，见 [ADR-0067](0067-rename-rule-flag-to-skill.md)）作为与 `--rule-skill` 同义的逗号列表旗标；装载序在原有「先 zip 后目录」之后追加全部 `--skill` 目录。**同名 skill 只保留后装载者**——`--skill` 排在最后，因此同名时 `--skill` 覆盖 `--rule-skill` / zip 的版本（见 ADR-0018 后续修订）。

## Context

ADR-0014 / 0018 定下的多包传法是**重复旗标**：

```bash
review-pi review ... --rule-skill-zip a.zip --rule-skill-zip b.zip
```

实际调用方（脚本 / 上层编排）习惯把多包写成一行列表，`--rule-skill-zip r1.zip, r2.zip, r3.zip`。这条命令在 bash / PowerShell 里都会被按空白切成多个 argv（`r1.zip,` / `r2.zip,` / `r3.zip`），于是解析器把 `r2.zip,` 当成旗标名，报 `unknown flag "r2.zip,"`——用户意图明确，却没有任何合法写法能表达（除非改成重复旗标）。

同时用户确认了一个此前隐含假设：**每个规则包就是一个完整且单一的 skill**，不存在「一个包里再含多个 skill」的形态。这条假设让 `--rule-skill-name`（包内多 skill 消歧）失去使用场景：

- 包内恰好 1 个 skill 时它是空操作；
- 多包场景下它又是「同一个名字逐包生效」，指定只会让其它包整体降级；
- 它把一个本应「包形态不合规」的错误包装成了「用户选一个」。

## Decision

### 1. 两个规则包旗标接受**逗号列表**，与重复旗标等价

```bash
# 引号内（单 argv）
--rule-skill-zip "r1.zip, r2.zip, r3.zip"

# 不加引号：bash 留下尾逗号，PowerShell 连逗号一并吃掉
--rule-skill-zip r1.zip, r2.zip, r3.zip
--rule-skill r1/, r2/, r3/

# 与重复旗标混用照旧
--rule-skill-zip a.zip,b.zip --rule-skill-zip c.zip
```

- **多 token 归并**：列表旗标的值位置**连续的非旗标 token 全部计入列表**（本命令没有位置参数，贪心吃非旗标 token 不产生歧义），再用 `,` 拼成一个值（`cli/args.ts` 的 `joinCommaListTokens`）。这是必须的：`--rule-skill r1/, r2/, r3/` 在 PowerShell 里实际 argv 是 `r1/ r2/ r3/`（逗号被 shell 吃掉），在 bash 里是 `r1/, r2/, r3/`（尾逗号保留）——两种形态归并到同一条路；
- **拆分**：逐项 `trim`、空项丢弃（`a.zip,,b.zip` 仍取两项）；**整值无有效项**（`--rule-skill-zip " , "`）自 2026-11-09 起也按「未传」处理（见 ADR-0044 后续修订；原先是 `must be a non-empty path list` 用法错误）；
- **顺序**：先全部 `--rule-skill-zip`（CLI 序，列表内按列表序），再全部 `--rule-skill`（ADR-0018 的装载序不变）；
- **代价（显式认识）**：这两种旗标的值里**不能再用逗号**。Windows 路径允许逗号，但规则包路径带逗号是极端个例，换来「一行传多个」的可用性；需要时把包放到无逗号路径。

### 2. `--rule-skill-name` 彻底移除，传入即给迁移文案

- 从已知旗标面删除，解析前先扫 argv 命中即返回专用文案（不是裸 `unknown flag`）：

  ```text
  --rule-skill-name 已移除（ADR-0034）：一个规则包就是一个 skill；多个包用 --rule-skill-zip a.zip,b.zip（或重复旗标）一次传入
  ```

- 不保留空操作别名：留着它只会让「包内多 skill」这种不合规形态看起来可救，而真正的传法是多包。

### 3. 装载器要求「一个包恰好一个 skill」

`knowledge/rule-skill.ts` 的 `selectSkill(skills, skillName)` 收为 `singleSkill(skills)`：

| 包内可装载 skill 数 | 结果 |
|---|---|
| 1 | 正常装在该包名下 |
| 0 | 降级：`rule-skill package contains no loadable rule skill (SKILL.md with name + description)` |
| ≥2 | 降级：`rule-skill package contains N rule skills (one package = one skill; split them into separate packages)` |

后者不再提示「用 `--rule-skill-name` 选一个」——正确处置是拆包，而不是消歧。`--strict-rule-skill` 下两者照旧抛错。

### 4. 回显与审计随动

- 参数回显（ADR-0031）去掉 `--rule-skill-name` 行；可重复旗标仍按**生效顺序全列**（逗号列表已在解析期展开，回显与重复旗标同形）：`--rule-skill-zip  a.zip, b.zip`；
- 审计 `ruleSkill[]` 的字节形态**不变**（`source` / `digest` / `name` / `degradedReason` / `diagnostics`）——本次只改「怎么传」与「包内几个 skill 算合规」，没改留痕结构。

## Options（为什么不是别的）

- **只认重复旗标，逗号列表直接报错并给提示**：最保守，但用户给出的就是列表形态，等于要求上层编排改写命令。否。
- **只支持引号内的逗号列表**：`"a.zip,b.zip"` 能工作，但 `a.zip, b.zip` 在 bash / PowerShell 里的默认行为是切成多个 argv——最常见的写法仍然失败，等于没解决问题。否——多 token 归并让不带引号也成立。
- **逗号全角 / 分号也当分隔符**：多一种分隔符就多一族边界（路径里出现分号更常见），收益不抵成本。否。
- **`--rule-skill-name` 保留为可选备用**：见 §2，它把「包形态不合规」伪装成「用户没选」。否。
- **`--rule-skill-name` 改造成逐包列表（`a,b,c` 与包列表按位置对应）**：多包时能做精确校验，但校验目标本身（一包一 skill）已由 §3 兜住，再引入一层位置对应只会增加误配面。否。
- **让 ≥2 个 skill 的包「全部装载」**：一个包 = 一个 skill 是用户的显式约定，静默装多个会让审计里的「包数 ≠ skill 数」，也会让候选 id 前缀（`RULE-CHECK@<skill>@`）与包身份脱钩。否。

## Consequences

- **好**：一行列表与重复旗标都能表达多包；包内多 skill 的处置从「猜/选」变成确定性降级 + 可执行建议（拆包）；旗标面少一个只在病态形态下才有意义的开关。
- **坏 / 需要显式认识的刻意偏离**：
  - **`--rule-skill-name` 是硬破坏**：旧脚本传入即 exit 1（有迁移文案，无兼容期）；
  - **逗号成为清单分隔符**：这两个旗标的路径里不能再出现逗号；
  - **包内多 skill 不再可救**：此前用 `--rule-skill-name` 选中的包，现在必须拆成多个包分别传入——审计里该包会以 `degradedReason` 留痕，strict 下 exit 1。
- **测试面**：`cli/args.test.ts`（引号内列表 / shell 切开的续粘 / 目录列表 / 与重复旗标混用 / 整值无有效项 / `--rule-skill-name` 迁移文案 / `USAGE_TEXT` 不再宣告该旗标）、`cli/args-echo.test.ts`（行数与 `--rule-skill-name` 缺席、列表按生效顺序全列）、`knowledge/rule-skill.test.ts`（包内 ≥2 个 skill 一律降级）。
