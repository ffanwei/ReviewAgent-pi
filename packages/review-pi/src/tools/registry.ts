import type { ToolSchema } from "../contracts/llm.js";

// 七个 review.* 工具注册表（#6 P3a；描述中文化 ADR-0090）：
// 工具名（点分 / 下划线）与参数键保持英文——它们是 wire 契约；
// description 与参数 description 是给模型看的自然语言，改为中文。
//
// canonical 键序 = DSH 线 toCanonicalJson：type → properties → required →
// additionalProperties；properties 子键字典序。pi 侧以字面键序构造（不用
// 运行时排序器）达成同字节——registry.test.ts 把守字面序。
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
      description: "返回本次受检合并请求（MR）的 unified diff。",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          limit: {
            type: "integer",
            minimum: 1,
            description: "最多返回的 diff 行数（页大小）。",
          },
          offset: {
            type: "integer",
            minimum: 1,
            description: "要返回的首行 diff 行号（1 起算）。",
          },
        },
        required: [],
        additionalProperties: false,
      }),
    },
    {
      name: "review.get_symbol",
      description:
        "按简单名在已配置的源码语言中查找符号，返回签名级声明（种类、修饰符、返回类型、参数、行号；不含方法体）。类型命中含其成员。",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "要查找的简单（非限定）符号名，例如 \"sumFirst\" 或 \"MathUtils\"。",
          },
        },
        required: ["symbol"],
        additionalProperties: false,
      }),
    },
    {
      name: "review.get_file",
      description: "读取仓库快照中的文件。可选用 1 起算的闭区间行范围（startLine/endLine）。",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          // properties 子键字典序：endLine → path → startLine
          endLine: {
            type: "integer",
            description: "读取的最后一行（1 起算、含端点）。可选，缺省到文件末尾。",
          },
          path: {
            type: "string",
            description: "要读取文件的仓库相对 POSIX 路径。",
          },
          startLine: {
            type: "integer",
            description: "读取的首行（1 起算、含端点）。可选，缺省为 1。",
          },
        },
        required: ["path"],
        additionalProperties: false,
      }),
    },
    {
      name: "review.find_references",
      description:
        "在已配置的源码语言中查找某符号的名称级引用（整词、区分大小写；不做类型解析，重载与覆写不区分）。返回声明与使用位置及其所属符号。",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "要搜索的简单（非限定）符号名，例如 \"sumFirst\" 或 \"MathUtils\"。",
          },
        },
        required: ["symbol"],
        additionalProperties: false,
      }),
    },
    {
      name: "review.get_call_chain",
      description:
        "围绕某方法 / 函数 / 构造器构建名称级调用链：一跳调用方、二跳调用方，以及声明体内调用的被调方。整词名称匹配、不做类型解析；不区分重载。",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          symbol: {
            type: "string",
            description: "构建调用链所用方法 / 函数 / 构造器的简单名，例如 \"sumFirst\"。",
          },
        },
        required: ["symbol"],
        additionalProperties: false,
      }),
    },
    {
      name: "review.search_rule",
      description:
        "按大小写不敏感的子串查询项目规则库（缺陷模式与业务规则）。返回命中的规则条目；条目按 run 静态配置。",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "在规则标题与正文中搜索的子串（大小写不敏感）。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      }),
    },
    {
      name: "review.search_history",
      description:
        "按大小写不敏感的子串查询本仓库的历史评审与缺陷记录。返回命中的历史条目；条目按 run 静态配置。",
      parametersJson: JSON.stringify({
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "在历史条目标题与正文中搜索的子串（大小写不敏感）。",
          },
        },
        required: ["query"],
        additionalProperties: false,
      }),
    },
  ];
}
