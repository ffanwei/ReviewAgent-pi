# 0079. 版本面：`review-pi version` / `--version`

**状态**：已接受（2026-11-13，用户决策：加版本命令；采纳「子命令 + 顶层别名、人读单行、`--json` 给支持 / CI」方案）
**关联**：[ADR-0025](0025-user-config-file.md)（配置装载是 CLI 的唯一落点）、[ADR-0035](0035-upstream-kernel-as-npm-deps-and-single-package.md)（内核四包是 npm 依赖、精确锁版本）、[ADR-0036](0036-cwd-session-index-and-export.md)（`export` 不加载配置的先例）、[ADR-0060](0060-run-log-in-session-dir.md)（运行日志）
**范围**：本仓 pi 线 0079。新增一个只读展示命令与两个排障出口（运行日志头 / `config show` 首行）；不改检视行为、退出码三态、审计与 stdout JSON 契约。

## Context

在此之前，本仓**有意没有** `--help` / `--version`：裸跑或未知输入一律 usage 到 stderr + `exit 1`，README 也把这条写成产品行为。这带来两个实际问题：

1. 用户报障时没有廉价方式确认「装的是哪一版」。版本常量 `REVIEW_PI_VERSION` 只出现在 MCP `clientInfo.version` 与同源测试里，终端上取不到。
2. `review-pi.log` 头只有 `startedAt` / `taskId`；日志被回传后，排障者仍要追问版本。`config show` 同理。

同时，`bin/review-pi.js` 有产物门禁（在位 + mtime 判鲜）。“版本命令在产物陈旧时能否回答”是一个必须先定的边界，不能顺手绕过。

## Decision

### 1. CLI 面：`version` 子命令 + 顶层别名

```
review-pi version [--json]
review-pi --version [--json]
review-pi -v
```

- `version` / `--version` / `-v` 三者同义，走同一个解析函数。
- 唯一旗标是无值布尔 `--json`；重复 `--json` = `duplicate flag`，未知旗标（含 `--config`）= 用法错误 + usage + `exit 1`。版本命令不读配置，就不接受配置旗标——静默忽略会让用户误以为它读过配置。
- usage 文案增加这两行，并撤掉「没有 `--version`」的旧措辞；`--help` 仍不提供（单独评估，不并入本 ADR）。

### 2. 执行位置：配置装载之前

`main()` 在 `loadConfig` 之前直接返回（与 `export` 同层）：

- 不读配置文件、不需要 apiKey、不碰模型；
- 不打印「未找到用户级配置文件」提示，也不做 `.env.local` 残留探测；
- 沙箱 HOME / CI 无配置文件的机器上恒可用。

### 3. 输出契约

人读形态 stdout **恰好一行**：

```
review-pi 0.5.0
```

可被 `cut` / 正则 / 版本比较脚本直接消费，不夹 Node 或内核细节。

`--json`（与 `config show --json` 同款两空格缩进）：

```json
{
  "name": "@baize/review-pi",
  "version": "0.5.0",
  "node": "v22.19.0",
  "kernel": {
    "@earendil-works/pi-ai": "0.85.1",
    "@earendil-works/pi-agent-core": "0.85.1",
    "@earendil-works/chord": "0.85.1",
    "@earendil-works/pi-telemetry": "0.85.1"
  }
}
```

### 4. 版本来源：产品单源 + 内核实际解析

- **产品版本** = `shared/version.ts` 的 `REVIEW_PI_VERSION`，由既有同源测试对着 `package.json` 钉住。运行时**不读**本包 `package.json`——版本只有一处可失败点。
- **内核四包** = 每条都 `import.meta.resolve(specifier)` 拿到 Node 真正会装载的入口，再从包根读 `package.json` 的 `version`。不硬编码 `0.85.1`，也不 `require.resolve`：内核包的 `exports` 只声明 `types` / `import` 条件，`require` 条件会直接 `ERR_PACKAGE_PATH_NOT_EXPORTED`（与 `bin/lib/cli-runtime.js` 的定位理由相同）。
- 解析失败（依赖未安装 / 布局异常 / 清单名字对不上）记 `null`，命令仍 `exit 0`——查版本本身不应因为某个依赖缺席而失败。

### 5. 排障出口：日志头与 `config show`

- `review-pi.log` 头固定增加一行 `# version: <version>`（ADR-0060 的日志头之后）。用户回传日志即可定位版本。
- `config show` 人读形态首行增加 `review-pi <version>`；`--json` 快照形状**不变**（它是配置审计面，不是产品信息面）。

### 6. bin 门禁不分叉

`version` 与其它命令一样经过 `bin/review-pi.js` 的在位 / 判鲜门：dist 缺失或过期时**照常拒跑**，不特判 `--version`。半构建树回答「版本」只会掩盖真正需要修的构建问题，并让 bin 与内核出现两套参数解析。

## Options（为什么不是别的）

- **只加顶层 `--version`，不加子命令**：否。`config` / `export` 已是子命令形态，`version` 同级最一致；顶层别名保留脚本友好性。
- **运行时读 `package.json` 当版本真源**：否。单源测试已把 `REVIEW_PI_VERSION` 与清单钉死；运行时读盘只多一处失败点。
- **人读行里塞 Node / 内核版本**：否。破坏「一行一个版本 token」的 shell 可消费性；细节放进 `--json`。
- **让 bin 特判 `--version` 绕过门禁**：否。见 §6。
- **`config show --json` 也加版本**：否。该形状是配置审计快照，加产品字段会把「配置变化」与「产品升级」混在一起。
- **同时补 `--help`**：否。本 ADR 只收版本面；help 的文案组织与旗标矩阵是独立决定。

## Consequences

- **好**：报障有统一的版本入口；脚本可拿单行产品版本；`--json` 一次给出 Node 与四个内核包的实际版本，安装布局问题可在排障阶段直接看见；日志与 `config show` 自带版本。
- **代价 / 风险**：
  - README 关于「没有 `--version`」的两处断言必须改（已随本 ADR 更新）；
  - `--json` 多一个需要随内核升级跟进的字段面（但值是解析出来的，不写死，不需要每次改代码）；
  - 依赖 `import.meta.resolve`（Node ≥ 22.19，`engines` 已满足）；包入口布局变化时对应项变 `null`，表现为「解析不到」而不是报错。
- **测试**：`args.test.ts` 锁解析面与 usage；`version-command.test.ts` 锁纯函数形状（注入解析器，不依赖真实安装布局）；`bin.process.test.ts` 进程面锁「单行 / JSON / 不加载配置 / 用法错误」；`config.process.test.ts` 与 `run-log.test.ts` 锁两个排障出口。
