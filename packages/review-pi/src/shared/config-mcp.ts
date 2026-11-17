// MCP 上报配置（ADR-0037 / ADR-0045）：类型、键集与装载期解析。
//
// 从 `shared/config.ts` 拆出：MCP 块的选择很多（servers / report / batch /
// queue），但语义独立——配置面只需要拿到解析结果，不需要了解每个键。

import { MCP_REPORT_EVENT_TYPES, type McpReportEventType } from "../contracts/mcp-report.js";
import {
  asObject,
  assertKnownKeys,
  boolOr,
  ConfigError,
  CONFIG_FILE_NAME,
  describe,
  intOr,
  optionalObject,
  optionalString,
  requiredNonEmptyString,
} from "./config-schema.js";

/** MCP 服务端连接（ADR-0037：v1 只有 HTTP 传输；ADR-0037 后续修订加老式 http-sse） */
export interface McpServerSettings {
  /**
   * `"http"` = Streamable HTTP（单端点 POST，响应回在 POST 上——推荐形态）；
   * `"http-sse"` = 老式 HTTP+SSE（2024-11-05 规范：GET 长连接收 `endpoint`
   * 事件，消息 POST 到该端点，**响应从 SSE 流回来**）。url 语义随形态：
   * http 填消息端点；http-sse 填 **SSE 端点**（如 `…/sse`）。
   */
  readonly transport: "http" | "http-sse";
  /**
   * 握手策略（ADR-0037 后续修订）：
   * - `"auto"`（缺省）：先试 `initialize`，服务端不认就降级为无状态直调
   *   （每个 `tools/call` 独立 POST，与 Postman 单发同形）；
   * - `"required"`：握手失败即视为上报不可用；
   * - `"off"`：从不发 `initialize`，直调 `tools/call`。
   */
  readonly handshake: "auto" | "required" | "off";
  readonly url: string;
  /** 秘密：审计 / stdout / stderr / `config show` 一律只报 set | missing */
  readonly headers: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}

/** 上报批次与背压（数值在装载期已校验过范围） */
export interface McpReportBatchSettings {
  readonly maxEvents: number;
  readonly maxDelayMs: number;
}

/** 上报策略（ADR-0037 决策 6；业务 tool 开关为 ADR-0045；`tool` 可选化为 ADR-0037 后续修订） */
export interface McpReportSettings {
  /** 指向 `servers` 里的名字；装载期校验存在 */
  readonly server: string;
  /**
   * 单槽位接收工具（批量塞进 `events` 数组）。**可选（ADR-0045 后默认形态）**：
   * 缺席 = 事件通道整体关闭——只调四个业务 tool，不用写占位名与
   * `include: []`。给了才发进度事件（`include` 缺省四类）。
   */
  readonly tool?: string;
  /**
   * 业务 tool 开关（ADR-0045）：true = 调 `startTask` / `endTask` /
   * `saveReviewSummary` / `mrReviewResult`；false = 只发进度事件。
   * 缺省 true——老 server 没有这批 tool 时可一行关闭（省得日志一片红字）。
   */
  readonly task: boolean;
  readonly include: readonly McpReportEventType[];
  readonly batch: McpReportBatchSettings;
  readonly queue: { readonly maxEvents: number };
  readonly flushTimeoutMs: number;
  /** findings 出站档位：v1 只支持 none / summary（正文永不出进程） */
  readonly findings: "none" | "summary";
}

/** `mcp` 配置块；未配置 = null（零建连、零请求） */
export interface McpSettings {
  readonly servers: Readonly<Record<string, McpServerSettings>>;
  readonly report: McpReportSettings;
}

const MCP_KEYS = ["servers", "report"] as const;
const MCP_SERVER_KEYS = ["transport", "handshake", "url", "headers", "timeoutMs"] as const;
const MCP_REPORT_KEYS = [
  "server",
  "tool",
  "task",
  "include",
  "batch",
  "queue",
  "flushTimeoutMs",
  "findings",
] as const;
const MCP_BATCH_KEYS = ["maxEvents", "maxDelayMs"] as const;
const MCP_QUEUE_KEYS = ["maxEvents"] as const;

/** 出站事件类型合法值（单一源：`contracts/mcp-report.ts`） */
const MCP_EVENT_TYPES: ReadonlySet<string> = new Set(MCP_REPORT_EVENT_TYPES);

/** 缺省上报事件集：`tool.*` / `skill.*` 频率最高、对机器流水价值最低，默认不发 */
const DEFAULT_MCP_INCLUDE: readonly McpReportEventType[] = [
  "run.start",
  "run.end",
  "phase",
  "request.end",
];

/**
 * `mcp` 块：未配置（或只有 servers 没有 report）= null，不是错误。
 * 有 report 但配置不自洽 = ConfigError（启动期 fail fast，不进主链）。
 */
export function parseMcp(raw: unknown, warnings: string[]): McpSettings | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const mcp = asObject(raw, "mcp", warnings);
  assertKnownKeys(mcp, MCP_KEYS, "mcp", warnings);
  if (mcp.report === undefined || mcp.report === null) {
    return null;
  }

  const serversObj = optionalObject(mcp.servers, "mcp.servers", warnings);
  const servers: Record<string, McpServerSettings> = {};
  for (const [name, entry] of Object.entries(serversObj)) {
    if (name.trim() === "") {
      throw new ConfigError(`${CONFIG_FILE_NAME}: mcp.servers keys must be non-empty server names`);
    }
    servers[name] = parseMcpServer(name, entry, warnings);
  }

  const reportObj = asObject(mcp.report, "mcp.report", warnings);
  assertKnownKeys(reportObj, MCP_REPORT_KEYS, "mcp.report", warnings);
  const server = requiredNonEmptyString(reportObj.server, "mcp.report.server");
  // tool 可选（ADR-0045 后默认形态）：缺席 = 事件通道关闭，只调四个业务 tool。
  // 给了就必须是非空字符串（空串 = 用法错误，不是「关」）。
  const tool =
    reportObj.tool === undefined || reportObj.tool === null
      ? undefined
      : requiredNonEmptyString(reportObj.tool, "mcp.report.tool");
  if (servers[server] === undefined) {
    const known = Object.keys(servers);
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: mcp.report.server must name a configured server (got ${JSON.stringify(server)}; ` +
        `${known.length === 0 ? "mcp.servers is empty" : `known: ${known.join(", ")}`})`,
    );
  }
  // 业务 tool 开关（ADR-0045）：缺省 true（要业务上报就真调；老 server 一行关闭）
  const task = boolOr(reportObj.task, "mcp.report.task", true);
  const include = parseMcpInclude(reportObj.include);

  const batchObj = optionalObject(reportObj.batch, "mcp.report.batch", warnings);
  assertKnownKeys(batchObj, MCP_BATCH_KEYS, "mcp.report.batch", warnings);
  const batch: McpReportBatchSettings = {
    maxEvents: intOr(batchObj.maxEvents, "mcp.report.batch.maxEvents", 1, 1_000, 50),
    maxDelayMs: intOr(batchObj.maxDelayMs, "mcp.report.batch.maxDelayMs", 0, 600_000, 2_000),
  };

  const queueObj = optionalObject(reportObj.queue, "mcp.report.queue", warnings);
  assertKnownKeys(queueObj, MCP_QUEUE_KEYS, "mcp.report.queue", warnings);
  const queue = {
    maxEvents: intOr(queueObj.maxEvents, "mcp.report.queue.maxEvents", 1, 100_000, 1_000),
  };

  const flushTimeoutMs = intOr(reportObj.flushTimeoutMs, "mcp.report.flushTimeoutMs", 0, 600_000, 5_000);

  const findingsRaw = optionalString(reportObj.findings, "mcp.report.findings")?.trim() ?? "summary";
  if (findingsRaw !== "none" && findingsRaw !== "summary") {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: mcp.report.findings must be "none" or "summary" (got ${JSON.stringify(findingsRaw)}; ` +
        `finding 正文永不出进程，要正文请读 reviews_en.json)`,
    );
  }

  return {
    servers,
    report: {
      server,
      ...(tool !== undefined ? { tool } : {}),
      task,
      include,
      batch,
      queue,
      flushTimeoutMs,
      findings: findingsRaw,
    },
  };
}

function parseMcpServer(name: string, raw: unknown, warnings: string[]): McpServerSettings {
  const path = `mcp.servers.${name}`;
  const obj = asObject(raw, path, warnings);
  assertKnownKeys(obj, MCP_SERVER_KEYS, path, warnings);

  const transport = optionalString(obj.transport, `${path}.transport`)?.trim() ?? "http";
  if (transport !== "http" && transport !== "http-sse") {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path}.transport must be "http" (Streamable HTTP，单端点 POST) ` +
        `or "http-sse" (老式 HTTP+SSE，GET 长连接 + endpoint 事件；got ${JSON.stringify(transport)}；stdio 不在范围内)`,
    );
  }

  const handshakeRaw = optionalString(obj.handshake, `${path}.handshake`)?.trim() ?? "auto";
  if (handshakeRaw !== "auto" && handshakeRaw !== "required" && handshakeRaw !== "off") {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path}.handshake must be "auto" ` +
        `(握手失败降级为无状态直调，缺省), "required" ` +
        `(握手失败即上报不可用) or "off" (从不握手，直接 tools/call；got ${JSON.stringify(handshakeRaw)})`,
    );
  }
  const handshake = handshakeRaw;

  const url = requiredNonEmptyString(obj.url, `${path}.url`);
  if (!/^https?:\/\//.test(url)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: ${path}.url must start with http:// or https:// (got ${JSON.stringify(url)})`,
    );
  }

  const headersObj = optionalObject(obj.headers, `${path}.headers`, warnings);
  const headers: Record<string, string> = {};
  for (const [key, value] of Object.entries(headersObj)) {
    if (typeof value !== "string") {
      throw new ConfigError(`${CONFIG_FILE_NAME}: ${path}.headers.${key} must be a string`);
    }
    headers[key] = value;
  }

  return {
    transport,
    handshake,
    url,
    headers,
    timeoutMs: intOr(obj.timeoutMs, `${path}.timeoutMs`, 100, 600_000, 60_000),
  };
}

/** `include` 缺省 = 稳定默认集；未知类型 fail fast（不静默忽略拼错的类型） */
function parseMcpInclude(raw: unknown): readonly McpReportEventType[] {
  if (raw === undefined || raw === null) {
    return DEFAULT_MCP_INCLUDE;
  }
  if (!Array.isArray(raw)) {
    throw new ConfigError(
      `${CONFIG_FILE_NAME}: mcp.report.include must be an array of event types (got ${describe(raw)})`,
    );
  }
  const include: McpReportEventType[] = [];
  raw.forEach((entry, index) => {
    if (typeof entry !== "string" || !MCP_EVENT_TYPES.has(entry)) {
      throw new ConfigError(
        `${CONFIG_FILE_NAME}: mcp.report.include[${String(index)}] must be one of ` +
          `${MCP_REPORT_EVENT_TYPES.join(", ")} (got ${JSON.stringify(entry)})`,
      );
    }
    if (!include.includes(entry as McpReportEventType)) {
      include.push(entry as McpReportEventType);
    }
  });
  return include;
}

