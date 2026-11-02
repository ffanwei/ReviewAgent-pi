/**
 * GitCode / GitLab 「MR 文件变更」JSON → 标准 unified diff（ADR-0029）。
 *
 * 接口 `GET /api/v5/repos/:owner/:repo/pulls/:number/files` 返回的是**按文件切片的
 * hunk 片段**：每一项只有路径与从 `@@` 开始的正文，没有
 * `diff --git` / `---` / `+++` 文件头。`diff-analysis.ts` 以文件头定位「当前文件」，
 * 裸 hunk 会被判成 `diff hunk appeared before any file header`——所以直接喂接口
 * 响应跑不起来，必须先补头。
 *
 * 注意同一家（GitCode v5）的几条接口字段不一致，现实里已经见到四种形态：
 *
 * | 顶层 | 每项路径 | 每项正文 | 出处 |
 * |---|---|---|---|
 * | 数组 | `new_path` | `diff` | GitLab `/changes` |
 * | 数组 | `filename` | `patch` | GitCode `/pulls/:number/files`、GitHub |
 * | 对象 `{diffs:[…]}` | `new_path` | `diff` | GitCode `/pulls/:number/files.json` |
 * | 数组 | `file_path`（外层） | `diff.diff`（内层对象） | GitCode 文件树包装形态（`{diff:{…}, file_path, file_type, level, title}`） |
 *
 * 全部要能直接喂，否则用户按文档拉到的响应只会得到「第 1 项缺 new_path」。
 *
 * 读取面只有**两个语义字段**，各自按优先级取第一个非空值：
 *
 * - 新侧路径：`new_path` → `filename` → `file_path` → `path`（外层没有就看 `diff` 内层）
 * - 文件正文：`diff` → `patch`（`diff` 是对象时向内递归，即 `diff.diff` / `diff.patch`）
 *
 * 其余字段（`old_path` / `new_file` / `deleted_file` / `renamed_file` / `status` /
 * `too_large` / `level` / `title` / …）一律忽略——新增与删除由 hunk 头自行判定
 * （`@@ -0,0 ` = 新增，`+0,0 @@` = 删除）。
 *
 * 本模块只做这一件确定性转换：不联网、不做路径改写、不猜内容。
 * 形状不对就 fail fast，错误消息带输入标签与条目序号（坏在第几项一眼可见），
 * 并列出该项**实际有哪些键**——方言再次漂移时不用猜。
 */

const FIRST_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m;

/** 新侧路径的字段方言（按优先级；外层与嵌套层共用） */
const PATH_KEYS = ["new_path", "filename", "file_path", "path"] as const;
/** 文件正文的字段方言（按优先级；`diff` 为对象时递归进同名子键） */
const BODY_KEYS = ["diff", "patch"] as const;

/**
 * JSON 文本 → unified diff 文本（之后与 `--mr-diff` 走同一条解析路径）。
 *
 * 顶层可以是数组，也可以是 `{diffs:[…]}`（GitCode `/files.json` 的外壳）。
 * 每个元素取路径（必填）与正文（可空）；正文为空的条目（二进制 / 纯改名 /
 * `too_large`，接口给的是空串或干脆没有该键）不产出块；一个可转换条目都没有时
 * 抛错——静默产出空 diff 会让上游拿到「零文件」的假结论。
 */
export function mrJsonToUnifiedDiff(raw: string, label: string): string {
  const text = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(
      `${label}: 不是合法 JSON（${error instanceof Error ? error.message : String(error)}）`,
    );
  }
  const entries = entriesOf(parsed, label);

  const chunks: string[] = [];
  entries.forEach((entry, index) => {
    const chunk = chunkOf(entry, index, label);
    if (chunk !== undefined) {
      chunks.push(chunk);
    }
  });
  if (chunks.length === 0) {
    throw new Error(
      `${label}: 没有可转换的文本 diff（${String(entries.length)} 个条目全部为空 diff / 二进制 / too_large / 纯改名）`,
    );
  }
  return chunks.join("");
}

/** 顶层两种形态：裸数组，或 `{diffs:[…]}` 外壳 */
function entriesOf(parsed: unknown, label: string): readonly unknown[] {
  if (Array.isArray(parsed)) {
    return parsed;
  }
  if (isRecord(parsed) && Array.isArray(parsed.diffs)) {
    return parsed.diffs;
  }
  throw new Error(
    `${label}: 期望文件变更数组或 {diffs:[…]}，得到 ${describe(parsed)}`,
  );
}

/** 单个条目 → diff 文本块；正文为空返回 undefined */
function chunkOf(entry: unknown, index: number, label: string): string | undefined {
  const where = `${label}: 第 ${String(index + 1)} 项`;
  if (!isRecord(entry)) {
    throw new Error(`${where}不是对象（得到 ${describe(entry)}）`);
  }
  const record = entry;

  const path = pathOf(record).trim();
  if (path === "") {
    throw new Error(
      `${where}缺 new_path（无路径就无法定位文件；可用 new_path / filename / file_path / path，` +
        `也可放在 diff 内层）——该项现有键：${keysOf(record)}`,
    );
  }

  const body = bodyOf(record, where);
  if (body === undefined) {
    return undefined;
  }

  const normalized = body.replace(/\r\n/g, "\n");
  // 已经是整段 patch（有些网关/代理直接回 git 原文）：不重复包头
  if (normalized.startsWith("diff --git ")) {
    return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  }

  const hunk = FIRST_HUNK.exec(normalized);
  // 新增文件 = `@@ -0,0 `（旧侧从 0 开始且零行）；删除文件 = `+0,0 @@`。
  // 只有新侧路径时两侧路径相同，靠这两个 hunk 头把 `/dev/null` 摆到正确一侧。
  const isNew = hunk !== null && hunk[1] === "0" && (hunk[2] ?? "1") === "0";
  const isDeleted = hunk !== null && hunk[3] === "0" && (hunk[4] ?? "1") === "0";

  const lines = [`diff --git a/${path} b/${path}`];
  if (isNew) {
    lines.push("new file mode 100644");
  }
  if (isDeleted) {
    lines.push("deleted file mode 100644");
  }
  lines.push(isNew ? "--- /dev/null" : `--- a/${path}`);
  lines.push(isDeleted ? "+++ /dev/null" : `+++ b/${path}`);
  lines.push(normalized.endsWith("\n") ? normalized : `${normalized}\n`);
  return lines.join("\n");
}

/** 路径：外层方言键优先；外层都没有就看 `diff` 内层（文件树包装形态） */
function pathOf(record: Record<string, unknown>): string {
  const flat = firstString(record, PATH_KEYS);
  if (flat !== "") {
    return flat;
  }
  const nested = record.diff;
  return isRecord(nested) ? firstString(nested, PATH_KEYS) : "";
}

/**
 * 按优先级取第一个非空字符串字段。缺失 / `null` / 空串都继续看下一个方言键，
 * 这样「`diff` 为空但 `patch` 有内容」的混合响应也能吃下。
 */
function firstString(record: Record<string, unknown>, keys: readonly string[]): string {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return "";
}

/**
 * 正文：`diff` / `patch` 哪个有内容用哪个。
 *
 * `diff` 有时是**对象**（`{new_path, diff, too_large, …}` 的文件树包装形态），
 * 此时向内递归——子层的键名与错误标签都带上前缀（`diff.diff`），让人一眼看出层级。
 * 非字符串 / 非对象的标量直接报错，不猜。
 */
function bodyOf(record: Record<string, unknown>, where: string, prefix = ""): string | undefined {
  for (const key of BODY_KEYS) {
    const value = record[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value === "string") {
      if (value.trim() !== "") {
        return value;
      }
      continue;
    }
    if (isRecord(value)) {
      const nested = bodyOf(value, where, `${prefix}${key}.`);
      if (nested !== undefined) {
        return nested;
      }
      continue;
    }
    throw new Error(`${where}的 ${prefix}${key} 必须是字符串（得到 ${describe(value)}）`);
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function keysOf(record: Record<string, unknown>): string {
  const keys = Object.keys(record);
  return keys.length === 0 ? "（无键）" : keys.join("、");
}

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
