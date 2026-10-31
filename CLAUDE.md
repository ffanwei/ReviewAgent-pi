# CLAUDE.md

Guidance for Claude Code when working in this repository.

## Repo identity（产品仓定位）

本仓（`MustacheXb/ReviewAgent-pi`）是 **pi 内核线的 Review CLI 产品仓**：Review Runtime 在 pi 内核（vendored `packages/{ai,agent,chord,telemetry}`）上从 0 重写（ADR-0009），产品形态是一次检视产出**英文 findings**（`reviews_en.json`）+ **中文按行分组的建议**（`reviews_tips_zh.json`），规则 Skill 是唯一形态。

A–E 配置矩阵、`configId` 身份维度与本仓的评测仪器层已于 ADR-0024 废止；与 DSH 内核线兄弟仓 [`MustacheXb/ReviewAgent`](https://github.com/MustacheXb/ReviewAgent) 的跨内核对照不再在本仓复跑。历史评测报告仍可在 `docs/report/` 与 `runs/**/REPORT.md` 查阅，但**不可复跑**。

**跨仓 ADR 限定语纪律**：两仓 ADR 各自独立编号（本仓 0001–0024 为 pi 线序列）。引用 DSH 兄弟仓的决策必须写全限定语「DSH 线 ADR-XXXX」；裸写「ADR-XXXX」一律指本仓 ADR。双 0009 尤其如此（本仓 0009 = pi 内核从 0 重写；DSH 线 0009 = 大 MR 切分）。

## Agent skills

### Issue tracker

Local Markdown: issues and specs live as files under `.scratch/<feature>/` in this repo (no CLI required). See `docs/agents/issue-tracker.md`.

### Triage labels

Default five canonical roles, label string equal to role name (`needs-triage` / `needs-info` / `ready-for-agent` / `ready-for-human` / `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: one `CONTEXT.md` at the repo root plus `docs/adr/`. See `docs/agents/domain.md`.
