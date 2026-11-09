# 0067. `--rule` 旗标更名为 `--skill`

**状态**：已接受（2026-11-09）
**关联**：[ADR-0018](0018-rule-skill-directory-input.md)（已解压目录输入）、[ADR-0034](0034-rule-skill-multi-input-and-name-removal.md)（逗号列表多值）、[ADR-0044](0044-valueless-rule-skill-flags-are-ignored.md)（缺值按未传处理）、[ADR-0027](0027-runs-layout-and-rule-skill-trust.md)（规则包只认显式输入）
**范围**：本仓 pi 线 0067。**只改旗标名字**，装载逻辑、去重顺序、缺值口径、审计与请求字节全部不变。

## Context

上一版把「已解压规则包目录」的等价输入旗标命名为 `--rule`（ADR-0018 / ADR-0034 / ADR-0044 的 2026-11-09 后续修订）。它与 `--rule-skill` 完全同义，装载序排在 `--rule-skill` 之后，同名 skill 由它覆盖。

`--rule` 的字面含义容易被读成「一条规则」或「规则文件」，而 CLI 的实际单位是**一个 skill 包（目录）**；同一组旗标里已有 `--rule-skill` / `--rule-skill-zip`，再引入 `--rule` 只会让「规则 vs skill 包」的边界更模糊。这个旗标刚落地、尚无外部依赖，正名成本最低。

## Decision

把 `--rule <dir[,dir…]>` **原样更名为** `--skill <dir[,dir…]>`：

- 值形态不变：已解压目录、逗号列表或重复旗标；
- 装载逻辑不变：与 `--rule-skill` 同一装载链路，排在全部 `--rule-skill` 之后，同名 skill 后装载者胜出；
- 缺值口径不变：值位置无 token 或只有空串 / 纯空白 / 纯逗号 ⇒ 按「未传」处理，stderr 一行提示、exit 0（ADR-0044）；
- 审计、`run.json`、请求字节、退出码均不变。

不保留 `--rule` 作为别名：该旗标仅在本次开发周期内存在，改名即收敛，避免两套写法长期并存。`--rule-skill` / `--rule-skill-zip` / `--strict-rule-skill` 保持原名。

## Consequences

- 用户面只有 `--rule-skill` / `--rule-skill-zip` / `--skill` 三种显式输入，`--skill` 的语义与「一个包就是一个 skill」一致；
- 旧脚本若写了 `--rule` 会得到 `unknown flag` 用法错误（本旗标此前只存在于同一开发周期，未进入稳定使用）；
- 参数回显、`--help` 文案与运行手册同步改为 `--skill`。
