# Output contract

Everything here is derived from `review-pi` 0.6.x. If the CLI and this file
disagree, the CLI output wins.

## stdout — one JSON document

`review-pi review` writes exactly one JSON document to stdout. Diagnostics,
progress, parameter echo, and warnings go to stderr.

```json
{
  "ok": true,
  "caseId": "change-001",
  "runId": "20261031_101500_000",
  "truncated": false,
  "rounds": 5,
  "toolCalls": 23,
  "findings": [ "...Finding objects..." ],
  "auditPath": "C:\\Users\\me\\.PiAgent\\tasks\\change-001\\audit\\20261031_101500_000.json"
}
```

| Key | Meaning |
|---|---|
| `ok` | The review completed. `false` should not appear with exit 0 |
| `caseId` | Derived from the diff filename (extension removed) |
| `runId` | First model-request timestamp, also the audit filename stem |
| `truncated` | `true` = honest truncation by round/tool budget; findings are incomplete |
| `rounds` | Six-phase loop rounds used |
| `toolCalls` | Review-tool calls used |
| `findings` | The full finding list (same objects as `reviews_all.json`) |
| `auditPath` | Absolute path to the audit JSON |

Cost and token usage are **not** in stdout; read `run.json` / the audit
document if needed.

## Finding object

```json
{
  "id": "F001",
  "severity": "P1",
  "category": "安全",
  "file": "src/main/java/.../Foo.java",
  "line": 42,
  "title": "用户可控输入直接拼进查询串",
  "description": "……",
  "evidence": [
    "Foo.java:42 query = \"...\" + userInput;",
    "review.find_references \"userInput\" → ..."
  ],
  "rule": "GEN-SQL-001",
  "confidence": 0.86,
  "tips": {
    "review": "……[缺陷类型] …… 影响评估：……",
    "suggestion": "[重构思路] …… 代码示例：```...```",
    "subcategory": "SQL 注入"
  }
}
```

- `severity`: exactly `P0` `P1` `P2` `P3`.
- `category`: one of `可维护` `安全` `可靠性` `可测试性` `性能` `可移植` `可读性`.
- `file` / `line`: repository-relative POSIX path and 1-based line in the
  post-change file.
- `evidence`: concrete symbols, line numbers, or code excerpts. A finding
  without evidence is rejected by the review's evidence gate.
- `confidence`: 0–1. It is a confidence signal, not a severity.
- `tips`: Chinese-native narrative produced with the candidate (not a second
  model call). It is optional in storage but normalized before delivery.

**Language**: natural-language fields are Chinese by design (ADR-0090).
Structured fields (`id`, `severity`, `file`, `line`, `rule`, code excerpts)
stay English/verbatim. Translate for the user if needed; do not rewrite the
stored artifacts.

## `reviews_tips_zh.json`

Written under `<tasks-dir>/<taskId>/runs/` when at least one finding survives
the confidence/severity filters and has coverage. Top-level shape is a plain
array of file groups:

```json
[
  {
    "filePath": "src/a.ts",
    "reviewTips": [
      {
        "id": "F001",
        "code": "line 42 source text",
        "review": "……",
        "suggestion": "……",
        "category": "安全",
        "subcategory": "SQL 注入",
        "severity": "Major",
        "level": "Major",
        "ruleId": "GEN-SQL-001",
        "lineNum": 42,
        "source": "rule-reviewer",
        "confidence": "High"
      }
    ]
  }
]
```

- One entry per `file` + `line` (the first wins; later same-line findings are
  only in `reviews_all.json` / stdout).
- `severity` mapping: `P0→Fatal`, `P1→Major`, `P2→Minor`, `P3→Suggestion`.
- `source` is `rule-reviewer` for findings whose id starts with `RULE-CHECK@`,
  otherwise a model-source label.
- Filters (`limits.confidence.min`, `limits.severity.min`) affect tips and MCP
  reporting **only**; stdout / `reviews_all.json` stay complete.

## Artifacts

Given `--tasks-dir <root>` and `--taskId <id>`:

```text
<root>/<id>/
├── runs/
│   ├── run.json                 # RunRecord (usage, timing)
│   ├── reviews_all.json         # { generatedAt, runId, caseId, model, findings, ... }
│   ├── reviews_tips_zh.json     # grouped Chinese tips (when produced)
│   ├── session-*.json           # transcripts (main + rule-skill sessions)
│   ├── request-timeline.jsonl   # per-request timing (diagnostics)
│   └── review-pi.log
└── audit/<runId>.json           # audit + effective config snapshot
```

The process cwd also receives `review-result.json` (the same content as
`reviews_all.json`) and a hidden `.review-pi-session.json` index on success.
Run the CLI from a scratch directory if you do not want those in a repo.

Sharded reviews put per-shard artifacts under
`runs/shards/attempt-<ts>/sNN/` and `audit/shards/...`; the top level holds the
merged findings.

## Exit codes

| Code | Meaning |
|---|---|
| `0` | Review completed, including `truncated: true`; `smoke` passed; `config`/`export` succeeded |
| `1` | Usage error, config error, missing key/model, input read failure, network/model failure, artifact write failure, strict rule-skill load failure, smoke probe failure |

MCP reporting is a side channel: its failures never change the exit code.

## What the CLI does not do

- It does not apply the diff to `--repo`; the snapshot must already be on the
  side you want tool reads to see.
- It does not edit the repository, apply fixes, commit, or push.
- It does not auto-discover rule packs.
- It does not translate Chinese findings to another language.
