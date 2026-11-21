# iter20 迭代集

来源：91 条交集，每语言 2 条（一正一负）。

| 语言 | instance | 仓库 | GT | 基线命中 | 生成 | 耗时 | OCR 覆盖 |
|---|---|---|---:|---:|---:|---:|---:|
| C | lvgl__lvgl@9cce37c | lvgl/lvgl | 3 | 2 | 5 | 115 | 1 |
| C | libsdl-org__SDL@1526727 | libsdl-org/SDL | 2 | 0 | 12 | 177 | 0 |
| C# | PowerShell__PowerShell@ea07b93 | PowerShell/PowerShell | 3 | 1 | 4 | 133 | 1 |
| C# | ppy__osu@748ab3d | ppy/osu | 4 | 0 | 10 | 355 | 0 |
| C++ | FreeCAD__FreeCAD@39c5968 | FreeCAD/FreeCAD | 5 | 1 | 4 | 249 | 0 |
| C++ | bitcoin__bitcoin@e98c51f | bitcoin/bitcoin | 3 | 0 | 18 | 1121 | 1 |
| Go | ollama__ollama@af112d6 | ollama/ollama | 5 | 2 | 10 | 167 | 1 |
| Go | gofr-dev__gofr@b9cdcbb | gofr-dev/gofr | 2 | 0 | 0 | 112 | 0 |
| Java | alibaba__spring-ai-alibaba@3555a95 | alibaba/spring-ai-alibaba | 2 | 2 | 8 | 113 | 2 |
| Java | keycloak__keycloak@805c204 | keycloak/keycloak | 6 | 0 | 11 | 584 | 1 |
| JavaScript | bluewave-labs__Checkmate@29e03a6 | bluewave-labs/Checkmate | 7 | 2 | 10 | 113 | 3 |
| JavaScript | sveltejs__svelte@44bec4c | sveltejs/svelte | 4 | 0 | 0 | 178 | 0 |
| PHP | filamentphp__filament@d47632c | filamentphp/filament | 2 | 2 | 4 | 113 | 0 |
| PHP | filamentphp__filament@871ec75 | filamentphp/filament | 3 | 0 | 3 | 141 | 0 |
| Python | browser-use__browser-use@0b21e50 | browser-use/browser-use | 1 | 1 | 4 | 96 | 1 |
| Python | infiniflow__ragflow@a63caa1 | infiniflow/ragflow | 6 | 0 | 0 | 104 | 2 |
| Rust | linera-io__linera-protocol@3535ddb | linera-io/linera-protocol | 5 | 3 | 4 | 122 | 2 |
| Rust | astral-sh__uv@61b521f | astral-sh/uv | 1 | 0 | 1 | 78 | 0 |
| TypeScript | cline__cline@2195a68 | cline/cline | 7 | 2 | 6 | 115 | 2 |
| TypeScript | google-gemini__gemini-cli@e7ed0a4 | google-gemini/gemini-cli | 1 | 0 | 5 | 111 | 0 |

## 覆盖

- 语言：{'C': 2, 'C#': 2, 'C++': 2, 'Go': 2, 'Java': 2, 'JavaScript': 2, 'PHP': 2, 'Python': 2, 'Rust': 2, 'TypeScript': 2}
- GT context：{'Diff Level': 37, 'File Level': 22, 'Repo Level': 13}
- GT category：{'Security Vulnerability': 10, 'Maintainability and Readability': 15, 'Code Defect': 42, 'Performance': 5}
- 单轮基线（复用已有 judge，未重跑 3 轮）：P 0.1513 / R 0.2639 / B 0.1923
- 评审耗时合计 4296s；最长 1121s
- OCR 参考：P 0.1829 / R 0.2361 / B 0.2061
