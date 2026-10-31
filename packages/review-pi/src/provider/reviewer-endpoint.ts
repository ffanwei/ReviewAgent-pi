import { requireApiKey, type ResolvedConfig } from "../shared/config.js";

// 检视链网关接入点（#4 → ADR-0025）：**唯一**来源是用户级配置文件
// （`~/.PiAgent/PiAgent.jsonc` / `--config`）。env 层（REVIEWER_* / DEEPSEEK_*）
// 已彻底关闭——本模块不再 import `review-llm` 的 resolver，也不读 `process.env`。
//
// 与 DSH 线 env.ts reviewerBaseUrlOf 同名同序同 trim/尾斜杠语义（已在配置层
// 完成归一）；差异：本包消费方是 pi-ai（OpenAI SDK 在 baseURL 上自行拼
// /chat/completions），故解析产物是 base URL 本身，不追加路径——网关 URL
// 需自带 /v1（OpenAI SDK 只追加 /chat/completions）。
//
// key 纪律：只经不可变配置快照进内存，绝不硬编码、绝不出现在错误信息或任何
// 落盘产物中。

/** 已解析的检视链接入点（真跑冒烟与后续实验共用） */
export interface ReviewerEndpoint {
  /** base URL（trim、尾斜杠已归一；不追加 /chat/completions） */
  readonly baseUrl: string;
  readonly apiKey: string;
}

/** 从配置快照解析接入点（缺 key = 人话 fail fast，提示 `config init`） */
export function resolveReviewerEndpoint(config: ResolvedConfig): ReviewerEndpoint {
  return {
    baseUrl: config.reviewer.baseUrl,
    apiKey: requireApiKey(config),
  };
}
