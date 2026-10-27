// 跨 skill 候选合并（ADR-0014 决策 9：候选门之前按 (file, line, category) 去重）。
//
// 纪律：
// - **主候选永不被丢弃**：主会话（Phase 5）的候选流原样保留——F 的改造面只
//   止于「追加 skill 候选」，主路径行为与无 skill 时一致；但主候选的
//   (file, line, category) 会**占键**，skill 侧重复的那条因此被合并（计入
//   `mergedCount`）——同一缺陷不该以两条 id 进候选门；
// - **skill 候选按 CLI 顺序裁决**：同一去重键由最先出现的批次（以及该批次内
//   最先出现的那条）胜出，后来者计入对应批次的 `mergedCount`；
// - **schema 非法的候选不参与去重**：既不查键也不占键——它要交给候选拦截链
//   以 SCHEMA_INVALID 留痕（ADR-0014 决策 9）；
// - **语义冲突不合并**：去重键只含 (file, line, category)，不同规则/不同主张
//   落在同一行时两条都保留。
import { validateFinding } from "../finding/finding-schema.js";

/** 一个 skill 会话的候选批次（顺序 = CLI 传入顺序） */
export interface SkillCandidateBatch {
  readonly skill: string;
  /** 该会话原始产出的候选对象（未经 Schema 校验） */
  readonly candidates: readonly unknown[];
}

export interface MergeSkillCandidatesInput {
  /** 主会话（Phase 5）产出的候选对象 */
  readonly primary: readonly unknown[];
  /** 各 skill 会话产出的候选对象（按 CLI 顺序） */
  readonly batches: readonly SkillCandidateBatch[];
}

export interface MergeSkillCandidatesOutput {
  /** 合并后的候选流：主候选在前，其后是按批次顺序存活的 skill 候选 */
  readonly candidates: readonly unknown[];
  /** 与 `batches` 一一对应的被合并条数（含「与主候选重复」而被合并的；账目闭合用） */
  readonly mergedCounts: readonly number[];
  /** 与 `batches` 一一对应的存活候选（Phase 6 候选清单只列这些） */
  readonly survivingBatches: readonly SkillCandidateBatch[];
}

/** 去重键：file + line + category（file 为字符串、line 为数字、category 为字符串） */
function dedupeKey(candidate: unknown): string | undefined {
  if (validateFinding(candidate).length > 0) {
    return undefined;
  }
  const record = candidate as { file: string; line: number; category: string };
  return `${record.file}\u0000${String(record.line)}\u0000${record.category}`;
}

export function mergeSkillCandidates(input: MergeSkillCandidatesInput): MergeSkillCandidatesOutput {
  const candidates: unknown[] = [...input.primary];
  const seen = new Set<string>();

  // 主候选只占键、不被丢弃（主路径行为零变化）
  for (const candidate of input.primary) {
    const key = dedupeKey(candidate);
    if (key !== undefined) {
      seen.add(key);
    }
  }

  const mergedCounts: number[] = [];
  const survivingBatches: SkillCandidateBatch[] = [];
  for (const batch of input.batches) {
    let merged = 0;
    const surviving: unknown[] = [];
    for (const candidate of batch.candidates) {
      const key = dedupeKey(candidate);
      if (key !== undefined && seen.has(key)) {
        merged += 1;
        continue;
      }
      if (key !== undefined) {
        seen.add(key);
      }
      surviving.push(candidate);
      candidates.push(candidate);
    }
    mergedCounts.push(merged);
    survivingBatches.push({ skill: batch.skill, candidates: surviving });
  }

  return { candidates, mergedCounts, survivingBatches };
}
