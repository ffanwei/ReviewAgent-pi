import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";

import {
  CLI_COMPILED_ENTRY,
  isFreshnessGateApplicable,
  renderRefusals,
  runtimeLegs,
} from "../../bin/lib/cli-runtime.js";

// 腿表定位（ADR-0026）：入口由**模块解析**给出，不再硬编码 `<repo>/packages/<dir>`。
// 这里锁两件事：
//   1. 每腿入口落在它声明的那个包里（清单 name 对得上——解析错了会立刻现形，
//      比如解析到提升的另一份同包副本）；
//   2. 判鲜门只在源码树形态生效（分发布局 mtime 被拷贝压平，判鲜只会误拒跑）。

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 腿 label → 该腿应属的包名（与 cli-runtime.js 的 PACKAGE_LEGS 同源断言） */
const EXPECTED_PACKAGE: Record<string, string> = {
  "pi-ai (vendored)": "@review-agent-pi/pi-ai",
  "pi-agent-core (vendored)": "@review-agent-pi/pi-agent-core",
  "chord (vendored)": "@review-agent-pi/chord",
  "pi-telemetry (vendored)": "@review-agent-pi/pi-telemetry",
  "review-llm": "review-llm",
};

test("腿表按模块解析定位：每腿入口属于声明包，不依赖仓库 packages/ 目录名", () => {
  const legs = runtimeLegs();
  expect(legs.map((leg) => leg.label)).toEqual([...Object.keys(EXPECTED_PACKAGE), "review-pi CLI"]);

  for (const leg of legs) {
    expect(leg.entry).not.toBe("");
    // 包根 = 该腿源树的上一级（腿表里源树与入口必须同属一个包——判鲜比较的
    // 是「这个包的 src vs 这个包的 dist」）
    const sourceRoot = leg.sourceRoots[0];
    expect(sourceRoot?.endsWith(path.join("", "src"))).toBe(true);
    const packageRoot = path.resolve(sourceRoot!, "..");
    const manifest = JSON.parse(readFileSync(path.join(packageRoot, "package.json"), "utf8")) as {
      name?: string;
    };
    const expected = EXPECTED_PACKAGE[leg.label] ?? "review-pi";
    expect(manifest.name).toBe(expected);
    expect(path.isAbsolute(leg.entry)).toBe(true);
  }
});

test("本包 CLI 腿指向 bin 的 spawn 目标，源树 = 本包 src", () => {
  const legs = runtimeLegs();
  const cli = legs[legs.length - 1];
  expect(cli?.entry).toBe(CLI_COMPILED_ENTRY);
  expect(cli?.buildCommand).toBe("pnpm --filter review-pi build");
  expect(cli?.sourceRoots).toHaveLength(1);
  expect(cli?.sourceRoots[0]?.endsWith(path.join("review-pi", "src"))).toBe(true);
});

test("判鲜门只在源码树形态生效：node_modules 布局 / 无 src / 未解析一律不判鲜", () => {
  const base = makeTempDir("review-pi-legs-");
  const sourceRoot = path.join(base, "src");
  mkdirSync(sourceRoot);
  const leg = (entry: string, sourceRoots: string[]) => ({
    label: "leg",
    entry,
    sourceRoots,
    buildCommand: "pnpm build:pi",
  });

  // 源码工作树：入口不在 node_modules 里且 src 在 → 判鲜
  expect(isFreshnessGateApplicable(leg(path.join(base, "dist", "index.js"), [sourceRoot]))).toBe(true);
  // pnpm deploy / 依赖安装布局：入口在 node_modules 里 → 只判在位
  expect(
    isFreshnessGateApplicable(
      leg(path.join(base, "node_modules", "pkg", "dist", "index.js"), [sourceRoot]),
    ),
  ).toBe(false);
  // 源码树没有 src（只发 dist 的形态）→ 不判鲜
  expect(
    isFreshnessGateApplicable(leg(path.join(base, "dist", "index.js"), [path.join(base, "no-src")])),
  ).toBe(false);
  // 依赖都没解析出来 → 不判鲜（缺席交给在位检查报）
  expect(isFreshnessGateApplicable(leg("", []))).toBe(false);
});

test("拒跑文案：未解析的腿指向安装/构建，源码树腿给 repo 相对 POSIX 路径", () => {
  const unresolved = renderRefusals([
    {
      kind: "missing",
      label: "chord (vendored)",
      entry: "",
      sourceRoots: [],
      buildCommand: "pnpm build:pi",
    },
  ]);
  expect(unresolved).toContain("依赖未安装或无法解析");
  expect(unresolved).toContain("pnpm build:pi");

  const legs = runtimeLegs();
  const cliLeg = legs[legs.length - 1];
  const stale = renderRefusals([{ kind: "stale", ...cliLeg! }]);
  expect(stale).toContain("产物过期");
  expect(stale).toContain("packages/review-pi/dist/cli/main.js");
  // 路径一律 POSIX 形态（跨平台可复现的文案）
  expect(stale).not.toContain("\\");
});
