import { expect, test } from "vitest";

import { REVIEW_PI_VERSION } from "../shared/version.js";
import {
  KERNEL_PACKAGES,
  PRODUCT_PACKAGE_NAME,
  renderVersionJson,
  renderVersionText,
  runVersionCommand,
  versionSnapshot,
} from "./version-command.js";

// version 子命令契约（ADR-0079）：产品版本单源、人读单行、JSON 覆盖内核四包，
// 不加载配置（进程面在 bin.process.test.ts 断言；这里锁纯函数形状）。

test("人读形态：恰好一行 review-pi <version>（可被 shell 直接消费）", () => {
  const text = renderVersionText();
  expect(text).toBe(`review-pi ${REVIEW_PI_VERSION}\n`);
  expect(text.trimEnd().split("\n")).toHaveLength(1);
});

test("快照：产品版本单源；node 取 process.version；内核四包按固定顺序", () => {
  const snapshot = versionSnapshot((specifier) =>
    specifier === "@earendil-works/pi-ai" ? "0.85.1" : null,
  );
  expect(snapshot.name).toBe(PRODUCT_PACKAGE_NAME);
  expect(snapshot.version).toBe(REVIEW_PI_VERSION);
  expect(snapshot.node).toBe(process.version);
  expect(Object.keys(snapshot.kernel)).toEqual([...KERNEL_PACKAGES]);
  expect(snapshot.kernel["@earendil-works/pi-ai"]).toBe("0.85.1");
  expect(snapshot.kernel["@earendil-works/chord"]).toBeNull();
});

test("--json：形状固定（name / version / node / kernel），解析失败记 null 不抛", () => {
  const text = renderVersionJson(versionSnapshot(() => null));
  const parsed = JSON.parse(text) as {
    name: string;
    version: string;
    node: string;
    kernel: Record<string, string | null>;
  };
  expect(parsed.name).toBe(PRODUCT_PACKAGE_NAME);
  expect(parsed.version).toBe(REVIEW_PI_VERSION);
  expect(parsed.node).toBe(process.version);
  for (const specifier of KERNEL_PACKAGES) {
    expect(parsed.kernel).toHaveProperty(specifier);
    expect(parsed.kernel[specifier]).toBeNull();
  }
});

test("runVersionCommand：人读恒一行、--json 恒结构化；退出码 0", () => {
  const lines: string[] = [];
  const code = runVersionCommand({}, { write: (text) => lines.push(text), resolveVersion: () => null });
  expect(code).toBe(0);
  expect(lines).toEqual([`review-pi ${REVIEW_PI_VERSION}\n`]);

  const jsonLines: string[] = [];
  const jsonCode = runVersionCommand(
    { json: true },
    { write: (text) => jsonLines.push(text), resolveVersion: () => "9.9.9" },
  );
  expect(jsonCode).toBe(0);
  const parsed = JSON.parse(jsonLines[0] as string) as { kernel: Record<string, string> };
  expect(parsed.kernel["@earendil-works/pi-agent-core"]).toBe("9.9.9");
});
