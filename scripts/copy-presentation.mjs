/**
 * 呈现引擎产物落地（ADR-0026）：`.tmp-gen/presentation/*.js` →
 * `packages/review-pi/presentation/`。
 *
 * 为什么要有这一步：`presentation.engine = "builtin"` 必须在制品里有一个
 * 稳定位置。`.tmp-gen/` 是多种构建共用的传输临时区（不入库、随时可清），
 * 不能当制品路径；`presentation/` 属于本包，`pnpm deploy` / 打包都会带走。
 *
 * 引擎编译产物只 import `node:*` 与同目录 `./*.js`（对 review-pi 的引用全是
 * `import type`，编译期抹掉），所以换目录不影响解析。复制前先清空目标目录：
 * 上一版残留的模块被 import 到比缺文件更难查。
 */

import { cp, mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..");
const sourceDir = path.join(repoRoot, ".tmp-gen", "presentation");
const targetDir = path.join(repoRoot, "packages", "review-pi", "presentation");

const files = (await readdir(sourceDir)).filter((name) => name.endsWith(".js"));
if (files.length === 0) {
  console.error(`copy-presentation: no compiled engine module in ${sourceDir}`);
  process.exit(1);
}

await rm(targetDir, { recursive: true, force: true });
await mkdir(targetDir, { recursive: true });
for (const name of files) {
  await cp(path.join(sourceDir, name), path.join(targetDir, name));
}

console.log(
  `copy-presentation: ${String(files.length)} file(s) -> ${path.relative(repoRoot, targetDir).split(path.sep).join("/")}`,
);
