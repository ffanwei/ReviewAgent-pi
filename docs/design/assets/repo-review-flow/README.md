# 全仓检视流程图

本目录保存 `docs/design/全仓扫描-方案与契约.md` 的流程图源文件与 PNG。

| 源文件 | 图片 | 内容 |
|---|---|---|
| `01-global.dot` | `01-global.png` | 全局流程：CLI → 枚举 / 分组 / 合成 → 组执行 → 合并 → MCP 上报 → 产物 |
| `02-enumerate.dot` | `02-enumerate.png` | 文件枚举与过滤链、跳过原因 |
| `03-grouping.dot` | `03-grouping.png` | 四种分组策略、双上限、大文件单文件成组（soloLarge）、组数护栏 |
| `04-group-execution.dot` | `04-group-execution.png` | 单组六阶段、语言清单 / Skill、路径修复、覆盖回填、逐文件上报 |
| `05-six-phases-skills.dot` | `05-six-phases-skills.png` | 六阶段顺序、Phase 5 快照、规则 Skill 独立会话与候选合并 |
| `06-repo-token-strategy.dot` | `06-repo-token-strategy.png` | 全仓 token 策略：一次快照、单轮、工具预算、缓存、Skill 复用与全局闸 |

## 重新渲染

依赖 [Graphviz](https://graphviz.org/)（本仓验证版本 8.1.0）。`.dot` 里写的是
`Microsoft YaHei`（Windows 自带）；Linux 需安装中文字体（如 Noto Sans CJK SC）
并把各 `fontname` 改成实际字体名，否则中文会缺字。

```bash
cd docs/design/assets/repo-review-flow
for f in 01-global 02-enumerate 03-grouping 04-group-execution 05-six-phases-skills 06-repo-token-strategy; do
  dot -Tpng -Gdpi=150 "$f.dot" -o "$f.png"
done
```

修改流程时请同时更新 `.dot` 与 `.png`，并在设计文档中核对图注是否仍准确。
