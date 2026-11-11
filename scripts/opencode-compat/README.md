# OpenCode 兼容会话：真机验证（opt-in）

ADR-0072 把每次 `review` 的会话**在 run 时**另存一份 OpenCode 兼容版
`{info, messages}` 到 `<runs>/opencode/`，使任何已兼容 OpenCode 的 session 查看
工具可复用（`opencode session import` 可直接接收）。

本目录的 `verify.mjs` 是**可选**的正经验证器：对一份已产出的原生转录
`session-<runId>.json`，用真实代码（`buildOpenCodeSession`）生成兼容文件并回灌
`opencode session import`，再 `session export` 回读比对。它不参与常规 CI
（CI 只守纯函数 shape，见 `packages/review-pi/src/export/opencode-compat.test.ts`）。

## 依赖

- 本机 `opencode` 在 PATH（`--standalone` 隔离到临时 XDG_DATA_HOME，不污染真实库）；
- 已构建：`pnpm --filter @baize/review-pi build`。

```bash
node scripts/opencode-compat/verify.mjs <path/to/session-<runId>.json>
```

输出（成功）：

```text
imported: session-20261109_122156_875
roundtrip ok: 16 messages, system,user,user,assistant,...
```

## 为什么不进 CI

`opencode` 二进制不在 Node 依赖里，且 `session import` 对消息 id / 字段形状的
接受面会随 OpenCode 版本漂移；把版本敏感性锁进 CI 会让这家仓库跟着上游的
import 校验规则波动。CI 层用 golden shape 单测（无 null、`msg_m` 确定性 id、
`finish`/`tool`/`model.variant` 归一），真机 trust 由本脚本按需手动跑。