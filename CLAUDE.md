# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Repo identity（产品仓定位）

本仓（`MustacheXb/ReviewAgent-pi`）是 **pi 内核线的 Review CLI 产品仓**：Review Runtime 在 pi 内核的 npm 上游包（`@earendil-works/{pi-ai,pi-agent-core,chord,pi-telemetry}`，精确锁 `0.85.1`，ADR-0035 取代 vendoring）上从 0 重写（本仓 ADR-0009），产品形态是一次检视产出**英文 findings**（`reviews_en.json`）+ **中文按行分组的建议**（`reviews_tips_zh.json`），规则 Skill 是唯一形态。

A–E 配置矩阵、`configId` 身份维度与本仓的评测仪器层已于 ADR-0024 废止；与 DSH 内核线兄弟仓 [`MustacheXb/ReviewAgent`](https://github.com/MustacheXb/ReviewAgent) 的跨内核对照不再在本仓复跑。历史评测报告仍在 `docs/report/`（`runs/**` 运行留痕自 ADR-0033 起不入库，旧目录已清理），但**不可复跑**。

**跨仓 ADR 限定语纪律**：两仓 ADR 各自独立编号（本仓 0001–0036 为 pi 线序列，新决策从 0037 起）。引用 DSH 兄弟仓的决策必须写全限定语「DSH 线 ADR-XXXX」；裸写「ADR-XXXX」一律指本仓 ADR。双 0009 尤其如此（本仓 0009 = pi 内核从 0 重写；DSH 线 0009 = 大 MR 切分）。

**历史文档路径口径**：ADR-0035 之前的 ADR / 设计文档 / 报告里出现的 `packages/{ai,agent,chord,telemetry}/…`、`@review-agent-pi/*`、`pnpm build:pi`、`tsconfig.base.json`，描述的**都是 vendoring 期形态**（该源码树已删除）；同名能力现由 npm 包 `@earendil-works/*`（精确锁 `0.85.1`）提供。历史文献按当时记录读，不改写正文；现状以 `CONTEXT.md` 与 ADR-0035 为准。

## Agent skills

### Diff review skills

Repo-local verification skills live under `.agents/skills/`. They are **not** part of the shipped runtime and are **not** rule skills loaded by `--rule-skill*`:

- `real-defect-url-injection` — replays a real, historically fixed URL-injection defect (default VUL4J-38 / CVE-2014-4172): copies the post-fix snapshot, reverts the fix with `git apply -R`, then runs a real `review-pi` review.
- `synthetic-defect-resource-leak` — injects GEN-RES-001 (file handle never closed) into a copy of `packages/review-pi/testdata/repos/multilang`, then runs a real `review-pi` review with `general-code-review` loaded.

Both call the model through the user config (`~/.PiAgent/PiAgent.jsonc`) and archive `defect.diff` / `ground-truth.json` / `meta.json` / stdout / stderr / runs / audit / `verdict.{json,md}` under `repo-diff-skill-result/<skill>/<timestamp>/` (gitignored). Shared execution layer: `.agents/skills/_shared/review-eval.mjs`.

```bash
node .agents/skills/real-defect-url-injection/scripts/run.mjs --dry-run
node .agents/skills/synthetic-defect-resource-leak/scripts/run.mjs --dry-run
```

### Issue tracker

Local Markdown: issues and specs live as files under `.scratch/<feature>/` in this repo (no CLI required). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles, label string equal to role name (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
