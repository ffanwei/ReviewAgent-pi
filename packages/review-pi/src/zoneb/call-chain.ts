import type { RepoContext } from "./repo-context.js";
import type { ChangedSymbolRef } from "./changed-symbols.js";
import { qualifiedName } from "./changed-symbols.js";
import type { ReferenceSite } from "./reference-sites.js";
import { enclosingLabel, findReferenceSites } from "./reference-sites.js";

/**
 * Call Chain 层（测量常量面：Diff → Symbol → Reference → Call Chain 管线第四层）。
 *
 * 降级为名字级引用链（深度由 `limits.micro.callChainHops` 决定，缺省 2）：
 * - hop 1：变更方法的引用点（非声明处）→ 引用者的符号限定名；
 * - hop 2…N：对上一层引用者的方法名再做一次名字级检索（visited 去环）；
 * - Callee hop 1：变更方法体内（base 版本）的名字级调用点。
 */

export interface CallChainOptions {
  /** 引用者链最大深度（1…3；缺省 2 = 历史行为） */
  readonly hops?: number;
  /** ripgrep 单次调用超时（`limits.timeouts.ripgrepMs`） */
  readonly timeoutMs?: number;
}

export async function buildCallChainBlocks(
  repo: RepoContext,
  methodRefs: readonly ChangedSymbolRef[],
  options: CallChainOptions = {},
): Promise<readonly (readonly string[])[]> {
  const sitesByName = new Map<string, readonly ReferenceSite[]>();
  const blocks: (readonly string[])[] = [];
  for (const ref of methodRefs) {
    blocks.push(
      await buildChainForMethod(repo, ref, (name) => loadSites(repo, sitesByName, name, options), options),
    );
  }
  return blocks;
}

async function loadSites(
  repo: RepoContext,
  cache: Map<string, readonly ReferenceSite[]>,
  name: string,
  options: CallChainOptions,
): Promise<readonly ReferenceSite[]> {
  const cached = cache.get(name);
  if (cached !== undefined) {
    return cached;
  }
  const sites = await findReferenceSites(repo, name, {
    ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
  });
  cache.set(name, sites);
  return sites;
}

async function buildChainForMethod(
  repo: RepoContext,
  ref: ChangedSymbolRef,
  sitesOf: (name: string) => Promise<readonly ReferenceSite[]>,
  options: CallChainOptions,
): Promise<readonly string[]> {
  const header = `${qualifiedName(ref)} - ${ref.symbol.kind} at ${ref.file}:${ref.symbol.line}`;
  const sites = await sitesOf(ref.symbol.name);
  const callSites = sites.filter((site) => !site.isDeclaration);

  const hop1 = ["  Callers (hop 1):", ...renderEntries(callSites.map((site) => siteEntry(site)))];

  const maxHops = Math.max(1, options.hops ?? 2);
  // 逐层展开：上一层的方法名 → 本层引用点；visited 防环（A→B→A 不会无限展开）
  const seen = new Set<string>([ref.symbol.name]);
  let frontier = callerMethodNames(callSites);
  const deeperHops: string[] = [];
  for (let hop = 2; hop <= maxHops; hop += 1) {
    if (frontier.length === 0) {
      break;
    }
    const nextNames: string[] = [];
    for (const callerName of frontier) {
      const hopSites = (await sitesOf(callerName)).filter((site) => !site.isDeclaration);
      deeperHops.push(`  Callers of "${callerName}" (hop ${String(hop)}):`);
      deeperHops.push(...renderEntries(hopSites.map((site) => siteEntry(site))));
      for (const name of callerMethodNames(hopSites)) {
        if (!seen.has(name)) {
          seen.add(name);
          nextNames.push(name);
        }
      }
    }
    frontier = [...new Set(nextNames)].sort();
  }
  if (maxHops >= 2 && deeperHops.length === 0) {
    deeperHops.push("  Callers (hop 2):", "    (no method-level callers identified at hop 1)");
  }

  const callees = await calleesOf(repo, ref);
  const calleeLines = ["  Callees (hop 1):", ...renderEntries(callees)];

  return [header, ...hop1, ...deeperHops, ...calleeLines];
}

/** 引用点集合 → 去重排序后的方法名（下一层检索对象） */
function callerMethodNames(sites: readonly ReferenceSite[]): readonly string[] {
  return [...new Set(sites.flatMap((site) => callerMethodNameOf(site)))]
    .filter((name) => name.length > 0)
    .sort();
}

/** 引用点 → 展示条目：限定名 - 文件:行 */
function siteEntry(site: ReferenceSite): string {
  return `${enclosingLabel(site.enclosing)} - ${site.file}:${site.line}`;
}

/** 引用点最内层符号为方法/构造器时的方法名（hop 2 的检索对象） */
function callerMethodNameOf(site: ReferenceSite): readonly string[] {
  const innermost = site.enclosing.at(-1);
  if (innermost === undefined) {
    return [];
  }
  return innermost.kind === "method" || innermost.kind === "constructor" ? [innermost.name] : [];
}

async function calleesOf(repo: RepoContext, ref: ChangedSymbolRef): Promise<readonly string[]> {
  const index = await repo.symbolIndex(ref.file).catch((error: unknown) => {
    // 归一为仓库相对路径消息（不泄漏绝对路径）
    throw new Error(
      `symbol index unavailable for file "${ref.file}" (not found or unreadable)`,
      { cause: error },
    );
  });
  const inRange = index.invocations.filter(
    (invocation) => invocation.line >= ref.symbol.line && invocation.line <= ref.symbol.endLine,
  );
  const entries = [
    ...new Set(inRange.map((invocation) => `${invocation.name} - ${ref.file}:${invocation.line}`)),
  ];
  return entries.sort(compare);
}

function renderEntries(entries: readonly string[]): readonly string[] {
  const unique = [...new Set(entries)].sort(compare);
  return unique.length > 0 ? unique.map((entry) => `    ${entry}`) : ["    (none)"];
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
