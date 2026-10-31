# Third-Party Notices

## pi (Earendil Works / Mario Zechner)

本仓库 vendored 了 [pi](https://github.com/earendil-works/pi) 代码仓的以下部分，
以源码形态定制（非 npm 包消费）：

- `packages/ai`（`@earendil-works/pi-ai` → 本仓发布名 `@review-agent-pi/pi-ai`）
- `packages/agent`（`@earendil-works/pi-agent-core` → 本仓发布名 `@review-agent-pi/pi-agent-core`）
- `packages/chord`（`@earendil-works/chord` → 本仓发布名 `@review-agent-pi/chord`）
- `packages/telemetry`（`@earendil-works/pi-telemetry` → 本仓发布名 `@review-agent-pi/pi-telemetry`）
- `tsconfig.base.json`（仓库根，被上述包的 `tsconfig.build.json` 以 `../../tsconfig.base.json` 引用）

**发布名与出处**（ADR-0028）：上述四包经源码定制后以 `@review-agent-pi/*` 发布到 npm；上游原名 `@earendil-works/*` 仅用于履约与出处对照，不代表上游对本仓发布物的背书。发布物是 MIT 许可下的修改版；本文件随 `review-pi` tarball 一起分发（`prepack` 从仓根复制），四个内核包的 tarball 各自保留上游 `license: MIT` 与仓库出处字段。

**上游锚定**：commit `6671c604766b3670ed95f405aa7856835d0ca702`（2026-09-16，发布版 v0.85.1 之后 11 天的 main 修复）。
裁剪、workspace 接线与构建脚本改动见 `docs/design/Pi 内核定制基线方案.md`；与上游的同步以
`git diff` 对照上游锚定为基线操作。

**数据文件出处**：`packages/ai/src/providers/data/*.json`（39 个 provider 模型数据，上游
gitignore 不入库、由 `generate-models.ts` 网络生成）提取自 npm 发布物 `@earendil-works/pi-ai@0.85.1`
tarball 的 `dist/providers/data`；与锚定源码的一致性由上游 `check:model-data` 脚本校验通过
（v0.85.1..锚定 commit 之间无任何 `*.models.ts` 变更）。

### License

```
MIT License

Copyright (c) 2025 Mario Zechner

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
