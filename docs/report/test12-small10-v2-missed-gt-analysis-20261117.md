# test12 小 diff：v2 未覆盖 GT 的 session 归因

> 对象：v2（`exp-tools-pr-dedup2-20261117`，`ae8dab4`，收紧去重后的运行）。
> 数据：10 条小 diff，47 条 GT；v2 覆盖 16/47，未覆盖 31 条。
> 方法：把 31 条 GT 与 v2 的 Phase 1/4 输出、Phase 5 候选、Gate 拦截记录逐条对齐；
> 并检查 diff hunk 覆盖。

## 1. 先排除结构性原因

- **31 条 GT 全部落在 v2 的 diff hunk 内**，没有一条因 `findingScope` / 文件过滤被排除。
- v2 只有 **1 条** Gate 拦截记录：`ragflow` F002 的 `VERIFICATION_FAILED`，不是 `OUT_OF_SCOPE`。
- 因此 recall 损失不是范围门造成的。

## 2. v2 比 OCR / 旧 baseline 少发现的 11 条

这 11 条是 OCR 或旧 baseline 至少一方覆盖、但 v2 未覆盖的 GT：

| 样本 | GT | 问题 | 谁覆盖 | v2 session 证据 | 归因 |
|---|---|---|---|---|---|
| `aspnetcore` | #3 | IPv6 scope ID 未处理 | arm2 | Phase 1 明写「（保留 scope id 的既有 TODO）」 | **看到了，判断为既有 TODO，主动不报** |
| `FreeCAD` | #1 | `Base::PyExc_*` 限定符被去掉 | arm2 | Phase 1 描述了 `PyExc_FC_*`；候选只报了 421 行异常名变化，未报限定符 | **看到了，报偏了另一个 PyExc 问题** |
| `alibaba` | #0 | `ACCESS_KEY_ID/SECRET` 缺服务前缀，易冲突 | OCR + arm2 | Phase 1 提到从环境变量读取这两个键，但无候选 | **看到改动，没识别命名冲突风险** |
| `filament` | #1 | `in_array` 对单列名应改 `===` | arm2 | 无相关候选/提及；候选集中在 79/153 行的排序问题 | **建议类，未生成候选** |
| `ragflow` | #4 | 串行 await 删除导致性能退化 | OCR | 候选 F001@442 已生成，Phase 6 以「旧代码 start_soon 传同步函数本就 TypeError、性能影响无量级证据」驳回 | **已报，被 Evidence Gate 驳回** |
| `linera` | #0 | `start >= received_log.count()` 需校验 | arm2 | Phase 4 明确核验 `read` 在 `start >= end` 时返回空 Vec，结论「不会 panic」 | **主动核验后判安全，不报** |
| `linera` | #3 | 恰好整除时多发一次查询 | OCR | 848 行候选报的是「缺少迭代上界，可无限循环」；未报 extra query | **同位置报了另一个问题** |
| `linera` | #4 | 常量应为 `pub(crate)` | arm2 | Phase 1 提到新增公开常量（带 TODO #4638），无候选 | **看到 `pub` 常量，未报封装建议** |
| `cline` | #0 | 校验后未清空 nonce | arm2 | AuthService.ts:33 候选已报「nonce 变实例常量，失去一次性绑定」，命中 GT#2 | **同一根因报在另一个文件** |
| `cline` | #1 | nonce 非一次性，可重放 | arm2 | 同上 | **同一根因报在另一个文件** |
| `cline` | #5 | `async` 关键字多余 | OCR | 无相关候选/提及 | **风格建议，未生成候选** |

分布：OCR 独有 3 条、旧 baseline 独有 7 条、两者都覆盖 1 条。

## 3. v2 未覆盖的全部 31 条 GT 归因

### 3.1 分类统计

| 类别 | 数量 | GT |
|---|---:|---|
| A. 被 Gate 拦截 | 1 | `ragflow` #4 |
| B. 同一根因报在别处，按文件匹配没算 | 2 | `cline` #0/#1 |
| C. 同文件/同位置报了另一个问题 | 6 | `valkey` #0、`FreeCAD` #1、`three.js` #1/#3、`filament` #0、`linera` #3 |
| D. 明确检查后判断安全 / 既有问题 | 3 | `aspnetcore` #3、`ragflow` #0、`linera` #0 |
| E. 建议/风格/重构类，不是新代码缺陷 | 8 | `FreeCAD` #0/#3/#4、`filament` #1、`ragflow` #5、`linera` #4、`cline` #5/#6 |
| F. Phase 1 描述了相关改动，但没生成候选（缺陷类） | 11 | `aspnetcore` #0/#1/#4、`FreeCAD` #2、`alibaba` #0、`three.js` #7、`ragflow` #2/#3、`linera` #1、`cline` #3/#4 |
| **合计** | **31** | |

### 3.2 关键判读

1. **不是「没读到代码」**：diff 全文在上下文里，31 条 GT 所在文件和行都在 hunk 内；Phase 1 的变更理解覆盖了绝大多数对应改动。
2. **主要问题是「读到了但没有转成候选」**：F 类 11 条 + E 类 8 条 + D 类 3 条 = 22 条，占 71%。其中 D 类是模型明确评估后决定不报（既有 TODO、`read` 安全），E 类是提示词主动压掉的建议类。
3. **C 类 6 条是「同位置报了另一个问题」**：模型把注意力放在同一 hunk 里更严重的缺陷上，GT 的另一个问题没有单独成条。
4. **A 类只有 1 条**：`ragflow` 的串行 await 性能问题确实生成了候选，被 Phase 6 以「证据不足」驳回；这是唯一一条「报了但被 Gate 拦掉」的 GT。
5. **B 类 2 条是评测口径问题**：`cline` 同一 nonce 复用根因在 GT 里被拆成 `AuthService.ts:33`、`controller/index.ts:461` 三处；v2 报了 AuthService 一处并命中 GT#2，另外两处按文件匹配无法计分。

### 3.3 值得注意的「伪缺陷」GT

以下 GT 不是「新代码引入的缺陷」，而是对改动本身的建议或确认；按第 2/4 条提示词主动不报，属于预期行为：

- `ragflow` #0：diff 实际是 `- list(sub_connect_graph.nodes)` → `+ list(sub_connect_graph)`，GT 描述的是被修掉的旧问题；模型把它识别为修复并写进 Phase 1。
- `FreeCAD` #0/#3/#4：lambda 参数类型、init-capture const、复用 `isNullOrEmpty()`，均属重构/一致性建议。
- `filament` #1：`in_array` → `===`，属效率/风格建议。
- `ragflow` #5：集合操作 idiom 一致性建议。
- `linera` #4：`pub` → `pub(crate)` 封装建议。
- `cline` #5：删除多余 `async`，纯风格。
- `cline` #6：校验逻辑去重，重构建议。

这 8 条按当前产品口径（只报缺陷、不报测试/文档/命名/格式类建议）不报是合理的；它们会计入 benchmark recall，但不计入产品价值。

## 4. 对 recall 的启示

1. **补 recall 的主战场是 F 类**（11 条，35%）：模型在 Phase 1 已经理解了改动，但没有把边界/失败场景转成候选。可在 Phase 5 增加「逐 hunk 边界检查」提示：对每个新增分支问一次空值、越界、类型、错误路径、资源释放。
2. **不建议为了 B/C 类改匹配或按多位置重复上报**：B 类是 benchmark 同一根因多处标注，C 类是同一 hunk 多问题；重复上报会拉低 precision。
3. **E 类不建议追**：建议/风格类 GT 与产品「只报缺陷」的口径冲突，追它们会把 P3 噪声放回来。
4. **A 类可复核**：`ragflow` #4 的 Phase 6 理由本身成立（旧代码 `start_soon` 传同步函数会 TypeError），但 benchmark 认为串行化仍是性能退化；这是口径差异，不是模型漏判。

## 5. 产物

- 逐 GT 原始分析：`C:\Users\Li\.claude\jobs\c7b993af\tmp\v2-missed-gt.json`
- v2 指标：`results/aacr_bench_v2_test12_small10/reviewpi/exp-tools-pr-dedup2-20261117/metrics_claude_20261117_202331.json`
