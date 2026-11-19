# Preparing a review target

`review-pi review` takes two inputs:

1. `--repo <dir>` — a repository **snapshot** the review tools read.
2. `--mr-diff <file>` (unified diff) **or** `--mr-json <file>` (GitCode/GitLab
   file-change JSON).

The CLI never applies the diff. The snapshot side determines what
`review.get_file`, symbol search, and reference search see.

## Which side should `--repo` be on?

Use the **post-change (head) side** for a normal review:

- changed files contain the new code, so evidence and line numbers match;
- new files exist and can be read;
- the CLI stays silent (it only warns when it detects a base-side or mixed
  snapshot).

The base side is valid for dataset replays where the snapshot deliberately
stays pre-change; then the review tools read old code and the CLI prints a
warning. Do not use base side for an ordinary MR review unless the user
explicitly wants that replay semantics.

## Modes handled by `prepare-review.mjs`

| Mode | Diff | `--repo` |
|---|---|---|
| `workspace` | `git diff HEAD` + untracked new-file patches | current worktree (already head side) |
| `range` | `git diff merge-base(base, head)..head` | temporary detached worktree at `head` |
| `commit` | `git diff commit^..commit` (merge: first parent) | temporary detached worktree at `commit` |
| `diff` | existing unified diff file | caller's `--repo` (must be head side) |
| `json` | existing MR JSON file | caller's `--repo` (must be head side) |

`workspace` includes staged and unstaged tracked changes plus untracked files.
Untracked files are rendered as new-file patches (`--- /dev/null`,
`+++ b/...`), with binary and oversized files skipped and reported in
`warnings`.

## Manual fallback (no Node script)

If you must prepare by hand, mirror the same steps.

Workspace:

```bash
git -c core.quotepath=false diff --no-ext-diff --no-textconv --no-color HEAD -- > change.diff
# Append new-file patches for untracked files; git diff does not include them.
git ls-files --others --exclude-standard
```

Range:

```bash
BASE=$(git merge-base origin/main HEAD)
git -c core.quotepath=false diff --no-ext-diff --no-textconv --no-color "$BASE"..HEAD -- > change.diff
# The snapshot must be at HEAD (post-change), not at BASE.
```

Commit:

```bash
git -c core.quotepath=false diff --no-ext-diff --no-textconv --no-color HEAD^..HEAD -- > change.diff
```

If you use a temporary worktree for the head side, remember to remove it:

```bash
git worktree add --detach /tmp/review-head HEAD
git worktree remove --force /tmp/review-head
```

## `taskId` and artifact location

- `--taskId` is a **single path segment**: no `/`, `\`, drive letter, leading
  dot, whitespace, `<>:"|?*`, or Windows reserved device name (`CON`, `NUL`,
  `COM1`…).
- The same `taskId` overwrites `run.json`, `reviews_all.json`, and
  `reviews_tips_zh.json`. Generate a fresh one per review.
- The script uses `review-<mode>-<sha7>-<timestamp>` and puts artifacts under
  its temporary work directory (`--tasks-dir`), so reviews do not pollute the
  user's global `~/.PiAgent/tasks` unless they ask for it.
- `review-result.json` is written to the process cwd. The script runs the CLI
  with cwd = work directory, so this file does not land in the repository.

## Business context

`--issue` is free text that becomes the initial user message. Good content:

- PR/MR title and a short description;
- linked issue / CVE / ticket ID;
- commit subjects in the range;
- the user's stated goal (e.g. "this is a security-only review").

Avoid: secrets, full CI logs, or invented acceptance criteria.

## Diff edge cases

| Edge case | Behavior |
|---|---|
| Binary file | Pre-filtered by the CLI; no findings. The script skips binary untracked files and warns |
| Empty file | The script emits the file header with no hunk |
| Rename without content change | Appears as a rename; usually no hunk |
| File > 5 MiB (untracked) | Skipped with a warning to avoid a huge diff |
| Huge overall diff | The CLI shards or honestly truncates; check `truncated` |
| No changes | The script fails early ("变更集为空") instead of producing an empty review |
| Unborn branch (no `HEAD`) | Fail with a hint to commit first or use `--mode diff` |
