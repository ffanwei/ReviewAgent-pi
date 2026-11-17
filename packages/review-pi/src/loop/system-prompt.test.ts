import { expect, test } from "vitest";
import { PHASE_ORDER } from "../loop/phases.js";
import { SYSTEM_PROMPT } from "./system-prompt.js";

// Zone A 系统提示：不再对 DSH 审计真源逐字节对照（ADR-0038）。
//
// 保留的是「可安全装配进请求」这一独立性质，而不是内容复述：
// 非空、首尾无游离空白（messages[0].content 原样上 wire）、六阶段名全部点名
// （提示词与阶段机不能各说各话）。
test("SYSTEM_PROMPT 可安全装配（非空、无首尾空白、点名六阶段）", () => {
  expect(SYSTEM_PROMPT.trim().length).toBeGreaterThan(0);
  expect(SYSTEM_PROMPT).toBe(SYSTEM_PROMPT.trim());
  for (const name of PHASE_ORDER) {
    expect(SYSTEM_PROMPT).toContain(name);
  }
});
