#!/usr/bin/env python
"""F-07 阶段压缩 A/B：对单个结果目录跑 N 轮 judge，汇总 P/R/B。

用法（在 evaluation/ 内、用其 venv 的 python 运行）：
  .venv/Scripts/python.exe D:/Project/ReviewAgent-pi/bench/experiments/2026-11-22-f07/eval_arm.py \
    --dataset D:/Project/ReviewAgent-pi/bench/aacr-bench-v2/configs/iterS10.jsonl \
    --results-dir results/iterF91/reviewpi/f07-off-20261122 \
    --out D:/Project/ReviewAgent-pi/bench/experiments/2026-11-22-f07/off-metrics.json \
    --rounds 3
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
from pathlib import Path

EVAL_DIR = Path("D:/Project/bench/aacr-bench/evaluation")
sys.path.insert(0, str(EVAL_DIR))

from evaluate import evaluate  # noqa: E402
from schema import load_instances  # noqa: E402


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--results-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--rounds", type=int, default=1)
    parser.add_argument("--reviewer", default="claude")
    args = parser.parse_args()

    instances = load_instances(args.dataset)
    rounds = []
    for index in range(args.rounds):
        data = asyncio.run(
            evaluate(
                instances,
                args.results_dir,
                args.reviewer,
                args.out.parent,
                round_label=f"_r{index + 1}",
            )
        )
        rounds.append(data)

    def mean(key: str) -> float:
        return round(sum(item["summary"][key] for item in rounds) / len(rounds), 4)

    payload = {
        "reviewer": args.reviewer,
        "results_dir": str(args.results_dir),
        "dataset": str(args.dataset),
        "rounds": len(rounds),
        "summary": {
            "precision": mean("file_semantic_match_rate"),
            "recall": mean("file_semantic_recall_rate"),
            "balanced": mean("balanced_score"),
            "generated_notes": mean("generated_notes"),
            "matched_generated_notes": mean("matched_generated_notes"),
            "covered_gt": mean("matched_file_semantic_notes"),
            "expected_notes": rounds[0]["summary"]["expected_notes"],
            "total_tokens": mean("total_tokens"),
            "avg_duration_seconds": mean("avg_duration_seconds"),
        },
        "per_round": [
            {
                "precision": item["summary"]["file_semantic_match_rate"],
                "recall": item["summary"]["file_semantic_recall_rate"],
                "balanced": item["summary"]["balanced_score"],
                "generated_notes": item["summary"]["generated_notes"],
                "covered_gt": item["summary"]["matched_file_semantic_notes"],
                "total_tokens": item["summary"]["total_tokens"],
            }
            for item in rounds
        ],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    print(json.dumps(payload["summary"], ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
