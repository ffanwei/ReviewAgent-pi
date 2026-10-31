# 0026. 配置面收口：呈现引擎路径与 `builtin` 哨兵、官方/网关判档单源、模板去 `$schema`

**状态**：已接受（2026-10-31；ADR-0025 落地后的收口批次之一）
**关联**：ADR-0025（用户级 JSONC 配置；本 ADR 修订其中「相对引擎路径按 cwd 绝对化」与「模板含 `$schema`」两处）、ADR-0002（官方直连 wire 字节对齐）、ADR-0010（语言钉英文 + 核外翻译）、ADR-0021（呈现模型跟随检视模型）
**跨仓**：本 ADR 为本仓 pi 线序列 0026；DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

ADR-0025 把运行配置收到用户级 `~/.PiAgent/PiAgent.jsonc` 之后，配置面还留着四处**同类问题：同一个概念在两个地方各判一次**，以及一条**只在某台机器上成立的路径**：

1. **`presentation.engine` 相对路径按进程 cwd 解析**（ADR-0025 决策 1）。配置是用户级的，cwd 取决于这次从哪里敲命令：同一份配置从仓库根跑得通、从 `~/work` 跑就加载失败。`config init --from-env` 的「写入时绝对化」只修补迁移路径，手写配置的人仍会踩。
2. **引擎制品没有稳定位置**。`build:presentation` 把产物落在 `.tmp-gen/presentation/`——那是多种构建共用的传输临时区（不入库、随时可清），把它写进用户配置当引擎路径，等于让「配置」指向「临时目录」。分发形态（`pnpm deploy` / 打包）里更没有这个目录。
3. **官方直连判档是字符串相等**。`pi-client.maxTokensFor` 拿 `baseUrl.trim().replace(/\/+$/, "")` 与本地常量比字面；`config.ts` 另有一份 `OFFICIAL_REVIEWER_BASE_URL`。「同一 URL 两处判断」已经够糟，字符串相等还意味着 `HTTPS://API.DEEPSEEK.COM`、`https://api.deepseek.com//` 会被判成**网关档**——于是官方直连也发 `max_tokens`，ADR-0002 的 wire 字节对齐在没人察觉的情况下破掉。网关缺省预算 `32768` 也有两份字面。
4. **模板里的 `$schema` 指向一个从未发布过的 schema**（`https://example.invalid/piagent.schema.json`）。对一个「秘密只写在这里」的用户文件，这不提供任何校验，只是噪声；`example.invalid` 还会让人以为需要联网。
5. **配置文件完全缺席时没有一句提示**。全缺省形态能跑，但缺 `reviewer.apiKey` 的报错没有告诉用户「你其实没有配置文件」——第一反应是「key 明明在环境变量里」。

## Decision

### 1. 引擎路径三形态，相对路径锚在配置文件目录

`presentation.engine` 接受：

| 取值 | 含义 |
|---|---|
| `null` / 空白 | 不投影（英文直通，现状形态） |
| `"builtin"` | 制品自带的引擎（`<pkg>/presentation/engine-zh.js`） |
| 绝对路径 | 原样使用 |
| 相对路径 | **相对配置文件所在目录**解析（不是 cwd） |

解析单源：`shared/config.ts` 的 `resolvePresentationEnginePath(engine, configPath)`。
该函数**只做路径解析，不校验存在性**——存在性判断放在装载它的地方（CLI 启动期），因为「模块缺失」的正确语义是降级而不是配置错误。

写 `"builtin"` 而不是绝对路径的理由：配置要能在机器之间、在源码树与分发包之间直接复制粘贴；制品位置由安装形态自己决定，用户不该知道 `<pkg>/presentation/` 这个内部路径。

### 2. 装载期校验：引擎缺失 = 本次未配置引擎

`cli/main.ts` 在动手投影之前解析路径并 `existsSync`：

- 在位 ⇒ 正常投影；
- 不在位 ⇒ **一行 stderr**（`presentation.engine 指向的模块不存在（…），本次按未配置引擎恒等直通`）+ 本次恒等直通；**exit 0，不抛错**。

不等到投影阶段才降级：那里会先打「呈现投影进行中」心跳，再在检视跑完几十秒后回退英文，等于让用户白等一轮网关时间。也不做成配置错误：配置本身合法，缺的是构建产物——`pnpm build:presentation` 没跑而已。

### 3. 引擎制品落到包内 `presentation/`

`build:presentation` 在编译之后执行 `scripts/copy-presentation.mjs`：

```text
.tmp-gen/presentation/*.js  →  packages/review-pi/presentation/
```

- 目标目录属于本包，`pnpm deploy` / 打包会带走（`.tmp-gen/` 不会）；
- 编译产物只 import `node:*` 与同目录 `./*.js`（对 `review-pi` 的引用全是 `import type`，编译期抹掉），换目录不影响解析；
- 复制前清空目标目录：上一版残留模块被 import 到，比缺文件更难查；
- 目录进 `.gitignore`（构建产物，不入库）。

`"builtin"` 的哨兵值因此有了一个**由安装形态自己决定**的落点：源码树是 `<repo>/packages/review-pi/presentation/`，分发形态是包内的同一相对位置。

### 4. 官方/网关判档归一化，常量单源

新增 `isOfficialReviewerBaseUrl(baseUrl)`，`maxTokensFor` 与配置侧都只经它判档：

- 未配置 / 空白 ⇒ 官方（缺省即官方端点）；
- 归一化比较：scheme 与 host 大小写不敏感、尾斜杠全部剥掉；**路径逐字符有意义**（`https://api.deepseek.com/v1` 是另一个端点，不是官方）；
- 官方 ⇒ 不传 `max_tokens`（ADR-0002 字节面）；其余 ⇒ `DEFAULT_GATEWAY_MAX_TOKENS`。

`pi-client.GATEWAY_MAX_TOKENS = DEFAULT_GATEWAY_MAX_TOKENS`（不再是第二份 `32_768` 字面）；`pi-client` 删掉本地 `OFFICIAL_DEEPSEEK_BASE_URL`。
**不新增配置键**（不引入 `reviewer.endpointKind` 之类）：「官方还是网关」是由 `baseUrl` 决定的事实，不是用户要声明的第二维。

### 5. 模板删 `$schema`，读取侧仍容忍

`config init` 模板与仓库内 `PiAgent.example.jsonc` 同时删掉 `$schema` 行（两者逐字节同源，测试仍然锁）。
读取侧 `$schema` 保留在已知键表里：旧文件带着它不报错、不冒未知键警告。没有发布 schema 之前，模板不写一个假地址。

### 6. `presentationBufferMs` 允许 0（文档写明）

ADR-0025 的「`0` 一律非法」在本 ADR 里补一条显式例外说明：`limits.timeouts.presentationBufferMs` 的合法域是 `0..3_600_000`，`0` 表示**不留缓冲**（超时上界 = 逐字段预算之和）。这是唯一允许 0 的键，其余超时/并发/边界仍从 1 起。

### 7. 配置文件缺席给一行提示

`review` / `smoke` 在配置文件不存在时向 stderr 打一行「未找到配置文件 …（全缺省；secret 缺失时 review/smoke 会中止）」。**不改退出码**：全缺省仍是合法状态（官方直连 + 内置模型目录可以跑通）。

## Options（为什么不是别的）

- **继续按 cwd 解析相对路径**：配置是用户级的、cwd 是每次命令的——两者不该互相绑。放弃。
- **引擎只接受绝对路径**：把「制品在哪」这个安装形态知识推给用户，源码树换目录、分发包换机器都要重写配置。放弃。
- **自动探测引擎**（如「找不到就试 `.tmp-gen/presentation/engine-zh.js`」）：隐式回退比缺省更糟——用户以为配的是 A，实际跑的是 B。放弃。
- **引擎缺失直接 fail fast**：检视本身不需要引擎；为了一个可选呈现层让整次检视失败，违背「呈现层失败绝不丢检视产物」（ADR-0010）。放弃。
- **新增 `reviewer.endpointKind: "official" | "gateway"`**：多一个可写错的键，且与 `baseUrl` 事实可能矛盾；判档本来就该是派生量。放弃。
- **保留 `$schema` 并真发布一个 schema**：本次目标是收口而不是扩面；发布 schema 是独立工作量（键表、类型、注释）。先删假地址，发布后再加回。放弃。
- **`maxOutputTokens` 显式缺省为 32768**：会改变官方直连的 wire（从「不发」变成「发」），破坏 ADR-0002 字节面。放弃。

## Consequences

- **正**：
  - 同一份配置在源码树、其他工作目录、分发包里行为一致；
  - `"builtin"` 让「用自带引擎」成为一个可复制的字面量；
  - 官方直连判档不再被 URL 的大小写/尾斜杠欺骗，字节面对齐可守住；
  - 模板与 example 不再指向虚构 schema；
  - 缺配置时用户能立刻知道「没有配置文件」。
- **负/风险**：
  - **ADR-0025 的「相对路径写入时绝对化」不再是运行期语义**：本 ADR 之后相对路径由读取侧锚到配置文件目录；`--from-env` 的绝对化仍保留（历史迁移产物不变），但新写法不必绝对化。文档必须按新口径写，否则读者会两边各信一半。
  - **分发包必须带上 `presentation/`**：打包方案（A 多包 / B deploy / C bundle）尚未定；本 ADR 只保证「落点在包内」，不保证任何具体打包器会复制它——那属于分发方案决定的事。
  - 引擎缺失时只有一行 stderr，容易被长输出淹没：文档里把它列进排障表首行。
- **中性**：
  - 不写 `presentation.engine` 的配置，行为逐字节不变（恒等直通，stdout 无 `presentation` 键）；
  - 官方直连配置的请求字节不变；网关档仍是显式 `max_tokens`；
  - `config show` / 审计快照的键集不变。

## 验收标准

1. **引擎解析**：`null`/空白 ⇒ `null`；`"builtin"` ⇒ `<pkg>/presentation/engine-zh.js`；相对路径 ⇒ 配置文件同目录下的绝对路径；绝对路径 ⇒ 原样（`config.test.ts`）。
2. **装载期缺失**：配置指向不存在模块 ⇒ 进程 exit 0、stderr 恰一行「指向的模块不存在」、stdout 无 `presentation` 键、**不出现**「呈现投影进行中」（`bin.process.test.ts`）。
3. **相对路径跨 cwd**：引擎放配置文件旁 `engines/` 子目录、配置里写相对路径、从另一个 cwd 启动 ⇒ 投影仍成功（`bin.process.test.ts`）。
4. **判档归一化**：`HTTPS://API.DEEPSEEK.COM`、尾斜杠、空白 ⇒ 不发 `max_tokens`；`/v1` 等不同路径 ⇒ 网关档（`pi-client.test.ts`、`config.test.ts`）。
5. **模板**：不含 `$schema`；旧文件带 `$schema` 能读且不警告；example 与模板逐字节同源（`config.test.ts`）。
6. **构建**：`pnpm build:presentation` 生成 `packages/review-pi/presentation/{engine-zh,terminology,tips,translate-projection}.js`。
7. **门**：`pnpm --filter review-pi test`、`pnpm typecheck`、`pnpm test` 全绿。
