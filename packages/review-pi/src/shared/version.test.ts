import { readFileSync } from "node:fs";

import { expect, test } from "vitest";

import { REVIEW_PI_VERSION } from "./version.js";

// 版本单源：`clientInfo.version` 与发行版本必须一致（发版时两处一起改）。

test("REVIEW_PI_VERSION 与 package.json 的 version 同源", () => {
  const manifest = JSON.parse(
    readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
  ) as { version?: string };
  expect(REVIEW_PI_VERSION).toBe(manifest.version);
});
