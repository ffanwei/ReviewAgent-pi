# smoke10 快速验证集

## 基线

- 样本：10；GT：46；生成：44；命中 GT：13
- Precision 0.273 / Recall 0.283 / Balanced 0.278
- 单条耗时合计 1838s；最长 504s

## 选中的样本

| 语言 | instance | 仓库 | 改动行 | 耗时(s) | diff | GT | 命中 GT | 生成 | 命中生成 |
|---|---|---|---:|---:|---:|---:|---:|---:|---:|
| C | lvgl__lvgl@9cce37c | lvgl/lvgl | 67 | 115 | 5546 | 3 | 2 | 5 | 2 |
| C# | ppy__osu@748ab3d | ppy/osu | 27 | 355 | 29994 | 4 | 0 | 10 | 0 |
| C++ | opencv__opencv@79afad9 | opencv/opencv | 307 | 504 | 44550 | 14 | 4 | 13 | 3 |
| Go | gofr-dev__gofr@b9cdcbb | gofr-dev/gofr | 215 | 112 | 30262 | 2 | 0 | 0 | 0 |
| Java | alibaba__spring-ai-alibaba@3555a95 | alibaba/spring-ai-alibaba | 140 | 113 | 12016 | 2 | 2 | 8 | 2 |
| JavaScript | sveltejs__svelte@44bec4c | sveltejs/svelte | 326 | 178 | 10216 | 4 | 0 | 0 | 0 |
| PHP | filamentphp__filament@d47632c | filamentphp/filament | 6 | 113 | 747 | 2 | 2 | 4 | 2 |
| Python | infiniflow__ragflow@a63caa1 | infiniflow/ragflow | 11 | 104 | 4810 | 6 | 0 | 0 | 0 |
| Rust | linera-io__linera-protocol@3535ddb | linera-io/linera-protocol | 40 | 122 | 3577 | 5 | 3 | 4 | 3 |
| TypeScript | cline__cline@f098af0 | cline/cline | 165 | 122 | 11715 | 4 | 0 | 0 | 0 |
