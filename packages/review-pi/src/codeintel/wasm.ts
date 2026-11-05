import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { Language, Parser } from "web-tree-sitter";

/**
 * tree-sitter wasm 运行时（ADR-0041：多语言解析器的公共装载层）。
 *
 * - `web-tree-sitter@0.27.0` 的运行时只初始化一次（进程级 memoization）；
 * - 语法 wasm 按「包/文件」memoize：未启用的语言永不触碰 wasm（懒加载）；
 * - parser 实例也按 key memoize——与 ADR-0040 的单语言实现保持同样的
 *   「一次装载、进程内复用」语义。
 */

let runtimePromise: Promise<void> | undefined;
const grammarCache = new Map<string, Promise<Language>>();
const parserCache = new Map<string, Promise<Parser>>();

function ensureRuntime(): Promise<void> {
  runtimePromise ??= Parser.init();
  return runtimePromise;
}

/** 装载（或复用）一个语法 wasm，返回 tree-sitter Language */
function loadGrammar(packageName: string, wasmFile: string): Promise<Language> {
  const key = `${packageName}/${wasmFile}`;
  let cached = grammarCache.get(key);
  if (cached === undefined) {
    cached = (async () => {
      await ensureRuntime();
      const require = createRequire(import.meta.url);
      const wasmPath = require.resolve(key);
      const wasmBytes = new Uint8Array(await readFile(wasmPath));
      return Language.load(wasmBytes);
    })();
    grammarCache.set(key, cached);
  }
  return cached;
}

/**
 * 创建（或复用）一个绑定到指定语法的 parser。
 * `label` 只用于失败信息，与既有 `failed to initialize the Java tree-sitter parser` 同形。
 */
export function createGrammarParser(
  label: string,
  packageName: string,
  wasmFile: string,
): Promise<Parser> {
  const key = `${packageName}/${wasmFile}`;
  let cached = parserCache.get(key);
  if (cached === undefined) {
    cached = (async () => {
      const language = await loadGrammar(packageName, wasmFile);
      const parser = new Parser();
      parser.setLanguage(language);
      return parser;
    })().catch((error: unknown) => {
      parserCache.delete(key);
      throw new Error(`failed to initialize the ${label} tree-sitter parser: ${errorMessage(error)}`, {
        cause: error,
      });
    });
    parserCache.set(key, cached);
  }
  return cached;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
