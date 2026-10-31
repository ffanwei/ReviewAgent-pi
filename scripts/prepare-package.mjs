/**
 * review-pi 打包前准备（prepack）：把仓根许可证履约文件带进包，并断言发布物在位。
 *
 * 为什么需要这一步：`THIRD-PARTY-NOTICES.md` 在仓根（vendored pi 四包与本仓共用一份
 * 履约文本），npm tarball 不能引用包根之外的文件——必须在打包时复制进包目录。
 * 断言而不是构建：打包必须是"确定性 + 离线"的，产物由 `pnpm build:dist` 显式产出；
 * 缺产物时让人话报错，而不是在 prepack 里默默触发一次构建。
 */
import { copyFileSync, existsSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const packageDir = join(repoRoot, "packages", "review-pi");

const noticesSource = join(repoRoot, "THIRD-PARTY-NOTICES.md");
const noticesTarget = join(packageDir, "THIRD-PARTY-NOTICES.md");
if (!existsSync(noticesSource)) {
  process.stderr.write(`review-pi prepack: 找不到 ${noticesSource}\n`);
  process.exit(1);
}
copyFileSync(noticesSource, noticesTarget);

const required = [
  join(packageDir, "dist", "cli", "main.js"),
  join(packageDir, "dist", "index.js"),
  join(packageDir, "bin", "review-pi.js"),
  join(packageDir, "bin", "lib", "cli-runtime.js"),
  join(packageDir, "presentation", "engine-zh.js"),
  join(packageDir, "presentation", "terminology.js"),
  join(packageDir, "presentation", "tips.js"),
  join(packageDir, "presentation", "translate-projection.js"),
  noticesTarget,
];

const missing = required.filter((path) => !existsSync(path));
if (missing.length > 0) {
  process.stderr.write(
    `review-pi prepack: 发布物不完整（${missing.length} 项缺席）——先跑 pnpm build:dist\n${missing
      .map((path) => `  ${relative(repoRoot, path).split("\\").join("/")}\n`)
      .join("")}`,
  );
  process.exit(1);
}

process.stdout.write("review-pi prepack: 发布物在位（dist / bin / presentation / 许可证履约）\n");
