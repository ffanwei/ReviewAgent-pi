import { expect, test } from "vitest";
import {
  CANDIDATES_PHASE_INDEX,
  PHASE_COUNT,
  PHASE_INSTRUCTIONS,
  PHASE_ORDER,
  buildPhaseInstruction,
} from "./phases.js";

// 六阶段指令（中文原生，ADR-0090）：不再对 DSH 审计真源逐字节对照（ADR-0038）。
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

test("每条指令都要求以单个 JSON 对象回复（ADR-0090 中文措辞）", () => {
  for (const instruction of PHASE_INSTRUCTIONS) {
    expect(instruction).toContain("只回一个 JSON 对象：");
  }
});

test("测试文件提示只挂在 Phase 5，其余阶段逐字节等于原指令", () => {
  PHASE_INSTRUCTIONS.forEach((instruction, index) => {
    const skipped = buildPhaseInstruction(index, true);
    const included = buildPhaseInstruction(index, false);
    if (index === CANDIDATES_PHASE_INDEX) {
      expect(skipped).toContain("测试文件已按配置从本 diff 中剔除");
      expect(included).toContain("测试文件已按配置包含在本 diff 中");
      expect(skipped.startsWith(instruction)).toBe(true);
      expect(included.startsWith(instruction)).toBe(true);
    } else {
      expect(skipped).toBe(instruction);
      expect(included).toBe(instruction);
    }
  });
});
