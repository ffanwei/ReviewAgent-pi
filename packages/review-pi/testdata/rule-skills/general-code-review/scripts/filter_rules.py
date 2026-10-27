#!/usr/bin/env python3
"""Filter the general-code-review rule base by keyword.

Reads ``rules/*.md`` (YAML-ish frontmatter + markdown body) and prints the rules
that match the requested keywords and filters, so a reviewer can decide which
rules are in scope for a change instead of reading the whole rule base.

Standard library only. No network, no third-party packages, Python 3.8+.

Examples
--------
    # rules you already suspect apply (any keyword matches by default)
    python filter_rules.py -k "sql,query" -k "resource,leak,close"

    # mine keywords straight out of a unified diff (file or stdin)
    python filter_rules.py --from-diff change.diff
    git diff | python filter_rules.py --from-diff -

    # require every keyword, restrict by severity, emit JSON
    python filter_rules.py -k timeout --all --severity high --format json

    # just list the rule base
    python filter_rules.py --list
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Dict, List, Optional, Sequence, Tuple

RULES_DIRNAME = "rules"
DEFAULT_FORMAT = "text"

# Tokens that carry no rule signal when mining a diff.
DIFF_STOPWORDS = frozenset(
    """
    if else elif for while do return break continue new this self super
    class def import from public private protected static final abstract
    void int long short byte char float double bool boolean string str
    true false null none nil and or not try catch except finally throw
    throws raise var let const function func package interface extends
    implements override val fn end begin then when case switch match
    the a an of to in on at is are was were be been being with without
    get set put add remove has have can will not
    """.split()
)

TOKEN_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_]{2,}")
META_LINE_RE = re.compile(r"^([A-Za-z0-9_-]+)\s*:\s*(.*)$")
SEVERITY_ORDER = {"high": 0, "medium": 1, "low": 2}

EXAMPLES = """\
examples:
  python filter_rules.py -k "sql,query" -k "resource,leak,close"
  python filter_rules.py --from-diff change.diff
  git diff | python filter_rules.py --from-diff -
  python filter_rules.py -k timeout --all --severity high --format json
  python filter_rules.py --list
"""


@dataclass
class Rule:
    """One rule file: its path, parsed frontmatter, and markdown body."""

    path: Path
    meta: Dict[str, object]
    body: str

    @property
    def rule_id(self) -> str:
        raw = self.meta.get("id")
        return str(raw).strip() if raw else self.path.stem

    @property
    def title(self) -> str:
        raw = self.meta.get("title")
        return str(raw).strip() if raw else ""

    @property
    def severity(self) -> str:
        raw = self.meta.get("severity")
        return str(raw).strip().lower() if raw else ""

    @property
    def category(self) -> str:
        raw = self.meta.get("category")
        return str(raw).strip() if raw else ""

    @property
    def tags(self) -> List[str]:
        raw = self.meta.get("tags")
        if isinstance(raw, list):
            return [str(item).strip() for item in raw if str(item).strip()]
        if raw:
            return [str(raw).strip()]
        return []

    def haystack(self) -> str:
        parts = [self.rule_id, self.title, self.category, " ".join(self.tags), self.body]
        return normalize(" ".join(parts))


# --------------------------------------------------------------------------- #
# frontmatter parsing
# --------------------------------------------------------------------------- #

def normalize(text: str) -> str:
    """Lowercase and collapse separators/whitespace so phrases match loosely."""
    text = text.lower()
    text = re.sub(r"[-_/.,;:()\[\]{}<>\"'`*#]+", " ", text)
    text = re.sub(r"\s+", " ", text)
    return text.strip()


def _scalar(value: str) -> str:
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    return value


def _split_inline_list(inner: str) -> List[str]:
    items: List[str] = []
    current: List[str] = []
    quote: Optional[str] = None
    for char in inner:
        if quote is not None:
            current.append(char)
            if char == quote:
                quote = None
        elif char in "\"'":
            quote = char
            current.append(char)
        elif char == ",":
            items.append("".join(current))
            current = []
        else:
            current.append(char)
    items.append("".join(current))
    return [item for item in (entry.strip() for entry in items) if item]


def parse_frontmatter(text: str) -> Tuple[Dict[str, object], str]:
    """Split ``---``-fenced frontmatter from the body.

    Supports ``key: value``, inline lists (``key: [a, b]``), and block lists
    (``key:`` followed by ``- item`` lines). No third-party YAML dependency.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n")
    if not text.startswith("---"):
        return {}, text.strip()

    lines = text.split("\n")
    end = None
    for index in range(1, len(lines)):
        if lines[index].strip() == "---":
            end = index
            break
    if end is None:
        return {}, text.strip()

    meta: Dict[str, object] = {}
    key: Optional[str] = None
    for raw in lines[1:end]:
        line = raw.rstrip()
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            continue
        if stripped.startswith("- ") and key is not None:
            bucket = meta.get(key)
            if not isinstance(bucket, list):
                bucket = []
                meta[key] = bucket
            bucket.append(_scalar(stripped[2:]))
            continue
        match = META_LINE_RE.match(line)
        if not match:
            continue
        key = match.group(1)
        value = match.group(2).strip()
        if value == "":
            meta[key] = []
        elif value.startswith("[") and value.endswith("]"):
            inner = value[1:-1].strip()
            meta[key] = [_scalar(item) for item in _split_inline_list(inner)] if inner else []
        else:
            meta[key] = _scalar(value)

    body = "\n".join(lines[end + 1 :]).strip()
    return meta, body


# --------------------------------------------------------------------------- #
# loading and filtering
# --------------------------------------------------------------------------- #

def default_rules_dir() -> Path:
    """``<script_dir>/../rules`` - independent of the current working directory."""
    return Path(__file__).resolve().parent.parent / RULES_DIRNAME


def load_rules(rules_dir: Path) -> List[Rule]:
    if not rules_dir.is_dir():
        print(f"error: rules directory not found: {rules_dir}", file=sys.stderr)
        raise SystemExit(2)

    rules: List[Rule] = []
    for path in sorted(rules_dir.glob("*.md")):
        try:
            text = path.read_text(encoding="utf-8")
        except OSError as exc:  # unreadable file: warn, keep going
            print(f"warning: cannot read {path.name}: {exc}", file=sys.stderr)
            continue
        meta, body = parse_frontmatter(text)
        if not meta.get("id") and not meta.get("title"):
            continue  # not a rule file
        rules.append(Rule(path=path, meta=meta, body=body))

    if not rules:
        print(f"error: no rules found under {rules_dir}", file=sys.stderr)
        raise SystemExit(2)
    return rules


def mine_keywords_from_diff(text: str, limit: int = 60) -> List[str]:
    """Pull candidate keywords from a unified diff: identifiers on added lines."""
    text = text.replace("\r\n", "\n")
    keywords: List[str] = []
    seen = set()
    for line in text.split("\n"):
        if line.startswith(("+++", "---")) or line.startswith("diff "):
            continue
        if not line.startswith("+"):
            continue
        for token in TOKEN_RE.findall(line[1:]):
            low = token.lower()
            if low in DIFF_STOPWORDS or low in seen:
                continue
            seen.add(low)
            keywords.append(token)
            if len(keywords) >= limit:
                return keywords
    return keywords


def collect_keywords(args: argparse.Namespace) -> List[str]:
    keywords: List[str] = []
    for value in list(args.keyword) + list(args.keywords):
        for part in value.split(","):
            part = part.strip()
            if part:
                keywords.append(part)
    if args.from_diff is not None:
        if args.from_diff == "-":
            diff_text = sys.stdin.read()
        else:
            diff_path = Path(args.from_diff)
            if not diff_path.is_file():
                print(f"error: diff file not found: {diff_path}", file=sys.stderr)
                raise SystemExit(2)
            diff_text = diff_path.read_text(encoding="utf-8", errors="replace")
        keywords.extend(mine_keywords_from_diff(diff_text))
    # De-duplicate case-insensitively, preserving order.
    deduped: List[str] = []
    seen = set()
    for keyword in keywords:
        key = normalize(keyword)
        if key and key not in seen:
            seen.add(key)
            deduped.append(keyword)
    return deduped


def matches(rule: Rule, keywords: Sequence[str], require_all: bool) -> bool:
    if not keywords:
        return True
    haystack = rule.haystack()
    hits = [kw for kw in keywords if normalize(kw) in haystack]
    return len(hits) == len(keywords) if require_all else bool(hits)


def apply_filters(rules: Sequence[Rule], args: argparse.Namespace) -> List[Rule]:
    selected: List[Rule] = []
    for rule in rules:
        if args.severity and rule.severity != args.severity:
            continue
        if args.tag and args.tag.lower() not in [tag.lower() for tag in rule.tags]:
            continue
        if args.category and args.category.lower() != rule.category.lower():
            continue
        selected.append(rule)
    return selected


def sort_rules(rules: Sequence[Rule]) -> List[Rule]:
    return sorted(rules, key=lambda r: (SEVERITY_ORDER.get(r.severity, 9), r.rule_id))


# --------------------------------------------------------------------------- #
# rendering
# --------------------------------------------------------------------------- #

def render_text(rules: Sequence[Rule]) -> str:
    if not rules:
        return "no rules matched"
    lines: List[str] = []
    for rule in rules:
        lines.append(f"[{rule.rule_id}] ({rule.severity or 'n/a'}) {rule.title}")
        if rule.category or rule.tags:
            details = []
            if rule.category:
                details.append(f"category={rule.category}")
            if rule.tags:
                details.append("tags=" + ",".join(rule.tags))
            lines.append("    " + "  ".join(details))
        lines.append(f"    rule: {rule.path.name}")
    return "\n".join(lines)


def render_ids(rules: Sequence[Rule]) -> str:
    return "\n".join(rule.rule_id for rule in rules)


def render_json(rules: Sequence[Rule]) -> str:
    payload = [
        {
            "id": rule.rule_id,
            "title": rule.title,
            "severity": rule.severity,
            "category": rule.category,
            "tags": rule.tags,
            "file": rule.path.name,
            "body": rule.body,
        }
        for rule in rules
    ]
    return json.dumps(payload, indent=2, ensure_ascii=False)


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #

def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="filter_rules.py",
        description="Filter the general-code-review rule base by keyword.",
        epilog=EXAMPLES,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("keywords", nargs="*", help="keywords (same as --keyword)")
    parser.add_argument("-k", "--keyword", action="append", default=[], metavar="TEXT",
                        help="keyword; repeatable, comma-separated values allowed")
    parser.add_argument("--from-diff", metavar="PATH",
                        help="derive keywords from a unified diff ('-' reads stdin)")
    parser.add_argument("--all", action="store_true",
                        help="require every keyword to match (default: any one)")
    parser.add_argument("--severity", choices=["high", "medium", "low"],
                        help="restrict to this severity")
    parser.add_argument("--tag", metavar="NAME", help="restrict to rules carrying this tag")
    parser.add_argument("--category", metavar="NAME", help="restrict to this category")
    parser.add_argument("--rules-dir", metavar="DIR",
                        help="rule directory (default: ../rules next to this script)")
    parser.add_argument("--format", choices=["text", "json", "ids"], default=DEFAULT_FORMAT,
                        help="output format (default: %(default)s)")
    parser.add_argument("--list", action="store_true", dest="list_all",
                        help="list every rule without keyword filtering")
    parser.add_argument("--print-keywords", action="store_true",
                        help="print the effective keyword list to stderr")
    parser.add_argument("--fail-if-empty", action="store_true",
                        help="exit non-zero when nothing matched")
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)

    rules_dir = Path(args.rules_dir).resolve() if args.rules_dir else default_rules_dir()
    rules = load_rules(rules_dir)

    if args.list_all:
        selected = sort_rules(apply_filters(rules, args))
        keywords: List[str] = []
    else:
        keywords = collect_keywords(args)
        if args.print_keywords:
            print("keywords: " + (", ".join(keywords) if keywords else "(none)"), file=sys.stderr)
        pool = apply_filters(rules, args)
        selected = sort_rules([rule for rule in pool if matches(rule, keywords, args.all)])

    if args.format == "json":
        output = render_json(selected)
    elif args.format == "ids":
        output = render_ids(selected)
    else:
        output = render_text(selected)
    print(output)

    if args.fail_if_empty and not selected:
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
