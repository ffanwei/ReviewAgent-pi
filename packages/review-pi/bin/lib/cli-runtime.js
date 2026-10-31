/**
 * review-pi CLI 运行时产物面（#7 P3b）：bin 的「在位检查 + mtime 新鲜度门」
 * 腿表与人话拒跑文案。纯 node 内建零依赖——bin 在 dist 可信之前运行，
 * 不能 import 任何构建产物（判鲜语义见同目录 compile-freshness.js）。
 *
 * 腿表 = dist/cli/main.js 导入图必需的全部运行时产物：vendored pi 四包
 * （ai / agent / chord / telemetry——经 node_modules default 条件消费 dist）+
 * review-llm（冻结仪器常量单源）+ 本包 CLI 镜像。后者是 vendored 源码形态
 * （无 prepare、构建显式执行），缺席/过期时 Node 的模块解析会在导入期秒死
 * ——在位检查必须覆盖全腿，不能只看本包产物。
 *
 * 定位方式（ADR-0026）：**模块解析**而不是硬编码 `<repo>/packages/<dir>`。
 * `import.meta.resolve` 让 Node 自己回答「这个包在哪」——源码工作树里它给的
 * 是 pnpm 链接指向的真实路径（`packages/ai/dist/index.js`），`pnpm deploy` /
 * 普通依赖安装给的则是 `<root>/node_modules/...`。两种布局同一份腿表。
 * 间接依赖（chord / pi-telemetry 只被 pi-agent-core 声明）从**已解析包的包根**
 * 的 `node_modules` 探测，与 Node 对消费方的解析布局一致。
 *
 * 判鲜只在**源码树形态**下生效：入口路径不含 `node_modules` 段且该腿的 `src/`
 * 存在。分发布局的 mtime 被拷贝过程统一改写（实测 pnpm deploy 会把 dist 与
 * src 的时间戳压平），拿它判鲜只会误拒跑；分发形态的正确判据是「在位」。
 *
 * 与 DSH 线 bin 的有意分家：陈旧即拒跑并给人话提示（DSH 线 bin 自动重编）。
 * 拒跑消息携带每腿的构建命令，重建动作永远留给用户显式执行。
 */

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { isCompileStale } from "./compile-freshness.js";

const packageDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const repoRoot = join(packageDir, "..", "..");

/** 本包 CLI 编译入口（spawn 目标） */
export const CLI_COMPILED_ENTRY = join(packageDir, "dist", "cli", "main.js");

/** 包名 → 构建命令（顺序 = 腿序；vendored 四包共用 root 脚本的依赖序） */
const PACKAGE_LEGS = [
  { label: "pi-ai (vendored)", specifier: "@review-agent-pi/pi-ai", buildCommand: "pnpm build:pi" },
  {
    label: "pi-agent-core (vendored)",
    specifier: "@review-agent-pi/pi-agent-core",
    buildCommand: "pnpm build:pi",
  },
  { label: "chord (vendored)", specifier: "@review-agent-pi/chord", buildCommand: "pnpm build:pi" },
  {
    label: "pi-telemetry (vendored)",
    specifier: "@review-agent-pi/pi-telemetry",
    buildCommand: "pnpm build:pi",
  },
  // 冻结仪器常量单源（prepare 在 pnpm install 时构建；源改后需重建）
  { label: "review-llm", specifier: "review-llm", buildCommand: "pnpm --filter review-llm build" },
];

/** 入口路径是否落在 node_modules 安装布局里（= 不是源码工作树形态） */
function isInstalledLayout(path) {
  return path.split(/[\\/]/).includes("node_modules");
}

/** `<pkg>/dist/index.js` → `<pkg>`（目录形态与 pnpm 链接目标都成立） */
function packageRootOf(entry) {
  return dirname(dirname(entry));
}

/**
 * 包根真实路径：pnpm 的 `node_modules/<pkg>` 是符号链接，Node 装载时会
 * 跟随（preserveSymlinks=false）。解析出真实路径后，「源码树形态」的判据
 * 才不会被链接路径里的 node_modules 段误伤（workspace 里 chord 挂在
 * `packages/agent/node_modules/` 下，真身是 `packages/chord`）。
 */
function realDir(dir) {
  try {
    return realpathSync(dir);
  } catch {
    return dir;
  }
}

/** 从包清单取入口相对路径（exports["."] 的 import/default → module → main） */
function manifestEntry(manifestPath) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  } catch {
    return "index.js";
  }
  const exportsRoot = manifest.exports?.["."];
  const fromExports =
    typeof exportsRoot === "string"
      ? exportsRoot
      : (exportsRoot?.import ?? exportsRoot?.default ?? exportsRoot?.require);
  return fromExports ?? manifest.module ?? manifest.main ?? "index.js";
}

/** 目录自身的 node_modules 里按标准布局探测包（间接依赖只有这条路） */
function probeInstalled(specifier, bases) {
  for (const base of bases) {
    const dir = join(base, "node_modules", ...specifier.split("/"));
    const manifestPath = join(dir, "package.json");
    if (!existsSync(manifestPath)) {
      continue;
    }
    return { dir, entry: join(dir, manifestEntry(manifestPath)) };
  }
  return undefined;
}

/** packageDir 的祖先链（允许 monorepo 提升布局） */
function ancestorDirs(dir) {
  const chain = [];
  let current = dir;
  for (;;) {
    const parent = dirname(current);
    if (parent === current) {
      return chain;
    }
    chain.push(parent);
    current = parent;
  }
}

/**
 * 定位一个包（包根 + 入口绝对路径）。
 *
 * 1. `import.meta.resolve`——Node 自己的答案（直接依赖：workspace 链接给出
 *    真实路径，安装布局给出 node_modules 路径）。`require.resolve` 在这里
 *    不适用：packages 的 exports 只声明 import/default 条件，require 会
 *    直接 ERR_PACKAGE_PATH_NOT_EXPORTED；
 * 2. 解析失败 ⇒ 间接依赖：在「本包 + 已解析的包根 + 仓库根 + 祖先链」的
 *    `node_modules` 里按标准布局探测（pnpm 隔离布局把 chord/telemetry 挂在
 *    pi-agent-core 自己的 node_modules 下）。
 *
 * 两条路都失败返回 undefined——依赖没装时不该伪造一个 `<repo>/packages/...`
 * 路径去判鲜，那会在分发形态里凭空造出「产物过期」。调用方把它记成缺席腿，
 * 文案指向安装/构建。
 */
function locatePackage(specifier, knownPackageDirs) {
  try {
    const entry = fileURLToPath(import.meta.resolve(specifier));
    const dir = realDir(packageRootOf(entry));
    return { dir, entry: join(dir, relative(packageRootOf(entry), entry)) };
  } catch {
    // 落到下面的安装布局探测
  }
  const probeBases = [packageDir, ...knownPackageDirs, repoRoot, ...ancestorDirs(packageDir)];
  const located = probeInstalled(specifier, probeBases);
  if (located === undefined) {
    return undefined;
  }
  const dir = realDir(located.dir);
  return { dir, entry: join(dir, relative(located.dir, located.entry)) };
}

/**
 * 腿表（label / 入口 / 源树 / 构建命令）。
 * `entry` 缺席（依赖未安装 / 无法解析）时为空串，由 `checkRuntimeArtifacts`
 * 报「依赖未安装」，而不是编造路径。
 */
export function runtimeLegs() {
  const knownPackageDirs = [];
  const legs = PACKAGE_LEGS.map(({ label, specifier, buildCommand }) => {
    const located = locatePackage(specifier, knownPackageDirs);
    if (located === undefined) {
      return { label, entry: "", sourceRoots: [], buildCommand };
    }
    knownPackageDirs.push(located.dir);
    return { label, entry: located.entry, sourceRoots: [join(located.dir, "src")], buildCommand };
  });
  legs.push({
    label: "review-pi CLI",
    entry: CLI_COMPILED_ENTRY,
    sourceRoots: [join(packageDir, "src")],
    buildCommand: "pnpm --filter review-pi build",
  });
  return legs;
}

/**
 * 该腿是否参与 mtime 判鲜：只在源码树形态下（入口不在 node_modules 里，且
 * 该腿确实有 `src/`）。分发形态一律只判在位。
 */
export function isFreshnessGateApplicable(leg) {
  return (
    leg.entry !== "" && !isInstalledLayout(leg.entry) && leg.sourceRoots.some((root) => existsSync(root))
  );
}

/** 在位 + 判鲜检查：任一腿缺席/过期即拒跑（全腿报告，一次给全） */
export function checkRuntimeArtifacts() {
  const refusals = [];
  for (const leg of runtimeLegs()) {
    if (leg.entry === "" || !existsSync(leg.entry)) {
      refusals.push({ kind: "missing", ...leg });
    } else if (isFreshnessGateApplicable(leg) && isCompileStale(leg.entry, leg.sourceRoots)) {
      refusals.push({ kind: "stale", ...leg });
    }
  }
  return refusals.length === 0 ? { ok: true } : { ok: false, refusals };
}

/** 拒跑文案（stderr）：每腿一行归因 + 一行构建指引；路径 repo 相对 POSIX 形态 */
export function renderRefusals(refusals) {
  const lines = [];
  for (const refusal of refusals) {
    const shown =
      refusal.entry === ""
        ? refusal.label
        : (() => {
            const rel = relative(repoRoot, refusal.entry);
            return (rel.startsWith("..") || isAbsolute(rel) ? refusal.entry : rel).split(sep).join("/");
          })();
    const cause =
      refusal.kind === "missing"
        ? refusal.entry === ""
          ? `依赖未安装或无法解析: ${shown}`
          : `构建产物缺席: ${shown}`
        : `产物过期（源树新于产物）: ${shown}`;
    lines.push(`review-pi: 拒跑——${cause}（腿: ${refusal.label}）`);
    lines.push(`  先${refusal.kind === "missing" ? "构建" : "重建"}: ${refusal.buildCommand}`);
  }
  return `${lines.join("\n")}\n`;
}
