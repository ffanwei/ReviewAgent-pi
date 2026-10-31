// LLM 消息与用量契约（测量常量面：与 DSH 线 / 冻结指标共享的口径）。

/** 对话消息（P1a 形态：无工具调用，仅 role + content） */
export interface LlmMessage {
  readonly role: "system" | "user" | "assistant";
  readonly content: string;
}

/**
 * wire 消息（onPayload 序列化点原样投影：OpenAI chat 格式）。
 * assistant 条目可携带 provider 扩展字段（如 deepseek 的 reasoning_content），
 * 透传不裁剪——审计 requests[].messages 必须与 wireBody.messages JSON 同构。
 */
export interface WireMessage {
  readonly role: "system" | "user" | "assistant" | "tool";
  readonly content: string;
  [extra: string]: unknown;
}

/** 工具 schema（DSH 审计口径：parametersJson 为注册表固定键序的序列化字节） */
export interface ToolSchema {
  readonly name: string;
  readonly description: string;
  readonly parametersJson: string;
}

export interface LlmUsage {
  /** 未命中缓存的输入 token */
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** 命中缓存的输入 token */
  readonly cacheReadTokens?: number;
  readonly cacheWriteTokens?: number;
}
