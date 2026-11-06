import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
  // root 的呈现层测试 import "review-pi"（type-only + 少量运行时契约）——别名把它
  // 指到 workspace 包的 TS 源，保证测试跑当前源码而不是陈旧 dist。
  //
  // 不再用 resolve.conditions ["source"]（ADR-0035）：内核四包现在是 npm 依赖，
  // 它们也声明了 source 条件并指向**未随 tarball 发布**的 .ts 源，全局开这个条件
  // 会让 vitest 去解析不存在的 src/ 文件。
  resolve: {
    alias: [{ find: /^@baize\/review-pi$/, replacement: fileURLToPath(new URL("./packages/review-pi/src/index.ts", import.meta.url)) }],
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
