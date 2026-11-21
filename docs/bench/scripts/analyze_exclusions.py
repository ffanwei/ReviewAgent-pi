"""分析 v2 全量跑的 skipped / failed 样本特征，输出 JSON + Markdown。

数据来源（全部为已跑完产物，不调用模型）：
  - 原始 v2：dataset/v2/positive_samples.json
  - 标准数据：evaluation/data/aacr_bench_v2.jsonl
  - 结果：evaluation/results/aacr_bench_v2/reviewpi/arm2/*.json
  - diff：results/.../.reviewpi/diff/<safe_id>.diff
"""
from __future__ import annotations

import json
import re
import statistics
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List

BENCH = Path("D:/Project/bench/aacr-bench")
EVAL = BENCH / "evaluation"
RAW = BENCH / "dataset/v2/positive_samples.json"
DATASET = EVAL / "data/aacr_bench_v2.jsonl"
RESULTS = EVAL / "results/aacr_bench_v2/reviewpi/arm2"
DIFFS = RESULTS / ".reviewpi/diff"
OUT = EVAL / ".pilot-logs/exclusion-analysis.json"
OUT_MD = EVAL / ".pilot-logs/exclusion-analysis.md"


def diff_blocks(path: Path) -> List[Dict[str, Any]]:
    """把 unified diff 按 diff --git 分块，返回 {path, chars}。"""
    if not path.is_file():
        return []
    text = path.read_text(encoding="utf-8", errors="replace")
    blocks: List[Dict[str, Any]] = []
    current_path = None
    current_chars = 0
    for line in text.splitlines(keepends=True):
        if line.startswith("diff --git "):
            if current_path is not None:
                blocks.append({"path": current_path, "chars": current_chars})
            matched = re.search(r" b/(.+)$", line.rstrip("\n"))
            current_path = matched.group(1) if matched else line.strip()
            current_chars = len(line)
        elif current_path is not None:
            current_chars += len(line)
    if current_path is not None:
        blocks.append({"path": current_path, "chars": current_chars})
    return blocks


def context_stats(comments: List[Dict[str, Any]]) -> Dict[str, int]:
    return dict(Counter(str(c.get("context") or "?") for c in comments))


def category_stats(comments: List[Dict[str, Any]]) -> Dict[str, int]:
    return dict(Counter(str(c.get("category") or "?") for c in comments))


def main() -> int:
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    raw_by_key: Dict[tuple, Dict[str, Any]] = {}
    for record in raw:
        matched = re.search(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)", record.get("githubPrUrl", ""))
        if not matched:
            continue
        repo = f"{matched.group(1)}/{matched.group(2)}"
        raw_by_key[(repo, str(record.get("target_commit"))[:7])] = record

    instances = [json.loads(line) for line in DATASET.read_text(encoding="utf-8").splitlines() if line.strip()]
    groups: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for instance in instances:
        safe_id = instance["instance_id"].replace("/", "__")
        result_path = RESULTS / f"{safe_id}.json"
        result = json.loads(result_path.read_text(encoding="utf-8")) if result_path.is_file() else {}
        status = result.get("status", "missing")
        record = raw_by_key.get((instance["repo"], instance["head_commit"][:7]), {})
        comments = record.get("comments") or []
        diff_path = DIFFS / f"{safe_id}.diff"
        diff_size = diff_path.stat().st_size if diff_path.is_file() else 0
        blocks = diff_blocks(diff_path) if status == "skipped" else []
        top_blocks = sorted(blocks, key=lambda b: b["chars"], reverse=True)[:5]
        stderr = result.get("stderr_tail") or ""
        skip_match = re.search(r"MR diff 过大：(\d+) 字符", stderr)
        item = {
            "instance_id": instance["instance_id"],
            "repo": instance["repo"],
            "language": record.get("project_main_language"),
            "status": status,
            "skip_reason": result.get("skip_reason"),
            "change_line_count": record.get("change_line_count"),
            "gt_comments": len(comments),
            "ai_comments": sum(1 for c in comments if c.get("is_ai_comment")),
            "ai_ratio": round(sum(1 for c in comments if c.get("is_ai_comment")) / len(comments), 3) if comments else 0,
            "context": context_stats(comments),
            "category": category_stats(comments),
            "created_at": record.get("created_at"),
            "merged_at": record.get("merged_at"),
            "pr": record.get("githubPrUrl"),
            "diff_size": diff_size,
            "reported_diff_chars": int(skip_match.group(1)) if skip_match else None,
            "top_diff_blocks": top_blocks,
            "gt_paths": [c.get("path") for c in comments][:20],
            "duration_seconds": result.get("duration_seconds"),
            "findings_count": result.get("findings_count"),
        }
        groups[status].append(item)

    summary: Dict[str, Any] = {}
    for status, rows in groups.items():
        values = [r["change_line_count"] for r in rows if isinstance(r["change_line_count"], int)]
        gt = sum(r["gt_comments"] for r in rows)
        summary[status] = {
            "samples": len(rows),
            "gt_comments": gt,
            "repos": dict(Counter(r["repo"] for r in rows)),
            "languages": dict(Counter(r["language"] for r in rows)),
            "change_line_count": {
                "min": min(values) if values else None,
                "median": statistics.median(values) if values else None,
                "max": max(values) if values else None,
                "sum": sum(values),
            },
            "context": dict(sum((Counter(r["context"]) for r in rows), Counter())),
            "category": dict(sum((Counter(r["category"]) for r in rows), Counter())),
            "ai_ratio": round(sum(r["ai_comments"] for r in rows) / gt, 3) if gt else 0,
        }

    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({"summary": summary, "groups": groups}, ensure_ascii=False, indent=2), encoding="utf-8")

    lines: List[str] = ["# AACR-Bench v2 排除样本特征", ""]
    for status in ("ok", "skipped", "failed"):
        rows = groups.get(status, [])
        if not rows:
            continue
        s = summary[status]
        lines.append(f"## {status}（{s['samples']} 条 / GT {s['gt_comments']}）")
        lines.append("")
        lines.append(f"- 语言：{s['languages']}")
        lines.append(f"- 仓库：{s['repos']}")
        lines.append(f"- 改动行数：min={s['change_line_count']['min']} median={s['change_line_count']['median']} max={s['change_line_count']['max']}")
        lines.append(f"- GT context：{s['context']}")
        lines.append(f"- GT category：{s['category']}")
        lines.append(f"- AI 评论占比：{s['ai_ratio']}")
        lines.append("")
        if status == "ok":
            continue
        lines.append("| instance | repo | lang | reason | change_lines | GT | diff_chars | top diff blocks |")
        lines.append("|---|---|---|---|---:|---:|---:|---|")
        for r in sorted(rows, key=lambda x: -(x["diff_size"] or 0)):
            tops = ", ".join(f"{b['path']} ({b['chars']})" for b in r["top_diff_blocks"][:3])
            lines.append(
                f"| {r['instance_id']} | {r['repo']} | {r['language']} | {r['skip_reason'] or 'failed'} | "
                f"{r['change_line_count']} | {r['gt_comments']} | {r['reported_diff_chars'] or r['diff_size']} | {tops} |"
            )
        lines.append("")
    OUT_MD.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(f"wrote {OUT} and {OUT_MD}")
    for status, s in summary.items():
        print(status, s["samples"], "GT", s["gt_comments"], "langs", s["languages"])
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
