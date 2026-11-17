import { expect, test } from "vitest";
import { parseCandidatesReply, parseJsonReply, parseVerificationReply } from "./parse.js";

// 阶段回复解析（测量常量面语义：解析失败不抛异常、有界推进、可审计留痕）。

test("parseJsonReply 直收 JSON 对象", () => {
  expect(parseJsonReply('{"a":1}')).toEqual({ a: 1 });
});

test("parseJsonReply 剥掉 markdown 代码围栏后重试", () => {
  expect(parseJsonReply('```json\n{"a":1}\n```')).toEqual({ a: 1 });
  expect(parseJsonReply('```\n{"a":1}\n```')).toEqual({ a: 1 });
});

test("parseJsonReply 非法输入返回 undefined（不抛异常）", () => {
  expect(parseJsonReply("not json at all")).toBeUndefined();
  expect(parseJsonReply("```json\n{broken\n```")).toBeUndefined();
  expect(parseJsonReply("")).toBeUndefined();
});

test("parseCandidatesReply 提取 candidates 数组", () => {
  const out = parseCandidatesReply('{"candidates":[{"id":"F001"},{"id":"F002"}]}');
  expect(out.candidates).toEqual([{ id: "F001" }, { id: "F002" }]);
  expect(out.note).toBeUndefined();
});

test("parseCandidatesReply 容错：非 JSON / 缺 candidates 数组 → 空结果 + 留痕", () => {
  const notJson = parseCandidatesReply("garbage");
  expect(notJson.candidates).toEqual([]);
  expect(notJson.note).toBeDefined();

  const noArray = parseCandidatesReply('{"summary":"no candidates here"}');
  expect(noArray.candidates).toEqual([]);
  expect(noArray.note).toBeDefined();

  // JSON 但非对象（数组/字符串）同样按不可用处理
  expect(parseCandidatesReply("[1,2]").candidates).toEqual([]);
});

test("parseVerificationReply 提取 verdicts 与 complete 信号", () => {
  const out = parseVerificationReply(
    '{"verdicts":[{"id":"F001","pass":true,"reason":"ok"},{"id":"F002","pass":false,"reason":"unsupported"}],"complete":true}',
  );
  expect(out.complete).toBe(true);
  expect(out.verdicts.get("F001")).toEqual({ pass: true, reason: "ok" });
  expect(out.verdicts.get("F002")).toEqual({ pass: false, reason: "unsupported" });
  expect(out.note).toBeUndefined();
});

test("parseVerificationReply 的 complete 仅在严格 true 时为真", () => {
  expect(parseVerificationReply('{"verdicts":[],"complete":true}').complete).toBe(true);
  expect(parseVerificationReply('{"verdicts":[],"complete":false}').complete).toBe(false);
  expect(parseVerificationReply('{"verdicts":[]}').complete).toBe(false);
  expect(parseVerificationReply('{"verdicts":[],"complete":"true"}').complete).toBe(false);
});

test("parseVerificationReply 跳过畸形 verdict 条目并留痕", () => {
  const out = parseVerificationReply(
    '{"verdicts":[{"id":"F001","pass":true},{"noId":true},{"id":"F002"}],"complete":true}',
  );
  expect(out.verdicts.size).toBe(2);
  expect(out.verdicts.get("F002")).toEqual({ pass: false, reason: "" });
  expect(out.note).toBeDefined();
});

test("parseVerificationReply 容错：非 JSON / 缺 verdicts → 空裁决 + complete false", () => {
  const notJson = parseVerificationReply("garbage");
  expect(notJson.verdicts.size).toBe(0);
  expect(notJson.complete).toBe(false);
  expect(notJson.note).toBeDefined();

  const noVerdicts = parseVerificationReply('{"complete":true}');
  expect(noVerdicts.verdicts.size).toBe(0);
  expect(noVerdicts.complete).toBe(true);
  expect(noVerdicts.note).toBeDefined();
});

// ---- P0：宽松提取（前后白话 / 围栏 / 示例陷阱 / 分级失败原因） ----

const FENCE = "```";

test("parseJsonReply 容忍围栏前后白话（P0）", () => {
  expect(parseJsonReply(`Here:\n${FENCE}json\n{"a":1}\n${FENCE}\nDone`)).toEqual({ a: 1 });
});

test("parseCandidatesReply 容忍围栏+前置白话", () => {
  const out = parseCandidatesReply(
    `Here is the result:\n${FENCE}json\n{"candidates":[{"id":"F1"}]}\n${FENCE}`,
  );
  expect(out.candidates).toEqual([{ id: "F1" }]);
  expect(out.note).toBeUndefined();
  expect(out.failure).toBeUndefined();
});

test("parseCandidatesReply 容忍裸 JSON + 后置白话", () => {
  const out = parseCandidatesReply('{"candidates":[]}\nHope this helps!');
  expect(out.candidates).toEqual([]);
  expect(out.note).toBeUndefined();
});

test("parseCandidatesReply 多个围栏块：取含 candidates 的最后一个", () => {
  const text = `${FENCE}json\n{"candidates":[]}\n${FENCE}\nand\n${FENCE}json\n{"candidates":[{"id":"F1"}]}\n${FENCE}`;
  expect(parseCandidatesReply(text).candidates).toEqual([{ id: "F1" }]);
});

test("parseCandidatesReply 先给示例对象再给真结果：不取示例（P0 关键）", () => {
  const text = '格式如下：{"candidates":[]}。本次结果：{"candidates":[{"id":"REAL"}]}';
  expect(parseCandidatesReply(text).candidates).toEqual([{ id: "REAL" }]);
});

test("parseCandidatesReply 分级原因：empty / truncated / not-json / missing-key", () => {
  expect(parseCandidatesReply("").failure).toBe("empty");
  expect(parseCandidatesReply('{"candidates":[{"id":"F1"').failure).toBe("truncated");
  expect(parseCandidatesReply("not json at all").failure).toBe("not-json");
  expect(parseCandidatesReply('{"summary":"no candidates here"}').failure).toBe("missing-key");
  // 截断/非 JSON 的诊断保留 "JSON" 字样（审计按它 grep）
  expect(parseCandidatesReply("not json at all").note).toContain("JSON");
  expect(parseCandidatesReply('{"candidates":[{"id":"F1"').note).toContain("JSON");
});

test("parseVerificationReply 先给示例对象再给真结果：取后者", () => {
  const text =
    '示例：{"verdicts":[],"complete":false}。结果：{"verdicts":[{"id":"F1","pass":true}],"complete":true}';
  const out = parseVerificationReply(text);
  expect(out.complete).toBe(true);
  expect(out.verdicts.get("F1")).toEqual({ pass: true, reason: "" });
});

test("parseVerificationReply 分级原因：missing verdicts 是 missing-key", () => {
  const out = parseVerificationReply('{"complete":true}');
  expect(out.failure).toBe("missing-key");
  expect(out.complete).toBe(true);
});

