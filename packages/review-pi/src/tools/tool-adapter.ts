import type { AgentTool } from "@earendil-works/pi-agent-core";

import type { RunProgressSink } from "../contracts/progress.js";
import { toWireToolName } from "./registry.js";
import { knownArgumentKeys, stripUnknownArguments } from "./tool-arguments.js";
import { withToolProgress, type ToolProgressLimits } from "./tool-progress.js";
import type { ReviewToolkit } from "./toolkit.js";

/**
 * 七工具 → `AgentTool` 的唯一适配器（ADR-0085）。
 *
 * 这里只拥有「投影与 wire 口径」：点分名 → 下划线 wire 名、入参剥离、
 * `"Error: "` 失败文本、可选的进度包装。预算、审计与计数全部由调用方的
 * hooks 注入——主 loop 传预算/审计/进度，规则 Skill 会话只传计数。
 */

/** 一次工具调用的审计视图（`argumentsJson` 已过 `prepareArguments`） */
export interface ToolCallInfo {
  /** 点分审计名（`schema.name`），不是 wire 名 */
  readonly name: string;
  readonly argumentsJson: string;
}

export interface ToolAdapterHooks {
  /**
   * 执行前：`skip` = 不执行工具，`text` 原样回给模型（预算耗尽等）。
   * 预算计数、审计与截取留痕由实现方在此完成。
   */
  beforeExecute?(call: ToolCallInfo):
    | { readonly kind: "run" }
    | { readonly kind: "skip"; readonly text: string };
  /** 成功：`result` 为工具原始文本 */
  onResult?(call: ToolCallInfo, result: string): void;
  /** 失败：`text` 为最终文本（已含 `"Error: "` 前缀） */
  onError?(call: ToolCallInfo, text: string): void;
  /** 进度包装；缺省 = 零包装 */
  progress?: {
    readonly emit: RunProgressSink;
    readonly limits?: ToolProgressLimits;
  };
}

export function buildAgentTools(
  toolkit: ReviewToolkit,
  hooks: ToolAdapterHooks = {},
): AgentTool[] {
  return toolkit.schemas.map((schema) => {
    const parameters = JSON.parse(schema.parametersJson) as Record<string, unknown>;
    const knownKeys = knownArgumentKeys(parameters);
    const tool: AgentTool = {
      name: toWireToolName(schema.name),
      label: schema.name,
      description: schema.description,
      parameters,
      prepareArguments: (args) => stripUnknownArguments(args, knownKeys),
      execute: async (_toolCallId, params) => {
        const args = params as Record<string, unknown>;
        const call: ToolCallInfo = {
          name: schema.name,
          argumentsJson: JSON.stringify(args),
        };
        const decision = hooks.beforeExecute?.(call);
        if (decision?.kind === "skip") {
          return { content: [{ type: "text", text: decision.text }], details: {} };
        }
        try {
          const result = await toolkit.executeTool(schema.name, args);
          hooks.onResult?.(call, result);
          return { content: [{ type: "text", text: result }], details: {} };
        } catch (error) {
          // t-series 真源字节：失败前缀 "Error: "（工具错误消息自带工具名前缀）
          const text = `Error: ${errorMessage(error)}`;
          hooks.onError?.(call, text);
          return { content: [{ type: "text", text }], details: {} };
        }
      },
    };
    return hooks.progress !== undefined
      ? withToolProgress(tool, schema.name, hooks.progress.emit, hooks.progress.limits)
      : tool;
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
