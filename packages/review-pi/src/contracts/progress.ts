import type { LlmUsage } from "./llm.js";
import type { ReviewPhase, RuleSkillPassStatus } from "./run.js";

/**
 * 运行进度事件（ADR-0016「运行进度投影」）。
 *
 * 事件是**既有运行留痕的实时投影**，不是新仪器：阶段来自 `phaseLog` 的推进点、
 * 请求来自 `onPayload` / `shouldStopAfterTurn`、工具来自工具包装层、skill 来自
 * `skillPassLog` 的会话。字段一律取自这些留痕已有的形状，故：
 * - 不新增审计键、不改 wire 字节、不改退出码；
 * - 消费方（CLI）只能看见「已经发生并被记下」的事实，看不见内核内部状态。
 *
 * 序号口径：
 * - `phase.index` 是 1-based 阶段序号（1..`total`），与 `phaseLog` 的写入顺序一致；
 * - `request.requestId` **按作用域自增**：主会话内全局递增，skill 会话内按该会话
 *   自增（skill 会话是独立 `Agent`，它的第 1 次请求就是 1）；
 * - `tool` 事件的 `name` 用点分名（`review.get_diff` / `bash`），与审计
 *   `toolCallLog[].name` 同形。`start` 只带名字（状态行用来报「在飞」），入参与
 *   结果尺寸只在 `end` 上出现——工具行是一次调用的**完成后**投影。
 *
 * 唯一一处「投影层自测的量」是 `durationMs`：它由发射点用 `Date.now()` 差值算出，
 * **只进显示、不落盘、不进任何指标**——与 ADR-0013 决策 10 拒绝的「逐消息耗时
 * 仪器」不同（那会把时钟写进产物）。
 */
export type RunProgressEvent =
  | {
      readonly kind: "phase";
      readonly round: number;
      readonly phase: ReviewPhase;
      readonly index: number;
      readonly total: number;
    }
  | { readonly kind: "request"; readonly state: "start"; readonly requestId: number }
  | {
      readonly kind: "request";
      readonly state: "end";
      readonly requestId: number;
      readonly durationMs: number;
      readonly usage: LlmUsage;
    }
  | {
      readonly kind: "tool";
      readonly state: "start";
      readonly name: string;
    }
  | {
      readonly kind: "tool";
      readonly state: "end";
      readonly name: string;
      readonly argumentsSummary: string;
      readonly durationMs: number;
      readonly ok: boolean;
      /** 失败摘要（首行，已截断）；成功时缺席 */
      readonly detail?: string;
      readonly resultChars: number;
      readonly resultLines: number;
    }
  | { readonly kind: "skill"; readonly state: "start"; readonly round: number; readonly skill: string }
  | {
      readonly kind: "skill";
      readonly state: "end";
      readonly round: number;
      readonly skill: string;
      readonly durationMs: number;
      readonly status: RuleSkillPassStatus;
      readonly requestCount: number;
      readonly toolCallCount: number;
      /** 失败/降级原因（已截断）；正常结束时缺席 */
      readonly detail?: string;
    }
  /**
   * run 级起止（ADR-0037）：也是既有事实的投影——`startedAt` / `runId` /
   * `usage` / `findings` 全部取自 `runReview` 已有的局部量与落盘产物。
   *
   * 与其余四类一样不进审计、不改 wire 字节、不改退出码；CLI 状态行忽略它。
   * `run.end` 的 `runId` 在**异常路径**可能缺席：`runId` 由首次模型请求时刻
   * 决定，run 在首次请求之前就失败时它从未存在过。
   */
  | {
      readonly kind: "run";
      readonly state: "start";
      readonly caseId: string;
      readonly model: string;
      /** run 起始时刻（ISO-8601） */
      readonly startedAt: string;
    }
  | {
      readonly kind: "run";
      readonly state: "end";
      readonly status: "ok" | "failed";
      /** 产物 id（`buildRunId(firstRequestAt)`）；异常路径可能缺席 */
      readonly runId?: string;
      readonly durationMs: number;
      /** 成功路径：本次 run 的累计用量（含规则 Skill 会话） */
      readonly usage?: LlmUsage;
      readonly truncated?: boolean;
      /** 成功路径才有；`count` 与 `bySeverity` 相加应等于 findings 总数 */
      readonly findings?: {
        readonly count: number;
        readonly bySeverity: Readonly<Record<"P0" | "P1" | "P2" | "P3", number>>;
      };
    };

/** 进度消费者的唯一入口形状（CLI 注入；缺省不注入 = 零输出、零行为变化） */
export type RunProgressSink = (event: RunProgressEvent) => void;

/** 缺省 sink：三处内核（主会话 / 零工具路径 / skill 会话）共用，避免各写一份空闭包 */
export const NO_OP_PROGRESS_SINK: RunProgressSink = () => {};
