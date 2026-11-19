# review-pi Agent Skill

A portable [Agent Skill](https://agentskills.io) that lets other coding agents
(Claude Code, Codex, Cursor, Copilot CLI, Kimi Code, OpenCode, and any host that
loads `SKILL.md`) run a structured review with the `review-pi` CLI.

The skill is a thin, deterministic wrapper. The review itself still runs in
`review-pi`'s own runtime: six phases, evidence gate, repository tools, rule
packs, audit artifacts. The skill adds:

- target detection → diff + head-side snapshot;
- untracked-file inclusion;
- a shell-free CLI invocation (works on Windows without `.cmd` shims);
- deterministic Markdown rendering of findings.

## Requirements

| Item | Requirement |
|---|---|
| Node.js | `>= 22.19` |
| review-pi CLI | `npm i -g @baize/review-pi` |
| Config | `~/.PiAgent/PiAgent.jsonc` with `reviewer.apiKey` and `model.default` |
| Network | Reachable model gateway |

First-time setup:

```bash
npm i -g @baize/review-pi
review-pi config init          # writes ~/.PiAgent/PiAgent.jsonc
# edit reviewer.apiKey / reviewer.baseUrl / model.default
review-pi smoke                # gateway + model probes
```

## Install the skill

### Recommended: `npx skills add`

```bash
npx skills add MustacheXb/ReviewAgent-pi --skill review-pi
```

If you use a fork or mirror, replace `MustacheXb/ReviewAgent-pi` with your
`owner/repo`. The command discovers `skills/review-pi/SKILL.md` and installs it
into the host's Agent Skills directory (for example `.agents/skills/` in a repo
or the host's user-level skills directory).

### Claude Code (manual)

```bash
# Personal (all projects)
cp -r skills/review-pi ~/.claude/skills/review-pi

# Or project-scoped
mkdir -p .claude/skills && cp -r <repo>/skills/review-pi .claude/skills/review-pi
```

Restart the session (or reload the window) so the skill is discovered.

### Cursor / Codex / Copilot / Kimi / other hosts

Copy the whole `skills/review-pi/` directory into the host's Agent Skills
directory. The directory name must stay `review-pi` and `SKILL.md` must stay at
its root; the bundled `scripts/` and `references/` are loaded on demand.

Do not copy only `SKILL.md` — the preparation and rendering scripts live next
to it.

## Use

Just describe the target; the host picks the skill from its description.

```text
review my changes
review the last commit
review this branch against main
review this diff file: /tmp/change.diff
review and fix P0/P1 issues in my working copy
```

Under the hood the skill runs:

```bash
node <skill-dir>/scripts/prepare-review.mjs --mode workspace --repo . --json --run
node <skill-dir>/scripts/render-findings.mjs --input <stdoutPath>
```

You can run those scripts yourself for debugging. Use `--help` on either.

## What it produces

- A Markdown report grouped by `P0` → `P3`, with evidence and Chinese
  suggestions.
- JSON artifacts under a temporary work directory: the CLI's stdout, stderr,
  `reviews_all.json`, `reviews_tips_zh.json`, audit, and transcripts.
- Honest truncation: `truncated: true` is reported, never hidden.

## Security notes

- `--repo` is read-only for the review tools; the CLI never edits the repo.
- Rule packs (`--rule-skill`) can execute code in a skill session's `bash`.
  Only load packs the user explicitly names. This skill never auto-discovers
  them.
- Findings, evidence, transcripts, and audits contain code and paths. Treat them
  as internal data.
- The skill never asks for or stores API keys; credentials stay in the user's
  `PiAgent.jsonc`.

## Relationship to other "skills" in this repo

| Name | What it is |
|---|---|
| `skills/review-pi/` (this directory) | Portable host-agent skill; runs the CLI |
| `.agents/skills/` | Development/verification skills (real-defect replay, synthetic defect injection, vendored authoring skills) |
| `--rule-skill` / `--skill` on the CLI | Project rule packs loaded as separate review sessions inside `review-pi` |

The CLI flag `--skill` is **not** this portable skill; it is a synonym for
`--rule-skill` (ADR-0034).
