# ReviewAgent-pi 全仓检视 Spike 方案报告

> 分支：`exp-repo-review`（从 `exp-flow@09870c7` 切出）
> 日期：2026-11-24
> 状态：spike 已实现并通过测试；未执行真实模型请求（避免产生 API 成本）
> 跟踪：`.scratch/exp-repo-review/map.md` · `R-SPK`

---

## 1. 背景与目标

产品最终要支持「无 diff 的全仓代码检视」。在正式改造 `review-pi` 之前，先用最小侵入的 spike 验证三件事：

1. **分组是否可控**：按目录 / 文件数把仓库拆成可处理的组；
2. **现有 MR 流水线能否复用**：把每个文件合成为「全部新增」的 unified diff，直接调用 `runReviewOutcome`；
3. **规则 Skill 能否透传**：按组加载并运行规则 Skill。

spike **不是**产品化 scan：不承诺行锚点语义、覆盖账本、scan 专用提示词和评测口径。

---

## 2. 方案概述

### 2.1 核心取巧：合成「全新增」diff

现有流水线只需要一份合法的 unified diff。spike 把每个文件写成：

```diff
diff --git a/src/foo.ts b/src/foo.ts
new file mode 100644
--- /dev/null
+++ b/src/foo.ts
@@ -0,0 +1,N @@
+<文件每一行>
```

然后调用现有 `runReviewOutcome`。这样：

- 分片 / 六阶段 / 证据门 / 候选门 / 输出都可以复用；
- 行号天然对得上（每一行都是 `+` 行）；
- 不需要修改 `review-run.ts`、`loop/*`、`gate/*`、`shared/config-limits.ts`。

### 2.2 分组：spike 自己分组，每组一次 runReviewOutcome

不依赖现有 `planReviewShards` 的字符装箱（最多 64 片，且不是语义分组）。spike 在调用前按文件分组：

| 模式 | 行为 |
|---|---|
| `directory`（默认） | 路径前两段：`src/a/x.ts` → `src/a`；`packages/x/...` → `packages/x` |
| `files` | 按路径顺序切固定文件数桶 |
| `language` | 按扩展名分组 |
| `none` | 一个文件一组 |

每组受 `maxFilesPerGroup`（默认 10）和 `maxGroupChars`（默认 120,000）双上限约束；超限文件跳过并留原因。分组结果完全确定：路径排序 → 分组键排序 → 桶内路径排序。

每组合成一份 diff，调用一次 `runReviewOutcome`：

```text
files(group)
  → synthesizeGroupDiff(group)
  → runReviewOutcome({
      caseId: repo-spike-gNNN-<group>,
      repoPath,
      diff: groupDiff,
      runsRoot: <out>/runs/<group>,
      runtime: spikeRuntime,
      ruleSkillDirs / ruleSkillZips,
    })
```

### 2.3 数据流

```text
repo snapshot
  → enumerateRepoFiles       （git ls-files + untracked / walk 回退）
  → groupRepoFiles           （directory / files / language / none）
  → synthesizeGroupDiff      （每组一份「全新增」unified diff）
  → runReviewOutcome × N     （每组一次现有 MR 流水线）
  → merge findings / usage / coverage
  → <out>/repo-spike-result.json
```

---

## 3. CLI 用法

### 3.1 Dry-run（零模型、不需要配置）

```bash
review-pi repo-spike --repo . \
  --path packages/review-pi/src/loop \
  --group-by directory \
  --max-files-per-group 8 \
  --out .scratch/exp-repo-review/spike-dry-run \
  --dry-run
```

输出示例（本仓实测）：

```text
[repo-spike] discovered=1973 selected=15 groups=2 skipped=0
[repo-spike] dry-run: discovered=1973 selected=15 skipped=0 groups=2
[repo-spike]   001 packages/review-pi files=8 diffChars=99771
[repo-spike]   002 packages/review-pi files=7 diffChars=21736
```

### 3.2 真跑（使用用户配置与 API key）

```bash
review-pi repo-spike --repo /path/to/repo \
  --group-by directory \
  --max-files-per-group 10 \
  --max-group-chars 120000 \
  --group-concurrency 1 \
  --rule-skill /path/to/rule-skill \
  --out /path/to/out
```

### 3.3 关键旗标

| 旗标 | 默认 | 说明 |
|---|---|---|
| `--repo` | 必需 | 仓库快照根目录 |
| `--out` | `repo-spike-out` | 独立输出目录，不碰 MR 产物 |
| `--dry-run` | false | 只枚举/分组/合成 diff，不触模型 |
| `--group-by` | `directory` | `directory` / `files` / `language` / `none` |
| `--max-files-per-group` | 10 | 单组文件数上限 |
| `--max-group-chars` | 120000 | 单组估算字符上限 |
| `--max-groups` | 500 | 组数护栏；超限显式失败，不静默截断 |
| `--max-files` | 2000 | 本次最多检视文件数 |
| `--max-file-chars` | 100000 | 单文件字符上限 |
| `--max-rounds` | 1 | 每组最大轮次（spike 默认 1 轮控成本） |
| `--group-concurrency` | 1 | 同时跑几组（默认串行；v1 上限 5） |
| `--include-tests` | false | 把测试文件纳入检视（缺省跳过，与全仓扫描契约一致） |
| `--path` | 无 | 只检视仓库内某路径前缀 |
| `--rule-skill` / `--rule-skill-zip` / `--skill` | 无 | 规则 Skill 显式路径，逗号列表或重复旗标 |
| `--strict-rule-skill` | false | Skill 装载失败即报错 |
| `--no-progress` | 打印 | 关闭进度行 |

---

## 4. 规则 Skill 支持

spike **支持传 Skill**，直接透传到 `ReviewRunInput`：

```ts
{
  ruleSkillZips?: readonly string[];
  ruleSkillDirs?: readonly string[];
  strictRuleSkill?: boolean;
}
```

行为：

- 每个组调用一次 `runReviewOutcome`，因此每个组都会独立加载并运行一次规则 Skill 会话；
- Skill 会话看到的是**该组合成 diff**；它仍可通过 `review.get_file` / `review.get_call_chain` / `bash` 读取整个仓库快照；
- 规则包必须显式传入（ADR-0027：不自动扫描被检视仓库里的规则目录）；
- Skill 候选经 `mergeSkillCandidates` 并入最终 findings；
- 组多时每个组会重复装载规则包；spike 默认串行，重复成本可接受。

---

## 5. 实现文件清单

### 5.1 新增

| 文件 | 作用 |
|---|---|
| `src/repo-spike/types.ts` | 选项 / 分组 / 结果类型 |
| `src/repo-spike/enumerate.ts` | 仓库文件枚举与过滤（git ls-files / walk、二进制嗅探、大小上限、扩展名白名单、目录黑名单） |
| `src/repo-spike/group.ts` | 四种分组策略 + 文件数/字符双上限切片 |
| `src/repo-spike/synthesize-diff.ts` | 「全新增」unified diff 合成 |
| `src/repo-spike/runtime.ts` | spike 专用 `ReviewRuntime` 覆盖；不修改默认值 |
| `src/repo-spike/output.ts` | 独立产物写出与摘要 |
| `src/repo-spike/run.ts` | 编排：枚举 → 分组 → 合成 → 每组 `runReviewOutcome` → 合并 |
| `src/repo-spike/enumerate.test.ts` | 枚举/过滤单测 |
| `src/repo-spike/group.test.ts` | 分组单测 |
| `src/repo-spike/synthesize-diff.test.ts` | diff 合成单测 |
| `src/repo-spike/run.test.ts` | dry-run + fake-fetch 全链测试 |
| `src/cli/repo-spike-command.ts` | CLI 执行缝（配置/端点/模型解析） |
| `src/cli/args-repo-spike.test.ts` | 参数解析单测 |

### 5.2 修改

| 文件 | 改动 |
|---|---|
| `src/cli/args.ts` | 新增 `repo-spike` 命令、旗标、usage、参数校验 |
| `src/cli/main.ts` | 新增 dispatch；dry-run 不加载配置 |
| `src/cli/args.test.ts` | 更新 unknown/missing command 文案与 usage 断言 |

### 5.3 明确未修改（PR 路径核心）

```text
src/run/review-run.ts
src/run/pass-runner.ts
src/run/shard-planner.ts
src/run/coverage-ledger.ts
src/run/mr-boundary-guard.ts
src/gate/diff-scope.ts
src/gate/candidate-gate.ts
src/loop/agent-review-loop.ts
src/loop/system-prompt.ts
src/loop/phases.ts
src/loop/messages.ts
src/shared/config-limits.ts
```

`runReviewOutcome` 是**被调用**，不是被修改。

---

## 6. 隔离性与对 PR 的影响

| 维度 | 结论 |
|---|---|
| PR 代码 | 核心 diff 管线零修改 |
| PR 提示词 | 未修改；`test:replay` 不需要重录 |
| PR 默认配置 | 未修改 `DEFAULT_LIMITS` / `DEFAULT_REVIEW_RUNTIME`；spike 用注入 runtime |
| PR 产物 | spike 使用独立 `--out`、独立 `runsRoot`、独立 `caseId` 前缀 |
| PR 命令 | `review` 分支逐字节不变 |
| 测试 | 全包 1265 passed / 1 skipped |

spike 的语义债：

- 合成 diff 把所有行标成 `+`，现有 diff 提示词会把仓库既有问题当成「本次新增」；
- 审计 `source` 仍是 `mr`；没有 scan 专用 manifest；
- 输出仍复用 MR 的 `reviews_en.json` 等产物名（在独立目录内）；
- 没有文件 × 区域覆盖账本，也没有 scan 评测口径。

---

## 7. 验证证据

| 验证 | 结果 |
|---|---|
| `pnpm --filter @baize/review-pi typecheck` | 通过 |
| `pnpm --filter @baize/review-pi build` | 通过 |
| `pnpm --filter @baize/review-pi test` | 115 个测试文件，**1265 passed / 1 skipped** |
| repo-spike 专项测试 | 6 个测试文件，**63 passed** |
| CLI dry-run（本仓 `src/loop`） | discovered=1973，selected=15，groups=2，diffChars=99,771 / 21,736 |
| 真实模型请求 | **未执行**（避免产生 API 成本；命令与配置已就绪） |

---

## 8. 限制与后续

### 8.1 spike 的边界

- 只验证「能跑通 + 分组/成本可控 + Skill 可传」；
- 不验证准确率，不产出 scan 指标；
- 选文件按路径排序取前 `maxFiles`，不做风险 / 复杂度排序；
- 目录分组只看路径前两段，不理解包 / 模块语义；
- 不适合大仓库一次性真跑；请先 `--dry-run` 看分组与字符量，再按组真跑。

### 8.2 产品化路径

1. **R-01 契约**：`ReviewMode = diff | repo`、`ReviewUnit`、行锚点、输出、CLI 形态；
2. **scan Zone A**：整文件语义、现有行锚点、工具纪律、覆盖纪律；
3. **repo planner**：文件枚举 + 目录/模块分组 + 预算 + 优先级；
4. **覆盖账本**：文件 × 区域三态（candidate / no-issue / not-reached）；
5. **评测**：全仓 GT（VUL4J 快照 / 注入缺陷），不能直接复用 iterF91；
6. **产品化命令**：把 `repo-spike` 替换为 `repo-review`，保留 dry-run 与分组能力。

### 8.3 建议的下一步实验

1. 在小仓库（如 `testdata/repos/multilang`）真跑一次，观察：
   - 模型对「全新增」diff 的输出形态；
   - findings 数量与噪声；
   - 每组 token / 墙钟；
2. 对比 `--group-by directory` vs `--group-by files` vs `none`；
3. 对比 `--max-rounds 1` vs `2`，看准确率与成本；
4. 带规则 Skill 跑一次，确认 Skill 会话与主会话的候选合并。

---

## 9. 结论

spike 已按「spike 自己按目录/文件数分组，每组一次 `runReviewOutcome`」实现并验证：

- **PR 路径零修改**，全包测试通过；
- **分组确定、可控、可 dry-run**；
- **规则 Skill 可透传**；
- **语义债明确**：这是探针，不是产品化 scan。

下一步应按 R-01 契约推进正式的 `repo-review` 模式，而不是把 spike 直接当产品。
