/**
 * 工具入参投影（pi-ai 严格校验缝的方言对冲）：把 schema 声明的已知键集合与
 * 实际入参对齐——审计真源里的工具入参可能带 schema 外的键，pi-ai 会严格拒绝；
 * 剥掉未知键即回到「按 schema 声明执行」的容忍语义。
 *
 * 主会话（`loop/agent-review-loop`）与 skill 会话（`knowledge/skill-pass`）
 * 共用同一投影口径：两者只差预算与留痕，入参处理不设两套。
 */

/** schema 已知入参键（prepareArguments 剥未知键的保留集） */
export function knownArgumentKeys(parameters: Record<string, unknown>): ReadonlySet<string> {
  const properties = parameters.properties;
  if (typeof properties !== "object" || properties === null) {
    return new Set();
  }
  return new Set(Object.keys(properties));
}

/** 按已知键投影入参；非对象入参 → 空对象（交给工具侧按缺省值处理） */
export function stripUnknownArguments(
  args: unknown,
  knownKeys: ReadonlySet<string>,
): Record<string, unknown> {
  if (typeof args !== "object" || args === null) {
    return {};
  }
  const stripped: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (knownKeys.has(key)) {
      stripped[key] = value;
    }
  }
  return stripped;
}
