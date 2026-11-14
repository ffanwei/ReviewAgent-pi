# 0091. 呈现投影层退役：`presentation` 整层删除

**状态**：已接受（2026-11-14，用户决策：删除呈现引擎与 `presentation.engine` 配置面；保留 tips 类型定义）
**关联**：[ADR-0010](0010-inspection-language-pinned-english-with-out-of-kernel-translation.md)（呈现投影的设立）、[ADR-0026](0026-config-surface-engine-and-endpoint-tier.md)（引擎配置面收口——本 ADR 删除其对象）、[ADR-0059](0059-presentation-partial-degradation.md)（单字段降级——仅存在于该层）、[ADR-0065](0065-console-english-and-unified-tips.md)（CLI 不再调用——第一个收窄）、[ADR-0090](0090-chinese-native-review.md)（检视本体即中文——失去存在对象）
**范围**：本仓 pi 线 0091。删除核外呈现投影层的全部实现面：root `src/presentation/`、包内 `presentation/` 制品、`tsconfig.presentation.json` / `copy-presentation.mjs` / `build:presentation` 构建腿、`presentation.engine` 配置键与 `"builtin"` 哨兵、`limits.timeouts.presentationRequestMs` / `presentationBufferMs`、`limits.retry.presentationAttempts`、`concurrency.suggestion`、`--from-env` 的 `REVIEW_PI_PRESENTATION_ENGINE` 迁移、`PresentationRuntime` 公开导出。保留 `ReviewTipLike` / `ReviewTipsDocumentLike` 类型（tips 12 键契约，搬到 `cli/presentation-projection.ts` 只剩类型）。

## Context

ADR-0090 之后，呈现投影层在检视链上已无任何调用点：候选直接产出中文与 `Finding.tips`，stdout 即中文真源，`reviews_tips_zh.json` 的语义与 MCP 报文同源自候选。该层唯一的残余价值是「外部消费方挂自己的引擎翻译英文产物」——但检视产物已无英文自然语言可译，理论用武之地也不存在。层内还拖着一条构建腿（`build:presentation`）、一份发行制品（`presentation/`）、三个配置键与一个哨兵值。

## Decision

1. **删除**：root `src/presentation/`（engine-zh / terminology / tips / translate-projection）、`tests/presentation/`、`packages/review-pi/presentation/` 制品、`tsconfig.presentation.json`、`scripts/copy-presentation.mjs`、`build:dist` 收为单段 `pnpm --filter @baize/review-pi build`、`prepack` / `verify:pack` 的 presentation 断言、`config init` 模板与 `PiAgent.example.jsonc` 的 `presentation` 分区、`REVIEW_PI_PRESENTATION_ENGINE` 迁移。
2. **配置面**：`presentation.engine` / `"builtin"` 哨兵 / `resolvePresentationEnginePath` 删除；`presentationRequestMs` / `presentationBufferMs` / `presentationAttempts` / `concurrency.suggestion` 删除（`retryPolicyFor` 的 `presentation` 路径一并退役）；旧配置文件含这些键会收到未知键警告（不中断）。
3. **保留**：`ReviewTipLike` / `ReviewTipsFileLike` / `ReviewTipsDocumentLike`（12 键 tips 契约，`cli/presentation-projection.ts` 退化为纯类型文件）；`model.presentation`（收尾总结模型，ADR-0090 后唯一消费者）。
4. **发行面**：tarball 内容 = `dist` + `bin` + `THIRD-PARTY-NOTICES.md` + `README.md`（`files` 收窄）。

## Options（为什么不是别的）

- **保留为「外部英文输入的通用翻译层」**：否。没有已知消费方，且它消费的是本仓 Finding 形状——外部英文输入不会有这个形状。
- **只删制品、保留配置键与源码**：否。留着一半只会让人以为还有一半在运行。
- **`presentation-projection.ts` 整文件删除**：否。`ReviewTipLike` 等 12 键类型被 delivery / unified-tips / reviews-tips-zh / review-summary 实际消费，改名搬走会牵动五个文件的纯类型 import，保留类型文件成本最低。

## Consequences

- **好**：少一条构建腿、一份发行制品、三个配置键、一个哨兵与一套引擎加载/校验机械；`verify:pack` 少一项断言；配置面与实际行为完全一致（写 `presentation.engine` 得到未知键警告，而不是静默无效）。
- **代价 / 风险**：配置了 `presentation.engine` 的既有用户会在装载期收到未知键警告（行为不变，警告可消除）；公开导出面少 `PresentationRuntime`（类型级破坏，无运行时影响）。
- **测试面**：全量 vitest 1023 passed；`test:replay` 6/6；`verify:pack` 全绿（重打包 549.9 KiB，较之前 577.2 KiB 小）；真网关 smoke 通过。
