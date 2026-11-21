"""从 AACR-Bench v2 已跑完结果中挑选一组“快速验证集”（默认 10 条，每语言 1 条）。

选择约束：
  - 只选 status=ok（可复现、已检视）的样本；
  - GT >= --min-gt（默认 2），保证有判定信号；
  - 改动行数 <= --max-change（默认 400）、耗时 <= --max-duration（默认 600s）、
    diff <= --max-diff（默认 1.2MB），保证跑得快、不会撞体积门；
  - 每语言按“耗时 + 0.3*改动行数 + diff/200000”从低到高排序；
  - 默认每语言 1 条，并在语言之间交替偏向“基线有命中”和“基线零命中”，
    让验证集同时能发现回归和改进。可用 --per-language 2 扩成 20 条。

产物：
  - data/aacr_bench_v2_smoke10.jsonl      固定样本 JSONL
  - metrics/smoke10-baseline.json         该子集的基线指标（复用已有 judge 结果）
  - metrics/smoke10-selection.md          可读选择表
"""
from __future__ import annotations

import argparse
import json
import re
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List

BENCH = Path("D:/Project/bench/aacr-bench")
EVAL = BENCH / "evaluation"
RESULTS = EVAL / "results/aacr_bench_v2/reviewpi/arm2"
METRICS = RESULTS / "metrics_claude_20261116_102219.json"
RAW = BENCH / "dataset/v2/positive_samples.json"
DATASET = EVAL / "data/aacr_bench_v2.jsonl"
DIFFS = RESULTS / ".reviewpi/diff"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--per-language", type=int, default=1)
    parser.add_argument("--min-gt", type=int, default=2)
    parser.add_argument("--max-change", type=int, default=400)
    parser.add_argument("--max-duration", type=float, default=600)
    parser.add_argument("--max-diff", type=int, default=1_200_000)
    parser.add_argument("--out-prefix", default="smoke10")
    parser.add_argument("--out-dir", type=Path, default=EVAL / "data")
    parser.add_argument("--metrics-dir", type=Path, default=EVAL / "metrics")
    args = parser.parse_args()

    raw = json.loads(RAW.read_text(encoding="utf-8"))
    raw_by_key: Dict[tuple, Dict[str, Any]] = {}
    for record in raw:
        matched = re.search(r"github\.com/([^/]+)/([^/]+)/pull/\d+", record.get("githubPrUrl", ""))
        if matched:
            raw_by_key[(f"{matched.group(1)}/{matched.group(2)}", str(record.get("target_commit"))[:7])] = record

    metrics = json.loads(METRICS.read_text(encoding="utf-8"))
    metric_rows = {row.get("instance_id"): row for row in metrics.get("eval_res") or []}
    instances = [json.loads(line) for line in DATASET.read_text(encoding="utf-8").splitlines() if line.strip()]

    candidates: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for instance in instances:
        safe_id = instance["instance_id"].replace("/", "__")
        result_path = RESULTS / f"{safe_id}.json"
        if not result_path.is_file():
            continue
        result = json.loads(result_path.read_text(encoding="utf-8"))
        if result.get("status") != "ok":
            continue
        record = raw_by_key.get((instance["repo"], instance["head_commit"][:7]), {})
        row = metric_rows.get(instance["instance_id"], {})
        comments = [c for c in (row.get("comments") or []) if c.get("note")]
        generated = row.get("generated_comments") or []
        gt = len(comments)
        matched_gt = sum(1 for c in comments if c.get("file_semantic_match"))
        matched_gen = sum(1 for g in generated if g.get("hit_new_gt"))
        change = record.get("change_line_count")
        duration = result.get("duration_seconds") or 0
        diff_path = DIFFS / f"{safe_id}.diff"
        diff_size = diff_path.stat().st_size if diff_path.is_file() else 0
        if change is None or gt < args.min_gt or change > args.max_change:
            continue
        if duration > args.max_duration or diff_size > args.max_diff:
            continue
        candidates[str(record.get("project_main_language"))].append({
            "instance": instance,
            "instance_id": instance["instance_id"],
            "repo": instance["repo"],
            "language": record.get("project_main_language"),
            "change": change,
            "duration": duration,
            "diff": diff_size,
            "gt": gt,
            "matched_gt": matched_gt,
            "gen": len(generated),
            "matched_gen": matched_gen,
            "score": duration + 0.3 * change + diff_size / 200000,
        })

    selected: List[Dict[str, Any]] = []
    used_repos: set = set()
    for index, language in enumerate(sorted(candidates)):
        pool = sorted(candidates[language], key=lambda r: r["score"])
        if args.per_language >= 2:
            wanted = [
                [r for r in pool if r["matched_gt"] >= 2 and r["matched_gen"] >= 1],
                [r for r in pool if r["matched_gt"] == 0],
            ]
            for group in wanted:
                pick = next((r for r in group if r["repo"] not in used_repos), None)
                pick = pick or next((r for r in group), None)
                if pick is not None and pick not in selected:
                    selected.append(pick)
                    used_repos.add(pick["repo"])
            if len([r for r in selected if r["language"] == language]) < args.per_language:
                for r in pool:
                    if r not in selected:
                        selected.append(r)
                        used_repos.add(r["repo"])
                        break
        else:
            prefer_positive = index % 2 == 0
            if prefer_positive:
                group = [r for r in pool if r["matched_gt"] >= 2 and r["matched_gen"] >= 1]
            else:
                group = [r for r in pool if r["matched_gt"] == 0]
            pick = next((r for r in group if r["repo"] not in used_repos), None)
            pick = pick or next((r for r in group), None) or pool[0]
            selected.append(pick)
            used_repos.add(pick["repo"])

    selected.sort(key=lambda r: r["language"])
    args.out_dir.mkdir(parents=True, exist_ok=True)
    args.metrics_dir.mkdir(parents=True, exist_ok=True)
    out_jsonl = args.out_dir / f"aacr_bench_v2_{args.out_prefix}.jsonl"
    with out_jsonl.open("w", encoding="utf-8") as handle:
        for row in selected:
            handle.write(json.dumps(row["instance"], ensure_ascii=False) + "\n")

    expected = sum(r["gt"] for r in selected)
    covered = sum(r["matched_gt"] for r in selected)
    generated = sum(r["gen"] for r in selected)
    matched_gen = sum(r["matched_gen"] for r in selected)
    precision = matched_gen / generated if generated else 0.0
    recall = covered / expected if expected else 0.0
    balanced = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    baseline = {
        "dataset": str(out_jsonl),
        "selection": {
            "per_language": args.per_language,
            "min_gt": args.min_gt,
            "max_change": args.max_change,
            "max_duration": args.max_duration,
            "max_diff": args.max_diff,
            "note": "outcome-stratified smoke set: positive/negative examples alternate by language; not an unbiased estimate.",
        },
        "selected": [
            {key: row[key] for key in ("instance_id", "repo", "language", "change", "duration", "diff",
                                       "gt", "matched_gt", "gen", "matched_gen")}
            for row in selected
        ],
        "baseline": {
            "samples": len(selected),
            "expected_gt": expected,
            "covered_gt": covered,
            "generated": generated,
            "matched_generated": matched_gen,
            "precision": round(precision, 3),
            "recall": round(recall, 3),
            "balanced": round(balanced, 3),
            "sum_duration_seconds": round(sum(r["duration"] for r in selected), 1),
            "max_duration_seconds": round(max(r["duration"] for r in selected), 1),
        },
    }
    baseline_path = args.metrics_dir / f"{args.out_prefix}-baseline.json"
    baseline_path.write_text(json.dumps(baseline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    lines = [f"# {args.out_prefix} 快速验证集", "", "## 基线", "",
             f"- 样本：{len(selected)}；GT：{expected}；生成：{generated}；命中 GT：{covered}",
             f"- Precision {precision:.3f} / Recall {recall:.3f} / Balanced {balanced:.3f}",
             f"- 单条耗时合计 {sum(r['duration'] for r in selected):.0f}s；最长 {max(r['duration'] for r in selected):.0f}s",
             "", "## 选中的样本", "",
             "| 语言 | instance | 仓库 | 改动行 | 耗时(s) | diff | GT | 命中 GT | 生成 | 命中生成 |",
             "|---|---|---|---:|---:|---:|---:|---:|---:|---:|"]
    for row in selected:
        lines.append(
            f"| {row['language']} | {row['instance_id']} | {row['repo']} | {row['change']} | "
            f"{row['duration']:.0f} | {row['diff']} | {row['gt']} | {row['matched_gt']} | {row['gen']} | {row['matched_gen']} |"
        )
    md_path = args.metrics_dir / f"{args.out_prefix}-selection.md"
    md_path.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps(baseline["baseline"], ensure_ascii=False, indent=2))
    print(f"wrote {out_jsonl}\nwrote {baseline_path}\nwrote {md_path}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
