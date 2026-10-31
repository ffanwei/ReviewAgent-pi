import { defineConfig } from "vitest/config";

export default defineConfig({
  // review-llm（workspace 内部包）按 "source" 条件解析到 TS 源而非 dist 产物，
  // 保证测试始终跑当前源码（exports: types/source 指向 src，default 指向 dist 供编译路径运行时用）
  resolve: {
    conditions: ["source"],
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    // ADR-0024 后 root 只剩呈现层（src/presentation）与它的测试；
    // 检视链的测试面在 packages/review-pi 内，用包内 vitest 配置跑。
    testTimeout: 120_000,
    hookTimeout: 120_000,
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"],
      // 产品代码覆盖率：root 只覆盖呈现层（核外翻译投影 / 分组映射 / 引擎装配）
      include: ["src/**/*.ts"],
      exclude: ["src/**/*.test.ts"],
      // 零网络常规门的最低覆盖线（全局；阈值沿用既有基线）
      thresholds: { lines: 80, branches: 80, functions: 80, statements: 80 },
    },
  },
});
