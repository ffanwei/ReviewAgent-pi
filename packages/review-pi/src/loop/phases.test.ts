import { expect, test } from "vitest";
import {
  CANDIDATES_PHASE_INDEX,
  PHASE_COUNT,
  PHASE_INSTRUCTIONS,
  PHASE_ORDER,
  SCAN_PHASE_INSTRUCTIONS,
  SCAN_PHASE_ORDER,
  buildPhaseInstruction,
  buildStageInstruction,
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

test("compact：Phase 1 合并风险分级、Phase 3 允许空 neededContext，其余阶段不变", () => {
  for (let index = 0; index < PHASE_COUNT; index += 1) {
    const compact = buildStageInstruction(index, false, "compact");
    if (index === 0) {
      expect(compact.startsWith(`Phase 1 of 6 - ${PHASE_ORDER[0]}.\n`)).toBe(true);
      expect(compact).toContain('"riskClass"');
      expect(compact).toContain("不要调用工具");
      expect(compact).toContain('"summary"');
    } else if (index === 2) {
      expect(compact.startsWith(`Phase 3 of 6 - ${PHASE_ORDER[2]}.\n`)).toBe(true);
      expect(compact).toContain("neededContext 返回空数组");
    } else {
      expect(compact).toBe(buildPhaseInstruction(index, false));
    }
  }
});

test("repo 模式：scan 六阶段与命名序一一对应，且不带 MR 变更语义", () => {
  expect(SCAN_PHASE_INSTRUCTIONS).toHaveLength(6);
  expect(SCAN_PHASE_ORDER).toHaveLength(6);
  SCAN_PHASE_INSTRUCTIONS.forEach((instruction, index) => {
    expect(instruction.startsWith(`Phase ${index + 1} of 6 - ${SCAN_PHASE_ORDER[index]}.`)).toBe(
      true,
    );
    expect(instruction).toContain("只回一个 JSON 对象：");
    expect(instruction).not.toContain("本次 diff");
    expect(instruction).not.toContain("本次变更引入");
    // compact / 测试文件提示都不应把 MR 指令混进 repo 模式。
    expect(buildStageInstruction(index, true, "compact", "repo")).toBe(instruction);
  });
});
