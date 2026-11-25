# R-13 · 语言缺陷清单（MR + 全仓）

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-25

## 需求

把 OCR 的语言规则复用到本仓：只支持 AST 已支持的 5 种语言，Phase 5 注入，
MR / 全仓独立开关，缺省关闭；中文、只保留缺陷类条目。

## 契约

- 语言：java / typescript（ts,tsx,js,jsx,mjs,cjs）/ python / go / cpp（c,h,cc,cpp,cxx,hpp,hh,hxx）。
- 注入点：Phase 5（Deep Reasoning）附加段；不动 system prompt 与其他阶段。
- 分组：按文件；混合语言用 `<rules for="…">` 分块。
- 配置：`limits.languageRules = { mr: false, repo: false }`，`config init` 生成。
- MR 约束：只用于本次新增/修改行；全仓约束：用于本组既有代码，但须有证据与失败场景。

## 实现

- `knowledge/language-rule-texts.ts`：5 份中文缺陷清单（删除拼写/命名/注释/格式/风格）。
- `knowledge/language-rules.ts`：扩展名映射、按语言分块、模式化 preamble。
- `run/review-pass.ts`：按 `runtime.limits.languageRules` 与 `reviewMode` 选择文件，Phase 5 `phaseBrief` 追加。
- `repo-spike/runtime.ts` + `run.ts` + `cli/repo-spike-command.ts`：把配置开关带进 repo runtime。
- `shared/config-limits.ts` + `shared/config.ts`：配置块与模板。
- ADR-0118；设计文档 §4.4。

## 验收

- 开关关闭时 Phase 1–6 字节不变（默认行为零漂移）。
- 开启后只在 Phase 5 出现规则块；MR 取变更文件，repo 取组内送检文件。
- 混合语言按 `<rules for>` 分块，路径排序确定。
- 全包回归 + build。
- 全包 1324 passed / 1 skipped；`config init` 含 `limits.languageRules`；build 通过。
