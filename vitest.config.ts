import { defineConfig } from "vitest/config";

// 根包的测试面只有 scripts/ 工具链的纯函数（回放指标解析等）；检视链的测试面
// 在 packages/review-pi 内，用包内 vitest 配置跑（ADR-0035 后内核四包是 npm
// 依赖，不再有任何根侧源码需要 alias 或 source 条件）。
export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
