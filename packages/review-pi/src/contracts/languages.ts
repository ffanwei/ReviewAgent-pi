// 代码智能支持的语言 id（单一真源，零依赖）。
//
// 放在 contracts 而不是语言注册表模块里：配置装载期（`shared/config.ts`）只需
// 校验 `codeintel.languages` 的取值，不应该为了一个常量依赖实现层（extractor /
// wasm 注册表）。注册表实现（`analysis/language-support.ts`）反向引用本模块，
// 并在测试里锁定「注册表覆盖的 id 集合 == 本清单」。

export const SUPPORTED_LANGUAGE_IDS = Object.freeze([
  "java",
  "typescript",
  "python",
  "go",
  "cpp",
] as const);

export type CodeLanguageId = (typeof SUPPORTED_LANGUAGE_IDS)[number];
