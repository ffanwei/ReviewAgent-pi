import type { RepoContext } from "./repo-context.js";
import type { ChangedSymbolRef } from "./changed-symbols.js";
import { qualifiedName } from "./changed-symbols.js";
import type { ReferenceSite } from "./reference-sites.js";
import { enclosingLabel, findReferenceSites } from "./reference-sites.js";
import { isCallableKind } from "./symbols.js";

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

/** 同名声明超过该数量时，工具层不再展开完整调用链（歧义太大） */
export const CALL_CHAIN_MAX_DECLARATIONS = 8;

/** 单段最多展示的调用方分组 / 被调方名字数（分组内行号另行压缩） */
const MAX_CALLER_GROUPS = 12;
const MAX_CALLEE_GROUPS = 12;
/** 单个分组最多展示的行号数 */
const MAX_LINES_IN_GROUP = 8;

interface CallerGroup {
  readonly label: string;
  readonly file: string;
  readonly lines: readonly number[];
}

interface CalleeSite {
  readonly name: string;
  readonly file: string;
  readonly line: number;
}

interface CalleeGroup {
  readonly name: string;
  readonly file: string;
  readonly lines: readonly number[];
}

export async function buildCallChainBlocks(
  repo: RepoContext,
  methodRefs: readonly ChangedSymbolRef[],
  options: CallChainOptions = {},
): Promise<readonly (readonly string[])[]> {
  const sitesByName = new Map<string, readonly ReferenceSite[]>();
  // 声明行即使因为 parseError 没被标成 isDeclaration，也不能出现在 callers 里。
  const declarationSites = new Set(
    methodRefs.map((ref) => `${ref.file}:${String(ref.symbol.line)}`),
  );
  const blocks: (readonly string[])[] = [];
  for (const ref of methodRefs) {
    blocks.push(
      await buildChainForMethod(
        repo,
        ref,
        (name) => loadSites(repo, sitesByName, name, options),
        options,
        declarationSites,
      ),
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
  declarationSites: ReadonlySet<string>,
): Promise<readonly string[]> {
  const header = `${qualifiedName(ref)} - ${ref.symbol.kind} at ${ref.file}:${ref.symbol.line}`;
  const sites = await sitesOf(ref.symbol.name);
  const callSites = sites.filter(
    (site) => !site.isDeclaration && !declarationSites.has(`${site.file}:${String(site.line)}`),
  );

  const hop1 = ["  Callers (hop 1):", ...renderCallerGroups(callSites)];

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
      const hopSites = (await sitesOf(callerName)).filter(
        (site) => !site.isDeclaration && !declarationSites.has(`${site.file}:${String(site.line)}`),
      );
      deeperHops.push(`  Callers of "${callerName}" (hop ${String(hop)}):`);
      deeperHops.push(...renderCallerGroups(hopSites));
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

  const language = repo.languageFor(ref.file);
  const calleeLines =
    language !== undefined && !language.supportsInvocations
      ? [
          "  Callees (hop 1):",
          `    (call-site extraction is not implemented for ${language.displayName})`,
        ]
      : ["  Callees (hop 1):", ...renderCalleeGroups(await calleesOf(repo, ref))];

  return [header, ...hop1, ...deeperHops, ...calleeLines];
}

/** 引用点集合 → 去重排序后的方法名（下一层检索对象） */
function callerMethodNames(sites: readonly ReferenceSite[]): readonly string[] {
  return [...new Set(sites.flatMap((site) => callerMethodNameOf(site)))]
    .filter((name) => name.length > 0)
    .sort();
}

/** 引用点按 enclosing symbol 聚合：同一函数内的多个调用点只占一行。 */
function renderCallerGroups(sites: readonly ReferenceSite[]): readonly string[] {
  if (sites.length === 0) {
    return ["    (none)"];
  }
  const byKey = new Map<string, { label: string; file: string; lines: number[] }>();
  for (const site of sites) {
    const label = enclosingLabel(site.enclosing);
    const key = `${site.file}\u0000${label}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = { label, file: site.file, lines: [] };
      byKey.set(key, group);
    }
    group.lines.push(site.line);
  }
  const groups: CallerGroup[] = [...byKey.values()]
    .map((group) => ({
      label: group.label,
      file: group.file,
      lines: [...new Set(group.lines)].sort((a, b) => a - b),
    }))
    .sort((a, b) => compare(a.file, b.file) || compare(a.label, b.label));
  const shown = groups.slice(0, MAX_CALLER_GROUPS);
  const lines = shown.map((group) =>
    group.lines.length === 1
      ? `    ${group.label} - ${group.file}:${String(group.lines[0])}`
      : `    ${group.label} - ${group.file} (${String(group.lines.length)} call sites: ${formatLineList(group.lines)})`,
  );
  if (groups.length > MAX_CALLER_GROUPS) {
    lines.push(
      `    ... ${String(groups.length - MAX_CALLER_GROUPS)} more caller group(s) omitted`,
    );
  }
  return lines;
}

/** 被调方按名字聚合：同名调用只占一行，行号压缩。 */
function renderCalleeGroups(sites: readonly CalleeSite[]): readonly string[] {
  if (sites.length === 0) {
    return ["    (none)"];
  }
  const byKey = new Map<string, { name: string; file: string; lines: number[] }>();
  for (const site of sites) {
    const key = `${site.file}\u0000${site.name}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = { name: site.name, file: site.file, lines: [] };
      byKey.set(key, group);
    }
    group.lines.push(site.line);
  }
  const groups: CalleeGroup[] = [...byKey.values()]
    .map((group) => ({
      name: group.name,
      file: group.file,
      lines: [...new Set(group.lines)].sort((a, b) => a - b),
    }))
    .sort((a, b) => compare(a.name, b.name) || compare(a.file, b.file));
  const shown = groups.slice(0, MAX_CALLEE_GROUPS);
  const lines = shown.map((group) =>
    group.lines.length === 1
      ? `    ${group.name} - ${group.file}:${String(group.lines[0])}`
      : `    ${group.name} - ${group.file} (${String(group.lines.length)} site(s): ${formatLineList(group.lines)})`,
  );
  if (groups.length > MAX_CALLEE_GROUPS) {
    lines.push(
      `    ... ${String(groups.length - MAX_CALLEE_GROUPS)} more callee name(s) omitted`,
    );
  }
  return lines;
}

/** 行号列表压缩：最多展示 MAX_LINES_IN_GROUP 个，其余只报数量。 */
function formatLineList(lines: readonly number[]): string {
  const shown = lines.slice(0, MAX_LINES_IN_GROUP);
  const omitted = lines.length - shown.length;
  return `${shown.join(", ")}${omitted > 0 ? `, +${String(omitted)} more` : ""}`;
}

/** 引用点最内层符号为方法/构造器时的方法名（hop 2 的检索对象） */
function callerMethodNameOf(site: ReferenceSite): readonly string[] {
  const innermost = site.enclosing.at(-1);
  if (innermost === undefined) {
    return [];
  }
  return innermost.kind === "method" ||
    innermost.kind === "function" ||
    innermost.kind === "constructor"
    ? [innermost.name]
    : [];
}

async function calleesOf(repo: RepoContext, ref: ChangedSymbolRef): Promise<readonly CalleeSite[]> {
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
  const entries = new Map<string, CalleeSite>();
  for (const invocation of inRange) {
    const key = `${invocation.name}\u0000${String(invocation.line)}`;
    if (!entries.has(key)) {
      entries.set(key, { name: invocation.name, file: ref.file, line: invocation.line });
    }
  }
  return [...entries.values()].sort(
    (a, b) => compare(a.name, b.name) || a.line - b.line,
  );
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
