# 0042. Go 与 C/C++ 符号提取器（多语言第二批）

**状态**：已接受（2026-11-05；`go` 与 `cpp` 两个语言 id）
**日期**：2026-11-05
**关联**：ADR-0003（零构建静态代码智能）、ADR-0040（语言注册表与 `codeintel.languages`）、ADR-0041（语言无关符号模型与多语言提取器）、ADR-0035（上游内核 npm 依赖）
**跨仓**：本 ADR 为本仓 pi 线序列 0042；引用 DSH 兄弟仓决策须写全限定语「DSH 线 ADR-XXXX」。

## Context

ADR-0041 建立了「语言无关 `CodeSymbol` + 每语言 extractor + 注册表」的接入面，并交付
首批 `java` / `typescript` / `python`。其 provisional 顺序把 Go 与 C/C++ 列为后续候选。
本轮按同一架构追加这两门，不改变检视主体、不新增语言分支：

- 语言能力只作用于 `review.get_symbol` / `review.find_references` /
  `review.get_call_chain`；
- `codeintel.languages` 缺省仍为 `"auto"`（升级后自动扩语言）；
- Java / TypeScript / Python 的输出字节与既有测试断言保持不变。

### 已实测前提

- `tree-sitter-go@0.25.0` 自带 `tree-sitter-go.wasm`；
- `tree-sitter-cpp@0.23.4` 自带 `tree-sitter-cpp.wasm`；
- 两包的原生 build script 不需要执行（只加载 wasm），因此在
  `pnpm-workspace.yaml` 的 `allowBuilds` 中登记为 `false`，避免 `pnpm` 的
  ignored-builds 报错；
- `web-tree-sitter@0.27.0` 可同时装载全部语法，parser 按「包/文件」memoize
  （`codeintel/wasm.ts`），未启用语言永不触碰 wasm。

## Decision

### 1. 两个语言 id

| id | displayName | globs | moduleLabel | 模块名来源 |
|---|---|---|---|---|
| `go` | Go | `*.go` | `package` | 文件头 `package X`（词法预读 + AST 双通道） |
| `cpp` | C/C++ | `*.c` `*.h` `*.cc` `*.cpp` `*.cxx` `*.hpp` `*.hh` `*.hxx` | `""` | 无（namespace 是符号，不是模块） |

C/C++ **只登记一个 `cpp` id**（ADR-0041 已定口径）：C 是 C++ 的子集，`.c/.h` 走
`tree-sitter-cpp`；不拆 `c` / `cpp` 两个 id 制造双份引用检索与双份配置项。
`.h` 的归属天然有歧义（C / C++ / Objective-C），按 C++ 语法解析是名字级模型的
可接受选择；语法错误会由 `parseError` 留痕，不静默丢弃。

### 2. Go extractor（`zoneb/extractors/go.ts`）

覆盖范围（测量常量面，名字级、无类型解析）：

- 顶层 `package` / `type` / `const` / `var` / `function` / `method`；
- `type_spec`：`struct` / `interface` / 命名类型；`type_alias`（`type ID = int`）
  以 `alias` 修饰符区分；
- struct 字段：一行多名字（`X, Y int`）、嵌入字段（`Embedded` / `*PointerEmbedded`
  取类型末段为字段名）、函数类型字段；
- interface 方法（`method_elem`）；
- 分组声明（`type ( … )` / `const ( … )` / `var ( … )`）按 spec 摊平；
- 方法接收者（`func (g *Greeter) …`）把 `Greeter` 写入 `owner`——Go 没有类型包裹
  节点，这正是 ADR-0041 预留 `owner` 的场景；
- 调用点：`call_expression`（`foo()` / `obj.foo()` 取被调名字）。

模块名 = 文件头 `package X`：`moduleNameFromHeader` 做词法预读，
extractor 从 AST 再取一次，两者同一语义；`package main` 也会展示为
`(package main)`。

### 3. C/C++ extractor（`zoneb/extractors/cpp.ts`）

覆盖范围（名字级、无类型解析）：

- 顶层与 namespace：`namespace`（含 `namespace a::b` 的嵌套说明符）、
  `class` / `struct` / `union` / `enum`、`typedef`、`using` alias、
  `template_declaration`（摊平其内部声明）、函数定义与声明；
- 类成员：方法原型 / 内联定义、构造 / 析构、字段（一行多声明符）、
  access specifier（class 缺省 `private`，struct / union 缺省 `public`）记为修饰符；
- 类外定义（`int Point::sum() const`）把限定作用域写入 `owner`；
- 构造器判定：析构名（`~T`）、或名字等于所属简单类型名且无返回类型；
- 调用点：`call_expression`（`f()` / `obj.f()` / `p->f()` / 模板函数）与
  `new_expression`；`new int(3)` 以类型名 `int` 计一次调用点。

`union` 在 `SymbolKind` 没有独立种类，按 `struct` 处理（成员容器语义相同）。
模板参数本身不建符号；模板声明里的函数 / 类正常提取。

### 4. 注册表与依赖

- `codeintel/language-support.ts` 的 `CodeLanguageId` 追加 `"go" | "cpp"`；
- 新增 `codeintel/go-parser.ts` / `codeintel/cpp-parser.ts`，只做
  `createGrammarParser(<label>, <package>, <wasm>)` 的薄封装；
- 新增依赖精确锁：`tree-sitter-go@0.25.0`、`tree-sitter-cpp@0.23.4`
  （`tree-sitter-c` 是 `tree-sitter-cpp` 的传递依赖，不直接使用）；
- `pnpm-workspace.yaml` 的 `allowBuilds` 增加 `tree-sitter-c` / `tree-sitter-cpp` /
  `tree-sitter-go: false`（只加载 wasm，不跑原生构建脚本）。

### 5. 扫描与调用链

- `codeintel.excludeGlobs` 缺省集不变；Go / C/C++ 的构建产物目录（`build/`、
  `out/` 等）已被覆盖；
- `supportsInvocations = true`：两门语言都提取调用点，Call Chain 的 Callees 段
  与既有语言同构；
- 整行注释过滤沿用 `["//", "/*", "*"]`（两门语言都是 C 系注释）。

### 6. 版本

新增能力走 **minor**：`0.3.0 → 0.4.0`；`packages/review-pi/package.json` 与
`src/shared/version.ts` 同改，由 `version.test.ts` 把守。

## Consequences

**收益**

- Go 与 C/C++ 仓首次获得真实符号 / 引用 / 调用链能力，而不是「看起来坏了」；
- 加语言仍是一个 extractor + 一行注册 + 一组测试，核心层没有语言分支；
- 方法 / 类外定义的归属通过 `owner` 正确进入 `qualifiedName`，Call Chain 不会
  把 `Point::sum` 记成命名空间成员。

**代价 / 风险**

- 名字级精度天花板不变：重载 / override / 模板特化 / 宏展开不分辨；
- C 与 C++ 共用语法：纯 C 的旧式 K&R 声明、Objective-C 头文件可能落入
  `parseError` 留痕；
- Go 的泛型实例化与 C++ 模板实例不建独立符号（只保留声明形态）；
- C++ 的 preprocessor 宏不展开：由宏生成的方法 / 类型不可见；
- `"auto"` 扩语言会让工具输出的语言标签与文件数变化，测试夹具需随版本更新。

**验证**

- `pnpm --filter review-pi typecheck` / `pnpm --filter review-pi build` exit 0；
- 新增 `zoneb/extractors/go.test.ts` / `cpp.test.ts`（结构、owner、调用点、签名渲染、
  parseError）；
- 多语言夹具新增 `service/cmd/main.go` 与 `native/src/math.cpp`，
  `language-support.test.ts` / `repo-context.test.ts` 的 id / glob / label /
  detectedLanguages 断言同步更新；
- Java 仓工具输出保持既有字节（`across N Java file(s)`、`(default package)`、
  Java 解析器失败文案不变）。
