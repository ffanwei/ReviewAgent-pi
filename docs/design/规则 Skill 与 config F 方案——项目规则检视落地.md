# 规则 Skill 与 config F 方案——项目规则检视落地

> **状态**：已归档（2026-10-26）。决策记录见 `docs/adr/0012`；术语见 `CONTEXT.md`「规则 Skill」。
> **后续**：**[ADR-0014](docs/adr/0014-rule-skill-review-pass-after-candidates-phase.md) 取代本文 §4 第 7 条硬纪律（绝不执行 zip 内任何脚本）、§6 验收 2（`ruleSkill` 单对象）与 Phase 5 简报注入形态（Q5/Q10/Q16 的注入点）**——现行口径是「Phase 5 之后追加独立 skill 检视会话」；本文其余内容（zip 定位/审计/解压、降级、伪配置位、不进 `search_rule`）继续有效。
> **适用范围**：pi 内核线 `ReviewAgent-pi`（`packages/review-pi`）。DSH 兄弟仓引用须写全限定语「DSH 线 ADR-XXXX」。
> **来源**：grill-me 三轮 grill（Q1–Q16）+ grill-with-docs 复核（修正 F1–F3，已折入正文）。
> **目标**：在 `new Agent` 之前把"被检视项目自带的规则 skill"（zip）定位、解压、装载好；在 **Phase 5（候选阶段）** 注入简报做规则检视；规则 finding 与一般 finding 天然合流。

---

## 0. 决策台账（Q1–Q16 → 已定）

| Q | 决策 | Q | 决策 |
|---|---|---|---|
| Q1 | **真 kernel skill 包**（`SKILL.md` + `loadSkills`） | Q9 | **只做简报**（不喂 `search_rule`，`knowledge.rules` 保持空） |
| Q2 | **仓库约定目录自动探测** | Q10 | **skill 块**（复用内核 `formatSkillInvocation`，**需净化 `location`**） |
| Q3 | **宿主 shell 解压** | Q11 | **伪配置位**（照 `REFERENCE_CONFIG_ID` 先例） |
| Q4 | **新增 config `F`** | Q12 | **不动 `Finding` 契约** |
| Q5 | **`phaseBrief` 阶段消息拼接** | Q13 | zip 定位 + 解到 `<out>/…/.cache/rule-skills/<sha256>/`，**不写回仓库** |
| Q6 | **降级 + 审计留痕** | Q14 | `child_process` + `tar.exe`/`unzip` 优先、`Expand-Archive` 兜底；超时 30s；`--strict-rule-skill` 缺省关 |
| Q7 | **`.review-rules/` 只放 zip**，先手动放，下载后期做 | Q15 | **解压前审计 + 解压后复核**；8MiB/2000/64MiB/100:1 |
| Q8 | 路径 `<repoPath>/.review-rules/`；F 取**单一** skill | Q16 | 追加**约定段**（英文-only／`RULE-CHECK@<file>:<line>` 前缀／证据必填）；`rule` = **skill 名** |

---

## 1. 总体设计

```
runReview → runToolDrivenReview (review-run.ts:217)
  │
  ├─[新] loadRuleSkill({ ruleSkillZip?, ruleSkillName?, repoPath, cacheRoot, strict })
  │        定位 .review-rules/*.zip → sha256 → 解压前审计 → 宿主 shell 解压 → 解压后复核
  │        → loadSkills(NodeExecutionEnv, cacheDir, BACKGROUND_CONTEXT) → 取单个 Skill
  │        任一步失败 → { degradedReason, ... }（不抛）
  │              │
  │              └── RuleSkill { name, description, content, filePath, digest, degradedReason? }
  │
  ├─ runAgentReviewLoop({ …,
  │       phaseBrief: i => i === RULE_CHECK_PHASE_INDEX ? buildRuleSkillBrief(skill) : undefined })
  │                              ▼   （RULE_CHECK_PHASE_INDEX = 4 = Phase 5，对齐 CANDIDATES_PHASE_INDEX）
  │                     new Agent({…})   ← 阶段五简报在"new Agent 前"已备好（agent-review-loop.ts:160）
  │                              ▼
  │                     advancePhase 进入 Phase 5 → followUp( phaseMessage(4) )
  │                              = PHASE_INSTRUCTIONS[4] + "\n\n" + <skill …>…</skill> + 约定段
  │                              ▼
  │                     Phase 5 产出 candidates（rule = "<skill 名>"）→ Phase 6 verdicts
  │                              → applyCandidateGate → findings（**天然合流**）
  │
  └─ 审计尾部追加 ruleSkill{ source, digest, name, degradedReason? }
```

**关键不变量**：
- 简报**只拼进同一条** Phase 5 消息——`followUpMode` 缺省 `one-at-a-time`（`packages/agent/src/agent.ts:232`），**连发两条 followUp = 两个 run**。
- `config.ruleSkill === false`（A–E）时 `loadRuleSkill` **不调用**、`phaseBrief` 缺省 ⇒ **逐字节不变**。
- 工具面、Zone A 常量、`phases.ts` **一律不动** ⇒ 六阶段 / 系统提示 / 工具 6 门全绿。
- **简报内不得出现任何宿主绝对路径**（修正 F1）。

---

## 2. 契约与新建文件（3 个）

### 2.1 契约（`packages/review-pi/src/knowledge/rule-skill.ts`）

```ts
export interface RuleSkillSource {
  /** 现在只有 "zip"；后期加 "url"（下载腿，见 §8） */
  readonly kind: "zip";
  readonly path: string;
}

export interface RuleSkillLimits {
  readonly maxArchiveBytes: number;         // 8 * 1024 * 1024
  readonly maxEntries: number;              // 2000
  readonly maxTotalUncompressed: number;    // 64 * 1024 * 1024
  readonly maxCompressionRatio: number;     // 100
  readonly timeoutMs: number;               // 30_000
}

export interface RuleSkill {
  readonly name: string;                    // frontmatter name（"xxx skill" 的 xxx）
  readonly description: string;
  readonly content: string;                 // SKILL.md 正文
  readonly filePath: string;                // 原始（绝对）路径——仅供审计，勿直接进简报
  readonly digest: string;                  // zip 内容 sha256（缓存键 + 审计留痕）
  readonly source: RuleSkillSource;
  readonly diagnostics: readonly SkillDiagnostic[];
  readonly degradedReason?: string;         // 有值 = 降级（空 skill）
}

export async function loadRuleSkill(options: {
  readonly repoPath: string;
  readonly cacheRoot: string;
  readonly explicitZipPath?: string;        // --rule-skill-zip
  readonly skillName?: string;              // --rule-skill-name
  readonly strict?: boolean;                // --strict-rule-skill（缺省 false）
  readonly spawnChild?: SpawnFn;            // 测试注入缝（对齐 review-run 的 fetch 注入风格）
  readonly loadSkillsFn?: typeof loadSkills;
  readonly limits?: RuleSkillLimits;
}): Promise<RuleSkill | undefined>;
```

### 2.2 `packages/review-pi/src/knowledge/rule-skill.ts`（核心）

**实现步骤（每步有界、可失败、可留痕）**：

| 步 | 做什么 | 要点 |
|---|---|---|
| 1 | 定位 zip：`explicitZipPath` 优先；否则扫 `<repoPath>/.review-rules/*.zip` | 0 个 / >1 个且未 `--rule-skill-name` → **降级**（不瞎猜） |
| 2 | 读 zip 字节 → `stat.size ≤ maxArchiveBytes`；`digest = sha256(bytes)` | 内容哈希做缓存键（幂等、可复现、可审计） |
| 3 | `cacheDir = <cacheRoot>/<digest>`；若含 `SKILL.md` → **跳过解压** | 命中复用 |
| 4 | **解压前审计**：`tar -tf` / `unzip -l` 列条目 → 校验（§4） | 越界/绝对路径/符号链接/条目数/声明大小 |
| 5 | **宿主 shell 解压**（§4）→ 目标 = `cacheDir` | win32 `tar.exe -xf`（不依赖 Git Bash）／posix `unzip -o` |
| 6 | **解压后复核**：`cacheDir` 内无逃逸文件、无链接、总解压量 ≤ 上限 | 兜住解压器差异 |
| 7 | `loadSkills(new NodeExecutionEnv({ cwd: cacheDir }), cacheDir, BACKGROUND_CONTEXT)` → 取 `skillName` 匹配项，否则取唯一项 | 内核 spec：frontmatter 校验 / `SKILL.md`-first（`skills.ts:51-78,145-157`） |
| 8 | 返回 `RuleSkill{ name, description, content, filePath: skill.filePath, digest, source, diagnostics }` | `Skill` 契约 `harness/types.ts:49-60` |
| 9 | **任何一步失败**：`strict` → 抛；否则 → `{ degradedReason, … }` | 绝不因外部依赖挂 run（`bytegate/tool-outputs-vul4j-1.gate.ts:28` 无网络纪律） |

**导入**（全部来自已存在依赖，**零新增 npm 包**）：`node:child_process`、`node:crypto`、`node:fs/promises`、`loadSkills` / `Skill` / `SkillDiagnostic`（根导出，`index.ts:79`）、`BACKGROUND_CONTEXT`（`@earendil-works/pi-agent-core/harness/context`）、`NodeExecutionEnv`（`@earendil-works/pi-agent-core/node`，`node.ts:1`）。

### 2.3 `packages/review-pi/src/knowledge/rule-skill-brief.ts`

```ts
import { formatSkillInvocation, type Skill } from "@earendil-works/pi-agent-core";
import type { RuleSkill } from "./rule-skill.js";

/** 候选阶段下标（0-based）。模块内自带，不与 loop 层耦合；由单测与本仓 CANDIDATES_PHASE_INDEX 对齐。 */
export const RULE_CHECK_PHASE_INDEX = 4;

/** 稳定伪路径：净化宿主绝对路径（修正 F1） */
function stableLocation(name: string): string {
  return `.review-rules/${name}/SKILL.md`;
}

const INSTRUCTION = (name: string) =>
  [
    "## Rule-based review (this phase)",
    "- Write EVERY finding field (id/title/description/category/evidence) in ENGLISH ONLY.",
    "- Emit the candidates that arise from the rules in the skill block above.",
    "- Prefix candidate ids with `RULE-CHECK@<file>:<line>`.",
    "- Evidence is mandatory (symbol + line + excerpt); candidates without evidence are dropped.",
    `- Set the "rule" field to the skill name "${name}".`,
  ].join("\n");

export function buildRuleSkillBrief(skill: RuleSkill): string {
  const sanitized: Skill = {
    name: skill.name,
    description: skill.description,
    content: skill.content,
    filePath: stableLocation(skill.name),   // ← 关键：绝不透传解压缓存的绝对路径
  };
  return formatSkillInvocation(sanitized, INSTRUCTION(skill.name));
}
```

- 复用内核 `formatSkillInvocation`（`skills.ts:39-42`）产出 `<skill name=… location=…>` + `\n\n` + 约定段。
- **修正 F1**：`location` 与 "References are relative to …" 均改用稳定伪路径 `.review-rules/<name>/SKILL.md`，请求字节不含宿主绝对路径、不随 `--out`/`experimentId` 漂移。
- 三条约定压住 gate 陷阱：`NON_ENGLISH` / `DUPLICATE_ID` / `NO_EVIDENCE`（`gate/candidate-gate.ts:82-106`）。
- `rule` = skill 名（受控、零额外解析，兑现 Q16）。

### 2.4 `packages/review-pi/src/knowledge/rule-skill.test.ts`

- fixture zip 放 `packages/review-pi/testdata/rule-skill/`（1 个合法包 + 1 个含 `../escape` 的恶意包）。
- 用例：正常装载 / 0 个 zip 降级 / >1 个且未指定降级 / `--rule-skill-name` 选中 / **Zip Slip 被拒** / 超尺寸被拒 / 条目数超限被拒 / 缺 `SKILL.md` 降级 / 同 zip 二次命中缓存（`loadSkills` 只调一次）/ `strict` 抛错 / 诊断透传 / **`buildRuleSkillBrief` 输出不含绝对路径且 `RULE_CHECK_PHASE_INDEX===CANDIDATES_PHASE_INDEX`**。
- 纯离线：注入 `spawnChild` + `loadSkillsFn` 假实现；另留 1 个**真解压集成用例**（系统 `tar`/`unzip`，CI 上 Windows/Linux 都有）。

---

## 3. 修改文件（逐条）

### 3.1 `packages/review-pi/src/contracts/config.ts` — 加 `F`

```ts
export type ConfigId = "A" | "B" | "C" | "D" | "E" | "F";

export interface ReviewConfig {
  readonly configId: ConfigId;
  readonly toolsEnabled: boolean;
  readonly prefetch: boolean;
  readonly fullRepo: boolean;
  readonly stablePrefix: boolean;
  readonly ledger: boolean;
  /** F = true：本仓规则 skill（.review-rules zip → 解压装载 → Phase 5 简报） */
  readonly ruleSkill: boolean;
}

// A–E 全部补 ruleSkill: false（字节语义不变）
F: { configId: "F", toolsEnabled: true, prefetch: false, fullRepo: false, stablePrefix: true, ledger: true, ruleSkill: true },  // = E + 规则 skill
```

### 3.2 `packages/review-pi/src/contracts/config.test.ts:19`

```ts
expect(Object.keys(CONFIGS)).toEqual(["A", "B", "C", "D", "E", "F"]);
```

### 3.3 `packages/review-pi/src/loop/agent-review-loop.ts` — 唯一循环改动（约 12 行）

```ts
// AgentReviewLoopInputs（:52-67）新增：
/** 阶段附加简报（0-based 阶段下标）；缺省 = 逐字节不变（C/D/E） */
readonly phaseBrief?: (phaseIndex: number) => string | undefined;
```

```ts
// 把 phaseInstruction（:295-301）泛化为 phaseMessage：
function phaseMessage(phaseIndex: number): AgentMessage {
  const instruction = PHASE_INSTRUCTIONS[phaseIndex];
  if (instruction === undefined) throw new Error(`missing phase instruction at index ${phaseIndex}`);
  const brief = inputs.phaseBrief?.(phaseIndex);
  const content = brief === undefined ? instruction : `${instruction}\n\n${brief}`;
  return { role: "user", content, timestamp: 0 };
}
```

替换 3 个调用点：`:187` `agent.prompt(phaseMessage(0))`、`:233` `followUp(phaseMessage(phaseIndex))`、`:262` `followUp(phaseMessage(0))`。**`PHASE_INSTRUCTIONS`（`phases.ts`）一个字节不动** ⇒ `phases.test.ts` + golden 全绿。

### 3.4 `packages/review-pi/src/run/review-run.ts` — 装配点（"new Agent 前"）

```ts
// ReviewRunInput（:40-70）新增（可选，缺省不影响 A–E）：
readonly ruleSkillZip?: string;
readonly ruleSkillName?: string;
readonly strictRuleSkill?: boolean;
readonly ruleSkillLoader?: typeof loadRuleSkill;   // 测试注入缝
```

```ts
// runToolDrivenReview（:217-262），在 runAgentReviewLoop 之前：
const loadRuleSkillFn = input.ruleSkillLoader ?? loadRuleSkill;
const ruleSkill = config.ruleSkill
  ? await loadRuleSkillFn({
      repoPath: input.repoPath,
      cacheRoot: path.join(input.runsRoot, input.experimentId, ".cache", "rule-skills"),
      ...(input.ruleSkillZip !== undefined ? { explicitZipPath: input.ruleSkillZip } : {}),
      ...(input.ruleSkillName !== undefined ? { skillName: input.ruleSkillName } : {}),
      ...(input.strictRuleSkill !== undefined ? { strict: input.strictRuleSkill } : {}),
    })
  : undefined;

const outcome = await runAgentReviewLoop({
  systemPrompt: SYSTEM_PROMPT,
  initialContextMessages,
  toolkit,                       // ← 不动（Q9 = 只做简报；knowledge.rules 保持空）
  ...(ruleSkill !== undefined && ruleSkill.degradedReason === undefined
    ? { phaseBrief: (i: number) => (i === RULE_CHECK_PHASE_INDEX ? buildRuleSkillBrief(ruleSkill) : undefined) }
    : {}),
  apiKey: input.apiKey, /* …其余不变… */
});
```

> `RULE_CHECK_PHASE_INDEX` 来自 `knowledge/rule-skill-brief.ts`（修正 F2：**不**依赖 loop 层未导出的 `CANDIDATES_PHASE_INDEX`）。降级时不注入简报（行为 = E）。

### 3.5 `packages/review-pi/src/contracts/run.ts` + `audit/audit-writer.ts` — 审计尾部留痕

```ts
// RunAudit 末尾追加（缺席省键）：
readonly ruleSkill?: {
  readonly source: string;
  readonly digest: string;
  readonly name: string;
  readonly degradedReason?: string;
  readonly diagnostics?: readonly { readonly code: string; readonly path: string }[];
};
```
`buildAuditFileContent` 透传即可（`...(audit.ruleSkill !== undefined ? { ruleSkill: audit.ruleSkill } : {})`）。

### 3.6 `packages/review-pi/src/cli/args.ts` — CLI 入口

- `USAGE_TEXT`（`:64-94`）补 `--rule-skill-zip <path>` / `--rule-skill-name <name>` / `--strict-rule-skill`。
- **必须把新旗标加进 review 命令的 allowlist**（`:41-61` 的 `KNOWN_*_FLAGS`），否则解析直接判非法。
- `--config` 校验 `:326 configRaw in CONFIGS` **自动接受 `F`**；CLI 缺省仍是 `E`（ADR-0011 切流），要 F 需显式 `--config F`。

### 3.7 `src/instrument/contracts/config.ts` — 伪配置位（Q11=③）

照 `REFERENCE_CONFIG_ID = "claude-code"`（`:10-20`）**同款**处理，**不**把 F 塞进 A–E 主矩阵：

```ts
export const RULE_SKILL_CONFIG_ID = "F" as const;
export type RuleSkillConfigId = typeof RULE_SKILL_CONFIG_ID;
/** 指标层配置键全集 = A–E 主矩阵 + claude-code 参照 + F 规则 skill 伪配置位 */
export type MetricsConfigId = ConfigId | ReferenceConfigId | RuleSkillConfigId;
```
F **永不进** `ExperimentPlan.configs` / `labels.allowedConfigs` / S-A-B 判定；只进 `RunResult.configId` 与指标分组。

### 3.8 硬编码 A–E 列表处置

| 位置 | 处置 |
|---|---|
| `packages/review-pi/src/contracts/config.test.ts:19` | **补 F**（§3.2） |
| `src/bytegate/ground-truth.ts:20`（`GateConfigId` A–E） | **保持 A–E**（F 不属冻结真源） |
| `packages/review-pi/src/bytegate/agent-truth.ts:28`（`"C"｜"D"｜"E"`） | **暂排除 F**；实现时先跑 `agent-truth.test.ts`，若为穷举断言同步声明 |
| `src/dataset/inverse-patch.ts:9`（`ALL_CONFIGS`） | **保持 A–E** |
| `src/dataset/msb-java/adapter.ts:57`（`["C","E"]`） | **保持** |
| `src/experiment/p5b-compare.ts:19`（`P5B_CONFIG_IDS`） | **保持 A–E** |
| `scripts/analyze-phase2.ts:31`（`["A".."E"]`） | **保持 A–E** |
| `src/metrics/verdict.ts:114`（`anchorConfigId:"C"`） | **不动** |
| 度量侧 `Object.keys(CONFIGS)` 派生（`review-plan.ts:101`、`report.ts:54`、`plan.ts:123`、`dashboard.ts:16`、`cli.ts:83`、`judge/report.ts:62,127`、`aggregate.ts:38`） | **自动仍旧 A–E**（§3.7 未往 instrument `CONFIGS` 加 F）——伪配置位的收益 |
| `packages/review-pi/src/disposition/record.ts:81-89` | 仅注释写死 "A–E"；逻辑 `in CONFIGS` 自动兼容 F，改文案 |

---

## 4. 解压实现与安全（Q13–Q15）

**命令选择**（`node:child_process.spawn`，照 `codeintel/rg.ts:143` 先例）：

| 平台 | 首选 | 兜底 |
|---|---|---|
| win32 | `tar.exe -xf <zip> -C <dest>`（`C:\Windows\system32\tar.exe`，**不依赖 Git Bash**） | `powershell -NoProfile -Command Expand-Archive -LiteralPath <zip> -DestinationPath <dest> -Force` |
| posix | `unzip -o <zip> -d <dest>` | `tar -xf <zip> -C <dest>` |

**护栏**：`timeout = 30s`（超时 kill）；失败 → 降级（`strict` 才抛）；**错误文本脱敏**——不回显宿主绝对路径（照 `rg.ts:166`）。

**安全清单（解压前审计 + 解压后复核，Q15=①）**：

| # | 检查 | 触发动作 |
|---|---|---|
| 1 | **Zip Slip**：条目名规范化后仍在 `cacheDir` 内；拒绝对路径 | 拒绝整包 → 降级 |
| 2 | **符号链接**条目 | 拒绝整包 |
| 3 | **解压炸弹**：`maxEntries` ≤2000、`maxTotalUncompressed` ≤64MiB、`maxCompressionRatio` ≤100:1 | 拒绝整包 |
| 4 | **单包大小** > 8MiB | 拒绝整包 |
| 5 | 大小写/Unicode 规范化后条目冲突 | 拒绝整包 |
| 6 | 解压后复核：目录内所有真实路径仍前缀于 `cacheDir`，无链接 | 拒绝整包 |
| 7 | **绝不执行 zip 内任何脚本**（只 `loadSkills` 读 `SKILL.md`） | 硬纪律（`skills.ts:145-157` 只读 `SKILL.md`） |

---

## 5. `F` 的字节行为与重锚清单

| 维度 | F |
|---|---|
| `toolsEnabled` / `stablePrefix` / `ledger` | true / true / true（= E） |
| 新增语义 | 仅 `ruleSkill: true` ⇒ loadRuleSkill + Phase 5 `phaseBrief` |
| 与 E 的字节差 | **唯一差**：Phase 5 那条 user 消息尾部多出 `\n\n<skill … location=".review-rules/<name>/SKILL.md">…</skill>\n\n<约定段>`（**无绝对路径**） |
| A–E 字节 | **逐字节不变**（`phaseBrief` 缺省、`loadRuleSkill` 不调用） |

| 门 | 影响 |
|---|---|
| `loop/phases.test.ts` + golden `phase-*.txt` | ✅ **不动**（常量未改） |
| `zonea/system-prompt.test.ts` + golden | ✅ **不动** |
| `tools/registry.test.ts` + `review-tools-*.json` | ✅ **不动**（工具面未改） |
| `loop/agent-review-loop.test.ts:173`（tools 名序） | ✅ 不动；**新增** F 用例 |
| `run/review-run.test.ts:442/484`（C/D/E wire） | ✅ 不动；**新增** F wire golden `wire-f-req*.json` |
| `loop/cache-break.test.ts:76` | **新增** F 断点期望（F 有 stablePrefix + Ledger） |
| `bytegate/semantic-parity.test.ts` | ✅ 不动（F 不进跨内核对照） |
| `contracts/config.test.ts:19` | **必改**（加 F） |

---

## 6. 验收标准

1. `pnpm --filter review-pi test` 全绿；`git diff` 里 `phases.ts` / `system-prompt.ts` / `tools/registry.ts` **零改动**。
2. `--config F`（repo 内放 `.review-rules/xxx.zip`）跑通，审计出现 `ruleSkill: { source, digest, name }`。
3. Phase 5 请求体里可见 `<skill name="…" location=".review-rules/<name>/SKILL.md">` + SKILL.md 正文 + 约定段，且**不含任何宿主绝对路径**。
4. findings 出现 `rule: "<skill 名>"`，且**无** `NON_ENGLISH` 拒绝留痕。
5. 把 zip 弄坏/删除 → run **照常完成**，审计留 `degradedReason`，findings 退回 E 水平。
6. 同 zip 跑两次 → `digest` 相同、第二次**不解压**（幂等缓存）。
7. `.review-rules/` 的 zip **未被改动**、被检视仓库快照**无新增文件**（解压产物只在 out 缓存里）。

---

## 7. 分步落地顺序（每步可独立验证）

| 步 | 做什么 | 验证网 |
|---|---|---|
| **1** | 加 `phaseBrief` 输入 + `phaseMessage()`（**不改任何配置**） | 现有全部测试**必须全绿**（缺省逐字节不变）——安全网 |
| **2** | 加 config F（运行时 `config.ts` + `config.test.ts`）；instrument 加伪配置位 | 类型全绿；F 空跑（无 zip）行为 = E |
| **3** | 写 `rule-skill.ts` + `rule-skill-brief.ts` + 单测（fake spawn / fake loadSkills / 恶意 fixture / 无绝对路径断言） | 离线全绿；Zip Slip/炸弹/降级/幂等用例通过 |
| **4** | `review-run.ts` 接线 + 审计尾部 + CLI flag | F + 本地 zip → 审计出现 `ruleSkill.digest` |
| **5** | 补 F golden（`wire-f-*`、cache-break）+ loop F 用例 | 门全绿 |
| **6** | 端到端真跑一条 VUL4J：F vs E | ① Phase 5 请求含 `<skill …>`；② findings 含 `rule:"<skill 名>"` |

---

## 8. 后期（下载腿）

`RuleSkillSource.kind` 已预留 `"url"`；届时在步 1 前插"`input.fetch` 下载 zip → `stat`/`sha256` → 复用同一解压/缓存管线"，并加源 URL 白名单与超时。**契约与解压模块无需返工**。

---

## 附：grill-with-docs 复核结论（F1–F3）

- **F1（须修，已折入 §2.3/§5/§6）**：`formatSkillInvocation` 会把 `skill.filePath`（解压缓存绝对路径，`skills.ts:40,303`）写进请求 → 污染字节可复现性、违反"无绝对路径"纪律。修法：净化 `location` 为 `.review-rules/<name>/SKILL.md`。
- **F2（须修，已折入 §2.3/§3.4）**：`CANDIDATES_PHASE_INDEX` 未导出（`agent-review-loop.ts:80`）；改为简报模块自带 `RULE_CHECK_PHASE_INDEX = 4` 并单测对齐。
- **F3（领域模型，已落 ADR-0012 + CONTEXT.md）**：CONTEXT.md 的「项目规则」= Zone B 槽位（`zone-b-builder.ts:230-236` 现为占位）、且 Zone B 仅 config B 有；本方案载体命名「规则 Skill」以消歧，并明确其 ≠ C3 Knowledge。

跨仓限定语纪律：本文引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。
