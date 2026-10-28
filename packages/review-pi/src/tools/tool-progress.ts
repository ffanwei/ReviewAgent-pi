import type { AgentTool } from "@earendil-works/pi-agent-core";
import { NO_OP_PROGRESS_SINK, type RunProgressSink } from "../contracts/progress.js";
import { clampLine, summarizeToolArguments } from "./tool-arguments.js";

/**
 * 工具进度包装层（ADR-0016）：给任意 `AgentTool` 套上「开始/结束」两个事件。
 *
 * 为什么共享一层：主会话（`loop/agent-review-loop`）与 skill 会话
 * （`knowledge/skill-pass`）的工具面不同（七只 / 八只），但「什么算失败」必须
 * 同口径，否则同一行进度在两个会话里会写出两种结论。判据沿用本仓既有的失败
 * 约定：工具返回文本以 `Error: ` 开头即失败（预算耗尽与抓取异常都走这条），
 * 抛出的异常同样算失败并原样上抛。
 *
 * 只投影、不决策：包装层不改入参、不改结果、不改预算与留痕顺序，也不吞
 * `execute` 的 `onUpdate` 回调（原样透传给被包装工具）。缺省 sink（进度关）
 * 直接原样返回工具——关闭进度时连结果文本长度的统计都不做。
 */

/** 失败摘要上限（只取首行；含省略号） */
const DETAIL_MAX_CHARS = 120;

export function withToolProgress(tool: AgentTool, name: string, emit: RunProgressSink): AgentTool {
  // 进度关：零包装（不额外扫结果文本算 chars/lines，也不改工具对象身份）
  if (emit === NO_OP_PROGRESS_SINK) {
    return tool;
  }
  return {
    ...tool,
    execute: async (toolCallId, params, signal, onUpdate) => {
      const startedAt = Date.now();
      const argumentsSummary = summarizeToolArguments(toArguments(params));
      emit({ kind: "tool", state: "start", name });
      try {
        const result = await tool.execute(toolCallId, params, signal, onUpdate);
        const text = textOf(result.content);
        const ok = !text.startsWith("Error:");
        emit({
          kind: "tool",
          state: "end",
          name,
          argumentsSummary,
          durationMs: Math.max(0, Date.now() - startedAt),
          ok,
          ...(ok ? {} : { detail: summarizeDetailLine(text) }),
          resultChars: text.length,
          resultLines: countLines(text),
        });
        return result;
      } catch (error) {
        emit({
          kind: "tool",
          state: "end",
          name,
          argumentsSummary,
          durationMs: Math.max(0, Date.now() - startedAt),
          ok: false,
          detail: summarizeDetailLine(error),
          resultChars: 0,
          resultLines: 0,
        });
        throw error;
      }
    },
  };
}

/**
 * 失败/降级的一行摘要：取首行、剥掉 `Error: ` 前缀（状态词由呈现层负责）、
 * 截断到 120 字符。输入可以是抛出的 Error，也可以是工具或会话返回的错误文本。
 */
export function summarizeDetailLine(value: unknown): string {
  const raw = value instanceof Error ? value.message : String(value);
  const firstLine = raw.split(/\r?\n/, 1)[0] ?? "";
  const stripped = firstLine.replace(/^Error:\s*/, "");
  return clampLine(stripped, DETAIL_MAX_CHARS);
}

function toArguments(params: unknown): Record<string, unknown> {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>) : {};
}

/** 结果文本（工具应答的 text 块拼接；与 wire tool 消息 content 同源） */
function textOf(content: unknown): string {
  if (!Array.isArray(content)) {
    return "";
  }
  return content
    .filter((block): block is { type: "text"; text: string } => {
      const candidate = block as { type?: unknown; text?: unknown };
      return candidate.type === "text" && typeof candidate.text === "string";
    })
    .map((block) => block.text)
    .join("\n");
}

function countLines(text: string): number {
  return text.length === 0 ? 0 : text.split(/\r?\n/).length;
}
