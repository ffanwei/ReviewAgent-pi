---
name: review-pi
description: >
  Run a structured AI code review with the review-pi CLI. Use when the user
  asks to review working-tree changes, staged or unstaged changes, a commit,
  a branch, a pull request, or a diff/MR JSON file; or asks for an
  evidence-backed code review with P0–P3 severity, structured JSON findings,
  and line-level Chinese suggestions. review-pi runs a six-phase review loop
  over an explicit diff and a repository snapshot, with an evidence gate
  ("no evidence, no finding"), and writes reproducible audit artifacts.
compatibility: >
  Requires Node.js >= 22.19 and the `review-pi` CLI (`npm i -g
  @baize/review-pi`). A user-level config at `~/.PiAgent/PiAgent.jsonc` with
  `reviewer.apiKey` and `model.default` is required, plus network access to
  the configured model gateway. The bundled preparation and rendering scripts
  need only Node.js. The CLI reads repositories; it never writes to them.
metadata:
  homepage: https://github.com/MustacheXb/ReviewAgent-pi
  version: "0.1.0"
---

# review-pi

`review-pi` is a code-review CLI with its own review runtime. This skill wraps
it: it turns "review my changes / this commit / this branch" into the two
explicit inputs the CLI needs, runs the CLI, and renders the findings.

The CLI is the reviewer. Do not perform the review yourself, and do not
paraphrase findings into new ones. Your job is to pick the right target, supply
honest business context, run the CLI, and present the returned evidence.

## Workflow

### Step 1 — Identify the review target and mode

| User says | Mode | Flags |
|---|---|---|
| "review my changes" / "working copy" | `workspace` (default) | none |
| "review this PR" / "review feature against main" | `range` | `--base <from> --head <to>` |
| "review commit abc123" | `commit` | `--commit <sha>` |
| "review this diff file" | `diff` | `--diff-file <path>` |
| "review this MR JSON" | `json` | `--json-file <path>` |

If the user gave no target, use `workspace`. If the target is ambiguous
(e.g. several candidate commits), ask exactly one short question.

### Step 2 — Gather business context (optional, but valuable)

Pass the MR/PR title, description, linked issue, and the commit subjects in
the range via `--issue "..."`. This becomes the initial user message of the
review. Summarize only what the user or repository actually says; never invent
requirements or acceptance criteria. Keep it concise (a short paragraph), and
quote the issue URL/ID when present.

### Step 3 — Prepare and run (preferred: one deterministic call)

Resolve `<skill-dir>` as the directory containing this `SKILL.md`, then run:

```bash
node <skill-dir>/scripts/prepare-review.mjs \
  --mode workspace --repo . --issue "<context>" --json --run
```

Range and commit reviews:

```bash
node <skill-dir>/scripts/prepare-review.mjs \
  --mode range --repo . --base main --head feature --json --run

node <skill-dir>/scripts/prepare-review.mjs \
  --mode commit --repo . --commit abc1234 --json --run
```

What the script does, and why you should not hand-roll it:

- produces a unified diff (`git diff` for tracked files **plus** new-file
  patches for untracked files, which `git diff` omits);
- checks out the **post-change (head) side** into a temporary Git worktree for
  `range` / `commit`, so the review tools read the code the findings refer to;
- derives a single-segment `taskId`, keeps all run artifacts under one
  temporary work directory, and runs the CLI **without a shell** (no quoting
  differences between PowerShell and POSIX shells);
- returns one JSON plan with `repo`, `diff`, `taskId`, `workDir`,
  `stdoutPath`, `stderrPath`, `review`, `cleanup`, and `warnings`.

Read the JSON. If `ok` is false, go to Troubleshooting with `stderrTail`. If
`ok` is true, continue to Step 4. Reviews can take several minutes; run this
step with a generous timeout (for example 10–20 minutes) or in the background.

Do **not** pre-check whether `review-pi` is installed (`command -v`,
`--version`, `smoke`) on the common path. Only on `command not found` or an
explicit configuration failure should you diagnose.

### Step 4 — Present the findings

Render deterministically instead of re-grouping by hand:

```bash
node <skill-dir>/scripts/render-findings.mjs --input <stdoutPath>
```

The renderer emits Markdown grouped by `P0 · Fatal` → `P3 · Suggestion`, with
evidence and the Chinese `tips.suggestion` attached. Rules:

- Report **all** findings, including P3. Do not silently drop "low" items.
- If `review.truncated` is true, say so explicitly: exit 0 with truncation is
  an honest incomplete result, not a clean bill of health.
- If there are no findings, state that, and do not invent issues.
- Keep `file`, `line`, identifiers, and `evidence` quotes verbatim. Findings
  are Chinese-native; if the user writes another language, translate the
  narrative but preserve the quoted code and paths.
- If stderr reports pre-filtered files (lockfiles, binaries, generated files,
  test files when configured) or coverage warnings, mention them briefly so the
  user knows what was not reviewed.
- Do not merge findings across files or re-rank them; the CLI already applied
  its evidence gate, scope filter, and deduplication.

### Step 5 — Fix (only when asked)

If the user asked to "review and fix" (not merely "review"):

1. Start with P0/P1, then P2; treat P3 as optional.
2. Use `tips.suggestion` and `evidence` to make the edit; re-read the file
   before editing.
3. Run the project's tests or typecheck for the touched area.
4. Never commit or push unless the user asked. Report what changed and what
   was skipped.

### Step 6 — Clean up

If the plan returned a non-empty `cleanup` array (a temporary worktree was
created), run it after presenting, unless the user wants to inspect that
checkout. With `--run --cleanup`, the script removes it automatically.

## Rule skills (project-specific review rules)

`review-pi` supports project rule packs as separate review sessions:

```bash
node <skill-dir>/scripts/prepare-review.mjs --mode workspace --repo . \
  --rule-skill .review-rules/java --json --run
```

`--rule-skill` is repeatable and accepts an unpacked directory. Rules are
**explicit input only**: never scan the reviewed repository for rule
directories, and never load a rule pack the user did not point at. A rule pack
can direct a `bash` tool inside its session, so loading an untrusted pack is a
code-execution decision (ADR-0027). Ask before using a pack you found but the
user did not name.

Do not confuse this with the portable skill: `--skill` on the CLI is a synonym
for `--rule-skill`; it is not this `SKILL.md`.

## Gotchas

- **`--repo` side matters.** The CLI does not apply the diff. `--repo` should be
  the post-change (head) tree, so `review.get_file` reads the changed code and
  line numbers line up. The preparation script materializes that tree for
  `range`/`commit`. If the CLI warns that the snapshot is on the base side,
  the tools are reading pre-change code.
- **Untracked files are invisible to `git diff`.** The script adds them as
  new-file patches; if you prepare a diff yourself, do the same. If the script
  warns that an untracked file looks like credentials (`.env`, `*.pem`,
  `id_rsa`, …), ask the user whether to exclude it with `--no-untracked` before
  sending it to the model.
- **stdout is one JSON document.** Progress, warnings, and parameter echo go to
  stderr. Never mix them, and never pipe stdout through `head`/`tail` on a
  large review; the script already writes it to a file.
- **Exit codes**: `0` = review completed (including honest `truncated: true`);
  `1` = usage, config, gateway, input, or artifact failure. Output artifacts
  may still exist on some exit-1 paths.
- **Config is user-level**: `~/.PiAgent/PiAgent.jsonc` (or `--config`), JSONC.
  Environment variables are not read.
- **Model comes from `model.default` only.** `--model` is accepted but ignored.
- **`--issue` is not a place for secrets.** It enters the model prompt and the
  audit.
- **Artifacts are sensitive**: findings, evidence, transcripts, and audit files
  contain code excerpts and paths. Treat them as internal material.
- **Same `taskId` overwrites artifacts.** The script generates a unique one;
  do not reuse it casually.

## Troubleshooting

| Symptom | Action |
|---|---|
| `review-pi: command not found` / CLI not found | `npm i -g @baize/review-pi`, or pass `--bin <...>/bin/review-pi.js` / set `REVIEW_PI_BIN` |
| Missing `reviewer.apiKey` | `review-pi config init`, then ask the user to fill the key; never invent one |
| Missing `model.default` | Ask the user to set it in `~/.PiAgent/PiAgent.jsonc`; do not add `--model` |
| Gateway connection error / timeout | `review-pi smoke` (uses the same config) and report its diagnosis; do not retry blindly |
| `--repo is not a directory` / diff `ENOENT` | Re-run preparation; check the target paths |
| `仓库快照停在 diff 的改前（base）侧` warning | Use the script's head-side worktree, or check out the post-change commit |
| `未装载任何规则包` | Normal; no rule pack was supplied. Not an error |
| stdout is not JSON | The CLI entry is wrong (often a `.cmd` shim). Pass `--bin` pointing at `bin/review-pi.js` |
| PowerShell wraps stderr as `NativeCommandError` | Content and exit code are still correct; use the script to avoid the shim |
| `truncated: true` | Honest truncation; report it. Consider splitting the change set rather than retrying |

## References

- `references/output-contract.md` — stdout keys, finding schema, tips schema,
  exit codes, artifacts.
- `references/preparation.md` — modes, head/base side semantics, manual Git
  fallback, task-id rules.
- `references/troubleshooting.md` — expanded failure table and diagnostics.
- `../README.md` — installation for Claude Code, Codex, Cursor, Copilot, and
  other Agent Skills-compatible hosts.
