---
name: real-defect-url-injection
description: Replay a real, historically fixed URL-injection defect (default VUL4J-38 / CVE-2014-4172) as a defect-introducing diff against its post-fix repo snapshot, run a real review-pi review with the configured model, and archive diff/findings/audit/verdict under repo-diff-skill-result/. Use when the user wants to prove the reviewer catches a known real vulnerability, asks for "真实缺陷回放", or wants a ground-truth evaluation rather than a synthetic bug.
---

# 真实缺陷回放：URL 参数注入

把一条**真实修复过的漏洞**回放成待检视的 diff，让 review-pi 真跑一次模型检视，最后把证据落到
`repo-diff-skill-result/real-defect-url-injection/<时间戳>/`。

默认案例：`VUL4J-38` / `CVE-2014-4172`（apereo/java-cas-client，CWE-74 URL 参数注入）。
真值来自 `data/vul4j/materialized-cases.json`；底座来自 `.cache/datasets/vul4j-repos/` 的已物化快照，
**不联网、不改被检视仓库**。

## 什么时候用

- 要回答「review-pi 到底能不能发现一个已知真实漏洞」。
- 需要可核查的 ground truth（CVE / CWE / 修复提交 / 位置），而不是自己编的 bug。
- 回归 reviewer 的检出能力，且希望结果可归档、可复跑。

不要用它替代完整 MR 检视；它只测「缺陷 → diff → findings」这一条链路。

## 运行

```bash
node .agents/skills/real-defect-url-injection/scripts/run.mjs
```

常用参数：

| 参数 | 说明 |
|---|---|
| `--case VUL4J-38` | 换一条 `materialized-cases.json` 里的案例（需已有 `.cache` 快照） |
| `--model <id>` | 覆盖 `PiAgent.jsonc` 的 `model.default` |
| `--out <dir>` | 覆盖归档目录（默认仓根 `repo-diff-skill-result/...`） |
| `--rule-skill <dir>` | 额外装载规则包（默认不装，测纯检视） |
| `--dry-run` | 只构造 diff 和真值，不调用模型 |
| `--keep-temp` | 保留临时 fixed/defect 副本，便于人工比对 |
| `--fail-on-miss` | 未捕获时 exit 2（默认 exit 0，判定写在 verdict 里） |

前置条件：

1. `node packages/review-pi/bin/review-pi.js config show` 中 `reviewer.apiKey` 为 `set`；
2. `packages/review-pi/dist/` 已构建（`pnpm --filter review-pi build`）；
3. `data/vul4j/materialized-cases.json` 与 `.cache/datasets/vul4j-repos/<case>/` 存在。

## 它做了什么

1. 复制修复后仓库为 `fixed`（干净底座）与 `defect`（回滚修复）；
2. 对 `defect` 执行 `git apply -R`，把真实修复补丁反转为“重新引入漏洞”；
3. `git diff --no-index fixed defect` 生成标准 unified diff；
4. 用 `--repo fixed` 真跑 `review-pi review`（真实模型、真实计费）；
5. 按真值位置 / 关键词 / 规则 id 判定 findings 是否命中；
6. 归档并清理临时目录（除非 `--keep-temp`）。

## 归档结构

```text
repo-diff-skill-result/real-defect-url-injection/<YYYYMMDD-HHmmss>/
  defect.diff          # 待检视的“重新引入漏洞”diff
  ground-truth.json    # CVE/CWE、修复提交、真值位置、关键词
  meta.json            # 模型、命令、耗时、diff sha256
  stdout.json          # review-pi stdout（JSON 文档）
  stderr.log           # 进度 / 诊断（不含 API key）
  result/
    runs/reviews_en.json       # 英文 findings（真源）
    runs/reviews_tips_zh.json  # 中文建议（若配置了呈现引擎）
    runs/run.json              # RunRecord
    runs/session-*.json        # 转录
    audit/*.json               # 审计（含脱敏配置快照）
  verdict.json         # 机器可读判定
  verdict.md           # 人读摘要：捕获/未捕获、命中表、复现命令
```

## 读结果

先看 `verdict.md`：

- `判定：捕获` 表示至少一条 finding 命中真值位置，或命中文件 + 注入/编码类关键词；
- `命中方式` 会写明是 `location`、`rule` 还是 `file+keyword`，不要只看结论；
- `全部 findings` 表保留未命中项，方便判断误报与漏报。

想复核模型看到的内容，直接读 `defect.diff` 和 `result/runs/session-*.json`。

## 边界

- 真实缺陷需要真实历史与真实修复提交，因此底座用 `.cache/datasets/vul4j-repos/` 的已物化快照；
  testdata 干净夹具无法承载「真实缺陷」，合成缺陷请用 `synthetic-defect-resource-leak`。
- 这是**单案的缺陷回放**，不是完整评测集；结论不能外推成召回率。
- `truth.locations` 来自数据集，个别行号可能指向修复改动行而非纯缺陷行；判定已用容差 + 关键词兜底。
- 真实模型调用会消耗额度；一次通常数分钟。批量跑请自行控制频率。
- 归档目录已在 `.gitignore` 中忽略；不要把运行产物提交进仓库。
- 不要在这里打印或复制 `reviewer.apiKey`；归档只应出现 review-pi 审计里的 `set/missing`。
