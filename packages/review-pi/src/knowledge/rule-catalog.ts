import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * 规则目录（ADR-0095）：把可确定性解析的规则包收敛为统一 Rule Catalog，
 * 并按文件/语言选出每个 Review Group 适用的规则子集。
 *
 * 本模块只做本地解析与选择，不执行规则包里的脚本；没有可解析规则的包
 * 归为 opaque，交由上层 skill runner 处理。
 */

export type RuleSource = "builtin" | "optional" | "user";

export interface RuleEntry {
  readonly id: string;
  readonly title: string;
  readonly severity?: string;
  readonly category?: string;
  readonly languages: readonly string[];
  readonly globs: readonly string[];
  readonly tags: readonly string[];
  readonly text: string;
  readonly pack: string;
  readonly source: RuleSource;
}

export interface DeclarativeRulePack {
  readonly kind: "declarative";
  readonly name: string;
  readonly description: string;
  readonly rules: readonly RuleEntry[];
  readonly root: string;
}

export interface OpaqueSkillPack {
  readonly kind: "opaque";
  readonly name: string;
  readonly description: string;
  readonly languages: readonly string[];
  readonly globs: readonly string[];
  readonly tags: readonly string[];
  readonly root: string;
}

export type ParsedRulePack = DeclarativeRulePack | OpaqueSkillPack;

export interface RuleCatalog {
  readonly rules: readonly RuleEntry[];
  readonly opaque: readonly OpaqueSkillPack[];
  /** 已并入规则目录、不应再开独立 skill 会话的用户声明式包名 */
  readonly declarativeUserNames?: readonly string[];
}

export interface RuleSkillRoot {
  /** 已装载 skill 的 SKILL.md 路径（目录或 zip 解压缓存） */
  readonly filePath: string;
}

export interface LoadRuleCatalogOptions {
  readonly builtinPack: string;
  readonly optionalPacks: readonly string[];
  readonly userSkills: readonly RuleSkillRoot[];
}

/** 出厂规则包根：`packages/review-pi/rules/<name>`（src / dist 同布局） */
export function builtinPackRoot(name: string): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(here, "..", "..", "rules", name);
}

/**
 * 装载内置 + 可选 + 用户声明式规则包；不存在的包直接跳过。
 * 用户 skill 的包根 = `dirname(filePath)`；zip 与目录形态一致。
 */
export function loadRuleCatalog(options: LoadRuleCatalogOptions): RuleCatalog {
  const packs: ParsedRulePack[] = [];
  const declarativeUserNames: string[] = [];
  const seen = new Set<string>();
  const add = (root: string, source: RuleSource): void => {
    if (seen.has(root) || !existsSync(root)) {
      return;
    }
    seen.add(root);
    packs.push(parseRulePack(root, source));
  };

  const builtinRoot = builtinPackRoot(options.builtinPack);
  add(builtinRoot, "builtin");
  const optionalRoot = path.dirname(builtinRoot);
  for (const name of options.optionalPacks) {
    add(path.join(optionalRoot, name), "optional");
  }
  for (const skill of options.userSkills) {
    const root = path.dirname(skill.filePath);
    add(root, "user");
    const parsed = packs.find((pack) => pack.root === root);
    if (parsed?.kind === "declarative") {
      declarativeUserNames.push(parsed.name);
    }
  }
  return { ...buildCatalog(packs), declarativeUserNames };
}

export interface ResolvedRules {
  readonly rules: readonly RuleEntry[];
  readonly text: string;
  readonly chars: number;
  /** 命中语言/glob 的规则总数（截断前） */
  readonly matchedRules: number;
  /** 是否因 maxChars 截断了命中规则 */
  readonly truncated: boolean;
}

interface Frontmatter {
  readonly fields: Readonly<Record<string, unknown>>;
  readonly body: string;
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export function parseRulePack(root: string, source: RuleSource): ParsedRulePack {
  const skill = readSkillFrontmatter(root);
  const name = stringField(skill.fields.name) ?? path.basename(root);
  const description = stringField(skill.fields.description) ?? "";
  const rules = readRules(root, name, source);

  const explicitOpaque = skill.fields.opaque === true;
  if (rules.length === 0 || explicitOpaque) {
    return {
      kind: "opaque",
      name,
      description,
      languages: arrayField(skill.fields.languages),
      globs: arrayField(skill.fields.globs),
      tags: arrayField(skill.fields.tags),
      root,
    };
  }
  return {
    kind: "declarative",
    name,
    description,
    rules,
    root,
  };
}

/** opaque skill 的 scope 元数据是否匹配任一文件；无元数据 = 全局适用。 */
export function opaqueSkillAppliesToFiles(
  pack: OpaqueSkillPack,
  filePaths: readonly string[],
): boolean {
  if (pack.languages.length === 0 && pack.globs.length === 0) {
    return filePaths.length > 0;
  }
  return filePaths.some((file) => {
    const normalized = file.replaceAll("\\", "/");
    const language = languageOfPath(normalized);
    if (pack.languages.length > 0 && !pack.languages.some((entry) => entry.toLowerCase() === language)) {
      return false;
    }
    if (pack.globs.length > 0 && !pack.globs.some((glob) => globMatches(glob, normalized))) {
      return false;
    }
    return true;
  });
}

export function buildCatalog(packs: readonly ParsedRulePack[]): RuleCatalog {
  return {
    rules: packs.flatMap((pack) => (pack.kind === "declarative" ? pack.rules : [])),
    opaque: packs.filter((pack): pack is OpaqueSkillPack => pack.kind === "opaque"),
  };
}

/**
 * 按 group 内文件选择规则：语言/glob 命中；同 id 用户规则覆盖内置；
 * 用户规则优先，其次 optional，最后 builtin；超字符上限截断。
 */
export function resolveRules(
  catalog: RuleCatalog,
  filePaths: readonly string[],
  maxChars: number,
  userOverrideBuiltin = true,
): ResolvedRules {
  const files = filePaths.map((file) => ({
    path: file.replaceAll("\\", "/"),
    language: languageOfPath(file),
  }));
  const byId = new Map<string, RuleEntry>();
  const ordered = [...catalog.rules].sort((left, right) => rank(left.source) - rank(right.source));
  for (const rule of ordered) {
    if (!files.some((file) => matches(rule, file.path, file.language))) {
      continue;
    }
    const existing = byId.get(rule.id);
    if (existing === undefined) {
      byId.set(rule.id, rule);
      continue;
    }
    if (userOverrideBuiltin && isUserRule(rule) && !isUserRule(existing)) {
      byId.set(rule.id, rule);
    }
  }
  const selected: RuleEntry[] = [];
  const blocks: string[] = [];
  let chars = 0;
  for (const rule of byId.values()) {
    const block = formatRule(rule);
    if (chars + block.length > maxChars) {
      continue;
    }
    selected.push(rule);
    blocks.push(block);
    chars += block.length;
  }
  return {
    rules: selected,
    text: blocks.join("\n\n"),
    chars,
    matchedRules: byId.size,
    truncated: selected.length < byId.size,
  };
}

function readSkillFrontmatter(root: string): Frontmatter {
  const skillPath = path.join(root, "SKILL.md");
  if (!existsSync(skillPath)) {
    return { fields: {}, body: "" };
  }
  return splitFrontmatter(readFileSync(skillPath, "utf8"));
}

function readRules(root: string, pack: string, source: RuleSource): RuleEntry[] {
  const rulesDir = path.join(root, "rules");
  if (!existsSync(rulesDir) || !statSync(rulesDir).isDirectory()) {
    return [];
  }
  const rules: RuleEntry[] = [];
  for (const entry of readdirSync(rulesDir).sort()) {
    if (!entry.endsWith(".md")) {
      continue;
    }
    const parsed = splitFrontmatter(readFileSync(path.join(rulesDir, entry), "utf8"));
    const id = stringField(parsed.fields.id);
    const title = stringField(parsed.fields.title);
    const severity = stringField(parsed.fields.severity);
    const category = stringField(parsed.fields.category);
    if (id === undefined || title === undefined || parsed.body.trim() === "") {
      continue;
    }
    rules.push({
      id,
      title,
      ...(severity !== undefined ? { severity } : {}),
      ...(category !== undefined ? { category } : {}),
      languages: arrayField(parsed.fields.languages),
      globs: arrayField(parsed.fields.globs),
      tags: arrayField(parsed.fields.tags),
      text: parsed.body.trim(),
      pack,
      source,
    });
  }
  return rules;
}

function splitFrontmatter(text: string): Frontmatter {
  const matched = FRONTMATTER.exec(text);
  if (matched === null) {
    return { fields: {}, body: text };
  }
  const fields: Record<string, unknown> = {};
  for (const line of (matched[1] ?? "").split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) {
      continue;
    }
    const key = line.slice(0, separator).trim();
    const raw = line.slice(separator + 1).trim();
    if (key !== "" && raw !== "") {
      fields[key] = parseValue(raw);
    }
  }
  return { fields, body: text.slice(matched[0].length) };
}

function parseValue(raw: string): unknown {
  if (raw.startsWith("[") && raw.endsWith("]")) {
    return raw
      .slice(1, -1)
      .split(",")
      .map((entry) => unquote(entry.trim()))
      .filter((entry) => entry !== "");
  }
  if (raw === "true") {
    return true;
  }
  if (raw === "false") {
    return false;
  }
  return unquote(raw);
}

function unquote(value: string): string {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  return value;
}

function stringField(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function arrayField(value: unknown): readonly string[] {
  if (Array.isArray(value)) {
    return value.map((entry) => String(entry).trim()).filter((entry) => entry !== "");
  }
  if (typeof value === "string" && value.trim() !== "") {
    return value
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }
  return [];
}

function rank(source: RuleSource): number {
  if (source === "user") {
    return 0;
  }
  if (source === "optional") {
    return 1;
  }
  return 2;
}

function isUserRule(rule: RuleEntry): boolean {
  return rule.source === "user";
}

function matches(rule: RuleEntry, filePath: string, language: string): boolean {
  if (rule.languages.length > 0 && !rule.languages.some((entry) => entry.toLowerCase() === language)) {
    return false;
  }
  if (rule.globs.length > 0 && !rule.globs.some((glob) => globMatches(glob, filePath))) {
    return false;
  }
  return true;
}

function formatRule(rule: RuleEntry): string {
  const meta = [
    `id=${rule.id}`,
    `source=${rule.source}`,
    ...(rule.severity !== undefined ? [`severity=${rule.severity}`] : []),
    ...(rule.category !== undefined ? [`category=${rule.category}`] : []),
  ].join(" ");
  return `<rule ${meta}>\n${rule.text}\n</rule>`;
}

function languageOfPath(filePath: string): string {
  const extension = path.extname(filePath).toLowerCase();
  switch (extension) {
    case ".ts":
    case ".tsx":
      return "typescript";
    case ".js":
    case ".jsx":
    case ".mjs":
    case ".cjs":
      return "javascript";
    case ".py":
      return "python";
    case ".go":
      return "go";
    case ".java":
      return "java";
    case ".kt":
    case ".kts":
      return "kotlin";
    case ".rs":
      return "rust";
    case ".c":
      return "c";
    case ".h":
      return "c";
    case ".cc":
    case ".cpp":
    case ".cxx":
    case ".hpp":
    case ".hh":
      return "cpp";
    case ".cs":
      return "csharp";
    case ".php":
      return "php";
    case ".rb":
      return "ruby";
    case ".swift":
      return "swift";
    case ".scala":
      return "scala";
    default:
      return "unknown";
  }
}

function globMatches(pattern: string, filePath: string): boolean {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    if (pattern.startsWith("**/", index)) {
      source += "(?:.*/)?";
      index += 2;
    } else if (pattern.startsWith("**", index)) {
      source += ".*";
      index += 1;
    } else if (pattern[index] === "*") {
      source += "[^/]*";
    } else if (pattern[index] === "?") {
      source += "[^/]";
    } else {
      source += pattern[index]!.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`).test(filePath);
}
