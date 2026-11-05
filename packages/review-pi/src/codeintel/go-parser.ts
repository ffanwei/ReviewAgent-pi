import type { Parser } from "web-tree-sitter";
import { createGrammarParser } from "./wasm.js";

/**
 * tree-sitter-go 解析封装（ADR-0042）。
 *
 * - tree-sitter-go@0.25.0 官方包自带 tree-sitter-go.wasm；
 * - 进程级 memoization 由 `wasm.ts` 统一负责。
 */
export function getGoParser(): Promise<Parser> {
  return createGrammarParser("Go", "tree-sitter-go", "tree-sitter-go.wasm");
}
