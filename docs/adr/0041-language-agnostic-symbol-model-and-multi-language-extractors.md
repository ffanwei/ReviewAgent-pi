# 0041. 语言无关符号模型与多语言提取器（路线 B：首批 TypeScript/JavaScript 与 Python）

**状态**：已接受（2026-11-05；首批 `java` / `typescript` / `python`，其余语言按需追加）
**日期**：2026-11-05
**关联**：ADR-0003（零构建静态代码智能）、ADR-0040（语言注册表与 `codeintel.languages`）、ADR-0025（用户级 JSONC 配置）、ADR-0038（退役外部真源逐字节对照）
**跨仓**：本 ADR 为本仓 pi 线序列 0041；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

ADR-0040 的路线 A 只回答了「扫哪些文件」：语言注册表 + `codeintel.languages` 把
`*.java` 从五处散点收口，并让非本语言仓明确提示而不是静默返回 0 条。但符号提取
本身仍是 Java 专用：

- `zoneb/symbols.ts` 的 `JavaSymbol`、节点表、修饰符集合、`(default package)` 文案；
- `changed-symbols.ts` / `call-chain.ts` / `search-tools.ts` 写死
  `kind === "method" || kind === "constructor"`；
- `repo-context.ts` 的 `PACKAGE_PATTERN` 是 Java 正则；
- `reference-sites.ts` 的注释前缀写死 `//` / `/*` / `*`；
- Zone A 系统提示写 "senior Java code reviewer"。

用户侧需求是「默认支持主要前后端语言、可手动修改、不影响功能与性能」。在拿到
客户 MR 样本之前无法用数据定语言顺序；本轮按用户确认的 **provisional 顺序**先交付
前两门：TypeScript/JavaScript → Python。顺序的最终依据仍是「目标客户样本 MR 的
语言覆盖率」（按 `diff --git` 文件块统计、绝不切 hunk），架构不随顺序改动。

### 已实测前提

12 个语法 wasm 用本仓 `web-tree-sitter@0.27.0` 逐个 `Language.load` + 样例解析，全部成功：

| 语言 | 包 | wasm |
|---|---|---|
| TypeScript / JSX | `tree-sitter-typescript@0.23.2` | `tree-sitter-typescript.wasm` + `tree-sitter-tsx.wasm` |
| Python | `tree-sitter-python@0.25.0` | `tree-sitter-python.wasm` |
| Java（既有） | `tree-sitter-java@0.23.5` | `tree-sitter-java.wasm` |
| 后续候选 | go / c / cpp / c-sharp / `@tree-sitter-grammars/tree-sitter-kotlin` | 均有 wasm |

两个已知坑：`.tsx` / `.jsx` 不是 typescript 语法的子集，必须走独立的 tsx 语法；
`tree-sitter-kotlin@0.3.8` 不带 wasm，后续必须换 `@tree-sitter-grammars/…`。

## Decision

### 1. 语言无关的 `CodeSymbol` 模型

`zoneb/symbols.ts` 只保留跨语言模型与树操作，具体提取下沉到
`zoneb/extractors/<language>.ts`：

```ts
type SymbolKind =
  | "class" | "interface" | "enum" | "record" | "struct" | "trait"
  | "namespace" | "module"
  | "method" | "function" | "constructor"
  | "field" | "property" | "enum-constant" | "type-alias";
```

- `isTypeKind` / `isCallableKind` 取代散点 `kind === …`：**顶层函数**与类方法同等
  参与 Reference / Call Chain，否则 TS/Python 的 diff 落在顶层函数上时调用链没有主体；
- `owner?: string`：给没有类型包裹节点的语言（Go 接收者方法、Rust `impl`）显式声明
  归属；Java/TS/Python 仍由容器推导；
- `moduleName` + `moduleLabel` 取代 `packageName`：Java 读 `package` 声明、Python 由
  路径推导 dotted module、TS 留空；展示后缀按语言渲染（Java 空包保留
  `(default package)` 以维持既有字节，非 package 语言空模块名直接省略）；
- 签名渲染下沉为 `renderSignature`，Java 实现原样搬过去，**输出字节不变**。

### 2. 注册表从「元数据」升级为「语言能力对象」

```ts
interface CodeLanguage {
  id; displayName;
  variants: { id; globs; createParser() }[];
  moduleLabel: string;                 // "package" | "module" | ""
  commentLinePrefixes: string[];       // Java/TS: ["//","/*","*"]；Python: ["#"]
  supportsInvocations: boolean;        // false = 显式报「不支持」，不是空结果
  moduleNameFromHeader?(head: string): string;
  extract(parser, file, source): FileSymbolIndex;   // 纯函数，AST 文档顺序
  renderSignature(symbol): string;
}
```

- 一门语言 = 若干**语法变体**：`.ts/.mts/.cts/.js/.mjs/.cjs` 走 typescript 语法，
  `.tsx/.jsx` 走 tsx 语法；
- `codeintel/wasm.ts` 收口运行时：`Parser.init()` 进程级一次，grammar 与 parser 按
  「包/文件」memoize；未启用的语言永不触碰 wasm；
- 注册表只 import 纯函数 extractor/renderer（无顶层 wasm 初始化），因此
  `shared/config.ts` 引用语言 id 仍是零副作用。

### 3. 首批语言与覆盖范围

- **TypeScript/JavaScript**（一个 id 覆盖 ts/tsx/js/jsx/mjs/cjs）：class / abstract
  class / interface / enum / type alias / namespace / function / 箭头函数；类成员
  method / constructor / field；接口 method_signature / property_signature；
  `call_expression` + `new_expression` 调用点。**不引入 `tree-sitter-javascript`
  直接依赖**（它是 typescript 包的传递依赖，只用于 build script 忽略）；
- **Python**：class / def / async def / 顶层赋值；类成员方法、类属性、嵌套类；
  装饰器按源码顺序记为修饰符（`@property` / `@staticmethod` / …）；`call` 调用点
  （`obj.foo()` 取末段 `foo`）。**嵌套函数不提取**——局部实现不是公共符号；
- 两门语言都是名字级、无类型解析（与 Java 同一精度天花板）。

### 4. 引用过滤与调用链语言化

- 整行注释过滤按文件所属语言取 `commentLinePrefixes`（Python 的 `#` 今天是误报源）；
- `supportsInvocations = false` 的语言在 Call Chain 的 Callees 段显式输出
  `(call-site extraction is not implemented for <language>)`，不与「查了但没有调用」
  共用空结果；
- Zone A 系统提示改为语言中立（"senior software engineer acting as a code reviewer"）；
  **动态语言清单不进系统提示**，避免破坏 cache 前缀稳定性；语言名只出现在 Zone B
  工具输出里（`across N <detected languages> file(s)`）。

### 5. 多语言扫描面：`codeintel.excludeGlobs`

`rgListFiles` 刻意使用 `--no-ignore`（不被仓库 `.gitignore` 左右，保证确定性）。
glob 从 `*.java` 扩到 `*.ts/*.tsx/*.js/*.py` 后，必须显式排除依赖与生成物：

```jsonc
"codeintel": {
  "languages": "auto",
  "excludeGlobs": [
    "**/node_modules/**", "**/dist/**", "**/build/**", "**/out/**",
    "**/target/**", "**/vendor/**", "**/__pycache__/**", "**/.venv/**",
    "**/venv/**", "**/generated/**", "**/.git/**", "**/*.min.js", "**/*.d.ts"
  ]
}
```

- 缺省值来自 `codeintel/scan-defaults.ts`，模板与运行时默认值由同一常量生成（不漂移）；
- 语义：负向 glob 排在正向之后（ripgrep 后者优先）；空数组 = 不排除任何东西；
- 未知键 / 非字符串 / 空字符串条目 = `ConfigError`（fail fast）。

### 6. 性能：先 rg 预收窄，再解析

`review.get_symbol` 与 `review.get_call_chain` 不再遍历全部源文件后逐个解析。新增
`RepoContext.candidateFilesForName(name)`：用 ripgrep 全词匹配拿到**文本上包含该名字**
的文件，再只解析这些文件。

正确性：符号声明必然在文本上包含自己的名字，因此预收窄不改变命中集合，只缩小解析面。
这比「加一个 `getSymbolMaxFiles` 静默截断上限」更优：既不丢结果，也避免多语言仓
（几万个 TS 文件）一次工具调用把延迟打穿。

### 7. 语言顺序（provisional，可被客户样本推翻）

- 本轮交付：TypeScript/JavaScript → Python；
- 后续候选顺序：Kotlin → Go → C# → C/C++；
- 排序方法不变：对客户样本 MR（建议 ≥300 条）按 `diff --git` 文件块归语言，主指标 =
  「某语言出现在多少 % 的 MR 里」，次指标 = 变更文件占比；不凭印象排优先级。

### 8. 版本

新增能力走 **minor**：`0.2.0 → 0.3.0`；`packages/review-pi/package.json` 与
`src/shared/version.ts` 同改。

## Consequences

**收益**

- 加语言 = 一个 extractor + 一行注册 + 一组测试，核心层不再出现语言分支；
- 前后端仓首次获得真实符号 / 引用 / 调用链能力，而不是「看起来坏了」；
- 引用检索不再把 Python 的 `#` 注释当代码引用；
- 多语言扫描不会把 `node_modules` / `dist` / `__pycache__` 当源码。

**代价 / 风险**

- TS/JS 用 TypeScript 语法解析（TS 是 JS 超集）：纯 JS 里的 Flow 注解等会落入
  `parseError` 留痕，属已知天花板；JSX 单独走 tsx 变体；
- Python 的 `__init__` 仍记作 `method` 而非 `constructor`（名字级模型不推断语义）；
- 名字级精度：重载 / override / 动态派发不分辨（Java 既有天花板）；
- `"auto"` 升级会扩语言，工具输出里的语言标签与文件数会变——需要随版本更新夹具；
- C/C++ 未来只登记一个 `cpp` id（`.c/.h/.cc/.cpp/.hpp` 走 cpp 语法），不拆两个 id
  制造双份引用检索。

**验证**

- `pnpm --filter review-pi typecheck` / `pnpm --filter review-pi build` exit 0；
- 全量 `vitest run` 611 passed（含新增 TS/Python extractor 单测、多语言夹具、
  Python `#` 注释过滤、rg 预收窄、`excludeGlobs`）；
- Java 仓工具输出保持既有字节：`toolkit.test.ts` 的 `across 3 Java file(s)`、
  `(default package)`、`failed to initialize the Java tree-sitter parser` 均未变。
