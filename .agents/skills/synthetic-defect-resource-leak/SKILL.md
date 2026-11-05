---
name: synthetic-defect-resource-leak
description: Inject a known resource-leak defect (GEN-RES-001) into a copy of the multilang testdata fixture, run a real review-pi review with the general-code-review rule pack, and archive diff/findings/audit/verdict under repo-diff-skill-result/. Use when the user wants a cheap, fully controlled synthetic bug test, asks for "合成缺陷注入" / "资源泄漏检视测试", or wants to check whether the reviewer and a rule pack catch a planted defect.
---

# 合成缺陷注入：资源未释放

在 testdata 夹具仓的临时副本里**新增一个会泄漏文件句柄的 Go 文件**，把“问题”做成待检视 diff，
然后真实调用 review-pi + `general-code-review` 规则包，最后归档到
`repo-diff-skill-result/synthetic-defect-resource-leak/<时间戳>/`。

默认缺陷：`GEN-RES-001`（Resource not released on the error path）——`os.Open` 之后没有任何
`Close` / `defer Close`，成功路径和错误路径都会泄漏文件描述符。

## 什么时候用

- 想用**完全可控**的注入缺陷验证 reviewer 的检出链路（不依赖真实 CVE / 外部仓库）。
- 想同时验证「规则包是否被装载、规则 id 是否被引用」。
- 需要一个便宜、可重复、可归档的回归样例。

真实漏洞请用 `real-defect-url-injection`。

## 运行

```bash
node .agents/skills/synthetic-defect-resource-leak/scripts/run.mjs
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--fixture <dir>` | 换一个底座仓库（默认 `packages/review-pi/testdata/repos/multilang`） |
| `--model <id>` | 覆盖 `PiAgent.jsonc` 的 `model.default` |
| `--out <dir>` | 覆盖归档目录 |
| `--no-rule-skill` | 不装载规则包，测纯检视 |
| `--dry-run` | 只构造 diff 和真值，不调用模型 |
| `--keep-temp` | 保留临时 base/defect 副本 |
| `--fail-on-miss` | 未捕获时 exit 2（默认 exit 0） |

前置条件：

1. `reviewer.apiKey` 已配置（`review-pi config show` 显示 `set`）；
2. `packages/review-pi/dist/` 已构建；
3. 夹具仓存在，且规则包目录存在（除非 `--no-rule-skill`）。

## 它做了什么

1. 复制夹具仓为 `base`（干净底座）与 `defect`（注入缺陷）；
2. 在 `defect/service/cmd/config.go` 写入故意不关闭文件的 Go 代码；
3. `git diff --no-index base defect` 生成标准 unified diff（新文件）；
4. 用 `--repo base` 真跑 `review-pi review --rule-skill <general-code-review>`；
5. 按注入文件 / 行范围 / `GEN-RES-001` / 关键词判定命中；
6. 归档并清理临时目录（除非 `--keep-temp`）。

注入代码（节选）：

```go
func ReadConfig(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	// 没有 defer file.Close()，也没有任何 Close 调用
	...
}
```

## 归档结构

```text
repo-diff-skill-result/synthetic-defect-resource-leak/<YYYYMMDD-HHmmss>/
  defect.diff          # 新增 config.go 的待检视 diff
  ground-truth.json    # 注入文件、行范围、规则 id、关键词
  meta.json            # 模型、规则包、命令、耗时、diff sha256
  stdout.json
  stderr.log
  result/
    runs/reviews_en.json
    runs/reviews_tips_zh.json
    runs/run.json
    runs/session-*.json
    audit/*.json
  verdict.json
  verdict.md
```

## 读结果

先看 `verdict.md`：

- `捕获` = 至少一条 finding 命中 `service/cmd/config.go` 的行范围，或同时命中该文件与
  `close|leak|resource|descriptor|handle|defer|file` 关键词，或引用了 `GEN-RES-001`；
- 未捕获时先看 `run.json` 的 `truncated` 与 `audit` 里的工具调用，再判断是模型没发现还是链路没跑到；
- `result/runs/reviews_en.json` 是英文 findings 真源；`reviews_tips_zh.json` 只是核外投影。

## 边界

- 这是**单案合成缺陷**，不是评测集；不能据此给出召回率。
- 新文件只存在于 diff 的 new side，`get_file` 在 base 底座里读不到它；reviewer 需要靠 diff 本身取证。
- 真实模型调用会消耗额度；一次通常数分钟。
- 归档目录已被 `.gitignore` 忽略；不要把运行产物提交进仓库。
- 不要在这里打印或复制 `reviewer.apiKey`。
