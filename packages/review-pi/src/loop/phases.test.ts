import { expect, test } from "vitest";
import { PHASE_COUNT, PHASE_INSTRUCTIONS, PHASE_ORDER } from "./phases.js";

// 六阶段指令：不再对 DSH 审计真源逐字节对照（ADR-0038）。
//
// 保留三条可独立判断的性质（阶段内容可演进，但骨架不能悄悄坏）：
// - 数量与命名序一一对应；
// - 每条以 `Phase N of 6 - <name>.` 起头（模型按此识别当前阶段）；
// - 每条都要求「只回一个 JSON 对象」（阶段解析器的前提）。
test("六阶段指令与命名序一一对应", () => {
  expect(PHASE_INSTRUCTIONS).toHaveLength(6);
  expect(PHASE_ORDER).toHaveLength(PHASE_INSTRUCTIONS.length);
  expect(PHASE_COUNT).toBe(6);
});

test("每条指令以 `Phase N of 6 - <name>.` 起头", () => {
  PHASE_INSTRUCTIONS.forEach((instruction, index) => {
    expect(instruction.startsWith(`Phase ${index + 1} of 6 - ${PHASE_ORDER[index]}.\n`)).toBe(true);
  });
});

test("每条指令都要求以单个 JSON 对象回复", () => {
  for (const instruction of PHASE_INSTRUCTIONS) {
    expect(instruction).toContain("Reply with a single JSON object:");
  }
});
