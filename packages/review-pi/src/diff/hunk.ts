// hunk 头语法（单一真源）：`@@ -oldStart[,oldCount] +newStart[,newCount] @@`。
//
// 两种严格度：
// - `parseHunkHeader`：前缀匹配，供宽松解析（块内容 / 范围判定 / 符号分析）；
// - `parseHunkHeaderStrict`：整行匹配（允许 `@@ ... @@ 上下文` 尾部），供边界
//   护栏的「可完整游走」判定——不能证明是 hunk 头就按 malformed 降级。

export interface HunkHeader {
  /** 旧侧起始行（1-based；0 仅用于新增文件的 `-0,0`） */
  readonly oldStart: number;
  readonly oldCount: number;
  /** 新侧起始行（1-based；0 仅用于删除文件的 `+0,0`） */
  readonly newStart: number;
  readonly newCount: number;
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const HUNK_HEADER_STRICT = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;

/** 宽松 hunk 头解析；不是 hunk 头或线号非法返回 null */
export function parseHunkHeader(line: string): HunkHeader | null {
  return parseWith(HUNK_HEADER, line);
}

/** 严格 hunk 头解析（整行匹配；计数 > 0 时起始行必须 ≥ 1） */
export function parseHunkHeaderStrict(line: string): HunkHeader | null {
  return parseWith(HUNK_HEADER_STRICT, line);
}

function parseWith(pattern: RegExp, line: string): HunkHeader | null {
  const match = pattern.exec(line);
  if (match === null) {
    return null;
  }
  const oldStart = Number(match[1]);
  const oldCount = match[2] === undefined ? 1 : Number(match[2]);
  const newStart = Number(match[3]);
  const newCount = match[4] === undefined ? 1 : Number(match[4]);
  if (
    !Number.isInteger(oldStart) ||
    !Number.isInteger(oldCount) ||
    !Number.isInteger(newStart) ||
    !Number.isInteger(newCount) ||
    (oldCount > 0 && oldStart < 1) ||
    (newCount > 0 && newStart < 1)
  ) {
    return null;
  }
  return { oldStart, oldCount, newStart, newCount };
}
