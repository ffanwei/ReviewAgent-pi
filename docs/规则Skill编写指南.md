# 规则 Skill 编写指南（自定义检视规则包）

本指南面向**为 review-pi 编写自定义规则 Skill 的人**：一个规则包（zip 或目录）= 一个 skill，在主检视流程的 Phase 5 之后作为**独立检视会话**运行，按你定义的规则对同一份 MR 做补充检视，产出的候选会与主会话结果合并、验证、上报。

先给一张全景图，说明「你写的东西在哪儿跑、周围已有什么」：

```text
review-pi review --mr-diff change.diff --taskId t1 --rule-skill-zip my-rules.zip
 │
 ├─ ① 输入预处理（harness 负责）        ← 不需要你做
 ├─ ② 六阶段主检视会话（harness 负责）   ← skill 会话以 Phase-5 快照为种子
 ├─ ③ 规则 Skill 会话（你的包在这里跑）  ← 每个包一个独立会话
 │     ├─ 七只 review.* 检视工具
 │     └─ bash（跑你包里的脚本）
 ├─ ④ 候选拦截链 + 合并 + Phase 6 验证（harness 负责）
 └─ ⑤ 产物落盘 / 中文 tips / MCP 上报（harness 负责） ← 不需要你做
```

你的职责只有一块：**③ 里「按什么规则检视、怎么用工具和脚本拿到证据」**。

---

## 1. 运行时给了你什么

### 1.1 会话上下文（你不用自己拼）

skill 会话是一条**独立模型会话**，它已经包含：

- **同一份系统提示词**（资深代码评审工程师角色，Zone A）；
- **主会话到 Phase 5 为止的完整对话快照**（初始上下文、diff、六阶段指令、工具调用与结果都在里面）——你不需要自己重新装载 diff，上下文里已经有；想再精确看，用 `review.get_diff` 分页读；
- **首条指令**：内核会把你的 `SKILL.md` 正文注入会话，并附上输出契约（见 §4）。

也就是说：**MR 是什么、改了哪些文件，会话开局就知道**。你的 SKILL.md 不要重复贴 diff，直接写「怎么检视」。

### 1.2 八只工具

前七只与主会话完全相同（只读、面向仓库快照）：

| 工具 | 参数 | 用途 |
|---|---|---|
| `review.get_diff` | `limit` / `offset`（分页） | 读本次 MR 的统一 diff |
| `review.get_symbol` | `symbol`（简单名） | 跨语言查符号声明（签名级：kind/修饰符/返回类型/参数/行号，不含函数体） |
| `review.get_file` | `path`（仓库相对 POSIX 路径）、可选 `startLine`/`endLine` | 读快照文件（可按 1-based 行区间读） |
| `review.find_references` | `symbol` | 名字级引用查找（整词、大小写敏感；不区分重载/覆写） |
| `review.get_call_chain` | `symbol` | 名字级调用链（hop-1/hop-2 调用方 + 被调方） |
| `review.search_rule` | `query`（大小写不敏感子串） | 搜项目规则库（按 run 静态配置，多数仓为空） |
| `review.search_history` | `query` | 搜历史检视/缺陷记录（同上） |

第八只是 skill 会话**专属**的：

| 工具 | 说明 |
|---|---|
| `bash` | 执行命令，**cwd 恒为你的包根目录**（SKILL.md 里用相对路径引用包内文件正合适） |

`bash` 的硬边界（不是你能在包里声明改掉的）：

- **无 shell**：命令串按引号规则切成 argv 直接 `spawn`。引号外出现 `& | ; < > $ \` 或换行会被拒绝；引号内按字面透传（所以 `python -c "import os; ..."` 里的分号没问题）。
- **env 白名单**：只透传 `PATH/PATHEXT/SYSTEMROOT/TEMP/HOME/USERPROFILE/LANG/PYTHONIOENCODING` 等少数键，`PYTHONIOENCODING` 被强制 `utf-8`。**拿不到宿主的其它环境变量和密钥**。
- **单条命令 120s 超时**、输出原始上限 256K 字符（之后走行预算截断）。超时/拒绝/非零退出都会变成**正常的工具文本**返回给模型（不是失败，模型可以自我纠正换命令）。
- **平台差异是真实存在的**（会话里已注入宿主平台提示）：Windows 上 `.cmd/.bat`（如 npm 生成的 `npx`）会被直接拒绝，`ls/grep/sed` 可能不存在——**脚本要用 `python`/`node` 这类跨平台解释器写**；POSIX 上可能只有 `python3`。SKILL.md 里如果写了命令示例，注明按平台选择。

### 1.3 你的产出怎么被消费

skill 会话最后一条 assistant 回复会被解析成候选（candidates），然后：

1. **字段校验**（10 字段 Finding schema，见 §4）；
2. **路径净化**：候选里出现你包的宿主绝对路径会被替换成占位符（包内路径**不得**回流到主会话请求）；
3. **跨 skill 去重合并**；
4. 并入主会话 **Phase 6（Evidence Verification）**，由主会话按同一标准逐条验证——**证据不足的候选会被丢弃**；
5. 存活者与主会话 findings 合并、重编号，进 `reviews_all.json` → 中文 tips → MCP 上报。

所以你的候选不是「直接出货」，而是「提交给主会话复核的提案」。写候选时就要按「能被独立验证」的标准写证据。

---

## 2. 主流程已经做了什么（不要在 skill 里重复做）

这些事 harness 已经做完，你的 skill **再做一遍纯属浪费会话预算，且产出会被丢弃**：

| 已处理 | 说明 |
|---|---|
| **MR 输入装载与预处理** | `--mr-diff` / `--mr-json`（GitCode/GitLab JSON 自动转统一 diff）；噪声文件预过滤（lockfile/生成物/minified/二进制）；体积门禁与分片 |
| **六阶段主检视** | 变更理解 → 风险分类 → 上下文决策 → 上下文检索 → 深度推理 → 证据验证，主会话已跑完 |
| **通用缺陷检视** | 主会话本身就产出通用 findings；你只补**你的规则特有的**问题 |
| **候选字段校验/修复** | schema 校验、非法字段的有界修复，都在拦截链里 |
| **去重与合并** | 同 file+line+title 跨 skill / 跨片去重 |
| **英文→中文 tips** | `reviews_tips_zh.json` 由 harness 的统一生成链产出，**你只写英文** |
| **意见上报（MCP）** | `mrReviewResult` / `saveReviewSummary` / `endTask` 等业务上报全部由 harness 在收尾统一执行，**skill 绝不做任何上报** |
| **产物落盘 / 审计 / 转录** | reviews_all.json、审计、session、trace 等 |

一句话：**你的 skill 是「规则检视器」，不是「流水线」**。输入已就绪、输出有固定契约，中间的检视逻辑才是你的地盘。

---

## 3. 不能做什么

- ❌ **数据预处理**：不要解析/装载/过滤 diff，不要对输入做归一化——上下文里已有 diff，harness 已做过滤。
- ❌ **意见上报**：不要尝试调用任何上报接口、写任何「平台」格式的文件。上报只发生在 harness 收尾。
- ❌ **写被检视仓库**：七只 review 工具全部只读；`bash` 的 cwd 是**你的包根**，不是被检仓库。不要试图改仓库或产出「修复补丁」。
- ✅ **候选直接产出中文与 tips**（ADR-0090）：`title` / `description` / `tips.{review,suggestion,subcategory}` 用中文；`category` 用中文七类（可维护 / 安全 / 可靠性 / 可测试性 / 性能 / 可移植 / 可读性）；`id` / `file` / `line` / `rule` / `evidence` 里的代码摘录保持英文原样。
- ❌ **依赖宿主环境变量 / 密钥**：bash 拿不到白名单之外的 env（网关 key、CI 变量都不可见）。脚本别设计成「需要 `SOME_TOKEN` 才能跑」。
- ❌ **声明新的工具或改工具边界**：八只工具的 schema、超时、env 白名单是核内常量，**不读你包里的任何声明**。
- ❌ **假设有 shell**：没有管道、重定向、`cd`、`&&`。每条 bash 命令是单个进程。
- ❌ **依赖 `.cmd/.bat` shim（Windows）**：`npx`、npm 全局命令等会被拒绝。
- ❌ **超过会话预算**：单 skill 会话默认 10 分钟（`limits.timeouts.skillPassMs` 可配），超时即 failed——脚本要快，别在 skill 里跑测试套件或构建。

---

## 4. 能做什么：输出契约（最重要的一节）

skill 会话结束的方式是：最后一条 assistant 回复**是一个 JSON 对象**：

```json
{"candidates": [
  {
    "id": "RULE-CHECK@<skill-name>@src/mod.py:42",
    "severity": "P1",
    "category": "security",
    "file": "src/mod.py",
    "line": 42,
    "title": "SQL query built by string concatenation",
    "description": "The order id is interpolated directly into the SQL text ...",
    "evidence": [
      "src/mod.py:42 — cursor.execute(\"select * from o where id = '\" + oid + \"'\")",
      "src/mod.py:55 — caller passes unvalidated oid from the request body"
    ],
    "rule": "ACME-SQL-001",
    "confidence": 0.9
  }
]}
```

逐字段规则（校验器就按这个拦）：

| 字段 | 约束 |
|---|---|
| `id` | 形如 `RULE-CHECK@<你的skill名>@<file>:<line>`（无轮次号；同 file+line 同 skill 恒同 id） |
| `severity` | `P0` / `P1` / `P2` / `P3`（枚举，其它值直接丢） |
| `category` | 非空字符串（建议短横线小写词，如 `security` / `concurrency`） |
| `file` / `line` | 仓库相对 POSIX 路径；`line` 为 ≥1 整数，**指向 MR 应用后的行号** |
| `title` / `description` | 一句话标题 + 缺陷与影响说明；**英文** |
| `evidence` | **字符串数组，必填**。每条 = `path:line — 摘录` 形态。没有证据的候选会被 `NO_EVIDENCE` 丢弃——这是第一大死因 |
| `rule` | 命中的规则 id（你 `rules/*.md` frontmatter 里的 `id`）；映射不到单条规则时才用 skill 名 |
| `confidence` | 0–1 之间数字 |

两条语义纪律（拦截链之外的「软约束」，但直接决定你的产出价值）：

1. **不重复主会话已报的问题**：同 file+line 已有 finding 时，只有**真正不同的缺陷**才再报，且 description 里明确说明差异；否则 Phase 6 会把你的候选当重复处理。
2. **不硬凑**：规则看着相关但实际不适用，就不报。空产出 `{"candidates": []}` 是**合法且诚实**的结果（状态 `empty`，不算失败）。

---

## 5. 包怎么组织

### 5.1 目录结构

```text
my-rules/                  ← 一个包 = 一个 skill
├── SKILL.md               ← 必需：入口（frontmatter + 正文）
├── rules/                 ← 强烈建议：规则即数据，一文件一规则
│   ├── 01-sql-injection.md
│   └── 02-xxx.md
├── scripts/               ← 可选：辅助脚本（经 bash 执行）
│   └── filter_rules.py
└── references/            ← 可选：参考规范文件（经 bash/工具读）
    └── coding-standard.md
```

### 5.2 SKILL.md

frontmatter 只有两个字段有效：

```yaml
---
name: acme-security-review      # 会话注入的 skill 名；也进候选 id，保持稳定
description: >
  ACME 项目安全规则包。检视输入校验、密钥处理、SQL 构造三类问题时使用。
  规则正文在 rules/，用 scripts/filter_rules.py 按关键词选子集。
  不用于风格检查。
---
```

- `name`：frontmatter 里的名字（zip 里目录名最好一致）；它会出现在 `RULE-CHECK@<name>@…`、审计、进度行里——**一旦定下就不要改**，否则历史对照会断。
- `description`：写给「选择是否适用」的场景描述，说清楚**这个包管什么、不管什么**。

正文（`## 之后的 content`）写给**模型**看，是 skill 会话的操作手册。推荐骨架：

```markdown
# <skill 标题>

## 1. 本包管什么
一两段：适用范围、与主会话通用检视的分工（只补本包规则特有的问题）。

## 2. 先选规则（第一件事）
    python scripts/filter_rules.py --list
    python scripts/filter_rules.py -k "sql,query" --format text
（或：直接按顺序读 rules/，每个文件很短。）

## 3. 检视方法
怎么组合七只工具 + bash：先 get_diff 定位改动行，再 get_file/read 规则，
find_references 查影响面…… 写成可遵循的步骤。

## 4. 证据标准
每条候选的证据必须包含什么（符号 + path:line + 摘录 + 可达路径）。

## 5. 项目专属注意事项
（见 §6）
```

**不要**把全部规则正文内联进 SKILL.md——那会撑爆每次会话的固定 token 开销。规则放 `rules/`，让模型按需读（这正是「规则即数据」）。

### 5.3 rules/*.md

一文件一规则，frontmatter + 三段式：

```markdown
---
id: ACME-SQL-001
title: SQL statement built by string concatenation
severity: high
category: security
tags: [sql, injection, concatenation]
---

## Why it matters
（这条规则为什么存在，一句话到一段。）

## Signals in a change
- 改动行里出现 xxx 模式
- 新增的 yyy 没有经过 zzz
（可检视的「信号」，写给检视时的模型。）

## Evidence required
- 必须给出哪个表达式、哪一行、从哪里可达
（把 §4 的证据要求具体化到这条规则。）
```

`id` 是候选 `rule` 字段的取值来源——**稳定、唯一、可读**。`severity` 是给人看的参考（真正的 severity 由候选字段决定）。规则数量建议控制在「一个会话能读完」的量级（参考实现 12 条，几十条就该配筛选脚本了）。

### 5.4 scripts/

脚本经 `bash` 执行，写之前先想清楚三条硬约束：

1. **解释器**：Windows 上优先 `python`（`python3` 可能不存在），POSIX 反之。跨平台写法是 SKILL.md 里两个都提，让会话按已注入的平台提示选。
2. **依赖**：`python` 标准**库**可以放心用；第三方包、联网下载都不行（宿主不一定装、env 里也没有凭据）。零依赖脚本 = 到处能跑。
3. **要快**：单条命令 120s 硬超时。规则筛选、关键词匹配这类 O(规则数×文本量) 的活没问题；别跑构建/测试。

脚本的典型用途：**规则筛选器**（从 diff 提关键词 → 选出相关规则子集），把「读哪些规则」从模型的自 Stream 里拿出来变成确定性一步。参考实现见仓内 `testdata/rule-skills/general-code-review/scripts/filter_rules.py`。

### 5.5 references/（规范与项目专属知识）

公司编码规范、安全基线、架构约束、内部术语表——**放进包里，用相对路径引用**：

```markdown
本包判定标准以 references/acme-java-standard.md §3.2 为准；
冲突处理规则见 references/error-policy.md。
```

模型会在 skill 会话里用 `bash`（cwd = 包根）或把它们 grep 出来读。三个注意点：

- 文件别太大（几十 KB 级合适；几 MB 的 PDF/Word 请先转成 Markdown 文本——`bash` 拿不到 Office 解析器）；
- 引用要**指到节**（`§3.2`），别甩整份文档让模型自己找；
- **项目专属注意事项就写在这里或 SKILL.md 的专门一节**：比如「本仓库所有新增接口必须走 X 框架的鉴权注解」「`OrderService` 的静态缓存是已知历史包袱，不要报已知问题」——这类「本地知识」正是自定义包相对通用模型的价值所在。

---

## 6. 让 skill 更好发挥的实操建议

**写得越「机械可执行」越好。** 会话里的模型会忠实照做：步骤明确（先选规则→再看 diff→再查引用）、判定标准可操作（出现什么信号才算命中）、证据模板固定。模糊的「注意代码质量」式指令产出不稳定。

**给「不报」的出口。** 每条规则都写清「什么情况看起来相关但不适用」（例如 optional 链已判空、测试代码豁免）。压误报比压漏报更能提高存活率——每个误报都会消耗 Phase 6 验证预算。

**复用七工具而不是重造。** 查符号用 `review.get_symbol` / `find_references`，不要让脚本自己 grep 仓库（工具走索引且结果已预算；脚本输出也占预算但没索引）。`bash` 留给你包内的数据处理（筛规则、解析 references）。

**多包拆分。** 规则域差别大就拆成多个包（`--rule-skill-zip a.zip,b.zip`），每个包会话聚焦、上下文小、互不干扰。顺序 = CLI 传入顺序。

**先拿 `--strict-rule-skill` 跑一次。** 装载失败（zip 损坏、无 SKILL.md、一包多 skill）时它直接报错而不是降级静默——包发给用户前用它自测。

**体量上限**（装载审计会拦）：zip ≤ 8 MiB、条目 ≤ 2000、解压后 ≤ 64 MiB、压缩比 ≤ 100:1。

---

## 7. 常见失败模式（对应你会看到的报错）

| 现象 | 原因 | 修法 |
|---|---|---|
| 收尾行 `skill xxx FAILED · … · …` + 审计 `degradedReason` | 会话异常 / provider 错误 / 解析失败 | 看 `degradedReason` 原文与 `failureStage`（见下） |
| `failureStage: "parse"` | 最后一条回复不是合法 `{"candidates":[…]}` JSON | SKILL.md 的输出契约段强调「只回一个 JSON 对象，无代码栅栏」；规则太多挤掉了输出预算时精简规则 |
| 候选被 `SCHEMA_INVALID` 丢弃 | 字段缺失 / severity 不是 P0-P3 / line 非整数 / confidence 越界 | 对照 §4 的字段表 |
| ~~候选被 `NON_ENGLISH` 丢弃~~ | ADR-0090 已删除该拦截门：中文候选合法 | 不再适用 |
| 候选被 `NO_EVIDENCE` 丢弃 | evidence 空 / 只是复述结论 | evidence 每条都要 `path:line — 摘录` |
| 候选被 `VERIFICATION_FAILED` 丢弃 | Phase 6 验证不通过：证据不足以支撑结论 | 证据给「可达路径」，不只给现象行 |
| `skill xxx FAILED · … · terminated` | 上游模型流被网络/网关切断（内部错误，非手动停止） | 重跑即可；频发查网关 |
| `rule-skill session timed out after …ms` | 会话超预算（默认 10 min） | 精简规则、加筛选脚本、避免跑慢命令 |
| bash 命令被拒绝 | 引号外有 shell 元字符 / 用了 `.cmd` | 拆成多条命令；换 `python`/`node` |

## 8. 提交前检查清单

- [ ] `SKILL.md` 有 frontmatter `name` / `description`；`name` 稳定不再变
- [ ] 规则放 `rules/*.md`（一文件一规则，frontmatter `id` 唯一），没有内联进 SKILL.md
- [ ] 输出契约字段全部能过 §4 的表（心里过一遍样例 JSON）
- [ ] 脚本零第三方依赖、单条 < 120s、Windows 用 `python` POSIX 用 `python3`
- [ ] 参考规范在 `references/`、Markdown 文本、引用指到节
- [ ] 项目专属注意事项写在 SKILL.md 或 references（含「已知问题不报」清单）
- [ ] 没有：数据预处理、意见上报、中文 findings、写仓库、依赖宿主 env
- [ ] 本地 `review-pi review … --strict-rule-skill --rule-skill-zip <你的包>` 跑过一轮，`skillPassLog` 状态 ok / empty，无 failed

---

**参考实现**：`packages/review-pi/testdata/rule-skills/general-code-review/`（12 条通用规则 + 标准库筛选脚本），是本指南全部建议的落地样板。
