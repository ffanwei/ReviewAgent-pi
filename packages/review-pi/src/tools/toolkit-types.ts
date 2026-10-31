import type { ContextLedger } from "../contracts/ledger.js";
import type { KnowledgeEntry } from "../contracts/knowledge.js";
import type { RepoContext } from "../zoneb/repo-context.js";

/**
 * 工具运行时上下文与执行器形状（#6 P3a）。
 *
 * 执行器是纯逻辑层（与 pi-agent-core 解耦）：Agent 桥接（AgentTool 包装、
 * 预算控制、审计记录）在 loop 层落位；本层可完全离线测试。
 */

/** 工具运行时上下文（executor 执行时所需的最小输入） */
export interface ToolRunContext {
  /** MR unified diff（review.get_diff 数据源） */
  readonly diff: string;
  /** 仓库快照读取层（懒加载 memoize；get_symbol / get_file 数据源） */
  readonly repo: () => Promise<RepoContext>;
  /** 单次工具结果字符预算 */
  readonly resultBudgetChars: number;
  /** C3 Knowledge 规则语料（review.search_rule 数据源；缺省空） */
  readonly rules: readonly KnowledgeEntry[];
  /** C3 Knowledge 历史记语料（review.search_history 数据源；缺省空） */
  readonly history: readonly KnowledgeEntry[];
  /** Context Ledger（run 私有；唯一形态恒为功能态，惰性态只留给测试夹具） */
  readonly ledger: ContextLedger;
}

/**
 * 单工具执行器：入参（pi 内核已解析的对象）→ 结果文本（resultSummary；
 * 同一内容既回填模型上下文也进审计 toolCallLog——与 DSH 线同一纪律）。
 * 抛错由桥接层捕获并包装为 "Error: <message>"（失败也计入预算，防死循环）。
 */
export type ReviewToolHandler = (
  args: Record<string, unknown>,
  context: ToolRunContext,
) => Promise<string>;
