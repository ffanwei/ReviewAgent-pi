/**
 * 发行形态 A（npm 多包，ADR-0028）：把六个包打成 tarball 到 `.artifacts/tarballs/`。
 *
 * - 打包顺序 = 依赖拓扑序（telemetry → chord → ai → agent → review-llm → review-pi），
 *   只为让日志与 `pnpm -r publish` 同序；tarball 之间没有打包期依赖。
 * - `pnpm pack` 会把 `workspace:*` 改写成真实版本号——这是发布物的正确形态，
 *   仓内开发仍走 workspace 链接。
 * - 只打包不发布：发布是显式动作（`pnpm -r publish`），且必须由人确认 registry。
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(repoRoot, ".artifacts", "tarballs");

/** 拓扑序（build:pi 的依赖序 + 两个应用包） */
const PACKAGES = [
  "packages/telemetry",
  "packages/chord",
  "packages/ai",
  "packages/agent",
  "packages/review-llm",
  "packages/review-pi",
];

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
