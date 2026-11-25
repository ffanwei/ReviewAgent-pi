import {
  LANGUAGE_RULE_TEXTS,
  type AstLanguage,
} from "./language-rule-texts.js";

/**
 * 语言缺陷清单的选择与拼装（ADR-0118）。
 *
 * - 只支持 AST 已支持的 5 种语言；
 * - 按文件扩展名分组；组内混合语言时用 `<rules for="…">` 按文件标注，
 *   避免模型把一种语言的规则套到另一种语言上；
 * - 规则块只作为 Phase 5 的附加段，不进入 system prompt。
 */

export type LanguageRuleMode = "mr" | "repo";

const LANGUAGE_BY_EXTENSION: Readonly<Record<string, AstLanguage>> = {
  ".java": "java",
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "typescript",
  ".jsx": "typescript",
  ".mjs": "typescript",
  ".cjs": "typescript",
  ".py": "python",
  ".go": "go",
  ".c": "cpp",
  ".h": "cpp",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
};

/** 固定顺序 = 规则块顺序，保证同一文件集合的提示词字节稳定 */
const LANGUAGE_ORDER: readonly AstLanguage[] = [
  "java",
  "typescript",
  "python",
  "go",
  "cpp",
];

const PREAMBLE: Readonly<Record<LanguageRuleMode, string>> = {
  repo: [
    "以下是与本组文件语言相关的缺陷检查清单。",
    "只把清单用于发现可被具体证据与失败场景支撑的问题；命中真实缺陷才产出候选，不要为了覆盖清单而报风格、命名、拼写、注释类问题。",
  ].join("\n"),
  mr: [
    "以下是与本次变更文件语言相关的缺陷检查清单。",
    "只把清单用于本次新增/修改行；不要报仓库里本来存在、且不是本次变更引入或加重的问题。",
    "命中真实缺陷才产出候选，不要为了覆盖清单而报风格、命名、拼写、注释类问题。",
  ].join("\n"),
};

export function astLanguageOf(filePath: string): AstLanguage | undefined {
  const normalized = filePath.trim().replaceAll("\\", "/");
  const base = normalized.split("/").at(-1) ?? normalized;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return undefined;
  }
  return LANGUAGE_BY_EXTENSION[base.slice(dot).toLowerCase()];
}

/**
 * 按文件集合拼装语言规则块；没有命中支持的语言时返回 undefined
 * （不注入空段，提示词字节保持不变）。
 */
export function buildLanguageRulesText(
  files: readonly string[],
  mode: LanguageRuleMode,
): string | undefined {
  const byLanguage = new Map<AstLanguage, string[]>();
  for (const file of files) {
    const language = astLanguageOf(file);
    if (language === undefined) {
      continue;
    }
    const bucket = byLanguage.get(language);
    if (bucket === undefined) {
      byLanguage.set(language, [file]);
    } else if (!bucket.includes(file)) {
      bucket.push(file);
    }
  }
  if (byLanguage.size === 0) {
    return undefined;
  }

  const blocks: string[] = [];
  for (const language of LANGUAGE_ORDER) {
    const bucket = byLanguage.get(language);
    if (bucket === undefined) {
      continue;
    }
    const paths = [...bucket].sort(compareText).join(", ");
    blocks.push(
      [
        `<rules for="${paths}">`,
        LANGUAGE_RULE_TEXTS[language],
        "</rules>",
      ].join("\n"),
    );
  }
  return `${PREAMBLE[mode]}\n\n${blocks.join("\n\n")}`;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
