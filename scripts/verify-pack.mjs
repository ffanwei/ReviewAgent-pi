/**
 * 发行形态 A（npm 多包，ADR-0028）的安装面冒烟：不联网、不发布，验证 tarball 装得上、
 * 装完能跑。
 *
 * 做法：把 `pack:packages` 产出的 tarball 解到临时 `node_modules/`（模拟 npm 安装布局），
 * 再把仓内已安装的第三方依赖按包逐个 junction 过去（只借依赖，不借源码），然后：
 *   1. 断言 tarball 内容面（dist / bin / presentation / 许可证；不含 src）；
 *   2. `review-pi`（无子命令）—— bin 的腿表在**安装布局**下能定位全部运行时腿；
 *   3. `review-pi config init/show` —— 配置面在安装布局下可读可写；
 *   4. `presentation.engine = "builtin"` 在安装布局下解析到包内制品；
 *   5. tree-sitter wasm / ripgrep 二进制在安装布局下可用。
 *
 * 包名一律从各包 `package.json` 读（不写死 scope）——换 scope 只改包清单，不改本脚本。
 * 这不是发布门（发布要人确认 registry），是"打出来的包到底能不能用"的本地门。
 */
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const tarballDir = join(repoRoot, ".artifacts", "tarballs");
const workDir = join(repoRoot, ".artifacts", "verify");
const stagingDir = join(workDir, "staging");
const appDir = join(workDir, "app");
const appModules = join(appDir, "node_modules");

/** 仓内包目录（按依赖拓扑序；从这些 node_modules 借第三方依赖） */
const SOURCE_PACKAGE_DIRS = [
  "packages/telemetry",
  "packages/chord",
  "packages/ai",
  "packages/agent",
  "packages/review-llm",
  "packages/review-pi",
];

/** 目录 → 包名（真源是各包 package.json，脚本不写死 scope） */
const PACKAGE_NAMES = new Map(
  SOURCE_PACKAGE_DIRS.map((dir) => [
    dir,
    JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")).name,
  ]),
);

/** 本仓发布的包名（junction 第三方依赖时要跳过它们） */
const OUR_PACKAGES = new Set(PACKAGE_NAMES.values());

/** 包名 → tarball 里必须具备的文件 */
function requiredEntries(name) {
  return name === "review-pi"
    ? [
        "package/dist/cli/main.js",
        "package/bin/review-pi.js",
        "package/presentation/engine-zh.js",
        "package/THIRD-PARTY-NOTICES.md",
      ]
    : ["package/dist/index.js"];
}

function fail(message) {
  process.stderr.write(`verify-pack: ${message}\n`);
  process.exit(1);
}

function posix(path) {
  return relative(repoRoot, path).split("\\").join("/");
}

function listTarball(tarball) {
  const run = spawnSync("tar", ["-tzf", tarball], { encoding: "utf8" });
  if (run.status !== 0) {
    fail(`无法列出 tarball（需要系统 tar）: ${posix(tarball)}`);
  }
  return run.stdout.split(/\r?\n/).filter(Boolean);
}

function extract(tarball, dest) {
  mkdirSync(dest, { recursive: true });
  const run = spawnSync("tar", ["-xzf", tarball, "-C", dest, "--strip-components=1"]);
  if (run.status !== 0) {
    fail(`解包失败: ${posix(tarball)}`);
  }
}

function linkDir(target, dest) {
  if (existsSync(dest)) {
    return;
  }
  mkdirSync(dirname(dest), { recursive: true });
  symlinkSync(realpathSync(target), dest, "junction");
}

// ---- 1. tarball 内容面 ----
if (!existsSync(tarballDir)) {
  fail("没有 tarball —— 先跑 pnpm pack:packages");
}
const tarballs = readdirSync(tarballDir)
  .filter((name) => name.endsWith(".tgz"))
  .sort();
if (tarballs.length === 0) {
  fail("tarball 目录为空 —— 先跑 pnpm pack:packages");
}

rmSync(workDir, { recursive: true, force: true });
mkdirSync(stagingDir, { recursive: true });
mkdirSync(appModules, { recursive: true });

const installed = [];
for (const name of tarballs) {
  const tarball = join(tarballDir, name);
  const entries = listTarball(tarball);
  // 源码不得随包发出（chord 上游的 `src/delta/README.md` 是文档，放行）
  const leakedSource = entries.filter((entry) => /^package\/src\/.*\.(?:ts|tsx|js|mjs|cjs)$/.test(entry));
  if (leakedSource.length > 0) {
    fail(`${name} 里混进了源码: ${leakedSource.slice(0, 3).join(", ")}`);
  }
  const staging = join(stagingDir, name.replace(/\.tgz$/, ""));
  extract(tarball, staging);
  const manifest = JSON.parse(readFileSync(join(staging, "package.json"), "utf8"));
  const packageName = manifest.name;
  if (!OUR_PACKAGES.has(packageName)) {
    fail(`${name} 的包名不在发行清单里: ${packageName}`);
  }
  const missing = requiredEntries(packageName).filter((entry) => !entries.includes(entry));
  if (missing.length > 0) {
    fail(`${packageName} 缺少必需文件: ${missing.join(", ")}`);
  }
  installed.push({ name: packageName, version: manifest.version, dir: join(appModules, ...packageName.split("/")) });
  mkdirSync(dirname(join(appModules, ...packageName.split("/"))), { recursive: true });
  renameSync(staging, join(appModules, ...packageName.split("/")));
  process.stdout.write(`verify-pack: ${packageName}@${manifest.version} 内容面 OK\n`);
}

if (installed.length !== OUR_PACKAGES.size) {
  fail(`tarball 数量与发行清单不一致（${installed.length} != ${OUR_PACKAGES.size}）`);
}

// ---- 2. 借用仓内第三方依赖（只借依赖图，不借源码） ----
for (const packageDir of SOURCE_PACKAGE_DIRS) {
  const modules = join(repoRoot, packageDir, "node_modules");
  if (!existsSync(modules)) {
    continue;
  }
  for (const entry of readdirSync(modules)) {
    if (entry.startsWith(".") || OUR_PACKAGES.has(entry)) {
      continue;
    }
    const full = join(modules, entry);
    if (entry.startsWith("@")) {
      for (const sub of readdirSync(full)) {
        const scopedName = `${entry}/${sub}`;
        if (OUR_PACKAGES.has(scopedName)) {
          continue;
        }
        linkDir(join(full, sub), join(appModules, entry, sub));
      }
      continue;
    }
    linkDir(full, join(appModules, entry));
  }
}

// ---- 3. 安装布局下跑 CLI ----
const binPath = join(appModules, "review-pi", "bin", "review-pi.js");
const configPath = join(appDir, "PiAgent.jsonc");
const env = {
  ...process.env,
  HOME: appDir,
  USERPROFILE: appDir,
  NO_COLOR: "1",
};

function runCli(args) {
  try {
    const stdout = execFileSync(process.execPath, [binPath, ...args], {
      cwd: appDir,
      env,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout };
  } catch (error) {
    return {
      status: typeof error.status === "number" ? error.status : 1,
      stdout: String(error.stdout ?? ""),
      stderr: String(error.stderr ?? ""),
    };
  }
}

const help = runCli([]);
const helpText = `${help.stdout}${help.stderr}`;
// 无子命令 = 用法提示（exit 1 是按设计），关键是被 bin 拉起的 main 真的跑到了这里
if (!helpText.includes("review-pi config") || !helpText.includes("missing command")) {
  fail(`安装布局下 bin/main 未能跑到用法提示（status=${help.status}）\n${helpText}`);
}
process.stdout.write("verify-pack: 安装布局下 bin 腿表 + main 入口 OK\n");

const init = runCli(["config", "init", "--config", configPath]);
if (init.status !== 0 || !existsSync(configPath)) {
  fail(`config init 失败（status=${init.status}）\n${init.stderr ?? ""}`);
}
const show = runCli(["config", "show", "--config", configPath, "--json"]);
if (show.status !== 0) {
  fail(`config show 失败（status=${show.status}）\n${show.stderr ?? ""}`);
}
const shown = JSON.parse(show.stdout);
if (shown.version !== 1 || typeof shown.values?.["limits.boundary.maxFiles"] !== "number") {
  fail("config show --json 的输出不是配置快照");
}
process.stdout.write("verify-pack: 安装布局下 config init/show OK\n");

// ---- 4. builtin 引擎在安装布局下的落点 ----
const configModuleUrl = pathToFileURL(
  join(appModules, "review-pi", "dist", "shared", "config.js"),
).href;
const probe = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `import { builtinPresentationEnginePath } from ${JSON.stringify(configModuleUrl)};
     process.stdout.write(builtinPresentationEnginePath());`,
  ],
  { encoding: "utf8", cwd: appDir },
);
if (probe.status !== 0) {
  fail(`builtin 引擎解析失败\n${probe.stderr}`);
}
const enginePath = probe.stdout.trim();
if (!existsSync(enginePath)) {
  fail(`builtin 引擎落点不存在: ${enginePath}`);
}
process.stdout.write(`verify-pack: builtin 引擎 -> ${posix(enginePath)}\n`);

// ---- 5. 原生/资产类依赖在安装布局下可用（tree-sitter wasm + ripgrep 二进制） ----
writeFileSync(join(appDir, "Probe.java"), "class Probe { void f() {} }\n");
const codeIntelProbe = spawnSync(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    `const { getJavaParser } = await import(${JSON.stringify(pathToFileURL(join(appModules, "review-pi", "dist", "codeintel", "java-parser.js")).href)});
     const parser = await getJavaParser();
     const tree = parser.parse("class Probe { void f() {} }");
     if (tree.rootNode.type !== "program") throw new Error("java 解析失败");
     const { rgListFiles } = await import(${JSON.stringify(pathToFileURL(join(appModules, "review-pi", "dist", "codeintel", "rg.js")).href)});
     const files = await rgListFiles(${JSON.stringify(appDir)}, "*.java");
     process.stdout.write(JSON.stringify({ root: tree.rootNode.type, files }));`,
  ],
  { encoding: "utf8", cwd: appDir },
);
if (codeIntelProbe.status !== 0) {
  fail(`tree-sitter / ripgrep 在安装布局下不可用\n${codeIntelProbe.stderr}`);
}
const codeIntel = JSON.parse(codeIntelProbe.stdout);
if (!codeIntel.files.includes("Probe.java")) {
  fail(`ripgrep 没有列出探针文件: ${codeIntel.files.join(", ")}`);
}
process.stdout.write("verify-pack: tree-sitter-java (wasm) + ripgrep 二进制 OK\n");

// ---- 5. 记一份安装面清单（排查用） ----
writeFileSync(
  join(workDir, "INSTALLED.md"),
  [
    "# verify-pack 安装面",
    "",
    "| 包 | 版本 |",
    "|---|---|",
    ...installed.map((entry) => `| \`${entry.name}\` | ${entry.version} |`),
    "",
    `临时安装目录：\`${posix(appDir)}\``,
    "",
  ].join("\n"),
);

process.stdout.write("verify-pack: 全绿（npm 多包发行面可用）\n");
