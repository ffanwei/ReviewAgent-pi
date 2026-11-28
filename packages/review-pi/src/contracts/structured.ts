// 结构化回包的契约层（与传输 / 调用方式无关）。
//
// 一次性调用（`provider/structured-reply`）和检视会话的阶段解析
// （`shared/parse`）共用同一套失败分级与解析结果形状：
// - 一次性调用可以用 `invokeStructured` 自动重发；
// - 会话内阶段解析保留同会话重试 / 离线 salvage，但失败原因与接受条件同源。

import type { ModelJsonFailureKind } from "./run.js";

export type StructuredFailureKind =
  | "transport"
  | ModelJsonFailureKind
  | "schema"
  | "semantic";

export interface StructuredFailure {
  readonly kind: StructuredFailureKind;
  /** 人话诊断（写审计 / stderr；不携带 key） */
  readonly note: string;
  /** 最后一次模型回包（截断后）；仅用于诊断与修复提示 */
  readonly raw?: string;
}

/** 解析结果：成功必须带 value，失败必须带 failure，避免调用方忘记检查 */
export type StructuredParse<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly failure: StructuredFailure };

/**
 * OpenAI 兼容的结构化输出声明。
 * - `json_object`：只保证是 JSON 对象；
 * - `json_schema`：供应商支持时按 schema 约束（更严格，但兼容性更差）。
 */
export type StructuredResponseFormat =
  | "json_object"
  | {
      readonly type: "json_schema";
      readonly json_schema: {
        readonly name: string;
        readonly schema: Readonly<Record<string, unknown>>;
        readonly strict?: boolean;
      };
    };
