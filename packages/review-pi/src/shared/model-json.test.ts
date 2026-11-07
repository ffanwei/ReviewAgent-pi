import { expect, test } from "vitest";
import { extractModelJson } from "./model-json.js";

// 宽松 JSON 提取器（P0）：整串 → 剥围栏 → 花括号配平扫描；
// 多对象优先取「含目标键的最后一个对象」。

const FENCE = "```";

test("纯 JSON 直接解析", () => {
  expect(extractModelJson('{"candidates":[{"id":"F1"}]}').value).toEqual({
    candidates: [{ id: "F1" }],
  });
});

test("纯围栏 JSON 剥围栏后解析", () => {
  expect(extractModelJson(`${FENCE}json\n{"candidates":[]}\n${FENCE}`).value).toEqual({
    candidates: [],
  });
  expect(extractModelJson(`${FENCE}\n{"a":1}\n${FENCE}`).value).toEqual({ a: 1 });
});

test("围栏前后夹白话照样能提取", () => {
  expect(
    extractModelJson(`Here is the result:\n${FENCE}json\n{"candidates":[{"id":"F1"}]}\n${FENCE}`)
      .value,
  ).toEqual({ candidates: [{ id: "F1" }] });
  expect(
    extractModelJson(`${FENCE}json\n{"candidates":[]}\n${FENCE}\nHope this helps!`).value,
  ).toEqual({ candidates: [] });
});

test("裸 JSON + 后置白话", () => {
  expect(extractModelJson('{"candidates":[]}\nLet me know if you need more.').value).toEqual({
    candidates: [],
  });
});

test("多个围栏块：取含目标键的最后一个对象", () => {
  const text = `${FENCE}json\n{"candidates":[]}\n${FENCE}\nand\n${FENCE}json\n{"candidates":[{"id":"F1"}]}\n${FENCE}`;
  expect(extractModelJson(text, { preferKey: "candidates" }).value).toEqual({
    candidates: [{ id: "F1" }],
  });
});

test("示例对象在前、真结果在后：preferKey 取最后一个（避开示例陷阱）", () => {
  const text =
    '格式如下：{"candidates":[]}。本次结果：{"candidates":[{"id":"REAL"}]}';
  expect(extractModelJson(text, { preferKey: "candidates" }).value).toEqual({
    candidates: [{ id: "REAL" }],
  });
});

test("白话里出现不成 JSON 的花括号：继续往后找真结果", () => {
  const text = '说明 { 这里是解释 }，结果：{"candidates":[{"id":"F1"}]}';
  expect(extractModelJson(text, { preferKey: "candidates" }).value).toEqual({
    candidates: [{ id: "F1" }],
  });
});

test("字符串内的花括号 / 转义引号 / 反斜杠不破坏配平", () => {
  const text = '{"candidates":[{"review":"if (x) { return; } 用 \\"y\\" 和 C:\\\\tmp"}]}';
  expect(extractModelJson(text, { preferKey: "candidates" }).value).toEqual({
    candidates: [{ review: 'if (x) { return; } 用 "y" 和 C:\\tmp' }],
  });
});

test("嵌套对象：preferKey 命中外层", () => {
  const text = '{"candidates":[{"id":"F1"}],"note":{"x":1}}';
  expect(extractModelJson(text, { preferKey: "candidates" }).value).toEqual({
    candidates: [{ id: "F1" }],
    note: { x: 1 },
  });
});

test("截断 JSON → truncated", () => {
  expect(extractModelJson('{"candidates":[{"id":"F1"').failure).toBe("truncated");
});

test("空回复 → empty", () => {
  expect(extractModelJson("").failure).toBe("empty");
  expect(extractModelJson("   \n\t").failure).toBe("empty");
});

test("纯白话 → not-json", () => {
  expect(extractModelJson("not json at all").failure).toBe("not-json");
  expect(extractModelJson("I cannot produce JSON {").failure).toBe("truncated");
});

test("解析出对象但缺目标键 → missing-key（仍返回对象）", () => {
  const out = extractModelJson('{"summary":"no candidates here"}', { preferKey: "candidates" });
  expect(out.failure).toBe("missing-key");
  expect(out.value).toEqual({ summary: "no candidates here" });
});

test("无 preferKey：取最后一个完整对象", () => {
  expect(extractModelJson('前置 {"a":1} 后置 {"b":2}').value).toEqual({ b: 2 });
});

test("整串是数组：保持 JSON 语义（由调用方判形状）", () => {
  expect(extractModelJson("[1,2]").value).toEqual([1, 2]);
});
