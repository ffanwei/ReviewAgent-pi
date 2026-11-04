import { describe, expect, test } from "vitest";

import {
  decodeMessage,
  encodeMessage,
  parseSseFrames,
  ProtocolError,
} from "./protocol.js";

// JSON-RPC 编解码与 SSE 分帧（ADR-0037 决策 4）：纯函数，解析必须严格。

describe("encodeMessage", () => {
  test("请求与通知都是单行 JSON", () => {
    expect(encodeMessage({ jsonrpc: "2.0", id: 1, method: "initialize", params: { a: 1 } })).toBe(
      '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"a":1}}',
    );
    expect(encodeMessage({ jsonrpc: "2.0", method: "notifications/initialized" })).toBe(
      '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    );
  });
});

describe("decodeMessage", () => {
  test("成功与失败响应都按原样解出", () => {
    expect(decodeMessage('{"jsonrpc":"2.0","id":7,"result":{"ok":true}}')).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: { ok: true },
    });
    expect(
      decodeMessage('{"jsonrpc":"2.0","id":8,"error":{"code":-32601,"message":"no such tool"}}'),
    ).toEqual({
      jsonrpc: "2.0",
      id: 8,
      error: { code: -32601, message: "no such tool" },
    });
  });

  test.each([
    ["not json", "invalid-json", "nope"],
    ["array", "invalid-message", "[]"],
    ["missing jsonrpc", "invalid-version", '{"id":1,"result":null}'],
    ["notification (no id)", "invalid-id", '{"jsonrpc":"2.0","method":"x"}'],
    ["both result and error", "ambiguous", '{"jsonrpc":"2.0","id":1,"result":1,"error":{"code":1,"message":"x"}}'],
    ["neither", "ambiguous", '{"jsonrpc":"2.0","id":1}'],
    ["bad error shape", "invalid-error", '{"jsonrpc":"2.0","id":1,"error":{"code":"x","message":1}}'],
  ])("%s → ProtocolError(%s)", (_label, code, raw) => {
    expect.assertions(2);
    try {
      decodeMessage(raw);
    } catch (error) {
      expect(error).toBeInstanceOf(ProtocolError);
      expect((error as ProtocolError).code).toBe(code);
    }
  });
});

describe("parseSseFrames", () => {
  test("多行 data 按 \\n 拼接，空行分帧，注释与 event/id/retry 忽略", () => {
    const body = [
      ": keep-alive",
      "event: message",
      "id: 1",
      'data: {"a":1}',
      "",
      "data: line-1",
      "data: line-2",
      "",
      "retry: 1000",
      "",
    ].join("\n");
    expect(parseSseFrames(body)).toEqual(['{"a":1}', "line-1\nline-2"]);
  });

  test("CRLF 与无空格 data: 都能解", () => {
    expect(parseSseFrames('data:{"x":1}\r\n\r\ndata: two\r\n\r\n')).toEqual(['{"x":1}', "two"]);
  });

  test("空正文 / 只有注释 → 零帧", () => {
    expect(parseSseFrames("")).toEqual([]);
    expect(parseSseFrames(": nothing\n\n")).toEqual([]);
  });
});
