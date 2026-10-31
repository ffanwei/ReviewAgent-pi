/**
 * GitCode / GitLab 「MR 文件变更」JSON → 标准 unified diff（ADR-0029）。
 *
 * 接口 `GET /api/v5/repos/:owner/:repo/pulls/:number/files` 返回的是**按文件切片的
 * hunk 片段**：每一项只有 `new_path` 与从 `@@` 开始的 `diff` 正文，没有
 * `diff --git` / `---` / `+++` 文件头。`diff-analysis.ts` 以文件头定位「当前文件」，
 * 裸 hunk 会被判成 `diff hunk appeared before any file header`——所以直接喂接口
 * 响应跑不起来，必须先补头。
 *
 * 读取面**只有两个字段**：`new_path` 与 `diff`。其余字段（`old_path` / `new_file` /
 * `deleted_file` / `renamed_file` / `patch` / …）一律忽略——新增与删除由 hunk 头
 * 自行判定（`@@ -0,0 ` = 新增，`+0,0 @@` = 删除）。
 *
 * 本模块只做这一件确定性转换：不联网、不做路径别名映射、不猜内容。
 * 形状不对就 fail fast，错误消息带输入标签与条目序号（坏在第几项一眼可见）。
 */

const FIRST_HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/m;

/**
 * JSON 文本 → unified diff 文本（之后与 `--mr-diff` 走同一条解析路径）。
 *
 * 顶层必须是数组；每个元素取 `new_path`（必填）与 `diff`（可空）。`diff` 为空的
 * 条目（二进制 / 纯改名，接口给的是空串）不产出块；一个可转换条目都没有时抛错
 * ——静默产出空 diff 会让上游拿到「零文件」的假结论。
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

  const path = typeof record.new_path === "string" ? record.new_path.trim() : "";
  if (path === "") {
    throw new Error(`${where}缺 new_path（无路径就无法定位文件）`);
  }

  const rawDiff = record.diff;
  if (rawDiff !== undefined && rawDiff !== null && typeof rawDiff !== "string") {
    throw new Error(`${where}的 diff 必须是字符串（得到 ${describe(rawDiff)}）`);
  }
  const body = typeof rawDiff === "string" ? rawDiff : "";
  if (body.trim() === "") {
    return undefined;
  }

  const normalized = body.replace(/\r\n/g, "\n");
  // 已经是整段 patch（有些网关/代理直接回 git 原文）：不重复包头
  if (normalized.startsWith("diff --git ")) {
    return normalized.endsWith("\n") ? normalized : `${normalized}\n`;
  }

  const hunk = FIRST_HUNK.exec(normalized);
  // 新增文件 = `@@ -0,0 `（旧侧从 0 开始且零行）；删除文件 = `+0,0 @@`。
  // 只有 new_path 时两侧路径相同，靠这两个 hunk 头把 `/dev/null` 摆到正确一侧。
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

function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  return typeof value;
}
