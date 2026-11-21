"""把评测指标整理成可读报告：总体 + 按语言 + 两臂对照。

用法：
    python report_aacr.py \
        --arm arm1=results/.../metrics_claude_xxx.json \
        --arm arm2=results/.../metrics_claude_yyy.json \
        --v2 dataset/v2/positive_samples.json
"""
from __future__ import annotations

import argparse
import json
import re
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List


def load_metrics(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def language_map(v2_path: Path) -> Dict[str, str]:
    """instance_id -> 语言（从原始 v2 记录推导，口径与转换器一致）。"""
    records = json.loads(v2_path.read_text(encoding="utf-8"))
    mapping: Dict[str, str] = {}
    for record in records:
        matched = re.search(r"github\.com/([^/]+)/([^/]+)/pull/\d+", record.get("githubPrUrl", ""))
        head = record.get("target_commit") or ""
        if matched and head:
            instance_id = f"{matched.group(1)}__{matched.group(2)}@{head[:7]}"
            mapping[instance_id] = record.get("project_main_language") or "?"
    return mapping


def aggregate(rows: Iterable[Dict[str, Any]]) -> Dict[str, float]:
    expected = generated = matched_gt = matched_gen = 0
    for row in rows:
        comments = row.get("comments") or []
        gens = row.get("generated_comments") or []
        expected += sum(1 for comment in comments if comment.get("note"))
        matched_gt += sum(1 for comment in comments if comment.get("file_semantic_match"))
        generated += len(gens)
        matched_gen += sum(1 for gen in gens if gen.get("hit_new_gt"))
    precision = matched_gen / generated if generated else 0.0
    recall = matched_gt / expected if expected else 0.0
    balanced = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {
        "expected": expected,
        "generated": generated,
        "matched_gt": matched_gt,
        "matched_gen": matched_gen,
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "balanced": round(balanced, 3),
    }


def fmt(name: str, stats: Dict[str, float]) -> str:
    return (f"{name:<22} P={stats['precision']:.3f} R={stats['recall']:.3f} "
            f"B={stats['balanced']:.3f} (GT {int(stats['matched_gt'])}/{int(stats['expected'])}, "
            f"GEN {int(stats['matched_gen'])}/{int(stats['generated'])})")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--arm", action="append", required=True, help="label=metrics.json")
    parser.add_argument("--v2", type=Path, required=True)
    parser.add_argument("--results-dir", type=Path, default=None,
                        help="可选：按结果状态给出剔除 skipped 的子集口径")
    args = parser.parse_args()
    languages = language_map(args.v2)
    statuses: Dict[str, str] = {}
    if args.results_dir is not None:
        for path in args.results_dir.glob("*.json"):
            if path.name.startswith("metrics_"):
                continue
            try:
                statuses[path.stem] = json.loads(path.read_text(encoding="utf-8")).get("status", "?")
            except (json.JSONDecodeError, OSError):
                pass

    for item in args.arm:
        label, raw_path = item.split("=", 1)
        data = load_metrics(Path(raw_path))
        rows = data.get("eval_res") or []
        summary = data.get("summary") or {}
        print(f"\n=== {label} ({len(rows)} evaluated) ===")
        print(fmt("总体", aggregate(rows)))
        print(f"summary: evaluated={summary.get('evaluated_instances')} "
              f"missing={summary.get('missing_instances')} "
              f"tokens={summary.get('total_tokens')} "
              f"duration={summary.get('total_duration_seconds')}s")
        if statuses:
            reviewed = [row for row in rows if statuses.get(row.get("instance_id", "")) == "ok"]
            print(fmt(f"仅 ok（{len(reviewed)} 条）", aggregate(reviewed)))
        by_language: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
        for row in rows:
            by_language[languages.get(row.get("instance_id", ""), "?")].append(row)
        for language in sorted(by_language):
            print(fmt(language, aggregate(by_language[language])))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
