// 兼容入口：实现已下沉到 `shared/one-shot-llm.ts`（核外一次性调用的公共层），
// 内核侧（候选修复）与 CLI 侧（报文 / 总结）共用同一实现。此处保留旧导入路径。
export {
  completeOneShot,
  extractJsonObject,
  type OneShotFailure,
  type OneShotLlmInput,
  type OneShotLlmResult,
} from "../shared/one-shot-llm.js";
