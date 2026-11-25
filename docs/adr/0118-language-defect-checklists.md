# 0118. 语言缺陷清单：Phase 5 按语言注入，MR / 全仓独立开关

**状态**：已接受（2026-11-25）
**关联**：[ADR-0090](0090-chinese-native-review.md)（中文原生检视）、[ADR-0117](0117-full-repo-mcp-reporting.md)（全仓扫描）、[ADR-0110](0110-semantic-aware-skill-candidate-merge.md)（候选合并）
**范围**：只加 Phase 5 的一种附加段；不改六阶段骨架、Finding 契约、规则 Skill 机制。

## Context

open-code-review 维护了一套按语言/文件类型的短规则文档（64 份，约 40–70 行/份），
按文件路径解析成规则文本直接放进检视 prompt；一组混语言时用 `<rules for="…">`
分块标注。它不是独立 agent 会话，成本只有 prompt token。

本仓现有规则通道只有「规则 Skill」：每个 skill 是一次独立会话，适合可执行规则，
但用来承载这种静态语言清单成本过高（每组每 skill 一个会话）。全仓与 MR 都需要
更便宜的「语言检查清单」通道。

## Decision

1. **只支持 AST 已支持的 5 种语言**：java / typescript（ts,tsx,js,jsx,mjs,cjs）/
   python / go / cpp（c,h,cc,cpp,cxx,hpp,hh,hxx）。其余扩展名不注入。
2. **只注入 Phase 5**（Deep Reasoning，候选生成）：作为阶段消息末尾的附加段，
   不改 `SYSTEM_PROMPT` / `SCAN_SYSTEM_PROMPT`，不改 Phase 1–4、6。
3. **按文件分块**：组内单语言时一个块；混合语言按语言分块，块头
   `<rules for="path1, path2">`，块内路径排序，保证提示词字节稳定。
4. **MR / 全仓独立开关**：`limits.languageRules = { mr: boolean, repo: boolean }`，
   **缺省全 false**；`config init` 生成。关闭时 Phase 消息与既有字节完全一致。
5. **规则内容**：从 OCR 规则 1:1 翻译为中文，但**删除非缺陷条目**（拼写、命名、
   注释、格式、风格、纯 STL/语法偏好）；保留空值、边界、错误路径、并发、
   资源生命周期、性能与安全。每份规则前加模式化约束：
   - MR：只用于本次新增/修改行，不报既有问题；
   - 全仓：用于本组既有代码，但必须有具体证据与失败场景。
6. **选择口径**：MR 用本遍 diff 的变更文件；全仓用本组实际送检文件（`fileSnapshot`
   路径，缺席时退回 diff 路径）。不依赖分组策略；`--group-by language` 只是可选优化。

## Consequences

- 好：两种检视共用同一份中文规则与同一条注入缝；默认关闭，零行为漂移；
  不增加模型调用，只增加每 pass 约 1–2k prompt tokens。
- 代价：开启 MR 后 Phase 5 请求字节变化，`test:replay` 需要重录，iterF91 / AACR
  基线需要重新对照；开启全仓后组级 token 略升。
- 噪声：OCR 原文含大量风格条目，本决策只保留缺陷导向条目；后续若发现某条
  噪声高，直接删该条，不引入新的配置面。
- 与规则 Skill 的关系：语言清单是 **prompt 上下文**，不是规则 Skill；规则 Skill
  仍是可执行规则与脚本的唯一形态。两者可以同时开启，Phase 5 会先给 skill 覆盖
  段、再给语言清单。
- 已知边界：`phase5Sweep`（缺省关闭）是独立请求，暂不重复注入语言清单；开启时
  需要时再补。
- 测试：`knowledge/language-rules.test.ts`（映射 / 分块 / 模式约束）、
  `shared/config.test.ts`（默认与解析）、`repo-spike/run.test.ts` 与
  `run/review-run.test.ts`（只在 Phase 5 注入、关闭时不注入）。
