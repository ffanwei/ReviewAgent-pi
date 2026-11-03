import { defineConfig } from "vitest/config";

// 测试 import 的都是包内相对路径 + 内核 npm 依赖（默认条件 → dist），不需要
// 自定义 resolve 条件。ADR-0035 之前这里开 ["source"] 是为了让 vendored 四包按
// TS 源解析；现在它们来自 npm（tarball 只含 dist），沿用会解析到不存在的 src/。
export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    testTimeout: 120_000,
  },
});
