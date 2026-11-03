/**
 * 发行形态（单包，ADR-0035）：把 `review-pi` 打成 tarball 到 `.artifacts/tarballs/`。
 *
 * - 只打一个包：内核四包 `@earendil-works/*` 是 npm 依赖，随安装从 registry 拉取，
 *   不进本仓的打包/发布面。
 * - `pnpm pack` 会把 `workspace:*` 改写成真实版本号——这是发布物的正确形态，
 *   仓内开发仍走 workspace 链接。
 * - 只打包不发布：发布是显式动作（`pnpm publish`），且必须由人确认 registry。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, ".artifacts", "tarballs");

/** 发行面 = 一个包（保持数组形态：多包时代的日志/失败计数结构不变） */
const PACKAGES = ["packages/review-pi"];

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
/** Windows 上 .cmd 必须经 shell（Node 的 spawn 不再直接执行 .cmd） */
const useShell = process.platform === "win32";
const packDestination = useShell && outDir.includes(" ") ? `"${outDir}"` : outDir;

rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });

let failed = 0;
for (const packagePath of PACKAGES) {
  const cwd = join(repoRoot, packagePath);
  if (!existsSync(join(cwd, "package.json"))) {
    process.stderr.write(`pack: 跳过不存在的包 ${packagePath}\n`);
    failed += 1;
    continue;
  }
  process.stdout.write(`pack: ${packagePath}\n`);
  const run = spawnSync(pnpm, ["pack", "--pack-destination", packDestination], {
    cwd,
    stdio: "inherit",
    shell: useShell,
  });
  if (run.status !== 0) {
    process.stderr.write(
      `pack: ${packagePath} 失败（status=${String(run.status)}${run.error ? `, ${run.error.message}` : ""}）\n`,
    );
    failed += 1;
  }
}

if (failed > 0) {
  process.stderr.write(`pack: ${failed} 个包打包失败\n`);
  process.exit(1);
}

const tarballs = readdirSync(outDir)
  .filter((name) => name.endsWith(".tgz"))
  .sort();
process.stdout.write(`\npack: ${tarballs.length} 个 tarball -> ${relative(repoRoot, outDir).split("\\").join("/")}\n`);
for (const name of tarballs) {
  const size = statSync(join(outDir, name)).size;
  process.stdout.write(`  ${name}  ${(size / 1024).toFixed(1)} KiB\n`);
}
