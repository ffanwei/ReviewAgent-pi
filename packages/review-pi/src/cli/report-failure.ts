/**
 * 上报不可用的 stderr 一行：只报事实（协议 / 网络 / 状态码），不回显 headers。
 * 截断到 160 字符，避免服务端把长消息灌进日志。
 *
 * CLI 组装点（MCP 建连 / 留痕写盘）与交付 module（覆盖补报）共用同一文案口径。
 */
export function describeReportFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const oneLine = message.replace(/\s+/g, " ").trim();
  return oneLine.length > 160 ? `${oneLine.slice(0, 157)}...` : oneLine;
}
