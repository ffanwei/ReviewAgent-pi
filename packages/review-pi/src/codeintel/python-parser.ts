import type { Parser } from "web-tree-sitter";
import { createGrammarParser } from "./wasm.js";

/**
 * tree-sitter-python 解析封装（ADR-0041）。
 *
 * - tree-sitter-python@0.25.0 官方包自带 tree-sitter-python.wasm；
 * - 进程级 memoization 由 `wasm.ts` 统一负责。
 */
export function getPythonParser(): Promise<Parser> {
  return createGrammarParser("Python", "tree-sitter-python", "tree-sitter-python.wasm");
}
