// 模型 JSON 回复的统一宽松提取器（P0）。
//
// 模型输出经常不是「纯 JSON」：前面有 "Here is the result:"、后面跟一句
// "Hope this helps!"、包在 ```json 围栏里、甚至先给一个格式示例对象再给真
// 结果。严格 `JSON.parse(整串)` 会把这类回复整批判失败。
//
// 本模块把三处解析入口（Phase 5 候选 / Phase 6 裁决 / 一次性报文）收口到
// 同一实现：
//   1. 整串解析（纯 JSON / 纯围栏 JSON 的原有快路径）；
//   2. 剥掉首尾围栏后再整串解析；
//   3. 花括号配平扫描：从文本里收集所有**完整**对象，按出现位置排序。
//
// 选取规则：给了 `preferKey` 时取「含该键的最后一个对象」——模型通常先给
// 示例、后给真结果，取最后一个能避开示例对象陷阱；没有匹配键时退回最后
// 一个**最外层**对象，由调用方判断目标键缺失（`missing-key`）。
//
// 失败返回分级原因（empty / truncated / not-json / missing-key），不抛异常：
// 调用方按「有界推进」处理，只把原因写进审计/进度。

import type { ModelJsonFailureKind } from "../contracts/run.js";

export interface ModelJsonOptions {
  /**
   * 目标键（如 `candidates` / `verdicts` / `tips`）。多对象场景下优先取
   * 「含该键的最后一个对象」，避开模型先给的示例对象。
   */
  readonly preferKey?: string;
}

export interface ModelJsonExtraction {
  /** 解析出的 JSON 值；完全无法解析时缺席 */
  readonly value?: unknown;
  /**
   * 为什么没有拿到调用方期望的形状：
   * - `empty`：回复为空；
   * - `truncated`：扫描到未闭合对象（输出被截断）；
   * - `not-json`：没有可解析的 JSON 值；
   * - `missing-key`：解析出对象，但没有 `preferKey`。
   * 成功时为缺席。
   */
  readonly failure?: ModelJsonFailureKind;
}

/** 扫描结果：完整对象区间 + 是否存在未闭合的 `{` */
interface ObjectSpan {
  readonly start: number;
  readonly end: number;
  /** 最外层对象（扫描栈归零时闭合） */
  readonly topLevel: boolean;
}

interface ObjectSpans {
  readonly spans: readonly ObjectSpan[];
  readonly unbalanced: boolean;
}

interface ParsedObject {
  readonly start: number;
  readonly value: Record<string, unknown>;
  readonly topLevel: boolean;
}

export function extractModelJson(
  text: string,
  options: ModelJsonOptions = {},
): ModelJsonExtraction {
  const trimmed = text.replace(/^\uFEFF/, "").trim();
  if (trimmed.length === 0) {
    return { failure: "empty" };
  }

  // 快路径 1：整串就是 JSON（含纯数组/标量——保持旧 parseJsonReply 语义）
  const direct = tryParse(trimmed);
  if (direct !== undefined) {
    return successOf(direct, options.preferKey);
  }
  // 快路径 2：剥掉首尾围栏后再整串解析（```json … ```）
  const unfenced = stripFenceMarkers(trimmed);
  if (unfenced !== trimmed) {
    const fenced = tryParse(unfenced);
    if (fenced !== undefined) {
      return successOf(fenced, options.preferKey);
    }
  }

  // 慢路径：花括号配平扫描，收集所有完整对象
  const scanned = scanObjectSpans(trimmed);
  const objects = collectObjects(trimmed, scanned.spans);
  if (objects.length === 0) {
    return { failure: scanned.unbalanced ? "truncated" : "not-json" };
  }

  const chosen = chooseObject(objects, options.preferKey);
  return successOf(chosen, options.preferKey);
}

/** 解析成功但缺目标键时仍返回对象（调用方据此报 `missing-key`） */
function successOf(value: unknown, preferKey: string | undefined): ModelJsonExtraction {
  if (
    preferKey !== undefined &&
    isPlainObject(value) &&
    !hasOwnKey(value, preferKey)
  ) {
    return { value, failure: "missing-key" };
  }
  return { value };
}

function tryParse(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** 剥掉首尾 markdown 围栏标记；没有围栏时原样返回 */
function stripFenceMarkers(text: string): string {
  const withoutOpen = text.replace(/^[ \t]*```[^\r\n]*\r?\n?/, "");
  const withoutClose = withoutOpen.replace(/\r?\n?[ \t]*```[ \t]*$/, "");
  return withoutClose.trim();
}

/**
 * 单遍花括号配平扫描：只认完整的 `{…}`，字符串内的花括号与转义正确跳过。
 * 用栈收集每个 `{` 的配对位置，因此嵌套对象和「白话里先出现一个不成 JSON
 * 的花括号」都不会吞掉后面的真结果；未闭合栈非空 ⇒ 输出被截断。
 */
function scanObjectSpans(text: string): ObjectSpans {
  const spans: ObjectSpan[] = [];
  const stack: number[] = [];
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === "{") {
      stack.push(index);
    } else if (char === "}") {
      const start = stack.pop();
      if (start !== undefined) {
        spans.push({ start, end: index + 1, topLevel: stack.length === 0 });
      }
    }
  }

  return { spans, unbalanced: stack.length > 0 || inString };
}

/** 把扫描到的区间逐个 parse，按起始位置升序返回（嵌套时外层先于内层） */
function collectObjects(
  text: string,
  spans: ObjectSpans["spans"],
): readonly ParsedObject[] {
  const ordered = [...spans].sort((left, right) => left.start - right.start);
  const objects: ParsedObject[] = [];
  for (const span of ordered) {
    const parsed = tryParse(text.slice(span.start, span.end));
    if (isPlainObject(parsed)) {
      objects.push({ start: span.start, value: parsed, topLevel: span.topLevel });
    }
  }
  return objects;
}

/**
 * 取「含 preferKey 的最后一个对象」；无匹配时取最后**最外层**对象
 * （避免把 `{"candidates":[…],"extra":{…}}` 的内层对象当成回复根）。
 */
function chooseObject(
  objects: readonly ParsedObject[],
  preferKey: string | undefined,
): Record<string, unknown> {
  if (preferKey !== undefined) {
    for (let index = objects.length - 1; index >= 0; index -= 1) {
      const candidate = objects[index];
      if (candidate !== undefined && hasOwnKey(candidate.value, preferKey)) {
        return candidate.value;
      }
    }
  }
  for (let index = objects.length - 1; index >= 0; index -= 1) {
    const candidate = objects[index];
    if (candidate !== undefined && candidate.topLevel) {
      return candidate.value;
    }
  }
  return objects[objects.length - 1]?.value as Record<string, unknown>;
}

function hasOwnKey(value: Record<string, unknown>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
