import type { McpReportEventType } from "../contracts/mcp-report.js";
import { ConfigError, type McpServerSettings, type ResolvedConfig } from "../shared/config.js";

/**
 * `mcp` 配置块 → reporter 的运行期形状（ADR-0037 决策 6）。
 *
 * 结构与取值范围已在 `shared/config.ts` 装载期校验过（fail fast）；本层只做
 * 「按名字取服务端」与「数组转集合」两件事，不再复述一遍校验规则。
 */
export interface ReportConfig {
  readonly server: McpServerSettings;
  readonly tool: string;
  /** 业务 tool 开关（ADR-0045）：`mcp.report.task`，缺省 true */
  readonly task: boolean;
  readonly include: ReadonlySet<McpReportEventType>;
  readonly batch: { readonly maxEvents: number; readonly maxDelayMs: number };
  readonly queue: { readonly maxEvents: number };
  readonly flushTimeoutMs: number;
  readonly findings: "none" | "summary";
}

/** 未配置 `mcp.report` → null（不上报，零建连） */
export function resolveReportConfig(config: ResolvedConfig): ReportConfig | null {
  const mcp = config.mcp;
  if (mcp === null) {
    return null;
  }
  const server = mcp.servers[mcp.report.server];
  if (server === undefined) {
    // 装载期已校验；这里只防直调内核的调用方绕过配置装载
    throw new ConfigError(
      `mcp.report.server names an unknown server (${JSON.stringify(mcp.report.server)})`,
    );
  }
  return {
    server,
    tool: mcp.report.tool,
    task: mcp.report.task,
    include: new Set(mcp.report.include),
    batch: mcp.report.batch,
    queue: mcp.report.queue,
    flushTimeoutMs: mcp.report.flushTimeoutMs,
    findings: mcp.report.findings,
  };
}
