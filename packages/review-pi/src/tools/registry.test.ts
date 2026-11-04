import { expect, test } from "vitest";
import { REVIEW_TOOL_ORDER, fromWireToolName, reviewToolSchemas, toWireToolName } from "./registry.js";

// 七工具注册表：不再对 DSH 审计真源逐字节对照（ADR-0038）。
//
// 保留的性质都独立于「外部真源长什么样」：
// - 工具面就是七个、名字唯一、顺序与 REVIEW_TOOL_ORDER 一致（审计按序投影）；
// - parametersJson 是可被模型消费的对象型 JSON Schema（canonical 键序 + 紧凑序列化，
//   决定 wire 字节稳定，但不再与历史记录比对）；
// - 点分名 ↔ 下划线名双向往返且无碰撞（运行期 fromWireToolName 遇到未知即抛错）。

test("工具集为七个、名字唯一、与 REVIEW_TOOL_ORDER 同序", () => {
  const schemas = reviewToolSchemas();
  expect(schemas).toHaveLength(7);
  expect(REVIEW_TOOL_ORDER).toHaveLength(schemas.length);

  const names = schemas.map((schema) => schema.name);
  expect(new Set(names).size).toBe(names.length);
  expect(names).toEqual([...REVIEW_TOOL_ORDER]);
  for (const schema of schemas) {
    expect(schema.description.trim().length).toBeGreaterThan(0);
  }
});

test("parametersJson 为对象型 JSON Schema 且 canonical 键序", () => {
  for (const schema of reviewToolSchemas()) {
    const parsed = JSON.parse(schema.parametersJson) as {
      type?: unknown;
      properties?: Record<string, unknown>;
      required?: readonly string[];
    };
    const keys = Object.keys(parsed);
    expect(keys).toEqual(["type", "properties", "required", "additionalProperties"]);
    expect(parsed.type).toBe("object");

    const properties = parsed.properties as Record<string, unknown>;
    expect(properties).toBeTypeOf("object");
    // properties 子键字典序（canonical 序列化的前提）
    expect([...Object.keys(properties)].sort()).toEqual(Object.keys(properties));
    // required ⊆ properties：声明必填却不给 schema 时模型无法产出可调用参数
    for (const name of parsed.required ?? []) {
      expect(Object.keys(properties)).toContain(name);
    }
    // 字节串与再序列化往返一致（无转义/空格残留）
    expect(JSON.stringify(parsed)).toBe(schema.parametersJson);
  }
});

test("wire 名映射：点分（审计口径）↔ 下划线（pi-ai/wire 口径）双向一致且无碰撞", () => {
  const wireNames: string[] = [];
  for (const schema of reviewToolSchemas()) {
    const wireName = toWireToolName(schema.name);
    expect(wireName).toBe(schema.name.replaceAll(".", "_"));
    expect(fromWireToolName(wireName)).toBe(schema.name);
    wireNames.push(wireName);
  }
  expect(new Set(wireNames).size).toBe(wireNames.length);
});
