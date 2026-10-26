# Spec: 规则 Skill 与 config F —— 项目规则检视

`Status: ready-for-agent`

- **Agent skills / domain docs**：`CONTEXT.md`（术语「规则 Skill」）、`docs/adr/0012-project-rules-as-rule-skill-injected-at-candidates-phase.md`
- **来源**：grill-me 三轮 grill（Q1–Q16）+ grill-with-docs 复核（F1–F3）+ to-spec 缝确认（S1 + S3）

## Problem Statement

作为 Review Runtime 的使用者，我无法让检视按"**被检视项目自己的规则**"进行。当前核内检视是通用的：Zone B 里那个「项目规则」槽位至今是**占位**（明说"本阶段不配置项目规则"），项目私有的缺陷模式与业务规则（CWD 一类）从未被喂给 reviewer。后果：

- **规则型缺陷漏检**——违反项目约定的改动不会被当成 Finding，因为没有规则可依。
- **没有可消融的开关**——想验证"加项目规则能不能提升 Recall / 降低 token"，却没有一个独立配置位可测；直接改冻结面又会污染 A–E 的历史测量。
- **规则无处投放**——项目方没有一条把"自己的检视规则"随仓库交付的通道。

## Solution

引入**规则 Skill（Rule Skill）**：项目把打包好的规则技能包（zip）放在本仓约定目录里随仓库交付。Review Runtime 在**构造 Agent 之前**完成"定位 → 哈希 → 解压前审计 → 宿主解压 → 解压后复核 → 装载"，然后在**候选阶段（Phase 5）**把一份简报注入候选阶段的那条消息——简报含该 skill 的检视指引 + 三条硬约定（英文-only / 候选 id 前缀 / 证据必填）。规则型候选与一般候选走**同一条候选拦截链**，最终产物是普通 Finding，与一般 Finding 天然合流。

该能力以**新测量配置 F**（= E + 规则 Skill）暴露，可对 E 做消融对比；A–E **逐字节不变**。规则包**只当数据**、永不执行；任何外部失败**降级**（空规则 + 审计留痕），run 照常。

## User Stories

1. As a **review operator**, I want to enable project-specific rules by dropping a rule-skill zip into the project's conventional directory, so that I don't change any code to turn it on.
2. As a review operator, I want the rule skill resolved automatically per reviewed repo, so that each project's rules apply without per-run flags.
3. As a review operator, I want to override which skill is used for a run, so that I can compare different rule packs on the same repo.
4. As a review operator, I want to select config F explicitly, so that rule-augmented review is opt-in and the default entry stays E.
5. As a review operator, I want an explicit zip path override, so that I can test a pack from outside the conventional directory.
6. As an **evaluator**, I want existing A–E results to remain byte-identical, so that prior measurements stay valid.
7. As an evaluator, I want F to be a first-class measurement line, so that Recall / Precision / token / CARC can be computed for rule-augmented review.
8. As an evaluator, I want F kept out of the frozen judgment matrix and anchor, so that rule-augmented review can't silently move the launch gate.
9. As an evaluator, I want F's byte difference localized to a single point, so that I can attribute effects unambiguously.
10. As the **reviewer (model)**, I want to see the project's rules at the candidates phase, so that I can raise rule-based candidates with evidence.
11. As the reviewer, I want a stable, environment-independent skill location in the brief, so that my requests are reproducible across machines.
12. As the reviewer, I want the brief to demand English-only output, so that non-English rule text isn't copied into findings and rejected.
13. As the reviewer, I want a naming convention for rule-based candidate ids, so that they don't collide with general finding ids.
14. As the reviewer, I want the brief to require real evidence, so that rule-based candidates survive the Evidence Gate.
15. As the reviewer, I want to attribute a finding to its rule, so that the origin is traceable.
16. As a **human reviewer**, I want rule-based findings merged with general findings, so that I review one list.
17. As a human reviewer, I want rule-based findings to go through disposition unchanged, so that I accept/reject them like any other.
18. As a **safety engineer**, I want path traversal in an archive rejected, so that a malicious pack can't write outside its cache.
19. As a safety engineer, I want decompression bombs rejected, so that a malicious pack can't exhaust memory or disk.
20. As a safety engineer, I want absolute paths and symlinks rejected, so that a pack can't escape its directory.
21. As a safety engineer, I want rule packs to be data-only and never executed, so that no pack can run code in the evaluation pipeline.
22. As a safety engineer, I want entry-count and compression-ratio caps, so that resource use is bounded.
23. As an **ops engineer**, I want a missing/broken pack to degrade rather than crash the run, so that no run dies from an external dependency.
24. As an ops engineer, I want signed-off strict mode, so that CI can demand the pack succeed.
25. As an ops engineer, I want extraction cached by content hash, so that repeated runs don't re-extract.
26. As an ops engineer, I want the reviewed repo snapshot left untouched, so that extraction doesn't pollute the model's readable surface.
27. As an ops engineer, I want extraction to work on Windows without Git Bash, so that local Windows runs succeed.
28. As an ops engineer, I want cross-platform extraction, so that CI on Linux and local Windows both work.
29. As an ops engineer, I want extraction timeouts and sanitized errors, so that a hung/hostile pack can't hang the run or leak host paths into recorded bytes.
30. As an **auditor**, I want the skill's source / digest / name / degradation recorded, so that I can explain any run's behavior after the fact.
31. As a **project author**, I want to ship my team's review rules as a versioned skill package, so that my rules travel with my repo.
32. As a **maintainer**, I want the 规则 Skill concept distinguished from the Zone B 「项目规则」 slot and from C3 knowledge, so that two different mechanisms aren't conflated.
33. As a maintainer, I want the decision recorded as an ADR + a glossary term, so that future readers understand why it exists.
34. As a maintainer, I want the measurement-constant face untouched, so that the byte discipline gates stay green.

## Implementation Decisions

- **New measurement config `F` = E + 规则 Skill.** E's shape (tools enabled, stable prefix, ledger) plus a `ruleSkill` flag. A–E each gain `ruleSkill: false` so their bytes are unchanged. Config F is the *only* knob that can change request bytes. _(Type shape from the design phase, Q1–Q16:)_

  ```ts
  type ConfigId = "A" | "B" | "C" | "D" | "E" | "F";
  // F = { toolsEnabled: true, stablePrefix: true, ledger: true, ruleSkill: true }
  // A–E = { ...existing, ruleSkill: false }
  ```

- **Rule-skill source = a conventional directory inside the reviewed repo**, holding exactly one zip. Explicit override (zip path; skill name) available. Network download is *not* part of this spec.
- **Loading reuses the kernel skill loader semantics** (`SKILL.md` + frontmatter validation; a skill is dropped if `name`/`description` are invalid). The runtime selects **exactly one** skill (by name, else the only one); ambiguous/absent ⇒ degrade.
- **Pre-agent lifecycle**: locate → content hash → pre-extraction audit → extract via host process → post-extraction verification → load. "Before the Agent is constructed" is a hard ordering requirement.
- **Extraction**: host child process, platform-appropriate (built-in `tar` on Windows — no Git Bash dependency; `unzip`/`tar` on POSIX; PowerShell `Expand-Archive` fallback). 30 s timeout. Error text **sanitized** (no host absolute paths; matches the repo's cross-environment reproducibility discipline).
- **Cache**: content-hash-named directory under the run output root. Idempotent (same content ⇒ no re-extract). **Never writes into the reviewed repo.**
- **Limits**: 8 MiB archive, 2000 entries, 64 MiB uncompressed, 100:1 compression ratio.
- **Injection seam**: an optional per-phase brief hook on the review-loop inputs. The brief is appended to the **same** candidates-phase message — never a second follow-up (the harness follow-up queue mode is one-at-a-time; two follow-ups would become two runs).
- **Brief content** = kernel skill-block format + a conventions paragraph: English-only output; candidate-id prefix (`RULE-CHECK@<file>:<line>`); mandatory evidence; `rule` = skill name. **The skill location in the block must be a stable pseudo-path (`.review-rules/<name>/SKILL.md`), never the host cache path** (ADR-0012 consequence / review finding F1).
- **Rules are data only. Never executed.** Only `SKILL.md` is read (and any data files), never run.
- **No dual path**: the rule skill does **not** enter the `search_rule` knowledge corpus —所以 规则 Skill **不是 C3 Knowledge**（`KnowledgeCorpus.rules` 保持空）。
- **Failure = degrade** (empty rules + audit reason) unless strict mode is on. Run always completes.
- **Metrics**: F is a **pseudo-config slot** (same posture as the existing external-reference slot) — visible in `RunResult.configId` and metric grouping, **not** in the A–E matrix / `labels.allowedConfigs` / S-A-B judgment.
- **Audit**: an optional tail key recording `source / digest / name / degradedReason? / diagnostics?` (absent-key discipline preserved).
- **CLI**: flags for explicit zip path / skill name / strict. Config selection accepts F; the default remains E.
- **Domain**: new glossary term **规则 Skill（Rule Skill）**; decision recorded as **ADR-0012**.
- **Contract of the loader output** _(type shape from the design phase)_:

  ```ts
  interface RuleSkill {
    name: string;          // frontmatter name — the "xxx" in "xxx skill"
    description: string;
    content: string;       // SKILL.md body
    digest: string;        // zip content sha256 (cache key + audit)
    degradedReason?: string;
  }
  ```

## Testing Decisions

- **What makes a good test**: assert only **external behavior** — given a repo snapshot + diff + a rule skill, the observable outcomes are (a) the wire request at the candidates phase, (b) the audit record, (c) the findings. No assertions on internal call sequences or private helpers.
- **Seams**: **S1 = the public run entry** (highest; existing; already supports transport injection) is the primary seam and the "one seam" ideal. **S3 = the rule-skill loader** (new, narrow, at the highest viable point — the assembly-layer function, not the unzip sub-routine) is used **only** for the extraction/security/idempotency matrix.
- **Modules tested**: the rule-skill loader (S3); the end-to-end run path (S1).
- **Prior art**: the run-path tests (fake transport + wire goldens + audit assertions) for S1; the ripgrep-wrapper tests (spawn-based) and the kernel skill-loader tests (fake execution env) for S3.
- **Byte-freeze guards**: assert A–E byte-identical — phase goldens, system-prompt golden, tool-face goldens unchanged; add new F wire goldens; add an F cache-break expectation (F has stable prefix + ledger).
- **Security matrix (S3)**: path traversal rejected; decompression bomb rejected; entry-count/ratio caps enforced; hash mismatch degrades; symlink/absolute rejected; same content ⇒ same digest ⇒ no re-extract; strict mode throws.
- **Determinism (S3 + S1)**: the brief contains **no absolute path**; the candidates-phase delta is the only byte difference vs E; degraded runs fall back to E-level output.
- **De-grade path (S1)**: a broken/absent pack ⇒ run completes, audit carries the degradation reason, findings match E.

## Out of Scope

- Downloading rule skills over the network (a later phase; the source type keeps a `url` slot).
- Multi-skill selection, layering, or precedence across packs.
- Feeding rules into `search_rule` / C3 knowledge.
- Filling the Zone B 「项目规则」 slot for config B.
- Structuring `Finding.rule` (a shared Finding-schema change; cross-repo).
- Adding F to the cross-kernel semantic-parity gate, the launch gate, or the A–E main matrix.
- Executing any code shipped inside a rule pack.
- Non-Java repos / per-language rule packs.

## Further Notes

- **Discipline**: the measurement-constant face stays untouched — Zone A prompt, phase instructions, the tool face, the finding/evidence contract are all byte-frozen; changes land **only** in the new config F.
- **Terminology**: 规则 Skill ≠ Zone B 「项目规则」槽位（另一落点，且 Zone B 仅 B 配置有）≠ C3 Knowledge。用语见 `CONTEXT.md`。
- **Rollout order** (each step independently verifiable): (1) add the per-phase brief hook with no config change and prove all existing tests green; (2) add config F; (3) build + unit-test the loader/brief; (4) wire the run path + audit + CLI; (5) add F goldens; (6) end-to-end on one VUL4J case, F vs E.
- **Risk**: a non-English skill whose text gets copied into findings ⇒ `NON_ENGLISH` rejections. Mitigated by the conventions paragraph; to be verified end-to-end in step (6).
- **Non-obvious**: extraction must happen *before* the loader runs (the loader reads a directory); a model-side unzip cannot feed the same run's skill list and is not used.
