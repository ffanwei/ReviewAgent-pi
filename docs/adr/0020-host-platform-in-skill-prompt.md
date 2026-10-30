# 0020. skill 会话提示词注入宿主平台信息

**状态**：已接受（2026-10-30）
**关联**：ADR-0014（Phase 5 之后的独立 skill 会话）、ADR-0018（规则包目录形态，开发期最常触发 bash）、`packages/review-pi/src/tools/skill-bash.ts`（平台提示单一来源）、`packages/review-pi/src/knowledge/skill-pass-brief.ts`（会话首条 user 消息）
**跨仓**：本 ADR 为本仓 pi 线序列 0020；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

skill 会话是唯一能让模型**执行命令**的会话（第 8 只工具 `bash`，ADR-0014 决策 6/7）。它的事实边界是：

- **没有 shell**（`shell: false`）：命令串只按引号规则切成 argv，引号外的 `& | ; < > $ \`` 与换行一律拒绝；
- **Windows 只认 `.exe` / 无后缀**：`shell: false` 下 Node 直接拒绝 `.cmd` / `.bat`，所以 `npx`、`pnpm` 这类 shim 不可用；
- **POSIX 上 `python` 可能缺席**（常见只有 `python3`），反之 Windows 上通常只有 `python`；
- 路径分隔符、大小写、`PATH` 可执行集随平台不同。

这些是**实现常量**，但模型看不到：`SKILL.md` 是规则包作者写的跨平台文本，其中出现的命令自然按作者本人的平台书写。在别的 OS 上跑时，模型会照抄一条**语法成立但本机不可执行**的命令（`python3 x.py` 在 Windows 上找不到、`npx` 直接被拒、POSIX 路径在 Windows 上无效），然后拿到一条工具失败，再把失败当成「规则无法验证」而放弃候选——这是**静默质量损失**，在转录里只表现为一次工具错误。

更麻烦的是：模型没有任何信号知道**当前**是哪个平台。它在检视会话里看不到宿主信息，`bash` 的工具描述也不说。

## Decision

1. **新增纯函数 `formatHostPlatformNote(platform, arch)`**，作为平台提示的**单一文本来源**（`tools/skill-bash.ts`）。默认参数取 `process.platform` / `process.arch`，可注入以保测试确定。
2. **同一段文本进两处提示词**：
   - `bash` 工具的 `description` 末尾（每次请求的 tools 段都可见，离调用点最近）；
   - skill 会话**首条 user 消息**的输出契约前列一条（进该会话的指令面，模型在做计划时就看见）。
   两处内容**逐字同源**，避免「工具描述说 A、会话指令说 B」的分叉。
3. **只进 skill 会话**。七工具面（`review` 等 A–E 主会话工具）、system prompt、相位指令、A–E 字节冻结面**零改动**。理由：只有 skill 会话能执行命令，主会话拿不到这份信息也没有代价；而往冻结面加字节会污染测量档与跨仓对照。
4. **文案只陈述既有边界，不新增能力**：
   - 恒有一行 `Host platform: <名称> (<platform>, <arch>) — commands run as direct processes without a shell.`；
   - 恒有一句「shell 内建与 `| > && $` 等操作符不可用」；
   - Windows 追加：路径风格、`.exe`/无后缀、`.cmd`/`.bat`（如 `npx`）被拒、优先 `python` 而非 `python3`；
   - macOS / Linux 追加：POSIX 路径、`python3` 常在而 `python` 可能缺席；
   - 其它平台走兜底句（只要求「按本平台路径语法与 PATH 上的可执行文件」+ 无 shell）。
   **不**承诺任何新能力（不引入 `sh -c`、不放开 `.cmd`、不自动翻译命令）。
5. **平台名称映射有限枚举**：`win32 → Windows`、`darwin → macOS`、`linux → Linux`，其余原样透出 `process.platform`（`freebsd` / `aix` 等），保证未知平台也有可读提示而不是空串。
6. **注入缝**：`buildSkillBashTool` 接受 `platform` / `arch`（缺省进程值）；`buildSkillPassInvocation(skill, runtime?)` 接受同名字段。生产路径不传 = 用真实宿主；测试传固定值。
7. **不进审计 / RunRecord / 渲染**：这是提示词内容，不是运行事实。要核对时看**转录**（`session-…-skill-<name>-r<N>.json` 的首条 user 消息）。

## Options（为什么不是别的）

- **只加在 bash 工具描述里**：工具描述在 tools 段，离调用最近，但模型在**计划**阶段（还没调工具）不会主动回看 tools；首条 user 消息更靠前、更像指令。两处同源成本极低，取双处。
- **只加在首条 user 消息里**：模型在真正拼命令时未必重读那条长消息；工具描述是调用点的最后一道提醒。同样取双处。
- **写进 system prompt**：会碰 A–E 冻结面（system prompt 是测量常量），且让主会话也背上无关信息。放弃。
- **在 SKILL.md 里让作者自己写**：不可控——规则包是共享资产，作者不知道运行者的 OS；而且每个包都要重复一遍。放弃。
- **运行时自动改写命令**（如把 `python3` 映射成 `python`）：等于在无 shell 的边界上再叠一层隐式翻译，错判时更难排障，且要维护命令表。放弃——只给信息，翻译留给模型。
- **报错时附平台信息**：事后补偿，模型已经浪费一次调用；而且失败信息未必能反映「是 OS 不兼容」。放弃作为主手段（既有工具错误文案不动）。
- **注入完整 `os.release()` / 发行版信息**：对选命令没有增量价值，且把宿主指纹写进提示词。只报 `platform` + `arch`。

## Consequences

- **正**：
  - 模型在**计划**与**调用**两个时点都能看到宿主平台，跨 OS 跑同一规则包的失败率下降；
  - 文案与实现同源（`formatHostPlatformNote`），将来放开/收紧 bash 边界时只改一处；
  - 不动测量面：A–E 请求字节、七工具 schema、审计/RunRecord 全零改动；
  - 平台/架构可注入 ⇒ 单测能覆盖 `win32` / `darwin` / `linux` / 未知平台四种文案，不依赖跑测者的机器。
- **负/风险**：
  - **提示词变长**：skill 会话首条 user 消息多一行、bash 工具描述多一句（约 200 字符），按 token 计可忽略，但确实改变了 skill 会话请求字节——**历史 skill 转录不可逐字节复现**，这是本 ADR 的显式代价（skill 会话本属非测量档，ADR-0014）。
  - **文案与真实能力可能漂移**：若将来 bash 支持了 shell 或放开 `.cmd`，必须同步改本文案（放在同一函数里就是为了让漂移可见）。
  - **不解决全部兼容问题**：只给平台与既有边界，模型仍可能写出本机不存在的命令（如某个未安装的工具）；这是知识面问题，不是提示词缺失。
- **中性**：不新增环境变量、不新增旗标、不改退出码；skill 会话的失败判定与 `skillPassLog` 语义不变。

## 验收标准

1. `formatHostPlatformNote` 为纯函数：同入参恒同输出；`win32` / `darwin` / `linux` / 未知平台四类文案各有断言（含平台名、OS 名、`.cmd/.bat` 拒绝、`python` 偏好、无 shell 句）。
2. `buildSkillBashTool({ platform, arch })` 的 `description` 含平台行，且 `name` / `parameters` 不变（仍只收 `command`）。
3. `buildSkillPassInvocation(skill, { platform, arch })` 的首条 user 消息含平台行，且既有 skill 块、`References are relative to …`、输出契约各要素逐项不变；不传 runtime 时用当前进程平台（有平台行即可，不钉死具体 OS）。
4. 进程面：`--config F --rule-skill <dir>` 的 skill 转录文件里能读到 `Host platform: ` 与会话首条 user 消息的同源文案。
5. A–E 请求字节、七工具 schema、审计与 RunRecord **零改动**（既有测试逐字节断言保持绿）。
