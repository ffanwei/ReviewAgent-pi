import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { REVIEW_PI_VERSION } from "../shared/version.js";
import type { VersionCliArgs } from "./args.js";

/**
 * `review-pi version`（ADR-0079）：纯展示命令——不加载配置、不需要 apiKey、
 * 不碰模型 / 文件系统产物，和 `export` 一样在 `main()` 的配置装载之前返回。
 *
 * 契约：
 * - 人读形态 stdout **恰好一行** `review-pi <version>`（可被 `cut` / 正则直接消费）；
 * - `--json` 输出结构化快照（产品 / Node / 内核四包实际解析版本），供支持与 CI 用；
 * - 版本值的唯一真源仍是 `shared/version.ts`（与 `package.json` 的同源测试守护），
 *   这里**不**在运行时读本包 `package.json`。
 *
 * 内核四包（ADR-0035：npm 依赖、精确锁版本）的版本是「实际解析到的那一份」，
 * 不再重复写死常量：同一条安装布局下，`import.meta.resolve` 给出的路径就是
 * Node 真正会装载的包。解析失败（依赖没装 / 布局异常）记 `null`，不影响退出码。
 */

/** 产品包名（与 `packages/review-pi/package.json` 一致；只用于结构化输出） */
export const PRODUCT_PACKAGE_NAME = "@baize/review-pi";

/** 内核四包（ADR-0035）：顺序稳定，JSON 输出按此顺序 */
export const KERNEL_PACKAGES = [
  "@earendil-works/pi-ai",
  "@earendil-works/pi-agent-core",
  "@earendil-works/chord",
  "@earendil-works/pi-telemetry",
] as const;

/** 结构化版本快照（`version --json` 的形状） */
export interface VersionSnapshot {
  readonly name: typeof PRODUCT_PACKAGE_NAME;
  /** 产品版本（`shared/version.ts` 单源） */
  readonly version: string;
  /** Node 版本（`process.version`，形如 `v22.19.0`） */
  readonly node: string;
  /** 内核四包实际解析到的版本；未安装 / 解析失败为 `null` */
  readonly kernel: Readonly<Record<string, string | null>>;
}

/**
 * 一个已安装依赖的版本：先由 Node 解析包入口，再从包根读 `package.json`。
 *
 * 不能直接 `require.resolve("<pkg>/package.json")`——内核包的 `exports` 只声明
 * `types` / `import` 条件，没有 `./package.json` 子路径导出（与 `bin/lib/cli-runtime.js`
 * 的定位方式同一理由）。入口恒为 `<pkg>/dist/<file>.js`，包根即上两级。
 */
export function resolveInstalledPackageVersion(specifier: string): string | null {
  try {
    const entry = fileURLToPath(import.meta.resolve(specifier));
    const manifest = JSON.parse(
      readFileSync(join(dirname(dirname(entry)), "package.json"), "utf8"),
    ) as { name?: unknown; version?: unknown };
    // 入口布局变了也不要报错：只认名字对得上的清单（否则宁可为 null）
    if (manifest.name !== specifier || typeof manifest.version !== "string") {
      return null;
    }
    return manifest.version;
  } catch {
    return null;
  }
}

/** 版本快照（`resolveVersion` 可注入：单元测试不依赖真实安装布局） */
export function versionSnapshot(
  resolveVersion: (specifier: string) => string | null = resolveInstalledPackageVersion,
): VersionSnapshot {
  const kernel: Record<string, string | null> = {};
  for (const specifier of KERNEL_PACKAGES) {
    kernel[specifier] = resolveVersion(specifier);
  }
  return {
    name: PRODUCT_PACKAGE_NAME,
    version: REVIEW_PI_VERSION,
    node: process.version,
    kernel,
  };
}

/** 人读形态：恰好一行，且只有产品名 + 版本 */
export function renderVersionText(): string {
  return `review-pi ${REVIEW_PI_VERSION}\n`;
}

/** `--json` 形态：与 `config show --json` 同款缩进 */
export function renderVersionJson(
  snapshot: VersionSnapshot = versionSnapshot(),
): string {
  return `${JSON.stringify(snapshot, null, 2)}\n`;
}

/** 执行 version 子命令；返回进程退出码（纯展示，恒 0） */
export function runVersionCommand(
  args: VersionCliArgs,
  options: {
    readonly write?: (text: string) => void;
    readonly resolveVersion?: (specifier: string) => string | null;
  } = {},
): number {
  const write = options.write ?? ((text: string) => void process.stdout.write(text));
  if (args.json === true) {
    write(renderVersionJson(versionSnapshot(options.resolveVersion)));
  } else {
    write(renderVersionText());
  }
  return 0;
}
