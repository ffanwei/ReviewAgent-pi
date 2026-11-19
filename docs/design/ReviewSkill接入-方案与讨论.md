# Review Skill 接入：方案、选型与待讨论点

> 状态：设计 + 首版实现（分支 `exp-skill`，基于 `exp-tools`）
> 日期：2026-11-18
> 目标：借鉴 OCR（`D:/Project/open-code-review`）的 Agent Skill 形态，为
> `review-pi` 增加一个可被其它编码工具安装的检视 Skill。
> 相关：`docs/design/复用OCR内置规则到Phase5-方案分析.md`（OCR 规则复用，
> 与本文的 Skill 接入是两件事）。

---

## 1. 结论（TL;DR）

**做一个、不做两个；走 CLI 驱动，不做 delegate 模式。**

首版交付一个标准 Agent Skill `skills/review-pi/`，它把「检视工作区 / 某提交 /
某分支 / 已有 diff」统一成 `review-pi` 需要的两个输入（head 侧仓库快照 +
含未跟踪文件的 unified diff），以无 shell 的方式调用 CLI，再把 findings
确定性渲染成 Markdown。

刻意**没有**照搬 OCR 的第二个 skill（`open-code-review-delegate`）：那个模式
让宿主模型自己检视，OCR 只做文件筛选与规则解析。我们的产品价值恰恰在
Review Runtime（六阶段、Evidence Gate、`review.*` 工具、规则 Skill 会话），
把检视降级成一段提示词会与本仓的架构立场冲突（见 §8.1）。

OCR 身上真正可复用的不是 delegate，而是它的**工程外壳**：

- 标准 `SKILL.md` + `npx skills add <owner>/<repo> --skill <name>`；
- 明确的 Step 工作流、参数表、输出模板、Gotchas、Troubleshooting；
- 「不要预检安装」「避免 stdout 截断」「覆盖每个变更文件」这类操作纪律；
- 把确定性工程（选文件、取规则、取 diff）与模型检视分开。

---

## 2. OCR 的 Skill 拆解

> 分析对象：`D:/Project/open-code-review` @ `d77d70b`（2026-11-18）。

### 2.1 两个 skill

| Skill | 谁调模型 | OCR 的职责 | 需要的凭据 |
|---|---|---|---|
| `open-code-review` | OCR | `ocr review` 全链路 | OCR 自己的 LLM 配置 |
| `open-code-review-delegate` | 宿主 agent | 只做 `delegate preview`（选文件）/ `delegate rule`（规则解析）；宿主自己取 diff、自己检视、自己按格式输出 | 不需要 |

Delegate 的关键设计：OCR 退化成**确定性工程库**，只回答「该看哪些文件」
「每个文件适用什么规则」「diff 长什么样」，检视智能来自宿主。

### 2.2 分发面

- 仓库根 `skills/<name>/SKILL.md`，目录名 = frontmatter `name`；
- `npx skills add alibaba/open-code-review --skill open-code-review`；
- 各宿主插件清单：Claude Code marketplace、Codex plugin、Cursor plugin、
  Kimi plugin、Copilot Agent Plugins 1.0（`plugins/` 树 + 各 `.xx-plugin/plugin.json`）；
- `compatibility` / `metadata` frontmatter 写清 CLI 与配置前置；
- 页面文档 `pages/src/content/docs/*/integrations/agent-skill.md`。

### 2.3 Skill 正文的可用模式

- **Step 1 收集业务上下文**（`--background`）；
- **Step 2 直接运行**，明确「不要先 `command -v` / `--version` 预检」；
- **Step 3 输出模板**（按 severity 分组）；
- **Step 4 修复流程**（只有用户明确要求才动手）；
- **Gotchas**：工作目录、未跟踪文件、token 上限、不要 `--audience human`、
  不要 `tail/head` 截断、resume 语义；
- **Troubleshooting**：命令不存在、旧版本旗标、LLM 连接失败；
- **Validation**：退出码、是否有 comments、stderr warnings。

这些是低成本的成熟经验，直接吸收。

---

## 3. 我们的可复用优点

| 我们的能力 | 在 Skill 里的用法 |
|---|---|
| 六阶段 + Evidence Gate | CLI 内部执行；Skill 不重复检视，只负责触发与呈现 |
| 八个 `review.*` 工具 + Context Ledger | CLI 内部执行；Skill 不模拟工具 |
| 规则 Skill（`--rule-skill`） | Skill 透传显式规则包；不自动发现（信任边界） |
| 结构化 Finding（P0–P3 / 七类 / evidence / confidence） | 渲染器的排序与展示依据；不重新判定 |
| 中文原生 findings + `reviews_tips_zh.json` | 渲染器把 `tips.review` / `tips.suggestion` 直接挂到 finding 下 |
| 确定性产物（stdout 单 JSON / `reviews_all.json` / audit / transcript） | Skill 只读产物，不解析进度日志 |
| `review-pi smoke` / `config show` | 故障诊断入口；不在正常路径预检 |
| 单条命令、无服务端依赖 | Skill 的分发只需 npm + 一个 `SKILL.md` 目录 |

我们的差异点：OCR 的 delegate 把检视交给宿主；我们**不**这么做，因为
Review Runtime 的一致性（阶段骨架、证据纪律、规则合并、分片、审计）正是
产品要保证的东西。Skill 只做「接入层」，不做「第二套检视器」。

---

## 4. 选型

### 4.1 形态

| 选项 | 结论 | 理由 |
|---|---|---|
| A. 只写 `SKILL.md`，让宿主拼命令 | 否 | 各宿主 shell 差异大（尤其 Windows `.cmd` shim）；未跟踪文件、head 侧快照、taskId 都容易错 |
| B. 单个 CLI 驱动 Skill + 确定性脚本 | **选** | 零核心改动；行为可复现；宿主只需读 JSON |
| C. 再加一个 delegate Skill | 暂不做 | 与本仓「Runtime 是产品」的立场冲突；见 §8.1 |
| D. 改 CLI 增加 `prepare` / `skill install` 子命令 | 暂不做 | 脚本可先验证形态；避免在产品面引入宿主相关逻辑；见 §8.3 |
| E. 各宿主插件清单（Claude/Codex/Cursor/Kimi） | 暂不做 | `npx skills add` 已覆盖通用安装；插件树维护成本高；见 §8.2 |

### 4.2 Skill 名与目录

- 目录：`skills/review-pi/`
- frontmatter `name: review-pi`
- 与 CLI `--skill` 旗标**同名但不同物**：`--skill` 是 `--rule-skill` 的同义输入
  （ADR-0034），本 skill 是宿主侧接入包。文档里必须显式区分（见 §8.6）。

### 4.3 输入统一

`prepare-review.mjs` 支持五种模式：

| 模式 | diff 来源 | 仓库快照 |
|---|---|---|
| `workspace`（缺省） | `git diff HEAD` + 未跟踪文件新增补丁 | 当前工作树（已是 head 侧） |
| `range` | `merge-base(base, head)..head` | 临时 detached worktree（head 提交） |
| `commit` | `commit^..commit`（merge 取第一父） | 临时 detached worktree（该提交） |
| `diff` | 已有 unified diff 文件 | 调用方给的 `--repo`（须 head 侧） |
| `json` | 已有 GitCode/GitLab 文件变更 JSON | 调用方给的 `--repo`（须 head 侧） |

五模式都落到同一对输入，之后只走 CLI 一条路径。

### 4.4 运行方式

脚本用 `spawnSync(process.execPath, [bin/review-pi.js, ...])`，**不经过 shell**：

- 规避 PowerShell 把 stderr 包成 `NativeCommandError`；
- 规避 Windows npm `.cmd` shim 在 Node 子进程里不可直接执行；
- `--issue` 里的 `&`、引号、换行不会被 shell 解释。

CLI 入口解析顺序：`--bin` → `REVIEW_PI_BIN` → 仓库内
`packages/review-pi/bin/review-pi.js`（向上 8 层）→ 全局
`$(npm root -g)/@baize/review-pi/bin/review-pi.js`。

### 4.5 产物布局

- 全部落在 `<tmp>/review-pi-skill/<taskId>/`：`change.diff`、`plan.json`、
  `review.stdout.json`、`review.stderr.log`、`tasks/<taskId>/runs/...`；
- CLI 的 cwd = 工作目录，因此 `review-result.json` 不落到用户仓库；
- `range` / `commit` 的临时 worktree 在 `<tmp>/review-pi-skill/<taskId>/repo`，
  计划里给出清理命令；`--run --cleanup` 自动清理。

---

## 5. 交付物

```text
skills/review-pi/
├── SKILL.md                     # 宿主 agent 的主指令（英文，标准 frontmatter）
├── README.md                    # 人读的安装 / 使用 / 安全说明
├── references/
│   ├── output-contract.md       # stdout / Finding / tips / 产物 / 退出码
│   ├── preparation.md           # 五模式、侧别语义、手工 Git 兜底、taskId
│   └── troubleshooting.md       # 故障表（CLI / 配置 / 网关 / 输入 / 平台）
└── scripts/
    ├── prepare-review.mjs       # 目标检测 + diff + head 侧快照 + 可选运行
    └── render-findings.mjs      # findings + tips -> Markdown / JSON 摘要
```

配套改动：

- `README.md` 功能表新增「Agent Skill 接入」一行；
- `docs/开发指南-仓库结构与文件职责.md` 顶层表新增 `skills/`；
- 本文。

---

## 6. 工作流（宿主视角）

```text
用户：review 这个分支 vs main
  │
  ├─ 1. 选模式 range --base main --head feature
  ├─ 2. 收集业务上下文 → --issue
  ├─ 3. prepare-review.mjs --run
  │      ├─ git merge-base / git diff / 未跟踪补丁
  │      ├─ git worktree add --detach <head>
  │      ├─ review-pi review --repo <worktree> --mr-diff <diff> --taskId ...
  │      └─ 写 stdout / stderr / runs 产物，输出 JSON 计划
  ├─ 4. render-findings.mjs --input <stdoutPath>
  │      └─ 按 P0→P3 分组 + evidence + tips.suggestion
  │         （tips 文件缺条目时回退 stdout Finding.tips，再回退 description，
  │          因此 tips 侧的置信度 / 严重级过滤不会让报告丢建议）
  ├─ 5.（可选）修复：只改代码，不提交
  └─ 6. 清理临时 worktree
```

Skill 的硬约束：

- 不预检安装（正常路径）；
- 不自己检视、不新增 finding、不合并/重排；
- 不丢 P3；
- `truncated: true` 必须如实报告；
- 规则包只认显式输入；
- 不读/不回显密钥。

---

## 7. 与 OCR 的对照

| 维度 | OCR | 本方案 | 取舍 |
|---|---|---|---|
| Skill 数量 | 2（CLI + delegate） | 1（CLI） | 不做第二套检视器 |
| 安装 | `npx skills add` + 五个宿主插件 | `npx skills add` + 手工复制 | 插件清单后置 |
| 模型归属 | OCR 或宿主 | 恒 `review-pi` | 保持 Runtime 一致性 |
| 输入准备 | CLI 内置 workspace/range/commit | 脚本内置五模式 + 未跟踪文件 | 脚本承担宿主差异 |
| 输出 | OCR comments（critical/high/medium/low） | Finding（P0–P3）+ 中文 tips | 保留本仓语义 |
| 截断 | 大 diff 跳过/压缩 | 分片 + 诚实 `truncated` | 本仓已有能力 |
| 规则 | `rule.json` 路径映射 | 规则 Skill 会话（显式装载） | 本仓已有能力 |
| 业务上下文 | `--background` | `--issue` | 等价 |
| 预检 | 明确不预检 | 明确不预检 | 直接复用 |
| 失败诊断 | Troubleshooting 表 | 三层：SKILL 表 + references + `smoke` | 更细 |

---

## 8. 需要讨论的点

### 8.1 要不要做 delegate Skill？

**现状**：不做。Delegate 让宿主模型检视，OCR 只提供选文件/规则；它适合
「没有网关 key、想用宿主订阅额度」的场景，但会绕过本仓的六阶段骨架、
Evidence Gate、工具策略、规则合并、分片与审计。

**需要拍板**：

- 如果目标用户里「不方便配网关」的人占多数，delegate 的接入价值可能大于
  一致性代价；
- 若做，建议独立 skill（`review-pi-delegate`），只复用
  `prepare-review.mjs` 产出 diff / 文件清单 / 规则包路径，检视与输出 schema
  由另一份提示词约束；不要让同一个 skill 在两种模式下切换（宿主容易混）。
- 也可以做「半 delegate」：宿主用 `prepare-review.mjs` 选文件，但检视仍调
  CLI；这等于现状，没有新增价值。

### 8.2 要不要补宿主插件清单？

`npx skills add` 已覆盖多数 Agent Skills 宿主。OCR 另外维护 Claude Code
marketplace、Codex/Cursor/Kimi/Copilot 插件树，好处是 `/plugin install`
体验；代价是同一份 skill 多份路径声明 + 校验脚本。

**待定**：首版先观察 `npx skills add` 的实际安装成功率；若 Claude Code
用户反馈「找不到 skill」，再加 `.claude-plugin/marketplace.json`，不要一次
铺五个宿主。

### 8.3 要不要把准备逻辑升格为 CLI 子命令？

当前 `prepare-review.mjs` 在 skill 目录内，随 skill 版本走。优点是产品面
零改动；缺点是同一逻辑无法被 `review-pi` 自身复用（例如未来做
`review-pi prepare` 或 `review-pi skill install`）。

**待定**：

- 若 Skill 形态验证通过，可把 `prepare` 提炼成 CLI 子命令，skill 只调用；
- 但 CLI 一旦承担 git/worktree 语义，就要处理「非 Git 仓库」「worktree 清理」
  「Windows 路径」等平台问题，产品测试面会扩大；
- 建议先让脚本跑一段时间，再决定是否上收。

### 8.4 `--repo` 侧别：文档口径与 Skill 实践不一致

`docs/使用手册-安装与运行.md` §5.1 / §5.2 写「快照停在 diff 的 **base 侧**」，
这是 VUL4J 数据集回放的约定；而普通 MR 检视应使用 **head 侧**，否则
`review.get_file` 读到改前内容、行号与 evidence 对不上。运行时
`detectRepoSnapshotSide` 只在 base/mixed 时告警，说明 head 侧是正常路径。

**待定**：

- 是否把手册改成「数据集回放用 base 侧；普通 MR 用 head 侧」的两句话；
- 或引入显式 `--repo-side base|head`？不推荐：运行时会自行判定，加旗标只会
  增加第二真源；
- 本文的 Skill 明确采用 head 侧，并在 `references/preparation.md` 里写清
  两种语义。需要文档 owner 确认。

### 8.5 产物放临时目录还是 `~/.PiAgent/tasks`？

Skill 默认 `--tasks-dir <workDir>/tasks`，让一次检视自包含、易清理；代价是
用户若想事后 `review-pi export`，需要回到工作目录，且临时目录可能被系统
清理。

**待定**：

- 是否默认写用户级 tasks 根（可追溯），只把 stdout/stderr 放临时目录？
- 是否提供 `--keep-artifacts` / `--artifacts-dir` 让用户显式选择？
- 临时目录的保留时长与清理策略（当前不自动删除，只打印清理命令）。

### 8.6 `--skill` 命名冲突

CLI 的 `--skill` 是 `--rule-skill` 的同义词（ADR-0034），而本仓现在又有
`skills/review-pi/` 这个宿主侧 Skill。用户看到两个 "skill" 很容易混淆。

**待定**：

- 是否在 CLI 帮助里把 `--skill` 标为 deprecated，只保留 `--rule-skill`？
- 或在文档里固定叫法：「规则 Skill」= CLI 装载包；「接入 Skill」= 本目录；
- Skill 名是否改成 `review-pi-entry` / `review-pi-cli` 以降低歧义？改名会
  影响 `npx skills add --skill <name>`，越早定越好。

### 8.7 版本与兼容性

Skill 的 frontmatter `version: 0.1.0` 与 CLI `0.6.1` 独立演进。CLI 旗标
（`--mr-diff` / `--tasks-dir` / `--no-progress`）目前稳定，但未来可能变。

**待定**：

- Skill 是否在运行前校验 `review-pi version --json` 的最低版本？这会增加一次
  进程调用（与「不预检」相悖），但可以在 CLI 报「未知旗标」时再提示升级；
- 是否维护「Skill 版本 × CLI 版本」兼容表；
- `npx skills add` 的 hash / lock 机制（本仓 `skills-lock.json` 是**安装**
  侧的清单，不是导出侧）是否需要给发布流程加校验。

### 8.8 未跟踪文件与秘密

`workspace` 模式会把未跟踪文件内容放进 diff，进而进入模型提示词与产物。
未跟踪文件里可能有 `.env`、密钥、临时导出。

**现状**：`prepare-review.mjs` 默认把未跟踪文件纳入 diff（与 OCR workspace
语义一致），但对 `.env*`、`id_rsa`、`*.pem`、`*.key`、`credentials*` 等
文件名给一条 warning，并支持 `--no-untracked` 整体排除。

**待定**：

- 是否把凭据类文件名改为**默认跳过**（warning 保留）？这更安全，但可能漏看
  确实需要检视的配置片段；
- 是否提供 `--include-untracked <glob>` 让用户只纳入指定未跟踪文件？
- 产物敏感性已在 README 提示，但 Skill 运行时是否要再提醒一次？

### 8.9 大仓库的 worktree 成本

`range` / `commit` 为 head 侧创建完整 worktree，大仓库可能耗时数十秒到
数分钟，且占用磁盘。替代方案：`git archive <ref> | tar -x`（Windows 的
tar 可用但不保证）、或要求用户预先 checkout。

**待定**：

- 是否给 `--no-worktree` 增加「侧别自检」：若当前 HEAD ≠ 目标 ref 且工作树
  有改动，直接报错而不是让用户拿到混合快照；
- 是否缓存 worktree（同 commit 复用）？会引入生命周期管理。

### 8.10 长检视与超时 / 断点

一次大 MR 可能跑 10–20 分钟，宿主工具调用默认超时常常更短；我们的 CLI
没有 OCR 的 `--resume`。Skill 目前只能提示「用更长超时或后台运行」。

**待定**：

- 是否在 CLI 侧增加 resume（从任务目录续跑）？这是产品级能力，超出 Skill；
- 或由脚本以后台进程 + 轮询状态文件的方式包装？会增加复杂度；
- 至少应在 SKILL.md 里给出宿主相关的超时建议（已给 10–20 分钟）。

### 8.11 国际化

Findings 是中文原生（ADR-0090）。英文宿主用户会看到中文报告。Skill 当前
要求「按用户语言翻译叙述、保留代码与路径」，但不自动翻译产物。

**待定**：

- 是否提供 `render-findings.mjs --language en` 的确定性翻译？需要另一个
  翻译模型，违背「零二次生成」；
- 或只做展示层翻译，由宿主完成，产物保持中文（当前方案）。

### 8.12 评测

Skill 不改变 Review Runtime 的提示词或工具面，因此**不应**影响离线回放
trace；但 `--repo` 侧别（head vs base）会改变工具读到的内容，可能影响
findings。

**待定**：

- 是否新增一个「Skill 路径」的端到端小样本（workspace / range / commit），
  对比直接 CLI 的同一 diff + 同一快照？
- 是否需要把 `render-findings.mjs` 的输出纳入快照测试（纯函数，易测）？

---

## 9. 手工验证清单（按用户要求，本次未跑真实模型）

| # | 场景 | 预期 |
|---|---|---|
| 1 | `prepare-review.mjs --mode workspace --json` | 输出 plan；diff 含未跟踪文件；无 worktree |
| 2 | 同上加 `--run` | stdout/stderr 落文件；`review.findingCount` 与 `reviews_all.json` 一致 |
| 3 | `--mode range --base main --head <branch>` | 创建 head worktree；清理命令可用；findings 行号与新侧代码一致 |
| 4 | `--mode commit --commit <sha>` | 单提交 diff；merge commit 取第一父并给 warning |
| 5 | `--mode diff --diff-file <file>` | 不创建 worktree；提示确认 head 侧 |
| 6 | `--mode json --json-file <file>` | 走 `--mr-json`；与 `--mr-diff` 结果同源 |
| 7 | 空变更 / 无 HEAD | 提前失败，人话提示 |
| 8 | 缺 key / 缺 model / 网关不可达 | `stderrTail` 可读；hint 指向 `config init` / `smoke` |
| 9 | 未安装 CLI | 提示安装或 `--bin`；不抛堆栈 |
| 10 | Windows PowerShell / Git Bash | 两条路径行为一致；无 `.cmd` 执行失败 |
| 11 | `render-findings.mjs`（有 P0–P3 / 空 / 截断 / 有 tips / 无 tips） | 分组完整、不丢 P3、截断显式 |
| 12 | 临时 worktree 清理 | `--cleanup` 成功；失败时给手动命令 |
| 13 | 规则包 `--rule-skill` | 透传成功；未装载时 stderr 提示属正常 |
| 14 | 大 diff | 分片或 `truncated: true`，报告如实 |

本次只做了静态检查与脚本级 dry-run（不调用模型）；真实检视由用户手动验证。

---

## 10. 实施状态

- [x] `skills/review-pi/SKILL.md`（标准 frontmatter + 工作流 + Gotchas + Troubleshooting）
- [x] `skills/review-pi/scripts/prepare-review.mjs`（五模式 + head 侧 + 未跟踪 + 无 shell 运行）
- [x] `skills/review-pi/scripts/render-findings.mjs`（P0–P3 + tips + 截断 + JSON 摘要）
- [x] `skills/review-pi/references/{output-contract,preparation,troubleshooting}.md`
- [x] `skills/review-pi/README.md`（安装 / 使用 / 安全）
- [x] `README.md` 功能表
- [x] `docs/开发指南-仓库结构与文件职责.md` 顶层表
- [x] 脚本级 dry-run：五种 mode、fake CLI 的成功 / 失败路径、renderer 的分组 /
  截断 / tips 回退（未调用真实模型；临时 worktree 已清理）
- [ ] 宿主插件清单（Claude Code marketplace 等）——按 §8.2 后置
- [ ] delegate mode——按 §8.1 后置
- [ ] 真实模型手工验证——用户执行
