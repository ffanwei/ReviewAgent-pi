# R-13 讨论归档

## 2026-11-25 · 语言规则复用方案

- 用户确认：只支持 AST 的 5 种语言；`languageRules` 默认 false；按文件用 `<rules for>` 分块；翻译时删除非缺陷类条目；PR 与 Repo 可分别配置。
- 插入点选择 Phase 5（候选生成）而不是 system prompt：只影响生成阶段，MR 默认关闭时字节不变。
- 注入实现复用现有 `phaseBrief` 缝；不新增模型调用，不包装成规则 Skill（避免每组额外会话）。
- 开启 MR 后 Phase 5 请求字节变化，后续需要重录 replay 并重跑 MR 基线；本轮只实现开关，默认关闭。
