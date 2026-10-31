/**
 * bin 编译判鲜（实现见同目录 compile-freshness.js，纯 node 内建零依赖，
 * 供 review-pi bin 与单元测试共用；测试面 src/cli/compile-freshness.test.ts）。
 */

/**
 * 产物是否陈旧：缺席 → true；任一源根的最新 mtime（构建可见文件——
 * *.test.ts 与 testing/e2e 目录不计数，镜像 tsconfig.build.json
 * exclude）严格晚于产物 mtime → true。等于视为新鲜；源根缺席不贡献信号。
 */
export declare function isCompileStale(outputPath: string, sourceRoots: readonly string[]): boolean;
