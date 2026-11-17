/**
 * 代码智能扫描面的缺省排除规则（ADR-0041）。
 *
 * 多语言后 `rg` 用的 glob 从 `*.java` 扩到 `*.ts/*.js/*.py`，而 `rgListFiles`
 * 刻意使用 `--no-ignore`（避免被仓库 .gitignore 左右，保证确定性）。若不加默认
 * 排除，node_modules / dist 里的 JS 会被当成源码扫进来——既慢又全是噪声。
 *
 * 语义：这些是「非手写源码」的目录/生成物；用户可用 `codeintel.excludeGlobs`
 * 覆盖（空数组 = 不排除任何东西）。
 */
export const DEFAULT_EXCLUDE_GLOBS: readonly string[] = Object.freeze([
  "**/node_modules/**",
  "**/dist/**",
  "**/build/**",
  "**/out/**",
  "**/target/**",
  "**/vendor/**",
  "**/__pycache__/**",
  "**/.venv/**",
  "**/venv/**",
  "**/generated/**",
  "**/.git/**",
  "**/*.min.js",
  "**/*.d.ts",
]);
