import type { ToolSchema } from "../contracts/llm.js";

// 七个 review.* 工具注册表（#6 P3a）：schema 字节一致口径的唯一真源。
// 与 DSH 线语义等价的契约面：
// - 审计投影（ToolSchema）：点分名 + parametersJson（canonical 键序字节串）；
// - pi-ai / wire（convertTools 直达）：下划线名 + parameters 对象。
//
// canonical 键序 = DSH 线 toCanonicalJson：type → properties → required →
// additionalProperties；properties 子键字典序。pi 侧以字面键序构造（不用
// 运行时排序器）达成同字节——registry.test.ts 对 t-series 真源逐字节把守，
// 字面序写错即红。
//
// 只读纪律：七工具全部为构造性只读（读快照、检索、拼装），无写路径——
// 工具执行器（toolkit.ts）落位后由只读断言测试看守（仓库内容哈希不变）。

/** 工具固定顺序（DSH 线 REVIEW_TOOL_ORDER 同序；消融面对比不因序污染） */
export const REVIEW_TOOL_ORDER = [
  "review.get_diff",
  "review.get_symbol",
  "review.get_file",
  "review.find_references",
  "review.get_call_chain",
  "review.search_rule",
  "review.search_history",
] as const;

export type ReviewToolName = (typeof REVIEW_TOOL_ORDER)[number];

/** 点分名（审计口径）→ 下划线名（pi-ai Tool.name / wire function.name 直达） */
export function toWireToolName(name: string): string {
  return name.replaceAll(".", "_");
}

/**
 * 下划线名 → 点分名（wire 回调 / 审计记录归属）。
 * 命名空间分隔符只有第一个下划线：review_get_diff → review.get_diff
 * （工具名本体的下划线——get_diff/get_call_chain——不是分隔符，原样保留）。
 */
export function fromWireToolName(wireName: string): ReviewToolName {
  const dotted = wireName.replace("_", ".") as ReviewToolName;
  if (!(REVIEW_TOOL_ORDER as readonly string[]).includes(dotted)) {
    throw new Error(`unknown review tool wire name: ${wireName}`);
  }
  return dotted;
}

/** 七工具 schema（审计投影口径；每次调用返回全新数组，防调用方原地改动） */
export function reviewToolSchemas(): readonly ToolSchema[] {
  return [
    {
      name: "review.get_diff",
      description: "Return the unified diff of the merge request under review.",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            description: "Maximum number of diff lines to return (page size).",
          },
          offset: {
            type: "integer",
            minimum: 1,
            description: "1-based line number of the first diff line to return.",
          },
        },
        required: [],
        additionalProperties: false,
      }),
    },
    {
      name: "review.get_symbol",
      description:
        "Look up a symbol by its simple name across all Java sources and return signature-level declarations " +
        "(kind, modifiers, return type, parameters, line number; no method bodies). Type matches include their members.",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: 'Simple (unqualified) symbol name to look up, e.g. "sumFirst" or "MathUtils".',
          },
        },
        required: ["symbol"],
        additionalProperties: false,
      }),
    },
    {
      name: "review.get_file",
      description:
        "Read a file from the repository snapshot. Supports an optional 1-based inclusive line range (startLine/endLine).",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          // properties 子键字典序：endLine → path → startLine
          endLine: {
            type: "integer",
            description: "Last line to read (1-based, inclusive). Optional; defaults to end of file.",
          },
          path: {
            type: "string",
            description: "Repository-relative POSIX path of the file to read.",
          },
          startLine: {
            type: "integer",
            description: "First line to read (1-based, inclusive). Optional; defaults to 1.",
          },
        },
        required: ["path"],
        additionalProperties: false,
      }),
    },
    {
      name: "review.find_references",
      description:
        "Find name-level references to a symbol across all Java sources (whole-word, case-sensitive match; " +
        "no type resolution, so overloads and overrides are not distinguished). Returns declaration and usage " +
        "sites with their enclosing symbols.",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: 'Simple (unqualified) symbol name to search for, e.g. "sumFirst" or "MathUtils".',
          },
        },
        required: ["symbol"],
        additionalProperties: false,
      }),
    },
    {
      name: "review.get_call_chain",
      description:
        "Build a name-level call chain around a method or constructor: hop-1 callers, hop-2 callers of those " +
        "callers, and callees invoked inside the method body. Whole-word name matching without type resolution; " +
        "overloads are not distinguished.",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: 'Simple name of the method or constructor to build the chain around, e.g. "sumFirst".',
          },
        },
        required: ["symbol"],
        additionalProperties: false,
      }),
    },
    {
      name: "review.search_rule",
      description:
        "Search the project rule base (defect-pattern and business rules) with a case-insensitive substring " +
        "query. Returns matching rule entries; entries are statically configured per run.",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Case-insensitive substring to search for in rule titles and texts.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      }),
    },
    {
      name: "review.search_history",
      description:
        "Search historical review and defect records for this repository with a case-insensitive substring " +
        "query. Returns matching history entries; entries are statically configured per run.",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Case-insensitive substring to search for in history entry titles and texts.",
          },
        },
        required: ["query"],
        additionalProperties: false,
      }),
    },
  ];
}
