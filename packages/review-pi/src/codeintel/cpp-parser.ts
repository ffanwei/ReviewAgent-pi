import type { Parser } from "web-tree-sitter";
import { createGrammarParser } from "./wasm.js";

/**
 * tree-sitter-cpp 解析封装（ADR-0042）。
 *
 * C 与 C++ 共用同一个 `cpp` 语言 id（ADR-0041 已定口径）：`.c/.h` 用 C++
 * 语法解析，C 是 C++ 的子集，不拆两个 id 制造双份引用检索。
 * 进程级 memoization 由 `wasm.ts` 统一负责。
 */
export function getCppParser(): Promise<Parser> {
  return createGrammarParser("C/C++", "tree-sitter-cpp", "tree-sitter-cpp.wasm");
}
