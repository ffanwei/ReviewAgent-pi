/**
 * review-pi 打包前准备（prepack）：把仓根许可证履约文件带进包，并断言发布物在位。
 *
 * 为什么需要这一步：`THIRD-PARTY-NOTICES.md` 在仓根（vendored pi 四包与本仓共用一份
 * 履约文本），npm tarball 不能引用包根之外的文件——必须在打包时复制进包目录。
 * 断言而不是构建：打包必须是"确定性 + 离线"的，产物由 `pnpm build:dist` 显式产出；
 * 缺产物时让人话报错，而不是在 prepack 里默默触发一次构建。
 */
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * shebang 行尾兜底（ADR-0028 决策 5）：`#!/usr/bin/env node\r` 会让 Unix 上的
 * 解释器变成 `node\r`，`pnpm pack` 也直接拒绝打包（`ERR_PNPM_BIN_CRLF`）。
 * `.gitattributes`（`bin/** text eol=lf`）只管**新检出**——旧工作区不会被
 * `git pull` 重写（git 认为内容没变），于是同一台机器上会出现「属性写对了、
 * 打包还是报 CRLF」。打包前在这里兜底：只动**首行带 CR** 的 bin 文件，整文件
 * 统一成 LF，并打一行提示（不静默改工作区）。
 */
let normalized = 0;
for (const file of listJsFiles(join(packageDir, "bin"))) {
  const text = readFileSync(file, "utf8");
  const firstNewline = text.indexOf("\n");
  if (firstNewline <= 0 || !text.startsWith("#!") || !text.slice(0, firstNewline).endsWith("\r")) {
    continue;
  }
  writeFileSync(file, text.replace(/\r\n/g, "\n"), "utf8");
  normalized += 1;
  process.stdout.write(
    `review-pi prepack: ${relative(repoRoot, file).split("\\").join("/")} 检出为 CRLF，已按 LF 重写` +
      `（.gitattributes: bin/** text eol=lf；旧工作区不会被 pull 重写）\n`,
  );
}

process.stdout.write(
  `review-pi prepack: 发布物在位（dist / bin / presentation / 许可证履约${normalized > 0 ? `；重写 CRLF ${normalized} 个` : ""}）\n`,
);

/** bin 下的 .js（一层 lib 子目录，递归即可；不引第三方遍历） */
function listJsFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      return listJsFiles(full);
    }
    return entry.name.endsWith(".js") ? [full] : [];
  });
}
