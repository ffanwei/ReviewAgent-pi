import type { Parser } from "web-tree-sitter";
import { createGrammarParser } from "./wasm.js";

/**
 * tree-sitter-java 解析封装（测量常量面：零构建静态解析，wasm 路线）。
 *
 * - web-tree-sitter@0.27.0（wasm，免编译、免构建脚本，pnpm 10 友好）
 * - tree-sitter-java@0.23.5 官方包自带 tree-sitter-java.wasm
 *
 * 进程级 memoization：wasm 与 parser 只加载一次（`wasm.ts`）。
 */
export function getJavaParser(): Promise<Parser> {
  return createGrammarParser("Java", "tree-sitter-java", "tree-sitter-java.wasm");
}
