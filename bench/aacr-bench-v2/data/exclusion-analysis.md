# AACR-Bench v2 排除样本特征

## ok（108 条 / GT 676）

- 语言：{'Python': 16, 'Go': 14, 'TypeScript': 15, 'Rust': 5, 'Java': 12, 'C++': 14, 'JavaScript': 8, 'PHP': 5, 'C': 13, 'C#': 6}
- 仓库：{'browser-use/browser-use': 3, 'gofr-dev/gofr': 6, 'ollama/ollama': 4, 'cline/cline': 5, 'unionlabs/union': 1, 'immich-app/immich': 5, 'google-gemini/gemini-cli': 5, 'infiniflow/ragflow': 4, 'langflow-ai/langflow': 2, 'kestra-io/kestra': 3, 'microsoft/typescript-go': 3, 'vllm-project/vllm': 4, 'FreeCAD/FreeCAD': 3, 'comfyanonymous/ComfyUI': 3, 'openai/codex': 1, 'bluewave-labs/Checkmate': 2, 'linera-io/linera-protocol': 2, 'filamentphp/filament': 3, 'sveltejs/svelte': 2, 'mpv-player/mpv': 4, 'ClickHouse/ClickHouse': 5, 'libsdl-org/SDL': 2, 'dotnet/aspnetcore': 3, 'ppy/osu': 1, 'alibaba/spring-ai-alibaba': 2, 'lvgl/lvgl': 2, 'keycloak/keycloak': 2, 'nodejs/node': 1, 'timescale/timescaledb': 3, 'appwrite/appwrite': 1, 'facebook/react': 2, 'elastic/elasticsearch': 5, 'PowerShell/PowerShell': 2, 'electron/electron': 3, 'valkey-io/valkey': 2, 'symfony/symfony': 1, 'astral-sh/uv': 1, 'mrdoob/three.js': 1, 'opencv/opencv': 2, 'bitcoin/bitcoin': 1, 'mudler/LocalAI': 1}
- 改动行数：min=5 median=136.5 max=971
- GT context：{'File Level': 241, 'Repo Level': 127, 'Diff Level': 308}
- GT category：{'Code Defect': 457, 'Maintainability and Readability': 119, 'Performance': 69, 'Security Vulnerability': 31}
- AI 评论占比：0.769

## skipped（30 条 / GT 186）

- 语言：{'C++': 9, 'Python': 2, 'Go': 3, 'C': 2, 'TypeScript': 4, 'JavaScript': 1, 'C#': 2, 'Java': 6, 'Rust': 1}
- 仓库：{'FreeCAD/FreeCAD': 5, 'langflow-ai/langflow': 2, 'microsoft/typescript-go': 2, 'lvgl/lvgl': 2, 'cline/cline': 2, 'mrdoob/three.js': 1, 'ClickHouse/ClickHouse': 2, 'google-gemini/gemini-cli': 1, 'ppy/osu': 1, 'elastic/elasticsearch': 6, 'bitcoin/bitcoin': 2, 'juspay/hyperswitch': 1, 'ollama/ollama': 1, 'immich-app/immich': 1, 'dotnet/aspnetcore': 1}
- 改动行数：min=5 median=138.5 max=862
- GT context：{'Diff Level': 78, 'File Level': 78, 'Repo Level': 30}
- GT category：{'Code Defect': 100, 'Performance': 25, 'Maintainability and Readability': 55, 'Security Vulnerability': 6}
- AI 评论占比：0.774

| instance | repo | lang | reason | change_lines | GT | diff_chars | top diff blocks |
|---|---|---|---|---:|---:|---:|---|
| elastic__elasticsearch@761281a | elastic/elasticsearch | Java | diff-too-large | 142 | 3 | 17037817 | x-pack/plugin/inference/qa/inference-service-tests/src/javaRestTest/resources/multilingual-e5-small.vocab.json (11437299), x-pack/plugin/inference/qa/inference-service-tests/src/javaRestTest/resources/rerank-v1.vocab.json (2648130), x-pack/plugin/inference/qa/inference-service-tests/src/javaRestTest/resources/elser_model_2.vocab.json (329851) |
| bitcoin__bitcoin@724546e | bitcoin/bitcoin | C++ | diff-too-large | 34 | 4 | 6629932 | src/chainparamsseeds.h (571719), src/secp256k1/src/wycheproof/ecdh_secp256k1_test.json (515394), src/secp256k1/src/wycheproof/ecdh_secp256k1_test.h (305853) |
| mrdoob__three.js@96ab072 | mrdoob/three.js | JavaScript | diff-too-large | 61 | 1 | 5288661 | build/three.webgpu.min.js (1050373), build/three.webgpu.nodes.min.js (1049329), build/three.core.min.js (740840) |
| langflow-ai__langflow@b1cbdba | langflow-ai/langflow | Python | diff-too-large | 22 | 3 | 4750663 | docs/package-lock.json (967144), uv.lock (658292), src/frontend/package-lock.json (555706) |
| bitcoin__bitcoin@4ba2e48 | bitcoin/bitcoin | C++ | diff-too-large | 135 | 1 | 6290316 | src/chainparamsseeds.h (571717), src/secp256k1/src/wycheproof/ecdh_secp256k1_test.json (515327), src/qt/locale/bitcoin_en.xlf (354917) |
| microsoft__typescript-go@45c0de9 | microsoft/typescript-go | Go | diff-too-large | 47 | 1 | 7305845 | package-lock.json (311364), internal/bundled/libs/lib.dom.d.ts (261936), testdata/baselines/reference/submodule/compiler/typedArrays.types (92464) |
| immich-app__immich@9032c7e | immich-app/immich | TypeScript | diff-too-large | 253 | 6 | 5109376 | machine-learning/uv.lock (912798), i18n/sr_Cyrl.json (197654), web/package-lock.json (163985) |
| elastic__elasticsearch@a9973f6 | elastic/elasticsearch | Java | diff-too-large | 229 | 4 | 3685750 | libs/simdvec/output.txt (342267), x-pack/plugin/inference/src/test/resources/org/elasticsearch/xpack/inference/highlight/sample-doc.json (142265), x-pack/plugin/esql/src/test/java/org/elasticsearch/xpack/esql/optimizer/PhysicalPlanOptimizerTests.java (93244) |
| ClickHouse__ClickHouse@f9d51fa | ClickHouse/ClickHouse | C++ | diff-too-large | 166 | 4 | 3476359 | src/Client/BuzzHouse/Proto/SQLGrammar.proto (102029), src/Client/BuzzHouse/Generator/ServerSettings.cpp (95936), docs/changelogs/v25.5.1.2782-stable.md (93305) |
| ollama__ollama@0b52f18 | ollama/ollama | Go | diff-too-large | 132 | 3 | 5386123 | integration/testdata/embed.json (640539), ml/backend/ggml/ggml/src/ggml-cpu/ggml-cpu.c (497166), llama/llama.cpp/src/llama-model.cpp (462389) |
| microsoft__typescript-go@100dbc5 | microsoft/typescript-go | Go | diff-too-large | 829 | 3 | 5056336 | testdata/baselines/reference/submodule/compiler/resolvingClassDeclarationWhenInBaseTypeResolution.errors.txt.diff (140467), testdata/baselines/reference/submodule/compiler/resolvingClassDeclarationWhenInBaseTypeResolution.errors.txt (139149), internal/ast/ast.go (88990) |
| FreeCAD__FreeCAD@eb761fd | FreeCAD/FreeCAD | C++ | diff-too-large | 672 | 14 | 4888344 | src/Mod/Drawing/DrawingPatterns.py (220897), src/Mod/Drawing/Templates/A3_Landscape.svg (128848), src/App/Document.cpp (108629) |
| lvgl__lvgl@a0067e3 | lvgl/lvgl | C | diff-too-large | 109 | 1 | 4904883 | demos/smartwatch/assets/img_custom_preview.c (257838), demos/smartwatch/assets/img_digital_preview.c (257811), demos/smartwatch/assets/img_lvgl_logo_icon.c (151379) |
| elastic__elasticsearch@5e604e4 | elastic/elasticsearch | Java | diff-too-large | 289 | 8 | 2734625 | x-pack/plugin/esql/src/main/java/org/elasticsearch/xpack/esql/parser/EsqlBaseParser.java (212234), x-pack/plugin/esql/src/main/java/org/elasticsearch/xpack/esql/parser/EsqlBaseLexer.java (212113), x-pack/plugin/esql/src/main/java/org/elasticsearch/xpack/esql/parser/EsqlBaseLexer.interp (127760) |
| FreeCAD__FreeCAD@a050e42 | FreeCAD/FreeCAD | C++ | diff-too-large | 862 | 14 | 3971867 | pixi.lock (288705), src/3rdParty/json/single_include/nlohmann/json.hpp (283955), src/Mod/Sketcher/Gui/CommandCreateGeo.cpp (111757) |
| FreeCAD__FreeCAD@ec3da2e | FreeCAD/FreeCAD | C++ | diff-too-large | 80 | 3 | 3986292 | src/Doc/BuildWebDoc.cfg.in (106129), src/Mod/Sketcher/App/planegcs/GCS.cpp (62627), src/Mod/Part/App/TopoShape.pyi (40591) |
| google-gemini__gemini-cli@6fd8269 | google-gemini/gemini-cli | TypeScript | diff-too-large | 300 | 10 | 1685744 | packages/vscode-ide-companion/package-lock.json (178987), packages/core/package-lock.json (167738), package-lock.json (134536) |
| cline__cline@cb4d5c9 | cline/cline | TypeScript | diff-too-large | 11 | 3 | 1507668 | webview-ui/package-lock.json (978654), package-lock.json (473800), src/core/Cline.ts (114277) |
| elastic__elasticsearch@2adcb2d | elastic/elasticsearch | Java | diff-too-large | 106 | 4 | 1794661 | server/src/test/java/org/elasticsearch/search/vectors/AbstractIVFKnnVectorQueryTestCase.java (49323), modules/transport-netty4/src/test/java/org/elasticsearch/http/netty4/Netty4HttpHeaderValidatorTests.java (42782), x-pack/plugin/ccr/src/javaRestTest/java/org/elasticsearch/xpack/ccr/AutoFollowIT.java (33747) |
| elastic__elasticsearch@e38d20c | elastic/elasticsearch | Java | diff-too-large | 465 | 4 | 2089692 | x-pack/plugin/esql/src/main/java/org/elasticsearch/xpack/esql/parser/EsqlBaseLexer.java (170777), x-pack/plugin/esql/src/main/java/org/elasticsearch/xpack/esql/parser/EsqlBaseLexer.interp (117657), x-pack/plugin/esql/src/main/java/org/elasticsearch/xpack/esql/parser/EsqlBaseParser.java (103534) |
| lvgl__lvgl@4a57db3 | lvgl/lvgl | C | diff-too-large | 29 | 5 | 2897678 | src/font/lv_font_source_han_sans_sc_16_cjk.c (1242972), src/font/lv_font_source_han_sans_sc_14_cjk.c (1038915), src/drivers/display/ft81x/lv_ft81x_defines.h (33365) |
| FreeCAD__FreeCAD@e596925 | FreeCAD/FreeCAD | C++ | diff-too-large | 725 | 23 | 2734750 | src/Mod/BIM/importers/importSH3DHelper.py (109157), src/Mod/CAM/CAMTests/TestRefactoredTestPostGCodes.py (62676), src/Mod/Sketcher/App/SketchObject.cpp (55660) |
| FreeCAD__FreeCAD@870d7f5 | FreeCAD/FreeCAD | C++ | diff-too-large | 776 | 30 | 1565008 | pixi.lock (1002557), package/rattler-build/pixi.lock (325333), src/Gui/cet_lut.hpp (205666) |
| elastic__elasticsearch@5e318eb | elastic/elasticsearch | Java | diff-too-large | 689 | 3 | 1677015 | x-pack/plugin/esql/src/main/java/org/elasticsearch/xpack/esql/parser/EsqlBaseParser.java (225956), x-pack/plugin/esql/src/main/java/org/elasticsearch/xpack/esql/parser/EsqlBaseLexer.java (196997), x-pack/plugin/esql/src/main/java/org/elasticsearch/xpack/esql/parser/EsqlBaseLexer.interp (126543) |
| juspay__hyperswitch@0231de6 | juspay/hyperswitch | Rust | diff-too-large | 127 | 3 | 2415540 | crates/hyperswitch_connectors/src/connectors/nuvei/transformers.rs (103280), crates/hyperswitch_connectors/src/default_implementations.rs (94043), crates/hyperswitch_connectors/src/connectors/paysafe/transformers.rs (64676) |
| ClickHouse__ClickHouse@3143520 | ClickHouse/ClickHouse | C++ | diff-too-large | 531 | 12 | 1061709 | docs/en/operations/storing-data.md (62655), tests/integration/test_storage_iceberg/test.py (44506), src/Storages/ObjectStorage/DataLakes/Iceberg/ComplexTypeSchemaProcessorFunctions.cpp (35707) |
| cline__cline@7d18fb9 | cline/cline | TypeScript | diff-too-large | 63 | 8 | 1320444 | src/core/Cline.ts (101137), package-lock.json (97806), evals/cli/package-lock.json (91408) |
| langflow-ai__langflow@6239290 | langflow-ai/langflow | Python | diff-too-large | 387 | 5 | 1071124 | src/backend/tests/.test_durations (336695), src/backend/base/langflow/initial_setup/starter_projects/Vector Store RAG.json (194518), src/frontend/src/icons/ScrapeGraphAI/ScrapeGraphAI.jsx (180890) |
| ppy__osu@87697a7 | ppy/osu | C# | diff-too-large | 31 | 2 | 1421605 | osu.Game/Screens/SelectV2/Carousel.cs (35368), osu.Game.Tests/Visual/Online/TestSceneUserPanel.cs (18192), osu.Game/Screens/Edit/Submission/BeatmapSubmissionScreen.cs (18018) |
| dotnet__aspnetcore@2f372e8 | dotnet/aspnetcore | C# | no-reviewable-files | 5 | 1 | 1602 | src/SignalR/server/StackExchangeRedis/test/Docker.cs (1579) |

## failed（13 条 / GT 82）

- 语言：{'C++': 3, 'Python': 2, 'Java': 6, 'Rust': 1, 'C': 1}
- 仓库：{'ClickHouse/ClickHouse': 3, 'comfyanonymous/ComfyUI': 2, 'keycloak/keycloak': 4, 'astral-sh/uv': 1, 'elastic/elasticsearch': 2, 'valkey-io/valkey': 1}
- 改动行数：min=12 median=259 max=871
- GT context：{'Diff Level': 33, 'Repo Level': 16, 'File Level': 33}
- GT category：{'Code Defect': 49, 'Maintainability and Readability': 22, 'Performance': 9, 'Security Vulnerability': 2}
- AI 评论占比：0.744

| instance | repo | lang | reason | change_lines | GT | diff_chars | top diff blocks |
|---|---|---|---|---:|---:|---:|---|
| elastic__elasticsearch@902352a | elastic/elasticsearch | Java | failed | 160 | 1 | 1538596 |  |
| elastic__elasticsearch@a6a4623 | elastic/elasticsearch | Java | failed | 211 | 1 | 1306339 |  |
| valkey-io__valkey@8b2137d | valkey-io/valkey | C | failed | 540 | 7 | 1106802 |  |
| ClickHouse__ClickHouse@3eee886 | ClickHouse/ClickHouse | C++ | failed | 412 | 9 | 1091949 |  |
| ClickHouse__ClickHouse@cc96255 | ClickHouse/ClickHouse | C++ | failed | 871 | 8 | 0 |  |
| comfyanonymous__ComfyUI@cfc3122 | comfyanonymous/ComfyUI | Python | failed | 319 | 6 | 0 |  |
| keycloak__keycloak@79dbba9 | keycloak/keycloak | Java | failed | 122 | 8 | 0 |  |
| comfyanonymous__ComfyUI@4936d01 | comfyanonymous/ComfyUI | Python | failed | 323 | 5 | 0 |  |
| keycloak__keycloak@21d4538 | keycloak/keycloak | Java | failed | 714 | 15 | 0 |  |
| astral-sh__uv@ed57db2 | astral-sh/uv | Rust | failed | 113 | 6 | 0 |  |
| keycloak__keycloak@460f800 | keycloak/keycloak | Java | failed | 259 | 7 | 0 |  |
| ClickHouse__ClickHouse@fd6ba0c | ClickHouse/ClickHouse | C++ | failed | 12 | 5 | 0 |  |
| keycloak__keycloak@2373a48 | keycloak/keycloak | Java | failed | 176 | 4 | 0 |  |

