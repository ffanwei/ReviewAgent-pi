import { readFileSync } from "node:fs";

/**
 * `.env` 文件的**纯解析**（ADR-0025 `config init --from-env` 专用）。
 *
 * 与旧 `shared/env-local.ts` 装载器的唯一区别：**绝不写 `process.env`**。
 * 配置装载后 env 层彻底关闭，这里只把文件当一次性迁移输入读进内存。
 *
 * 语义（保持旧装载器的行级口径，减少迁移期意外）：
 * - `KEY=VALUE` 行；首个 `=` 分割，值中的 `=` 保留；
 * - 空行与 `#` 注释行跳过（行内 `#` 是值的一部分）；
 * - 成对单/双引号剥离；BOM 剥离；CRLF 安全；
 * - 空值行保留为空串（迁移期可区分「写了但为空」与「没写」）；
 * - 同名键首次出现胜出（后续重复行忽略）；
 * - 坏行只记行号（原文可能恰是裸贴的 key，绝不回显）。
 */

export interface EnvFileParseResult {
  readonly filePath: string;
  /** 文件是否存在（缺失 = 空结果，不报错） */
  readonly exists: boolean;
  /** 键 → 值（按文件顺序；值不做 trim 以外的加工） */
  readonly values: ReadonlyMap<string, string>;
  /** 无法解析的行（"line N"，1 起；不含原文） */
  readonly malformedLines: readonly string[];
}

/** 合法行形态：KEY=VALUE（key 为 [A-Za-z_][A-Za-z0-9_]*；"KEY = value" 视为坏行） */
const ENV_LINE_RE = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/;

export function parseEnvFile(filePath: string): EnvFileParseResult {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { filePath, exists: false, values: new Map(), malformedLines: [] };
    }
    throw new Error(
      `failed to read ${filePath}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const values = new Map<string, string>();
  const malformedLines: string[] = [];
  // BOM 剥离（Windows 编辑器常给）；split(/\r?\n/) 同时吃掉 CRLF
  const lines = content.replace(/^\uFEFF/, "").split(/\r?\n/);
  for (const [index, rawLine] of lines.entries()) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) {
      continue;
    }
    const match = ENV_LINE_RE.exec(line);
    if (match === null || match[1] === undefined || match[2] === undefined) {
      malformedLines.push(`line ${String(index + 1)}`);
      continue;
    }
    const key = match[1];
    if (values.has(key)) {
      continue;
    }
    values.set(key, stripPairedQuotes(match[2].trim()));
  }
  return { filePath, exists: true, values, malformedLines };
}

/** 成对引号剥离（"value" / 'value' → value；不成对原样保留） */
function stripPairedQuotes(value: string): string {
  if (value.length < 2) {
    return value;
  }
  const first = value.charAt(0);
  const last = value.charAt(value.length - 1);
  if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
    return value.slice(1, -1);
  }
  return value;
}
