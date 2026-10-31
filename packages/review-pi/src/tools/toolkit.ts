import type { ContextLedger } from "../contracts/ledger.js";
import type { KnowledgeCorpus } from "../contracts/knowledge.js";
import type { ToolSchema } from "../contracts/llm.js";
import type { RepoContext } from "../zoneb/repo-context.js";
import { loadRepoContext } from "../zoneb/repo-context.js";
import { createContextLedger, createInertContextLedger } from "./ledger.js";
import { DEFAULT_TOOL_RESULT_BUDGET_CHARS } from "./result-budget.js";
import { getDiffTool } from "./get-diff.js";
import { getFileTool } from "./get-file.js";
import { getSymbolTool } from "./get-symbol.js";
import {
  findReferencesTool,
  getCallChainTool,
  searchHistoryTool,
  searchRuleTool,
} from "./search-tools.js";
import { REVIEW_TOOL_ORDER, reviewToolSchemas } from "./registry.js";
import type { ReviewToolHandler, ToolRunContext } from "./toolkit-types.js";

/**
 * review.* 工具箱装配（#6 P3a：工具驱动形态的工具面）。
 *
 * - schema 面（Zone A）：reviewToolSchemas() 固定七工具（字节稳定）；
 * - 执行面（Zone C）：懒加载 RepoContext memoize——模型不调用工具的 run 不产生
 *   仓库读取成本；首次调用失败成为有界的工具错误（进审计 toolCallLog），不静默；
 * - Context Ledger：ledgerMode="enabled"（唯一形态）注入功能态（重复读取返回
 *   "Already loaded: ctx#NNN" 引用），"inert" 注入惰性态（行为零变化，测试夹具用）；
 * - C3 Knowledge 语料（search_rule / search_history 数据源）静态注入，缺省空语料。
 *
 * 本层是纯逻辑层（与 pi-agent-core 解耦）：Agent 桥接（AgentTool 包装、
 * 工具预算、审计记录）在 loop 层落位。
 */

/** 七工具执行器（顺序与 REVIEW_TOOL_ORDER 对齐；装配处查重防漂移） */
export function reviewToolHandlers(): ReadonlyMap<string, ReviewToolHandler> {
  const handlers: ReadonlyArray<[string, ReviewToolHandler]> = [
    ["review.get_diff", getDiffTool],
    ["review.get_symbol", getSymbolTool],
    ["review.get_file", getFileTool],
    ["review.find_references", findReferencesTool],
    ["review.get_call_chain", getCallChainTool],
    ["review.search_rule", searchRuleTool],
    ["review.search_history", searchHistoryTool],
  ];
  const byName = new Map(handlers);
  if (byName.size !== handlers.length) {
    throw new Error("internal error: duplicate review tool handler registration");
  }
  for (const name of REVIEW_TOOL_ORDER) {
    if (!byName.has(name)) {
      throw new Error(`internal error: missing executor for registered tool "${name}"`);
    }
  }
  return byName;
}

export interface ReviewToolkitOptions {
  readonly repoPath: string;
  readonly diff: string;
  /** 单次工具结果字符预算，默认 DEFAULT_TOOL_RESULT_BUDGET_CHARS */
  readonly resultBudgetChars?: number;
  /** 预加载的 RepoContext（调用方共享同一快照；缺省懒加载） */
  readonly repo?: RepoContext;
  /** C3 Knowledge 检索语料（search_rule / search_history 数据源；缺省空语料） */
  readonly knowledge?: KnowledgeCorpus;
  /** Context Ledger 模式：唯一形态传 "enabled"；"inert" 只留给测试夹具（缺省 "inert"） */
  readonly ledgerMode?: "enabled" | "inert";
  /**
   * 外部注入的 Ledger（ADR-0014：skill 会话用主账本 Phase-5 快照分叉）。
   * 一经提供即优先于 `ledgerMode`——调用方负责决定种子内容。
   */
  readonly ledger?: ContextLedger;
}

export interface ReviewToolkit {
  /** 挂载到审计投影与 Agent 桥接的 schema（点分名，字节稳定，Zone A 的一部分） */
  readonly schemas: readonly ToolSchema[];
  /** 本 toolkit 的 Ledger（审计留痕用；功能态/惰性态由 ledgerMode 决定） */
  readonly ledger: ContextLedger;
  /**
   * 执行单次工具调用（点分名 + 已解析参数）→ 结果文本（resultSummary）。
   * 未知名 / 执行抛错由调用方（Agent 桥接层）捕获包装为 "Error: <message>"。
   */
  executeTool(name: string, args: Record<string, unknown>): Promise<string>;
}

export function buildReviewToolkit(options: ReviewToolkitOptions): ReviewToolkit {
  const schemas = reviewToolSchemas();
  const handlers = reviewToolHandlers();
  const repoPromise = memoizedRepo(options);
  const ledger =
    options.ledger ??
    (options.ledgerMode === "enabled" ? createContextLedger() : createInertContextLedger());
  const context: ToolRunContext = {
    diff: options.diff,
    repo: () => repoPromise(),
    resultBudgetChars: options.resultBudgetChars ?? DEFAULT_TOOL_RESULT_BUDGET_CHARS,
    rules: options.knowledge?.rules ?? [],
    history: options.knowledge?.history ?? [],
    ledger,
  };
  return {
    schemas,
    ledger,
    executeTool: async (name, args): Promise<string> => {
      const handler = handlers.get(name);
      if (handler === undefined) {
        throw new Error(
          `unknown tool "${boundedToolName(name)}" (available: ${schemas.map((entry) => entry.name).join(", ")})`,
        );
      }
      return handler(args, context);
    },
  };
}

/** 工具名回显上限（未知名可能来自模型幻觉，回显必须有界） */
function boundedToolName(name: string): string {
  return name.length <= 60 ? name : `${name.slice(0, 60)}...`;
}

/** RepoContext 懒加载（memoize：同一 toolkit 内只加载一次，失败可重读同一错误） */
function memoizedRepo(options: ReviewToolkitOptions): () => Promise<RepoContext> {
  let cached: Promise<RepoContext> | undefined;
  return (): Promise<RepoContext> => {
    if (options.repo !== undefined) {
      return Promise.resolve(options.repo);
    }
    cached ??= loadRepoContext(options.repoPath);
    return cached;
  };
}
