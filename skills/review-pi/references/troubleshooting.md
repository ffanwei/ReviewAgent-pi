# Troubleshooting

Read the plan's `stderrTail` first. The CLI writes human-readable Chinese
diagnostics to stderr, and stdout stays a clean JSON document.

## CLI discovery

| Symptom | Fix |
|---|---|
| `找不到 review-pi CLI` from the script | `npm i -g @baize/review-pi`, pass `--bin <abs>/bin/review-pi.js`, or set `REVIEW_PI_BIN` |
| `review-pi: command not found` in a shell | Same as above; do not assume the CLI is missing before trying it once |
| stdout parses as text, not JSON | The entry is probably a `.cmd`/`.ps1` shim or a wrapper printing extra lines. Point `--bin` at the package's `bin/review-pi.js` and run it with Node |

The script resolves the CLI in this order: `--bin` → `REVIEW_PI_BIN` →
`<repo>/packages/review-pi/bin/review-pi.js` (and ancestors) → global
`$(npm root -g)/@baize/review-pi/bin/review-pi.js` → the bare `--bin` command.
It invokes the JS entry with `process.execPath`, never through a shell.

## Configuration

| Symptom | Fix |
|---|---|
| `reviewer.apiKey` missing | `review-pi config init`, then ask the user to fill the key. Never invent or echo a key |
| `model.default` missing | Ask the user to set it in `~/.PiAgent/PiAgent.jsonc`. `--model` is ignored (ADR-0093 stage 1) |
| Unknown config key warnings | Remove the key or use the current schema; warnings do not fail the run |
| Env vars seem ignored | By design: env is not read; use `--config` or the user-level file |

Use `review-pi config show` for a redacted view of the effective values and
their sources (`reviewer.apiKey` only reports `set` / `missing`).
Use `review-pi smoke` to probe gateway health + model reachability; it uses the
same config and never echoes the key.

## Gateway / model

| Symptom | Fix |
|---|---|
| `ENOTFOUND` / `ECONNREFUSED` / `ETIMEDOUT` | Run `review-pi smoke`; report the failing probe. Check base URL, network, proxy |
| HTTP 400 context overflow | The CLI narrows and retries with a reduced budget (ADR-0102); if it still fails, reduce the change set or the configured context window |
| HTTP 401/403 | Key or endpoint wrong; do not print the key |
| HTTP 429 | Retry with backoff **once** at the skill level; then report. Do not loop |
| `MODEL_MAX_TOKENS_REACHED` | Output budget too small for this model/gateway; ask the user before changing config |
| Review takes minutes | Normal for large MRs. Use a 10–20 minute tool timeout or run in the background |

## Inputs

| Symptom | Fix |
|---|---|
| `变更集为空` | Stage changes, pick a different range/commit, or pass `--diff-file` |
| `--repo 不是 Git 工作树` | Use a worktree path; for a plain directory use `--mode diff` / `json` and a real repo snapshot |
| `diff 文件不存在` / MR JSON missing | Re-run preparation; check the path |
| `--repo is not a directory` from the CLI | Same; the snapshot must exist |
| `未装载任何规则包` | Normal when no `--rule-skill` was passed |
| Rule pack load failure | Without `--strict-rule-skill`, the run degrades and continues. If the user wants fail-fast, add it explicitly; otherwise report the warning |

## Snapshot side

The CLI prints:

```
仓库快照停在 diff 的改前（base）侧：get_file 读到的是改前内容，改后内容以 diff 为准
```

or

```
仓库快照侧别混杂：部分文件可能读到与 diff 不同侧的内容
```

This means `--repo` does not match the diff's post-change side. For an ordinary
review, use the preparation script's head-side worktree, or check out the
post-change commit. For dataset replays, the base-side warning may be expected.

## Truncation and coverage

- `truncated: true` with exit 0 is **honest truncation**, not success with full
  coverage. Report it.
- Zero findings with truncation does not mean "no defects".
- Files removed by the input pre-filter (lockfiles, generated files, binaries,
  test files when configured) do not produce findings. The CLI logs the filter
  to stderr.
- Sharded reviews merge findings deterministically; a failed shard leaves no
  aggregate result (exit 1). Do not reconstruct partial results by hand.

## Shell and platform

| Symptom | Fix |
|---|---|
| PowerShell wraps every stderr line as `NativeCommandError` | The CLI content and exit code are still correct. Use the script, or call Node on `bin/review-pi.js` directly |
| `review-pi` not found on Windows in a Node child process | `.cmd` shims need a shell. The script avoids this; if invoking manually, use `node <path>/bin/review-pi.js` |
| Paths with spaces / non-ASCII | The script passes argv directly, no shell quoting. For manual runs, quote the paths |
| Temp worktree cannot be removed on Windows | A process may still hold files. Close the review/editor, then `git worktree remove --force <path>` |

## Artifacts

| Symptom | Fix |
|---|---|
| `review-result.json` appears in the repo | The CLI ran with cwd = repo. Run it from a scratch directory, as the script does |
| Old findings mixed with new | Reused `taskId`. Use a fresh one |
| `export` cannot find the session | Run `review-pi export` from the directory where the review ran, or pass `--taskId` + `--tasks-dir` |
| Audit / transcripts contain code | Expected: artifacts are sensitive operational data; treat them as internal |
