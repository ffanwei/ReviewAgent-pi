# 0040. 代码智能语言注册表与 `codeintel.languages` 配置（路线 A：零行为变化）

**状态**：已接受（2026-11-05；当前只登记 Java，多语言解析器为后续阶段）
**日期**：2026-11-05
**关联**：ADR-0010（检视输出恒英文、语言是呈现配置）、ADR-0025（用户级 JSONC 配置）、ADR-0038（退役外部真源逐字节对照）、ADR-0039（大 MR 分片）
**跨仓**：本 ADR 为本仓 pi 线序列 0040；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

代码智能四层管线（Diff → Symbol → Reference → Call Chain）从 POC1 起锁死 Java：

- `codeintel/rg.ts` 的缺省 glob 是 `"*.java"`；
- `zoneb/repo-context.ts` 只列 `*.java`，字段名还是 `javaFiles`；
- `zoneb/changed-symbols.ts` / `zoneb/call-chain.ts` / `tools/search-tools.ts` 按 `JavaSymbol` 工作；
- `tools/registry.ts` 的 schema 描述与 Zone A 系统提示直接写 "Java sources"。

非 Java 仓库的体验是**静默降级**：检视照常出 findings，但 `review.get_symbol` /
`review.find_references` / `review.get_call_chain` 返回
`no … found across 0 Java file(s)`——技术上诚实，产品上像故障。

需求侧提出「做一个默认支持主要前后端语言的配置，可手动修改，且不影响功能与性能」。
必须先钉死一个事实：**语言支持不是配置问题，是解析器问题**。

| 层 | 能否靠配置开 | 原因 |
|---|---|---|
| 检视 diff | 本来就全语言 | 模型读文本，无语法前置 |
| 符号 / 引用 / 调用链 | 不能 | 每语言需要一份 tree-sitter wasm + 符号提取规则 |

若配置写 `["java","typescript","python"]` 而 TS/Python 没有提取器，工具只会静默返回空。
这违反本仓「零静默降级」纪律，比不加配置更糟。

因此本轮只做**路线 A**：把散点收口成语言注册表、加配置形状、把「不支持」说清楚；
**不新增任何语言的解析能力**（路线 B：通用 AST 提取器 + 多语言节点表，另行立项）。

## Decision

### 1. 新增顶层 `codeintel.languages`

```jsonc
"codeintel": {
  "languages": "auto"   // 缺省；或 ["java"]；空数组 = 显式关闭
}
```

- `"auto"` = 跟随**当前版本已实现的解析器**（今天只有 Java）。升级后自动扩语言，
  用户不用回来改配置——这是选 `"auto"` 而非默认写死 `["java"]` 的原因；
- 数组 = 只启用列出的语言；条目做 `trim + lowercase` 归一、去重保序；
- **未实现的条目在装载期告警并丢弃**（`已实现：java`），不静默；
- 空数组 = 显式关闭代码智能（符号级工具扫 0 个文件），不退化成 `"auto"`；
- 非 `"auto"` 字符串、非字符串条目、空字符串条目 = `ConfigError`（fail fast）。

### 2. 语言注册表 `codeintel/language-support.ts`

```ts
interface CodeLanguage {
  id: "java" | …;
  displayName: string;          // 工具输出里的 "Java"
  globs: readonly string[];     // ripgrep -g，如 ["*.java"]
  createParser(): Promise<Parser>;
}
export const CODE_LANGUAGES: readonly CodeLanguage[] = [java];
```

- 新增语言的最小改动 = 补提取器 + 往表里加一行；调用方不再出现具体扩展名；
- `createParser` 走**动态 import**，未启用的语言永不加载 wasm；
- 配置装载只需要语言 id（纯元数据），因此 `shared/config.ts` 引用本模块不会拉起
  tree-sitter。

### 3. 硬编码收口

| 位置 | 变化 |
|---|---|
| `zoneb/repo-context.ts` | `javaFiles` → `sourceFiles`；新增 `languages` / `languageGlobs` / `languageLabel`；解析器按文件所属语言懒加载 |
| `codeintel/rg.ts` | `rgListFiles` 接受多 glob；`rgSearchWord` 改 `globs: readonly string[]`；空列表 = 0 结果（不退化成扫全仓） |
| `zoneb/reference-sites.ts` | 引用检索传 `repo.languageGlobs` |
| `tools/toolkit.ts` | `loadRepoContext` 透传 `runtime.codeintel.languages` |
| `tools/get-symbol.ts` / `tools/search-tools.ts` | 遍历 `sourceFiles`，文案用 `languageLabel` |

### 4. 把「不支持」说清楚

0 源文件时统一返回：

```text
no supported source files detected in this repository (code intelligence languages: Java)
```

显式关闭时：

```text
no supported source files detected in this repository (code intelligence is disabled by codeintel.languages)
```

替换旧的 `across 0 Java file(s)`。工具输出保持英文（与既有工具文案同一语言域）。

### 5. 零行为变化边界（有意限定）

- Java 仓的工具输出**逐字节不变**：`across 3 Java file(s)`、`Symbol "…"` 等文案由
  `languageLabel` 生成，值为 `Java`；
- Zone A 系统提示与工具 schema 描述**本轮不改**（仍写 "Java sources"）。它们是
  字节稳定面，真正多语言解析器落地时必须连同输出文案一起重标定；现在改只会
  提前打破基线而不带来能力；
- `JavaSymbol` 类型名不改：它描述的是 Java 语法树产物，路线 B 才引入语言无关符号模型。

### 6. 本轮不加 `referenceGlobs`

上一轮讨论提议过 `codeintel.referenceGlobs`（扫非源码文件的引用）。v1 不采纳：
引用范围直接由语言表派生，避免「语言表」与「额外 glob」两个杠杆抢同一效果；
等出现真实的「引用出现在模板/资源文件」需求再加。

## Consequences

**收益**

- 加语言不再需要在五处散点做 if-else；
- 非本语言仓从「看起来坏了」变成「明确告诉你当前支持什么」；
- 配置形状就位，将来升级到多语言时用户零改动。

**代价 / 风险**

- 符号提取仍是 Java 专用（`zoneb/symbols.ts`）；注册表只解决「扫哪些文件」，
  路线 B 还要解决「用什么规则抽符号」；
- 用户若在配置里预填一串路线图语言，每次启动都会收到告警。这是刻意的：
  宁可控诉，也不静默返回空结果；
- `"auto"` 意味着未来版本升级会改变工具输出文案（新增语言），需要新的夹具与断言。

**验证**

- Java 仓既有输出字节断言（`toolkit.test.ts`）不变；
- 新增：语言注册表单测、`codeintel.languages` 解析（auto / 数组 / 未知语言告警 /
  非法值 fail fast）、非本语言仓与显式关闭的提示断言、多 glob 扫描。
