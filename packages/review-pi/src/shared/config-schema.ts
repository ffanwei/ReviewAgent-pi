// 配置装载的通用校验工具（单一真源）：类型错误 / 键名校验 / 基础取值。
// 配置面（config.ts）、limits（config-limits.ts）与 MCP（config-mcp.ts）共用；
// 只依赖 Node 内建，不 import 任何配置域模块。

export const CONFIG_FILE_NAME = "PiAgent.jsonc";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export function asObject(value: unknown, path: string, warnings: string[]): Record<string, unknown> {
  void warnings;
  if (!isPlainObject(value)) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path === "" ? "root" : path} must be an object`);
  }
  return value;
}

export function optionalObject(value: unknown, path: string, warnings: string[]): Record<string, unknown> {
  if (value === undefined) {
    return {};
  }
  return asObject(value, path, warnings);
}

export function asRecordOrUndefined(value: unknown): Record<string, unknown> | undefined {
  return isPlainObject(value) ? value : undefined;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function assertKnownKeys(
  obj: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
  warnings: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) {
      continue;
    }
    const full = path === "" ? key : `${path}.${key}`;
    if (PINNED_KEYS.has(key)) {
      warnings.push(`PiAgent.jsonc: ${full} 已钉死（pinned），不会被采用`);
      continue;
    }
    warnings.push(`PiAgent.jsonc: unknown key ${full}${nearestHint(key, allowed)}`);
  }
}

export function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be a string (got ${typeof value})`);
  }
  return value;
}

export function optionalInt(
  value: unknown,
  path: string,
  bounds: { readonly min: number; readonly max: number; readonly nullable: boolean },
): number | null | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (value === null) {
    if (!bounds.nullable) {
      throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be an integer (null is not allowed)`);
    }
    return null;
  }
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be an integer (got ${describe(value)})`);
  }
  if (value < bounds.min || value > bounds.max) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path} must be in ${String(bounds.min)}…${String(bounds.max)} (got ${String(value)})`,
    );
  }
  return value;
}

/** 必填的「有值则校验，无值用缺省」整数 */
export function intOr(value: unknown, path: string, min: number, max: number, fallback: number): number {
  const parsed = optionalInt(value, path, { min, max, nullable: false });
  return parsed === undefined ? fallback : (parsed as number);
}

/**
 * 必填的「有值则校验，无值用缺省」有限小数（0–1 这类比例值；非有限数 /
 * 非数字 / 越界一律 fail fast，不把 "0.5" 当 0.5）。
 */
export function numberOr(value: unknown, path: string, min: number, max: number, fallback: number): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} must be a number (got ${describe(value)})`);
  }
  if (value < min || value > max) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path} must be in ${String(min)}…${String(max)} (got ${String(value)})`,
    );
  }
  return value;
}

/**
 * 严重级阈值：缺省用 fallback；只接受 P0–P3（大小写不敏感，归一为大写），
 * 其它值 fail fast（不把 "P5" / 4 当合法档位）。
 */
export function severityOr(
  value: unknown,
  path: string,
  fallback: "P0" | "P1" | "P2" | "P3",
): "P0" | "P1" | "P2" | "P3" {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toUpperCase();
    if (normalized === "P0" || normalized === "P1" || normalized === "P2" || normalized === "P3") {
      return normalized;
    }
  }
  throw new ConfigError(
    `${CONFIG_FILE_NAME}: ${path} must be one of P0, P1, P2, P3 (got ${describe(value)})`,
  );
}

/** 布尔开关：缺省用 fallback；出现非布尔值 fail fast（不把 "false" 当 false） */
export function boolOr(value: unknown, path: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "boolean") {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path} must be true or false (got ${describe(value)})`,
    );
  }
  return value;
}

/**
 * 模型 id → 网关 wire 字段（`reviewer.stripModelPrefix` 开启时生效）：
 * 剥掉**最后一个 `/` 前的所有**（`pan/deeseek` → `deeseek`、`a/b/c` → `c`）。
 * 无斜杠原样返回；剥完为空（如 `pan/`）也原样返回——发送空 model 是更坏的
 * 失败形态，宁可让网关拒原串并留痕。开关关闭 = 逐字节原样（现行契约）。
 */
export function modelIdForGateway(rawModelId: string, stripPrefix: boolean): string {
  if (!stripPrefix) {
    return rawModelId;
  }
  const cut = rawModelId.lastIndexOf("/");
  return cut >= 0 && cut < rawModelId.length - 1 ? rawModelId.slice(cut + 1) : rawModelId;
}

export function normalizeBaseUrl(value: string, path: string): string {
  const trimmed = value.trim();
  if (!/^https?:\/\//.test(trimmed)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path} must start with http:// or https:// (got ${JSON.stringify(value)})`,
    );
  }
  return trimmed.replace(/\/+$/, "");
}

export function describe(value: unknown): string {
  if (value === null) {
    return "null";
  }
  return Array.isArray(value) ? "array" : typeof value;
}

export function requiredNonEmptyString(value: unknown, path: string): string {
  const text = optionalString(value, path)?.trim();
  if (text === undefined || text === "") {
    throw new ConfigError(`${CONFIG_FILE_NAME}: ${path} is required (non-empty string)`);
  }
  return text;
}

/** 已钉死的键名（配置里出现 → 警告「不会被采用」） */
const PINNED_KEYS = new Set<string>([
  "maxToolCalls",
  "toolResultBudgetChars",
  "temperature",
  "reasoningEffort",
  "reasoning_effort",
  "effort",
  "envAllowlist",
  "skillBashEnvAllowlist",
  "provider",
  "api",
  "compat",
  "thinkingFormat",
  "maxTokensField",
]);

/** 编辑距离 ≤2 的最近键提示（只用于未知键，不用于禁配字段） */
function nearestHint(key: string, allowed: readonly string[]): string {
  let best: string | undefined;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    const distance = editDistance(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  return best !== undefined && bestDistance <= 2 ? ` (did you mean ${best}?)` : "";
}

function editDistance(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0] ?? 0;
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const temp = previous[j] ?? 0;
      previous[j] = Math.min(
        (previous[j] ?? 0) + 1,
        (previous[j - 1] ?? 0) + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = temp;
    }
  }
  return previous[b.length] ?? 0;
}

/** glob 列表解析（`codeintel.excludeGlobs` 与 `limits.mrFilter.excludeGlobs` 共用） */
export function parseGlobList(
  value: unknown,
  label: string,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${label} must be an array of glob patterns (got ${describe(value)})`,
    );
  }
  const globs: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigError(
        `${CONFIG_FILE_NAME}: ${label}[${String(index)}] must be a non-empty string (got ${describe(entry)})`,
      );
    }
    const glob = entry.trim();
    if (!globs.includes(glob)) {
      globs.push(glob);
    }
  });
  return globs;
}

/**
 * 正则列表解析（ADR-0078：`limits.mrFilter.includeRegex` / `excludeRegex`）。
 * 与 glob 列表的差别：**不 trim**（首尾空格可能是正则语义的一部分），
 * 但纯空白仍拒绝；逐条 `new RegExp` 试编译，装载期 fail fast；去重保序。
 */
export function parseRegexList(
  value: unknown,
  label: string,
  fallback: readonly string[],
): readonly string[] {
  if (value === undefined || value === null) {
    return fallback;
  }
  if (!Array.isArray(value)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${label} must be an array of regular expressions (got ${describe(value)})`,
    );
  }
  const patterns: string[] = [];
  value.forEach((entry, index) => {
    if (typeof entry !== "string" || entry.trim() === "") {
      throw new ConfigError(
        `${CONFIG_FILE_NAME}: ${label}[${String(index)}] must be a non-empty string (got ${describe(entry)})`,
      );
    }
    try {
      new RegExp(entry);
    } catch (error) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME}: ${label}[${String(index)}] is not a valid regular expression (${error instanceof Error ? error.message : String(error)})`,
      );
    }
    if (!patterns.includes(entry)) {
      patterns.push(entry);
    }
  });
  return patterns;
}
