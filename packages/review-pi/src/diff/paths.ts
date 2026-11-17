// 统一 diff 的路径词法（单一真源）：
// - git C 风格引号 + 八进制转义（非 ASCII / 特殊字符路径）；
// - `---`/`+++` 头部的时间戳剥离与 `/dev/null` 判定；
// - `diff --git a/x b/x` 的成对路径提取（带空格路径按引号或最后一个 ` b/` 切）；
// - a/ b/ 前缀与反斜杠归一。
//
// 所有 diff 视图（块切分 / 宽松解析 / 严格度量 / 范围判定 / MR JSON 转换）
// 都从这里取路径，不再各写一份引号与八进制解码。

/** `---`/`+++` 行尾的制表符时间戳 */
export function stripTimestamp(raw: string): string {
  const tab = raw.indexOf("\t");
  return tab >= 0 ? raw.slice(0, tab) : raw;
}

/** git C 风格引号内的转义解码（八进制按 UTF-8 字节还原） */
export function decodeGitQuotedPath(value: string): string {
  const bytes: number[] = [];
  const simple: Readonly<Record<string, number>> = {
    t: 0x09,
    n: 0x0a,
    r: 0x0d,
    f: 0x0c,
    v: 0x0b,
    a: 0x07,
    b: 0x08,
    '"': 0x22,
    "\\": 0x5c,
  };
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index] as string;
    if (char !== "\\") {
      bytes.push(...Buffer.from(char, "utf8"));
      continue;
    }
    const next = value[index + 1];
    if (next === undefined) {
      bytes.push(0x5c);
      break;
    }
    const octal = /^[0-7]{1,3}/.exec(value.slice(index + 1));
    if (octal !== null) {
      bytes.push(Number.parseInt(octal[0], 8));
      index += octal[0].length;
      continue;
    }
    bytes.push(simple[next] ?? next.charCodeAt(0));
    index += 1;
  }
  return Buffer.from(bytes).toString("utf8");
}

/** 成对引号包住的路径解码；未加引号原样返回 */
export function unquoteGitPath(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return decodeGitQuotedPath(trimmed.slice(1, -1));
  }
  return trimmed;
}

/**
 * diff 侧路径 → 仓库相对 POSIX 路径：解引号 → 反斜杠归一 → 去 `a/` `b/` →
 * 去前导 `./`。不做大小写折叠，不解析 `..`（调用方按需自行 jail）。
 */
export function normalizeDiffPath(raw: string): string {
  return unquoteGitPath(raw)
    .replace(/\\/g, "/")
    .replace(/^[ab]\//, "")
    .replace(/^\.\//, "");
}

/**
 * 检视范围正则的匹配对象归一化（ADR-0078）：与 `normalizeDiffPath` 同口径，
 * 但**不**去 `./`——保持该接口自建立起的行为不变。
 */
export function normalizeDiffPathForRegex(raw: string): string {
  return unquoteGitPath(raw).replace(/\\/g, "/").replace(/^[ab]\//, "");
}

/** `--- x` / `+++ x` 行 → 路径；`/dev/null` 表示该侧不存在 */
export function parseHeaderPath(
  line: string,
  marker: "--- " | "+++ ",
): { readonly path: string | null; readonly deleted: boolean } {
  const text = stripTimestamp(line.slice(marker.length)).trim();
  if (text === "/dev/null") {
    return { path: null, deleted: true };
  }
  const path = normalizeDiffPath(text);
  return { path: path === "" ? null : path, deleted: false };
}

/** `diff --git` 行的两侧路径（任一侧无法识别时缺席） */
export function parseGitHeaderPaths(
  line: string,
): { readonly oldPath?: string; readonly newPath?: string } {
  const rest = line.slice("diff --git ".length);
  const quoted = rest.match(/"((?:[^"\\]|\\.)*)"/g);
  if (quoted !== null) {
    if (quoted.length >= 2) {
      const oldPath = normalizeQuoted(quoted[0] as string);
      const newPath = normalizeQuoted(quoted[quoted.length - 1] as string);
      return {
        ...(oldPath !== undefined ? { oldPath } : {}),
        ...(newPath !== undefined ? { newPath } : {}),
      };
    }
    if (quoted.length === 1) {
      const newPath = normalizeQuoted(quoted[0] as string);
      return newPath !== undefined ? { newPath } : {};
    }
  }
  const separator = rest.lastIndexOf(" b/");
  if (separator > 0) {
    const oldPath = normalizeDiffPath(rest.slice(0, separator));
    const newPath = normalizeDiffPath(rest.slice(separator + 1));
    return {
      ...(oldPath !== "" ? { oldPath } : {}),
      ...(newPath !== "" ? { newPath } : {}),
    };
  }
  return {};
}

function normalizeQuoted(quoted: string): string | undefined {
  const text = decodeGitQuotedPath(quoted.slice(1, -1));
  const normalized = normalizeDiffPath(text);
  return normalized === "" ? undefined : normalized;
}
