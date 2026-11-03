# 0029. MR 输入面：`--mr` 拆成 `--mr-diff` / `--mr-json`

**状态**：已接受（2026-10-31）；**修订（2026-11-02）**——决策 2 的读取面由「只读 `new_path` 与 `diff`」放宽为「路径 `new_path` / `filename` / `file_path` / `path`、正文 `diff` / `patch`，各按优先级取第一个非空，且支持 `diff` 为内层对象时递归到 `diff.diff`」：GitCode v5 的 `GET /pulls/:number/files` 实际是 **GitHub 形态**（`filename` + `patch`），`/pulls/:number/files.json` 是 **`{diffs:[…]}` 外壳**（`new_path` + `diff`），另有文件树包装形态（外层 `file_path` + 内层 `diff.diff`）；原实现只认最后一种的字段，按文档拉 `/files` 会直接报「第 1 项缺 new_path」。缺路径的报错同时列出该项**实际键名**（方言再漂移不必猜）
**关联**：ADR-0024（仓收窄为 Review CLI 产品仓）、ADR-0025（用户级 JSONC 配置）、ADR-0027（产物路径与规则包信任边界）、ADR-0028（npm 多包分发）
**跨仓**：本 ADR 为本仓 pi 线序列 0029；DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

单次检视的唯一输入面一直是 `--mr <diff-file>`：一个标准 unified diff 文件。上游数据集（VUL4J 等）给的正是这种形态，所以历史上足够。

现在多了一条真实入口：**直接吃 GitCode / GitLab 的 MR 文件变更接口**。

```text
GET https://api.gitcode.com/api/v5/repos/:owner/:repo/pulls/:number/files
Authorization: Bearer <token>
```

它返回的**不是** unified diff，而是按文件切片的 JSON 数组：

```json
[
  {
    "new_path": "src/api/user.ts",
    "diff": "@@ -12,9 +12,15 @@\n   id: number;\n-  email: string;\n+  email: string | null;\n }",
    "old_path": "src/api/user.ts",
    "new_file": false,
    "renamed_file": false,
    ...
  }
]
```

每项的 `diff` 值从 `@@` 开始，**没有** `diff --git` / `---` / `+++` 文件头。

> 上例是 `/pulls/:number/files.json` 变体的字段。同一平台的 `/pulls/:number/files` 是 GitHub 形态（`filename` + `patch`），两套都要能直接喂——见决策 2（2026-11-02 修订）。

`zoneb/diff-analysis.ts` 以文件头判定「当前文件」，于是两种「凑合能用」的做法都失败：

| 做法 | 结果 |
|---|---|
| 整份 JSON 直接喂 `--mr-diff` | `diff contains no parsable file headers` |
| 只把各项 `diff` 字符串拼起来 | `diff hunk appeared before any file header` |

要么让用户先跑一个转换脚本（多一步、多一份中间态、多一处出错），要么让 CLI 认这份响应。本 ADR 采纳后者，同时把「输入形态」这件事在旗标上显式化。

## Decision

### 1. `--mr` 拆成两个旗标，二选一

```text
--mr-diff <file>   标准 unified diff 文本
--mr-json <file>   GitCode/GitLab 文件变更 JSON 数组
```

- **命名 kebab-case**：与本仓既有 `--rule-skill-zip` / `--strict-rule-skill` 风格一致。
- **恰好给一个**：都省略 → `missing required flag --mr-diff (or --mr-json)`；都给 → `conflicting flags --mr-diff and --mr-json (give exactly one)`。不静默取其一——两种输入语义不同，猜错会让检视基于错误的变更集。
- **`--mr` 硬改名，无兼容别名**，但给专用迁移提示而非裸 unknown flag：

  ```text
  --mr 已改名（ADR-0029）：统一 diff 文件用 --mr-diff，接口 JSON 用 --mr-json
  ```

  这是本仓既有的迁移做法（ADR-0025 对 `--env` 同款）：不留别名，但把「该换成什么」直接说清。

### 2. `--mr-json` 读「路径 + 正文」两个语义字段（多方言、多层级）

转换层 `zoneb/mr-json.ts` 只关心两件事——每个变更属于哪个文件、它的 hunk 正文是什么——但**同一平台不同接口的响应形状并不统一**，现实里已见到四种：

| 顶层 | 每项路径 | 每项正文 | 出处 |
|---|---|---|---|
| 数组 | `new_path` | `diff` | GitLab `/merge_requests/:iid/changes` |
| 数组 | `filename` | `patch` | GitCode `/pulls/:number/files`、GitHub `/pulls/:number/files` |
| 对象 `{diffs:[…]}` | `new_path` | `diff` | GitCode `/pulls/:number/files.json` |
| 数组 | `file_path`（外层） | `diff.diff`（内层对象） | GitCode 文件树包装形态：`{diff:{…}, file_path, file_type, level, title}` |

读取规则（两种输入形态、两个语义字段，各按优先级取第一个非空值）：

| 语义 | 字段（按优先级） | 备注 |
|---|---|---|
| 新侧路径 | `new_path` → `filename` → `file_path` → `path` | 外层都没有时看 `diff` 内层同名键；仍找不到即 fail fast |
| 文件正文 | `diff` → `patch` | `diff` 是对象时向内递归（`diff.diff` / `diff.patch`）；空串继续看下一个键 |

GitCode v5 `/files` 的真实响应（2026-11 核对官方文档）：

```json
[
  {
    "sha": "6dcb09b",
    "filename": "src/api/user.ts",
    "status": "modified",
    "additions": "2",
    "deletions": "1",
    "blob_url": "https://…",
    "raw_url": "https://…",
    "patch": "@@ -12,9 +12,15 @@\n   id: number;\n-  email: string;\n+  email: string | null;"
  }
]
```

文件树包装形态（用户实际拿到的一份）：

```json
[
  {
    "diff": {
      "a_mode": "0", "b_mode": "", "deleted_file": false,
      "diff": "@@ -0,0 +1,3 @@\n+public class A {}",
      "new_file": true, "new_path": "a.java", "old_path": "a.java",
      "renamed_file": false, "too_large": false
    },
    "file_path": "a.java", "file_type": "file", "level": 9, "title": "a.java"
  }
]
```

其余字段（`old_path` / `new_file` / `deleted_file` / `renamed_file` / `status` / `too_large` / `level` / `title` / …）**一律忽略**，理由：

- 接口在重命名/复制场景下新侧路径才是定位依据，旧侧不影响行号；
- `new_file` / `deleted_file` / `status` 是声明，与 hunk 头可能不一致；**以 diff 本身为准**比信任元数据更可靠；
- 多读一个字段就多一条「接口方言变了怎么办」的耦合面——所以方言是**封闭表**，只收语义等价的别名与层级，不做字段猜测（不读 `old_path` 当新路径、不读 `title` 当路径）。

**新增 / 删除由 hunk 头判定**：

| hunk 头 | 判定 | 产出 |
|---|---|---|
| `@@ -0,0 ` | 新增 | `new file mode 100644` + `--- /dev/null` |
| `+0,0 @@` | 删除 | `deleted file mode 100644` + `+++ /dev/null` |
| 其它 | 修改 | 两侧都用同一条路径 |

### 3. 转换在装载期一次完成，之后共用同一条路径

```
读 --mr-json 文件
  → mrJsonToUnifiedDiff(raw, "--mr-json")
  → 统一 diff 文本
  → analyzeDiff(...)  // 与 --mr-diff 完全相同的后续
```

- **不做网络请求**：CLI 只读本地文件，取接口响应用户自己完成（`curl.exe -o` / `Invoke-RestMethod`）。CLI 不持有 token、不做分页、不猜 owner/repo/number。
- **不做路径改写**：接口给什么路径就写什么路径（不补 `a/` 前缀到仓库根、不做别名映射）。
- **形状不对 fail fast**，错误消息带**输入标签与条目序号**：

  | 情况 | 错误 |
  |---|---|
  | 非法 JSON | `--mr-json: 不是合法 JSON（…）` |
  | 顶层既非数组也无 `diffs` 数组 | `--mr-json: 期望文件变更数组或 {diffs:[…]}，得到 object` |
  | 条目不是对象 | `--mr-json: 第 2 项不是对象（得到 string）` |
  | 缺路径（`new_path` / `filename` / `file_path` / `path` 全无，含 `diff` 内层） | `--mr-json: 第 1 项缺 new_path（无路径就无法定位文件；可用 new_path / filename / file_path / path，也可放在 diff 内层）——该项现有键：sha、status、patch` |
  | 正文非字符串 | `--mr-json: 第 1 项的 diff 必须是字符串（得到 array）` / `第 1 项的 patch 必须是字符串（得到 number）` / 内层带层级：`第 1 项的 diff.diff 必须是字符串（得到 number）` |
  | 全部条目空正文 | `--mr-json: 没有可转换的文本 diff（N 个条目全部为空 diff / 二进制 / too_large / 纯改名）` |

- **空 `diff` 条目跳过**：二进制与纯改名在接口里给空串，产不出可检视的行。但**一个都没有时不静默产出零文件 diff**——那会让上游拿到「零变更」的假结论，直接 exit 1。
- **BOM / CRLF 容忍**：Windows 侧导出常带两者，装载期归一。
- **整段 patch 透传**：若 `diff` 已以 `diff --git` 开头（有些网关直接回 git 原文），原样透传，不重复包头。

### 4. 参数模型省键

`ReviewCliArgs` 保留 `mr` 字段，另加可选 `mrFormat?: "json"`：

| 输入 | `mr` | `mrFormat` |
|---|---|---|
| `--mr-diff f` | `f` | 省键 |
| `--mr-json f` | `f` | `"json"` |

diff 形态省键沿用 `args.ts` 既有的「缺席省键」惯例（`out` / `issue` 同款），避免为一次改名重写大量既有 `toEqual` 断言；`main.ts` 只多一个 `args.mrFormat === "json"` 分支。

## Options（为什么不是别的）

- **保留 `--mr` 并按扩展名/内容自动判别**：`--mr m.json` 猜 JSON、`--mr m.diff` 猜 diff。看起来「不用改用户命令」，但把形态判断藏进文件名，用户改个扩展名就静默换语义；JSON 文件也可能叫 `.txt`。显式旗标才能让错误在解析期暴露。放弃。
- **保留 `--mr` 为 diff 别名，另加 `--mr-json`**：需要长期维护两条指向同一语义的旗标，文档与错误消息都要写「或」，且用户会一直看到旧名。本仓 `--env` 的先例是不留别名。放弃。
- **CLI 自己拉接口（`--mr-url` / `--repo-url`）**：CLI 要持有 token、处理分页与限流、承担网络错误面，与「读本地文件、无副作用」的输入纪律冲突。放弃。
- **读 JSON 里所有 `patch` 之外字段做 rename 映射**：多一条耦合面，收益只是少数 rename 场景的展示路径。放弃。
- **空 diff 数组当成功（零变更）**：静默空检视比报错更危险。放弃。

## Consequences

- **正**：
  - 拉完接口直接 `--mr-json` 就能跑，不需要中间转换脚本；
  - 两个旗标各自语义单一，错误在解析期/装载期暴露，带条目序号可定位；
  - 转换层是纯函数（`zoneb/mr-json.ts`），单测不用进程、不用网络；
  - `--mr-diff` 的既有调用方只需机械改名，且旧名有专用提示。
- **负/风险**：
  - **破坏性改名**：脚本与文档中的 `--mr` 一律失效（有提示，不改行为）；
  - 只读路径与正文意味着 rename 场景只按新侧路径处理，旧路径信息不进入检视上下文（当前 Diff→Symbol 管线也只按新侧路径定位，符合既有语义）；
  - 别名与层级是**封闭表**：`new_path` / `filename` / `file_path` / `path`、`diff` / `patch`、`diff` 内层同名键。再出新方言仍需改代码（但错误消息会列出该项实际键名，定位不用猜）。
- **中性**：
  - 产物契约（`reviews_en.json` / `reviews_tips_zh.json` / 审计）不变；落点由 ADR-0032 拍平为 `<out>/runs/` 与 `<out>/audit/`（无 `mr/<caseId>/rep-<N>` 层）；
  - `caseId` 派生规则不变（文件名去最后一个扩展名），JSON 与 diff 输入同款；
  - 不引入新的配置键。

## 验收标准

1. **解析**：`args.test.ts` 锁定 —— `--mr-diff` 省 `mrFormat`、`--mr-json` 标 `"json"`、二选一冲突与双缺文案、`--mr` 迁移提示。
2. **转换**：`zoneb/mr-json.test.ts` 锁定 —— 用户真实样例转出的文件头/行区间能被 `analyzeDiff` 读出；四种形状（GitLab `new_path`+`diff`、GitHub/GitCode `/files` `filename`+`patch`、`{diffs:[…]}` 外壳、文件树包装 `file_path`+`diff.diff`）正向可转换；路径与正文的方言优先级（外层优先、空串继续看下一个键、`diff` 内层递归）；二进制条目无正文即跳过；额外字段不产生 rename、不信任 `new_file`；空 diff 跳过与全空 fail fast；BOM/CRLF；形状错误的标签、序号、「该项现有键」与内层键的层级前缀（`diff.diff`）。
3. **进程**：`bin.process.test.ts` 锁定 —— `--mr-json` 正向跑通（exit 0、stdout 单 JSON、`caseId` 正确、产物落在 `<out>/runs/`），坏 JSON 与空 diff 数组 exit 1 且 stdout 干净。
4. **门**：`pnpm --filter review-pi typecheck`、`pnpm --filter review-pi test` 全绿。
5. **文档**：`docs/使用手册-安装与运行.md` §5.1/§5.2（`--mr-json` 章节）/§5.7/§5.10/§6.2/§8.4/§9.1–9.2、`docs/运行手册-单次检视.md` 旗标表与命令块、`README.md` 命令示例同步为「二选一」形态。
