// Skill 包检视的最小识别层（v1）：
// - 变更文件向上找最近的 SKILL.md / skill.md，命中即归属该 skill 根；
// - 变更成员按角色分组（manifest / doc / script / other）；
// - 文档类成员（manifest 与 doc）在位置门上按「整文件」放行；
// - 全部识别是确定性的，不调模型、不执行包内脚本；只读 manifest 做引用核对。
//
// 范围纪律：未变更的兄弟文件只作证据，不产出 finding——finding 的 file
// 仍必须是本次 diff 里的变更文件。完整 strategy brief / 分组会话不在本层，
// 后续按 ADR 演进。
import { existsSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { listChangedFilePaths } from "./mr-input.js";

const DOC_EXTENSIONS = new Set([".md", ".mdx", ".rst", ".adoc"]);
const MANIFEST_NAMES = ["SKILL.md", "skill.md"] as const;
/** 引用核对上限：manifest 体积与引用条数（只读 manifest，不读其它文件内容） */
const MAX_MANIFEST_BYTES = 256 * 1024;
const MAX_REFERENCES = 200;
/** 看起来像“文件路径”的后缀（没有斜杠时也按路径处理） */
const PATH_EXTENSIONS = new Set([
  ".md", ".mdx", ".rst", ".adoc", ".txt",
  ".sh", ".bash", ".ps1", ".py", ".js", ".mjs", ".cjs", ".ts",
  ".json", ".jsonc", ".yaml", ".yml", ".toml", ".ini", ".cfg",
  ".java", ".go", ".rs", ".c", ".h", ".cpp", ".hpp", ".rb", ".php", ".sql",
]);
const NON_PATH_PREFIXES = ["http://", "https://", "mailto:", "tel:", "data:", "ftp://", "ssh://", "git@"];

export type SkillMemberRole = "manifest" | "doc" | "script" | "other";

export interface SkillMemberReview {
  readonly path: string;
  readonly role: SkillMemberRole;
}

export interface SkillRootReview {
  readonly root: string;
  readonly manifest: string;
  readonly changedMembers: readonly SkillMemberReview[];
  /** manifest 的确定性引用核对（读不到 / 超上限时也可能在场，见 truncated） */
  readonly referenceCheck?: SkillReferenceCheck;
}

/** manifest 里的一条相对引用（Markdown 链接 / 引用定义 / 行内代码路径） */
export interface SkillReference {
  /** 原文写法（用于证据引文） */
  readonly target: string;
  /** 相对 repo 根的归一化路径 */
  readonly resolved: string;
  /** manifest 中的 1-based 行号 */
  readonly line: number;
}

export interface SkillReferenceCheck {
  readonly manifest: string;
  readonly verified: readonly SkillReference[];
  readonly missing: readonly SkillReference[];
  /** manifest 超体积上限或引用条数超上限：清单不完整 */
  readonly truncated: boolean;
}

export interface SkillReviewProfile {
  readonly roots: readonly SkillRootReview[];
  /** 命中的文档类变更文件（manifest + doc），按 diff 首见序去重 */
  readonly docFiles: readonly string[];
  /** 位置门整文件放行的文件集合（当前 = docFiles） */
  readonly wholeFilePaths: readonly string[];
}

/** 文档类路径：Markdown / MDX / RST / AsciiDoc（大小写不敏感） */
export function isDocPath(filePath: string): boolean {
  const posix = filePath.replace(/\\/g, "/");
  const dot = posix.lastIndexOf(".");
  if (dot < 0) {
    return false;
  }
  return DOC_EXTENSIONS.has(posix.slice(dot).toLowerCase());
}

/**
 * 从过滤后的 diff 识别 skill 包变更。没有任何变更文件命中 skill 根时返回
 * undefined（调用方据此保持全代码路径的零漂移）。
 */
export function detectSkillReview(
  diff: string,
  repoPath: string,
): SkillReviewProfile | undefined {
  const membersByRoot = new Map<string, SkillMemberReview[]>();
  const docFiles: string[] = [];
  const seenDoc = new Set<string>();

  for (const filePath of listChangedFilePaths(diff)) {
    const root = findSkillRoot(repoPath, filePath);
    if (root === undefined) {
      continue;
    }
    const role = roleOf(root, filePath);
    const members = membersByRoot.get(root) ?? [];
    members.push({ path: filePath, role });
    membersByRoot.set(root, members);
    if ((role === "manifest" || role === "doc") && !seenDoc.has(filePath)) {
      seenDoc.add(filePath);
      docFiles.push(filePath);
    }
  }

  if (membersByRoot.size === 0) {
    return undefined;
  }

  const roots: SkillRootReview[] = [];
  for (const [root, members] of membersByRoot) {
    const manifest = `${root}/${manifestNameOf(members)}`;
    const referenceCheck = checkSkillReferences(repoPath, root, manifest);
    roots.push({
      root,
      manifest,
      changedMembers: members,
      ...(referenceCheck !== undefined ? { referenceCheck } : {}),
    });
  }
  return { roots, docFiles, wholeFilePaths: [...docFiles] };
}

/** skill 包的初始消息段：只给事实与核查方向（详细生成规则在 Phase 5） */
export function buildSkillReviewBrief(
  profile: SkillReviewProfile,
  options?: { readonly ruleSkillLoaded?: boolean },
): string {
  const rootBlocks: string[] = [];
  for (const root of profile.roots) {
    rootBlocks.push(`- ${root.root}（manifest: ${root.manifest}）`);
    for (const member of root.changedMembers) {
      rootBlocks.push(`  - ${member.path}（${member.role}）`);
    }
    rootBlocks.push(...referenceFactLines(root));
  }
  const heading = options?.ruleSkillLoaded === true
    ? "## 被检视的 Skill 包（事实）"
    : "## 被检视的 Skill 包";
  const ownership = options?.ruleSkillLoaded === true
    ? [
        "本轮已装载专门的 skill 检视规则 Skill；检视清单与领域口径以其 SKILL.md 为准。",
        "本节只提供被检视包的事实、平台证据与位置纪律。",
      ]
    : ["详细生成规则与示例在 Phase 5 追加；核验口径在 Phase 6 追加。"];
  return [
    heading,
    "",
    "本次变更命中以下 Skill 包：",
    ...rootBlocks,
    "",
    "核查方向：被引用路径是否存在；命令 / 旗标 / 配置键是否与仓库现状一致；与 manifest 或兄弟文档是否矛盾；是否描述已删除、改名或未实现的能力；历史记录类文档（docs/adr/**、report）按当时口径读。",
    ...ownership,
    "",
    "证据形态：原文引文 + 目标文件:行 + review.get_file 的结果。",
    "finding 的 file 仍须是本次变更文件；未变更的兄弟文件只能作为证据。",
  ].join("\n");
}

/**
 * Phase 5 附加段：文档 / Skill 文件的生成口径。
 * 放在 Phase 5 指令之后，覆盖系统提示与示例里的编码导向；不改变 Finding schema。
 */
export function buildSkillPhase5Override(
  profile: SkillReviewProfile,
  options?: { readonly ruleSkillLoaded?: boolean },
): string {
  const docFiles = profile.docFiles.length > 0 ? profile.docFiles : profile.roots.map((root) => root.manifest);
  const referenceLines = referencePhaseLines(profile);
  const platformRules = [
    "- evidence：原文引文 + 目标文件:行 + review.get_file 结果；不要求符号或代码摘录。",
    "- category 仍用七类；文档问题落「可维护」「可读性」，细分写 subcategory。",
    "- tips.suggestion 保留「[重构思路]」「代码示例」两个标记；示例内容可以是 Markdown / 配置 / shell 片段。",
    "- 严重级：P3 只用于措辞；过期或矛盾按 P2；会导致误配置、误操作按 P1。",
  ];
  if (options?.ruleSkillLoaded === true) {
    return [
      "## 文档 / Skill 文件覆盖（Phase 5）",
      "",
      "本轮已装载专门的 skill 检视规则 Skill；生成清单与领域口径以其 SKILL.md 为准。",
      "以下平台口径仍然适用：",
      ...platformRules,
      ...referenceLines,
    ].join("\n");
  }
  return [
    "## 文档 / Skill 文件覆盖（Phase 5）",
    "",
    `本次变更的文档类文件：${docFiles.join("、")}`,
    "对文档类文件，本节覆盖系统提示与上文示例中的编码导向：",
    ...platformRules,
    "- 逐项核查：frontmatter 合法性；被引用相对路径存在性；命令 / 旗标 / 配置键与仓库现状一致；与 manifest 或兄弟文档不矛盾；不描述已删除、改名或未实现的能力；示例可做静态核对。",
    ...referenceLines,
    "",
    "生成示例（整条回复仍是同一个 JSON 对象；字段与 schema 完全一致）：",
    '{"candidates":[{"id":"F001","severity":"P2","category":"可维护","file":"skills/foo/SKILL.md","line":42,"title":"引用的 references/old.md 已不存在","description":"SKILL.md 仍指向已删除的 references/old.md，读者按文档找不到目标文件。","evidence":["SKILL.md:42 — 「详见 references/old.md」","review.get_file(\\"references/old.md\\") 返回不存在"],"rule":"SKILL-REF-001","confidence":0.9,"tips":{"review":"[缺陷类型] 失效引用。影响评估：读者无法按文档找到目标。","suggestion":"[重构思路] 删除或改指现有文件。代码示例：\\n```md\\n详见 references/new.md\\n```","subcategory":"失效引用"}}]}',
  ].join("\n");
}

/** Phase 6 附加段：文档候选的核验口径（只接受具体反驳） */
export function buildSkillPhase6VerificationNote(): string {
  return [
    "## 文档候选核验覆盖（Phase 6）",
    "",
    "对文档类候选，只接受具体反驳：引文不符、目标不存在、与目标矛盾；",
    "review.get_file 返回不存在或内容不符，即具体反驳。",
    "不以「缺少代码符号」「风格主观」或「没有代码示例」为由驳回。",
  ].join("\n");
}

/** 向上查找最近的 skill 根；只在 repo 内走，路径含 `..` / 绝对路径直接拒绝 */
function findSkillRoot(repoPath: string, filePath: string): string | undefined {
  const posix = filePath.replace(/\\/g, "/").trim().replace(/^\.\//, "");
  if (
    posix === "" ||
    posix.startsWith("/") ||
    /^[A-Za-z]:/.test(posix) ||
    posix.split("/").some((segment) => segment === "..")
  ) {
    return undefined;
  }
  let dir = path.posix.dirname(posix);
  while (dir !== "." && dir !== "" && dir !== "/") {
    const absoluteDir = path.join(repoPath, ...dir.split("/"));
    if (MANIFEST_NAMES.some((name) => existsSync(path.join(absoluteDir, name)))) {
      return dir;
    }
    const parent = path.posix.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return undefined;
}

function roleOf(root: string, filePath: string): SkillMemberRole {
  const posix = filePath.replace(/\\/g, "/");
  const base = path.posix.basename(posix).toLowerCase();
  if (base === "skill.md") {
    return "manifest";
  }
  if (isDocPath(posix)) {
    return "doc";
  }
  const relative = posix.startsWith(`${root}/`) ? posix.slice(root.length + 1) : posix;
  if (relative.startsWith("scripts/") || relative.startsWith("script/")) {
    return "script";
  }
  return "other";
}

/** 根下实际命中的 manifest 文件名（大小写变体保持原样） */
function manifestNameOf(members: readonly SkillMemberReview[]): string {
  for (const member of members) {
    const base = path.posix.basename(member.path);
    if (base.toLowerCase() === "skill.md") {
      return base;
    }
  }
  return MANIFEST_NAMES[0];
}

/** 初始消息用的引用事实行（存在 / 缺失，均带 manifest 行号） */
function referenceFactLines(root: SkillRootReview): string[] {
  const check = root.referenceCheck;
  if (check === undefined) {
    return [];
  }
  const lines: string[] = [];
  if (check.truncated) {
    lines.push("  - 引用核对已截断（manifest 过大或引用过多），清单不完整");
  }
  if (check.verified.length > 0) {
    const shown = check.verified.slice(0, 10).map((ref) => ref.resolved);
    const more = check.verified.length > shown.length ? ` 等 ${String(check.verified.length)} 条` : "";
    lines.push(`  - 已核对存在：${shown.join("、")}${more}`);
  }
  if (check.missing.length > 0) {
    lines.push("  - 缺失引用（必须产出 finding）：");
    for (const ref of check.missing) {
      lines.push(`    - ${ref.target}（manifest 第 ${String(ref.line)} 行）`);
    }
  } else if (!check.truncated) {
    lines.push("  - 缺失引用：无");
  }
  return lines;
}

/** Phase 5 用的引用事实段：缺失项直接作为候选靶子 */
function referencePhaseLines(profile: SkillReviewProfile): string[] {
  let checked = 0;
  let truncated = false;
  const missing: string[] = [];
  for (const root of profile.roots) {
    const check = root.referenceCheck;
    if (check === undefined) {
      continue;
    }
    checked += check.verified.length + check.missing.length;
    truncated ||= check.truncated;
    for (const ref of check.missing) {
      missing.push(`- ${ref.target}（${root.manifest}:${String(ref.line)}）`);
    }
  }
  if (checked === 0 && !truncated) {
    return [];
  }
  const lines = ["", "确定性引用核对："];
  if (missing.length > 0) {
    lines.push("以下缺失引用已在仓库快照中确认不存在，必须产出 finding：", ...missing);
  } else {
    lines.push(`已核对 ${String(checked)} 条相对引用，未发现缺失引用。`);
  }
  if (truncated) {
    lines.push("注意：引用扫描已截断，清单不完整。");
  }
  return lines;
}

/**
 * 读 manifest（只读，不执行）并核对其中的相对引用。
 *
 * 口径：
 * - 只认 Markdown 链接 / 引用定义 / 行内代码里“像路径”的内容（含 `/` 或已知后缀）；
 * - 跳过 URL、锚点、绝对路径、占位符、含空白或 shell 元字符的内容；
 * - 解析结果必须落在 repo 内，`..` 越界一律丢弃；
 * - manifest 超体积 / 引用超条数时返回 truncated，不静默。
 */
function checkSkillReferences(
  repoPath: string,
  root: string,
  manifest: string,
): SkillReferenceCheck | undefined {
  const manifestAbs = path.resolve(repoPath, ...manifest.split("/"));
  const relative = path.relative(repoPath, manifestAbs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  let content: string;
  try {
    const info = statSync(manifestAbs);
    if (!info.isFile()) {
      return undefined;
    }
    if (info.size > MAX_MANIFEST_BYTES) {
      return { manifest, verified: [], missing: [], truncated: true };
    }
    content = readFileSync(manifestAbs, "utf8");
  } catch {
    return undefined;
  }

  const verified: SkillReference[] = [];
  const missing: SkillReference[] = [];
  const seen = new Set<string>();
  let truncated = false;
  const lines = content.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    for (const raw of extractReferenceTargets(lines[index] ?? "")) {
      const ref = toSkillReference(raw, root, repoPath, index + 1);
      if (ref === undefined) {
        continue;
      }
      const key = `${ref.target}\u0000${String(ref.line)}`;
      if (seen.has(key)) {
        continue;
      }
      if (verified.length + missing.length >= MAX_REFERENCES) {
        truncated = true;
        break;
      }
      seen.add(key);
      const absolute = path.resolve(repoPath, ...ref.resolved.split("/"));
      if (existsSync(absolute)) {
        verified.push(ref);
      } else {
        missing.push(ref);
      }
    }
    if (truncated) {
      break;
    }
  }
  return { manifest, verified, missing, truncated };
}

/** 一行里的候选引用：Markdown 链接、引用定义、行内代码 */
function extractReferenceTargets(line: string): string[] {
  const targets: string[] = [];
  for (const match of line.matchAll(/\[[^\]]*\]\(([^)\s]+)(?:\s+["'][^"']*["'])?\)/g)) {
    if (match[1] !== undefined) {
      targets.push(match[1]);
    }
  }
  const definition = /^\s*\[[^\]]+\]:\s*(\S+)/.exec(line);
  if (definition?.[1] !== undefined) {
    targets.push(definition[1]);
  }
  for (const match of line.matchAll(/`([^`\n]+)`/g)) {
    if (match[1] !== undefined) {
      targets.push(match[1]);
    }
  }
  return targets;
}

/** 原始候选 → 可核对的相对路径；不像路径 / 会越界 / 非本地的项返回 undefined */
function toSkillReference(
  raw: string,
  root: string,
  repoPath: string,
  line: number,
): SkillReference | undefined {
  let target = raw.trim();
  if (target.startsWith("<") && target.endsWith(">")) {
    target = target.slice(1, -1).trim();
  }
  target = target.replace(/\\/g, "/");
  const hash = target.indexOf("#");
  if (hash >= 0) {
    target = target.slice(0, hash);
  }
  const query = target.indexOf("?");
  if (query >= 0) {
    target = target.slice(0, query);
  }
  if (target === "" || target.startsWith("#") || target.startsWith("/")) {
    return undefined;
  }
  const lower = target.toLowerCase();
  if (NON_PATH_PREFIXES.some((prefix) => lower.startsWith(prefix))) {
    return undefined;
  }
  // 空白 / 占位符 / shell 元字符：不是可核对的单个相对路径。
  if (/[\s<>{}*?$|;&]/.test(target)) {
    return undefined;
  }
  const hasSlash = target.includes("/");
  const hasKnownExtension = [...PATH_EXTENSIONS].some((extension) => lower.endsWith(extension));
  if (!hasSlash && !hasKnownExtension) {
    return undefined;
  }
  const normalized = path.posix.normalize(target.startsWith("./") ? target.slice(2) : target);
  if (normalized === "" || normalized === "." || normalized.startsWith("../")) {
    return undefined;
  }
  const resolved = path.posix.normalize(`${root}/${normalized}`);
  if (resolved.startsWith("../") || resolved === "..") {
    return undefined;
  }
  const absolute = path.resolve(repoPath, ...resolved.split("/"));
  const relative = path.relative(repoPath, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return undefined;
  }
  return { target: raw.trim(), resolved, line };
}
