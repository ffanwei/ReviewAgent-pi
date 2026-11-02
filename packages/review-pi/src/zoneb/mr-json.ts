/**
 * GitCode / GitLab 「MR 文件变更」JSON → 标准 unified diff（ADR-0029）。
 *
 * 接口 `GET /api/v5/repos/:owner/:repo/pulls/:number/files` 返回的是**按文件切片的
 * hunk 片段**：每一项只有路径与从 `@@` 开始的正文，没有
 * `diff --git` / `---` / `+++` 文件头。`diff-analysis.ts` 以文件头定位「当前文件」，
 * 裸 hunk 会被判成 `diff hunk appeared before any file header`——所以直接喂接口
 * 响应跑不起来，必须先补头。
 *
 * 注意同一家（GitCode v5）的两条接口字段不一致：`/pulls/:number/files` 是 GitHub
 * 形态（`filename` + `patch`），`/pulls/:number/files.json` 才是 `new_path` + `diff`。
 * 两套都要能直接喂，否则用户按文档拉 `/files` 只会得到「第 1 项缺 new_path」。
 *
 * 读取面是**两个语义字段**，各自有一小撮方言（同一家接口的两套形态）：
 *
 * | 语义 | 字段（按优先级） | 出处 |
 * |---|---|---|
 * | 新侧路径 | `new_path` → `filename` → `path` | GitLab / GitCode `files.json` 用 `new_path`；GitCode v5 `/files` 与 GitHub 用 `filename` |
 * | 文件正文 | `diff` → `patch` | 同上 |
 *
 * 其余字段（`old_path` / `new_file` / `deleted_file` / `renamed_file` / `status` / …）
 * 一律忽略——新增与删除由 hunk 头自行判定（`@@ -0,0 ` = 新增，`+0,0 @@` = 删除）。
 *
 * 本模块只做这一件确定性转换：不联网、不做路径改写、不猜内容。
 * 形状不对就 fail fast，错误消息带输入标签与条目序号（坏在第几项一眼可见），
 * 并列出该项**实际有哪些键**——方言再次漂移时不用猜。
 */

const FIRST_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m;

/** 新侧路径的字段方言（按优先级） */
const PATH_KEYS = ["new_path", "filename", "path"] as const;
/** 文件正文的字段方言（按优先级） */
const BODY_KEYS = ["diff", "patch"] as const;

/**
 * JSON 文本 → unified diff 文本（之后与 `--mr-diff` 走同一条解析路径）。
 *
 * 顶层必须是数组；每个元素取路径（必填，`new_path` / `filename` / `path` 任一）与
 * 正文（可空，`diff` / `patch` 任一）。正文为空的条目（二进制 / 纯改名，接口给的是
 * 空串或干脆没有该键）不产出块；一个可转换条目都没有时抛错——静默产出空 diff 会让
 * 上游拿到「零文件」的假结论。
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
  if (!Array.isArray(parsed)) {
    throw new Error(`${label}: 期望文件变更数组，得到 ${describe(parsed)}`);
  }

  const chunks: string[] = [];
  parsed.forEach((entry, index) => {
    const chunk = chunkOf(entry, index, label);
    if (chunk !== undefined) {
      chunks.push(chunk);
    }
  });
  if (chunks.length === 0) {
    throw new Error(
      `${label}: 没有可转换的文本 diff（${String(parsed.length)} 个条目全部为空 diff / 二进制变更）`,
    );
  }
  return chunks.join("");
}

/** 单个条目 → diff 文本块；`diff` 为空返回 undefined */
function chunkOf(entry: unknown, index: number, label: string): string | undefined {
  const where = `${label}: 第 ${String(index + 1)} 项`;
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
    throw new Error(`${where}不是对象（得到 ${describe(entry)}）`);
  }
  const record = entry as Record<string, unknown>;

  const path = firstString(record, PATH_KEYS).trim();
  if (path === "") {
    throw new Error(
      `${where}缺 new_path（无路径就无法定位文件；也可用 filename / path）` +
        `——该项现有键：${keysOf(record)}`,
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

/** 正文：`diff` / `patch` 哪个有内容用哪个；非字符串（且非空）直接报错，指明是哪个键 */
function bodyOf(record: Record<string, unknown>, where: string): string | undefined {
  for (const key of BODY_KEYS) {
    const value = record[key];
    if (value === undefined || value === null) {
      continue;
    }
    if (typeof value !== "string") {
      throw new Error(`${where}的 ${key} 必须是字符串（得到 ${describe(value)}）`);
    }
    if (value.trim() !== "") {
      return value;
    }
  }
  return undefined;
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
