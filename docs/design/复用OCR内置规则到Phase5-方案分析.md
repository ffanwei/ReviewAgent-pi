# 复用 OCR 内置规则到 Phase 5：方案分析

> 状态：分析稿，未实现。
> 目标：评估把 OCR（`D:/Project/open-code-review`）的 64 份内置 review 规则
> 按变更文件筛选后，接入 review-pi 的 Phase 5 检视流程，是否可行、接在哪、
> 代价和风险是什么。
> 相关：`docs/report/test12-small10-b2-sweep-experiment-20261118.md`（B2 独立扫描）、
> `docs/report/test12-small10-lens-experiment-20261117.md`（B1 注意力置换）、
> `docs/report/exp-group-missed-gt-classification-20261118.md`（未命中分类）。

## 1. 结论

**可行，但不建议把 OCR 的 64 份规则原样塞进主 Phase 5。**

三条路径按风险从低到高：

| 路径 | 做法 | 是否改核心 | 是否在 Phase 5 | 风险 |
|---|---|---|---|---|
| A. 规则 Skill 包 | 把 OCR 规则转成 review-pi 的 `--rule-skill` 包 | 不改 | 否，Phase 5 之后独立会话 | 低；但不是主 Phase 5 |
| B. Phase 5 规则补漏扫描 | 复用 B2 的独立扫描，把筛选出的规则追加到扫描消息 | 小改 | 是，Phase 5 的第二次请求 | 中；消息变长 |
| C. 主 Phase 5 注入 | 通过 `phaseBrief(4)` 把规则拼进主 Phase 5 指令 | 小改 | 是，主请求 | 高；B1 已证明会注意力置换 |

**推荐顺序：先 A 验证内容与价值，再 B 做产品化；C 只在 B 不够时做对照实验。**

理由：

1. OCR 规则质量高，但**包含大量风格/命名/注释/测试覆盖条款**，与本仓
   `SYSTEM_PROMPT` 的“不要报测试缺失、文档/注释/命名/格式类建议”直接冲突。
   直接注入会让模型收到互相矛盾的指令，必须先做 scope 适配。
2. B1 实验已经证明：把检查项塞进主 Phase 5 会挤掉原有候选；B2 用独立扫描
   才解决置换。OCR 规则文本（单样本平均 ~5.2–5.8KB）比六项镜头大一个数量级，
   主 Phase 5 注入的置换风险更高。
3. 规则 Skill 是现有架构的“唯一规则形态”，先走 A 可以零核心改动地验证
   规则内容、选择器、去重和收益；验证通过后，再把同一份规则数据接到 B。

## 2. OCR 的规则体系是什么

### 2.1 内置、按路径选择、注入主评审

- `internal/config/rules/system_rules.json` + `rule_docs/`，共 **64 份规则文档**，
  通过 `//go:embed` 编进二进制（`system_rules.go:89`）。
- `path_rule_map` 按路径/扩展名选规则：`*.ts/*.tsx` → `ts_js_tsx_jsx.md`，
  `*.go` → `go.md`，`*.c` → `c.md`，`*.java` → `java.md`，`pom.xml`、
  `package.json`、`Cargo.toml`、GitHub Workflows 也各有规则。
- 没命中路径时回落到 `default.md`；**每个被检视文件都至少有一份规则**。
- 规则通过 `main_task_user.md` 的 `{{system_rule}}` 注入主评审的 user 消息
  （`agent.go:1349/1442/1727`），与 diff 在同一次评审里。
- 主系统提示词还有 `Strict Focus Rules`：`<review_files>` 每个文件单独过一遍，
  鼓励跨文件一致性，不允许评论 `review_files` 之外的文件。

### 2.2 规则内容

`default.md` 只有 22 行，覆盖 Correctness / Security / Performance /
Maintainability / Test Coverage 五类。语言规则更具体：

- Go 69 行：错误/panic/API 契约、nil/接口/值语义、context/goroutine/取消、
  channel/锁/共享状态、timer/资源生命周期、集合/切片/数值边界、安全边界、
  测试与范围。
- Rust 61 行：所有权/生命周期、错误/panic、unsafe、并发、async/取消安全、
  集合/迭代器/性能、类型/API 设计、宏、安全。
- Python 77 行：可变默认参数、边界/空值、异常、identity/equality、资源、
  性能、并发/async。
- C 61 行：malloc/free、泄漏、缓冲区溢出、安全字符串、命名。
- TS/JS 40 行：拼写、死代码、重复代码、注释、硬编码、`var`、`==`、`any`、
  空值、嵌套三元、React Hooks/性能、async、XSS/innerHTML/eval、敏感信息。
- 还有 Java、C#、PHP、C++、JSON/YAML、package.json、pom.xml、Cargo.toml、
  GitHub Workflows 等。

**质量判断**：规则写得具体、带“不要报”的限定，整体偏 precision，比我们
六项镜头的一句话清单细得多。这是 OCR 能在类型/序列化、性能、资源、
边界类上补回更多的直接原因。

### 2.3 许可

OCR 仓库是 **Apache-2.0**。复制/改编规则文本到本仓需要保留版权与许可声明，
并在 `THIRD-PARTY-NOTICES.md` 增加条目；如果本仓是私有产品，Apache-2.0
允许使用，但 NOTICE 义务仍在。建议在动手前做一次法务确认，并固定 OCR
commit + 文件 sha256，避免“来源不明”。

## 3. 我们的接入点

### 3.1 现有 Phase 5 注入缝

`agent-review-loop.ts:877` 的 `phaseMessage(index)` 已经支持 `phaseBrief(index)`：

```ts
const content = [instruction, strategyBrief, skillBrief]
  .filter((part) => part !== undefined && part.trim().length > 0)
  .join("\n\n");
```

`review-pass.ts:185` 目前只在命中 skill review 时返回 Phase 5/6 覆盖。
所以**主 Phase 5 注入不需要新机制**，只需在 `phaseBrief(4)` 里拼规则段。

### 3.2 现有 Phase 5 补漏扫描

`agent-review-loop.ts:900` 的 `phase5SweepMessage()` 是 B2 的独立请求：
列出已有候选，要求只报新增，六项镜头。它已经有“不重复已有候选”的语义，
是接规则最自然的缝。

### 3.3 现有规则 Skill

`--rule-skill` 把规则包作为 **Phase 5 之后的独立会话**运行
（`docs/规则Skill编写指南.md`）：种子是 Phase 5 快照，工具有八只 `review.*`
加 `bash`，候选合并后进 Phase 6 验证。它不改变主 Phase 5 的注意力。

## 4. 三条路径的详细对比

### A. 规则 Skill 包（零核心改动）

把 OCR 的 `rule_docs/*.md` 转成一个 review-pi 规则包：

```text
ocr-review-rules/
├── SKILL.md
├── rules/
│   ├── default.md
│   ├── go.md
│   ├── ts_js_tsx_jsx.md
│   └── ...
├── index.json          # 路径 → 规则文件
└── scripts/
    └── select_rules.py # 按变更路径选规则（标准库）
```

`SKILL.md` 写清楚：先跑 `select_rules.py`，再按选出的规则逐条检视；
不重复主会话已有候选；输出英文 candidates。

**优点**：

- 不改核心；现有 `--rule-skill` 直接可用。
- 规则包可在 skill 会话里用 `bash` 跑选择器，选择确定。
- 有独立审计、独立 transcript，便于对比。
- 失败降级、超时、schema 校验、Phase 6 验证都已存在。

**缺点**：

- 不是主 Phase 5；它只能补漏，不能改变主 Phase 5 的注意力。
- 每个包一个完整会话，10 分钟上界，token 成本高。
- 规则包内的规则文本会进入 skill 会话上下文；如果包很大，仍可能注意力分散。
- 现有 `general-code-review` 的 `filter_rules.py` 是关键词过滤；OCR 是路径映射，
  需要新写一个 `select_rules.py` 或把路径映射做成数据。

**适用**：先验证“OCR 规则到底能不能补回我们的漏项”，不急着改核心。

### B. Phase 5 规则补漏扫描（推荐的产品化路径）

在 B2 的 `phase5SweepMessage()` 末尾追加一段“本次适用规则”：

```text
Phase 5 补漏扫描（六项镜头 + 适用规则）。
已有候选：...
六项镜头：...
本次变更适用的规则（按变更文件筛选）：
### Go
...
### TypeScript
...
对照上述规则逐条检查；只输出新候选。
```

规则文本在 `review-pass.ts` 侧构建（那里有 `input.diff`、`repoPath`、
`runtime`），通过新的 `phase5RuleBrief?: string` 传入 loop；
`phase5SweepMessage()` 只负责拼接。

**优点**：

- 保留 B2 的“独立请求、只增不减”性质，避免 B1 置换。
- 规则和六项镜头在同一个补漏请求里，模型只需一次注意力分配。
- 复用现有候选合并/去重/Phase 6 验证。
- 可选择“每轮一次”或“只第一轮一次”，控制成本。

**缺点**：

- 需要小改核心（新输入字段、配置开关、测试）。
- 消息变长：六项镜头 + 规则（平均 5.2–5.8KB，最大 11.6KB）。
- 如果规则里含风格/测试条款，仍会与 scope 冲突，需要适配器。

**配置建议**：

```jsonc
"limits": {
  "loop": {
    "maxRounds": 3,
    "phase5Sweep": true,
    "phase5Rules": {
      "enabled": true,
      "maxChars": 12000,
      "includeDefault": true,
      "scope": "review-pi"   // 过滤掉测试/文档/命名/格式条款
    }
  }
}
```

### C. 主 Phase 5 注入

通过 `phaseBrief(4)` 把规则拼到主 Phase 5 指令末尾。

**优点**：最接近 OCR 的形态，规则真正指导主推理。

**缺点**：

- B1 已证明会置换：六项镜头塞进主 Phase 5，原有候选被挤掉；
  OCR 规则文本更大，风险更高。
- 每轮都会重复注入（maxRounds 3），token 成本 ×3。
- 规则里的风格/测试条款会直接和系统提示词的排除项冲突。
- 规则变化会改变 Phase 5 消息，影响该请求的缓存前缀（Zone A 不受影响）。

**结论**：不作为第一版；只作为 B 验证有效后的对照实验，确认“主注入”
是否比“补漏扫描”更好。

## 5. 规则选择器设计

### 5.1 输入

- 本遍 diff 的文件路径（分片后 = 片内路径；不是整个 MR）。
- 已经过 `limits.mrFilter` / `testFiles.skip` 过滤后的路径。
- 规则包版本（OCR commit + sha256）。

### 5.2 选择算法

1. 展开 OCR `path_rule_map` 的 brace glob（`*.{ts,js,tsx}`）。
2. 用现有 `mr-input.ts` 的 glob 匹配器（需补 brace 展开）逐路径匹配，
   首个命中即该文件的规则；未命中用 `default.md`。
3. 去重：同一规则文档只保留一份；`default.md` 是否叠加由 `includeDefault`
   决定（OCR 原生是“未命中才回落”，不是叠加）。
4. 排序：`default.md` 在前，语言规则按 diff 中首次出现顺序。
5. 截断：按 `maxChars` 截断，优先保留语言规则；截断留审计。

### 5.3 预算估算

用 91 条交集样本的 GT 路径做过估算（**下限**，因为只用了 GT 路径，不是全部变更文件）：

| 口径 | 平均选中文档 | 平均字符 | 最大字符 |
|---|---:|---:|---:|
| OCR 原生：每个文件恰好一份，未命中回落 `default.md` | 1.16 份 | 5,170 | 11,579（`go.md` + default，PR 内含 `go.mod`） |
| 本方案 `includeDefault=true`：语言规则 + default | 2.00 份 | 5,784 | 11,579（同上） |

分布（OCR 原生口径）：`<2k` 9 条、`2–5k` 44 条、`5–10k` 26 条、`≥10k` 12 条。

按 1 token ≈ 3.5 字符估算，平均约 **1.5–1.7k tokens**，最大约 **3.3k tokens**。
相对 review-pi 每样本约 20k input tokens，增量约 **7–17%**；如果每轮都注入，
三轮约 **20–50%**。这是必须做预算上限的原因。

### 5.4 Scope 适配器（关键）

OCR 规则不能原样用。需要一层 `scope adapter`：

**保留**（与我们的范围一致）：

- 空值/边界/类型/错误路径/资源/并发/安全/性能/API 契约；
- 重复代码、结构、死代码、简化（可维护性）；
- 跨文件一致性、调用方影响。

**删除或改写**（与 `SYSTEM_PROMPT` 冲突）：

- 拼写错误、命名规范、注释要求、格式/风格；
- “测试覆盖/建议补测试”；
- 纯风格条款（`var`/`==`/`any` 等，如果只是风格而非行为缺陷）；
- 与具体语言工具链强绑定的建议（`gofmt`/`go vet`/Staticcheck 已覆盖的）。

**改写**：

- OCR 工具名 `file_read` / `code_search` → `review.get_file` / `review.search_code`；
- OCR 的 `task_done` / `code_comment` 等流程词删除；
- 规则标题加 `OCR-<lang>-<section>` id，便于审计和去重。

**原则**：规则文本服务“找缺陷”，不是“做风格审查”。保留 OCR 的具体信号
（例如 Go 的 typed nil、Rust 的 `unsafe` 边界、Python 的可变默认参数），
删掉与产品范围冲突的条款。

## 6. 去重与合并

- 规则扫描的候选与主候选、六项镜头候选、规则 Skill 候选都走
  `mergeSkillCandidates` + `candidate-gate` 的同根因去重。
- 规则扫描消息里列出已有候选（B2 已有），要求“只报新增”。
- 规则 id 写进 `Finding.rule`，同根因去重可用“同 rule”判定。
- 注意：OCR 规则与六项镜头有重叠（空值、边界、资源、并发、错误路径），
  重叠部分的候选应被去重，不要重复计数。

## 7. 实验设计

### 7.1 变量

| 组 | 规则来源 | 注入位置 | 目的 |
|---|---|---|---|
| V0 | 无（当前 B2） | 六项镜头 | 基线 |
| V1 | `default.md` | Phase 5 补漏扫描 | 最小规则集 |
| V2 | 语言规则（scope 适配后） | Phase 5 补漏扫描 | 主实验 |
| V3 | 语言规则（原样，含风格） | Phase 5 补漏扫描 | 测 scope 影响 |
| V4 | 语言规则（scope 适配后） | 规则 Skill 包 | 对照 A 路径 |
| V5 | 语言规则（scope 适配后） | 主 Phase 5 注入 | 对照 C 路径，验证置换 |

### 7.2 数据与指标

- 先 10 条小 diff（47 GT），再 91 条交集（588 GT）。
- 指标：P / R / B、按 15 类的召回、token/耗时/工具调用、
  **置换检查**（V0 已覆盖的 GT 是否在 V1–V5 丢失）。
- judge 3 轮取均值；空响应重试。
- 成功标准（建议）：
  - V2 vs V0：R +3pp、B +2pp、P 下降 ≤2pp、token 增幅 ≤20%；
  - 不出现 V0 已覆盖 GT 的系统性丢失（>1 条/样本）；
  - 类型/序列化、性能、资源三类至少有可见提升。

### 7.3 预期

根据未命中分析：

- 类型/序列化（OCR 补回率 52%）：OCR 的 Go/Rust/Python/TS 规则覆盖类型、
  单位、边界、序列化信号，V2 应有提升。
- 性能（40.6%）：OCR 语言规则有性能章节，V2 应有提升。
- 资源（34.8%）、边界（34.5%）：规则覆盖较细，V2 应有提升。
- 可维护性（24.1%）：OCR 规则有重复代码/结构条款，但我们的 scope 会删掉
  一部分；V2 提升可能有限，V3 会更高但 P 更差。
- API 契约（10.0%）：OCR 规则覆盖有限，V2 可能提升不大；这类需要
  `search_code`/调用方检索，规则文本帮助有限。

## 8. 风险清单

| 风险 | 影响 | 缓解 |
|---|---|---|
| 注意力置换 | 新增规则挤掉原有候选 | 用独立补漏扫描（B），不用主 Phase 5（C）；保留“只增不减”合并 |
| Scope 冲突 | 规则要求报风格/测试，系统提示词禁止 | scope adapter；V3 专门测原样注入的代价 |
| 许可/NOTICE | Apache-2.0 复制义务 | 法务确认；保留 LICENSE/NOTICE；固定 commit + sha256 |
| 规则漂移 | OCR 更新后行为变化 | 固定 commit；生成脚本 + CI 校验 sha256 |
| 工具名不匹配 | 模型调用不存在的工具 | 规则文本改写为 `review.*` |
| 语言误配 | 规则假设的项目结构不适用 | 按路径选择；未知扩展只用 default；规则里保留“确认上下文再报” |
| 成本 | 每轮多一次请求 + 规则文本 | `phase5Rules.enabled` 开关；`maxChars`；只第一轮扫描 |
| 规则太长 | 截断丢关键条款 | 按语言优先级截断；审计记录选了哪些规则 |
| 维护负担 | 64 份文档的转换/更新 | 生成器 + 快照；不手改规则正文 |

## 9. 实施步骤（建议）

### Phase 0：规则快照与适配（1–2 天）

- 从 OCR 固定 commit 复制 `system_rules.json` + `rule_docs/` 到
  `packages/review-pi/src/knowledge/ocr-rules/`（或独立数据包）。
- 写 `snapshot.json`：source repo、commit、sha256、license。
- 写 `selector.ts`：brace glob + 路径映射 + 去重 + `maxChars`。
- 写 `scope-adapter.ts`：删除/改写风格、测试、文档条款；工具名替换。
- 单测：路径选择、brace glob、截断、scope 过滤、空路径。

### Phase 1：规则 Skill 包（2–3 天）

- 生成 `ocr-review-rules/`：`SKILL.md` + `rules/*.md` + `index.json` +
  `scripts/select_rules.py`。
- 用 `--rule-skill` 跑 10 条小 diff，与 V0 对比。
- 检查：候选是否覆盖类型/序列化、性能、资源；P 是否可接受；token 成本。

### Phase 2：Phase 5 规则补漏扫描（3–5 天）

- 新增 `phase5RuleBrief?: string` 输入；`review-pass.ts` 构建。
- `phase5SweepMessage()` 拼接规则段；配置 `limits.loop.phase5Rules`。
- 审计：`selectedRules`、`ruleChars`、`snapshotVersion`。
- 跑 10 条小 diff → 91 条交集；3 轮 judge；置换检查。
- 如果 V2 达标，考虑设为 benchmark 配置默认；产品默认仍需权衡。

### Phase 3：主 Phase 5 注入对照（可选）

- 只在 V2 不足时做 V5；用 `phaseBrief(4)` 注入。
- 重点看置换：V0 已覆盖 GT 是否丢失；如果丢失，回退到 B。

## 10. 待确认的问题

1. **许可**：是否允许把 Apache-2.0 的 OCR 规则文本复制/改编进本仓？
   需要法务确认，还是只允许“运行时读取外部 OCR 包”？
2. **Scope**：是否保留 OCR 的风格/命名/测试条款？如果保留，是否要同步放宽
   `SYSTEM_PROMPT` 的排除项？这会影响产品定位和 precision。
3. **目标**：这轮优化是对齐 benchmark recall，还是提升生产检视质量？
   如果是 benchmark，V3（原样规则）可能分数更高但产品噪声更大。
4. **语言范围**：先覆盖 benchmark 的 9 种语言（TS/Go/C/C++/Java/Python/
   Rust/PHP/C#），还是一次性接 64 份？
5. **注入位置**：接受“Phase 5 补漏扫描（第二次请求）”，还是必须“主 Phase 5
   同一次请求”？后者要承担 B1 式置换风险。
