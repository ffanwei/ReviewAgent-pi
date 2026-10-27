---
name: general-code-review
description: Language-agnostic code-review rule pack. Use when reviewing a code change and you need to decide which defect patterns are in scope - the rules live in rules/*.md and scripts/filter_rules.py selects the subset that matches the change. Not for language-specific linting or style-only checks.
---

# General code review: find the rules that apply, then apply them

This pack is a **rule base**, not a prompt: the rule index is **not** inlined
here. Read it from `rules/`, or let `scripts/filter_rules.py` select the subset
that matches the change you are reviewing.

## 1. Layout

- `SKILL.md` - this file: how to run the helpers, how to inspect a change.
- `rules/*.md` - one file per rule: frontmatter (`id`, `title`, `severity`,
  `category`, `tags`) plus a body (`Why it matters`, `Signals in a change`,
  `Evidence required`). **This is the only source of truth.**
- `scripts/filter_rules.py` - standard-library keyword filter over `rules/`.

## 2. Pick the rules that apply (do this first)

```bash
# which rules exist at all (cheap ids-only listing)
python scripts/filter_rules.py --list

# keywords you already suspect from the change
python scripts/filter_rules.py -k "sql,query" -k "resource,leak,close"

# mine keywords straight out of the diff you are reviewing
python scripts/filter_rules.py --from-diff change.diff

# require every keyword, narrow by severity, emit machine-readable output
python scripts/filter_rules.py -k timeout --all --severity high --format json
```

Flags: `--keyword`/`-k` (repeatable, comma-separated), `--from-diff PATH` (`-`
reads stdin), `--all`, `--severity`, `--tag`, `--category`, `--format
text|json|ids`, `--list`, `--fail-if-empty`. Keywords match case-insensitively
against each rule's `id`, `title`, `category`, `tags`, and body text. `--format
ids` is the cheap answer to "which rules are in scope"; `--format text` (the
default) prints the rule bodies you then read.

If the filter comes back empty or too broad, read `rules/` directly - each file
is short, and `--list` tells you the ids.

## 3. Inspect the change against those rules

Use the review tools (`get_diff`, `get_file`, `get_symbol`, `find_references`,
`get_call_chain`, `search_rule`, `search_history`) plus `bash` (grep over the
checkout, or `filter_rules.py` itself) to find each selected pattern in the
change. Look at the changed lines first, then at the callers and readers the
change affects.

Then, for every rule that genuinely applies:

1. Cite **concrete evidence**: an identifier plus `path:line` and a short excerpt.
2. State the defect in one sentence, then the impact.
3. If a rule looks relevant but does not apply, say so briefly - never force a
   finding.

Never invent evidence. A rule without evidence in the change is **not** a
finding.

## 4. Notes

- Rules are data. `filter_rules.py` only reads `rules/*.md`; it never executes
  anything from the change under review.
- Python 3.8+, standard library only: no network, no third-party packages.
