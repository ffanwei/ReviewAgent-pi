import type { Parser } from "web-tree-sitter";
import { createGrammarParser } from "./wasm.js";

/**
 * tree-sitter-typescript 解析封装（ADR-0041）。
 *
 * 一个 grammar 包带两个 wasm：
 * - `tree-sitter-typescript.wasm` 覆盖 .ts/.mts/.cts 与无 JSX 的 .js/.mjs/.cjs；
 * - `tree-sitter-tsx.wasm` 覆盖 .tsx/.jsx（JSX 语法不是 typescript 语法的子集）。
 *
 * 进程级 memoization 由 `wasm.ts` 统一负责。
 */
export function getTypeScriptParser(): Promise<Parser> {
  return createGrammarParser(
    "TypeScript",
    "tree-sitter-typescript",
    "tree-sitter-typescript.wasm",
  );
}

export function getTsxParser(): Promise<Parser> {
  return createGrammarParser("TSX", "tree-sitter-typescript", "tree-sitter-tsx.wasm");
}
