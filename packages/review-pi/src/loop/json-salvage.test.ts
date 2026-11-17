import { describe, expect, test } from "vitest";
import { salvageCandidatesReply, salvageVerificationReply } from "./json-salvage.js";

function candidate(id: string, description = "desc"): string {
  return `{"id":"${id}","severity":"P2","category":"bug","file":"src/A.java","line":10,"title":"t","description":"${description}","evidence":["e"],"rule":"r","confidence":0.7}`;
}

describe("salvageCandidatesReply", () => {
  test("合法 JSON 不走 salvage（没有可修字符）", () => {
    expect(salvageCandidatesReply(`{"candidates":[${candidate("F001")}]}`)).toBeUndefined();
  });

  test("正文里的裸引号可被修复，且条目数验收通过", () => {
    const text = `{"candidates":[${candidate("F001", 'uses "foo" here')}]}`;
    // JSON.stringify 无法直接生成裸引号，这里手工构造
    const malformed = text.replace('uses \\"foo\\" here', 'uses "foo" here');
    const salvaged = salvageCandidatesReply(malformed);
    expect(salvaged).toHaveLength(1);
    expect((salvaged?.[0] as { id?: string }).id).toBe("F001");
  });

  test("修复后条目数少于原文 id 数 → 拒绝（有损恢复）", () => {
    const malformed = `{"candidates":[${candidate("F001")},{"id":"F002"`;
    expect(salvageCandidatesReply(malformed)).toBeUndefined();
  });

  test("末尾缺外层 } → 结构修复后可接受", () => {
    const malformed = `{"candidates":[${candidate("F001")}]`;
    const salvaged = salvageCandidatesReply(malformed);
    expect(salvaged).toHaveLength(1);
  });

  test("已知良性扩展字段（confidence_note）不拒绝", () => {
    const malformed =
      '{"candidates":[{"id":"F001","severity":"P2","category":"bug","file":"a","line":1,"title":"t","description":"uses "foo" here","evidence":[],"rule":"r","confidence":0.5,"confidence_note":"why"}]}';
    expect(salvageCandidatesReply(malformed)).toHaveLength(1);
  });

  test("未知字段 → 拒绝", () => {
    const malformed = `{"candidates":[{"id":"F001","severity":"P2","category":"bug","file":"a","line":1,"title":"t","description":"uses "foo" here","evidence":[],"rule":"r","confidence":0.5,"prose":"x"}]}`;
    expect(salvageCandidatesReply(malformed)).toBeUndefined();
  });
});

describe("salvageVerificationReply", () => {
  test("正文裸引号修复后返回裁决与 complete", () => {
    const malformed = '{"verdicts":[{"id":"F001","pass":true,"reason":"uses "foo" here"}],"complete":true}';
    const salvaged = salvageVerificationReply(malformed);
    expect(salvaged?.entries).toHaveLength(1);
    expect(salvaged?.complete).toBe(true);
  });

  test("缺少 complete / 条目数不足 → 拒绝", () => {
    expect(
      salvageVerificationReply('{"verdicts":[{"id":"F001","pass":true,"reason":"ok"}]}'),
    ).toBeUndefined();
    expect(
      salvageVerificationReply('{"verdicts":[{"id":"F001","pass":true,"reason":"ok"}],"complete":true}'),
    ).toBeUndefined();
  });
});
