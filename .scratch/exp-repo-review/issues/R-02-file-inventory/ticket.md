# R-02 · 仓库文件枚举与过滤

- Status: DONE
- Branch: `exp-repo-review`
- Created: 2026-11-24

## 问题

全仓扫描没有 diff 文件清单，必须先确定性枚举「哪些文件值得检视」。

## 目标

- 遍历仓库快照，应用 exclude / ignore 规则；
- 识别二进制、生成物、lockfile、vendor、构建产物并默认跳过；
- 语言分类与单文件大小上限；
- 输出可审计清单：每个文件的状态（可检视 / 跳过）与跳过原因。

## 验收

- 同一快照两次枚举结果字节一致；
- 嵌套目录、符号链接、超大文件、非 UTF-8、空文件均有单测；
- 跳过原因可枚举、可汇总；
- 零模型完成，不发任何模型请求。

## 依赖

R-01 输入契约。

## 实现与验收证据（2026-11-24）

- 实现：`packages/review-pi/src/repo-spike/enumerate.ts`
  - git `ls-files -z` + `--others --exclude-standard`，非 git 仓库回退 walk；
  - 目录 / 文件名 / 后缀排除、源码扩展名白名单、8 KB 二进制嗅探、空文件、单文件字符上限、全局文件数上限；
  - `lstat` 不跟随符号链接，避免把仓库外文件带进检视范围；
  - 输出按路径排序，跳过项带固定原因。
- 单测：`enumerate.test.ts` 5 个用例（排序 / 原因、pathPrefix、maxFiles、两次枚举字节一致、符号链接）。
- dry-run 证据：`repo-spike --repo spring-ai-java --dry-run` → discovered=1607, selected=1607, groups=175, skipped=0。
- 局限：排除目录 / 后缀目前是代码常量，尚未提升为 `limits.repoScan.*` 配置；配置化列为 R-02b（不阻塞本轮评测）。

