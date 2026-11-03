# Third-Party Notices

## pi (Earendil Works / Mario Zechner)

`review-pi` 以 **npm 依赖**消费 [pi](https://github.com/earendil-works/pi) 的四个包
（ADR-0035）：

- `@earendil-works/pi-ai`
- `@earendil-works/pi-agent-core`
- `@earendil-works/chord`
- `@earendil-works/pi-telemetry`

版本**精确锁定**在 `packages/review-pi/package.json`（四包同版本成套），安装时由
registry 提供、随 npm tarball 自带 `license: MIT` 与仓库出处字段。本仓不再 vendor
这四个包，也不再以 `@review-agent-pi/*` 的名义重新发布它们。

**上游版本**：`0.85.1`。判定过程（`0.86.1` → `0.86.0` → `0.85.1` 的顺序与失败原因）
记录在 ADR-0035 的「执行记录」；上游更新走「改版本号 + 跑门」，确需改内核时用
`pnpm patch`（ADR-0035 决策 5）。

**历史**：ADR-0028 时代这四包曾以源码形态 vendored 进仓（锚定 commit
`6671c604`，v0.85.1 后 11 天）并改名发布；ADR-0035 已废止该形态，相关定制与接线
方案保留在 `docs/design/Pi 内核定制基线方案.md` 作为历史记录。

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
