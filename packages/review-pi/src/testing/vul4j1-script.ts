import { fileURLToPath } from "node:url";
import type { FakeReply } from "../provider/fake-fetch.js";
import { goldenFixture } from "./golden.js";

// VUL4J-1 的 fake 适配器脚本（离线全链共享 fixture）。
// 回复 1–5 = t-series 审计原文（DSH 线 VUL4J-1/B/rep-1 requests[i].messages 尾部
// assistant 内容）；回复 6 为合成裁决（F001 驳回理由逐字取自 t-series 拒绝留痕
// "candidate: " 之后）；usage 按回合拆分上报，六回合之和 = t-series 聚合
// {input 9579, output 14484, cacheRead 24064}。

/** VUL4J-1 仓库快照（.cache/datasets/vul4j-repos/，repo-root 相对） */
export const VUL4J_1_SNAPSHOT = fileURLToPath(
  new URL("../../../../.cache/datasets/vul4j-repos/VUL4J-1-f5903fa564", import.meta.url),
);

export const VUL4J_1_ISSUE =
  "Vulnerability CVE-2017-18349 (CWE-20: Improper Input Validation) in alibaba/fastjson. Fixed by https://github.com/alibaba/fastjson/commit/f5903fa56497c00ed0703ac875b511f9bd5f1d8e.";

/** 阶段 6 合成裁决：F001 驳回、F002 通过、complete 信号终止 */
const REPLY_6 = JSON.stringify({
  verdicts: [
    {
      id: "F001",
      pass: false,
      reason:
        "The cited evidence does not establish that componentType and componentClass ever diverge. The visible diff hunk shows both assigned together as 'componentType = componentClass = clazz.getComponentType()', and there is no evidence in the available context of another branch where componentType is a ParameterizedType while componentClass is raw. The finding explicitly relies on code not visible in the diff, which violates the No Evidence, No Finding policy; it is speculative rather than evidence-backed.",
    },
    { id: "F002", pass: true, reason: "The cited evidence supports the finding." },
  ],
  complete: true,
});

/** 六回合 usage 拆分：Σinput = 9579、Σoutput = 14484、ΣcacheRead = 24064 */
const USAGE_SPLIT = [
  { promptTokens: 4000, completionTokens: 2000, cacheReadTokens: 0 },
  { promptTokens: 5800, completionTokens: 1200, cacheReadTokens: 4600 },
  { promptTokens: 5800, completionTokens: 2500, cacheReadTokens: 4700 },
  { promptTokens: 5850, completionTokens: 2300, cacheReadTokens: 4800 },
  { promptTokens: 6100, completionTokens: 4800, cacheReadTokens: 4900 },
  { promptTokens: 6093, completionTokens: 1684, cacheReadTokens: 5064 },
] as const;

/** fake 适配器脚本：回复 1–5 黄金原文 + 回复 6 合成裁决 */
export function vul4j1Corpus(): FakeReply[] {
  const texts = [
    goldenFixture("reply-1-vul4j-1.txt"),
    goldenFixture("reply-2-vul4j-1.txt"),
    goldenFixture("reply-3-vul4j-1.txt"),
    goldenFixture("reply-4-vul4j-1.txt"),
    goldenFixture("reply-5-vul4j-1.txt"),
    REPLY_6,
  ];
  return texts.map((text, index) => ({ text, usage: USAGE_SPLIT[index] }));
}
