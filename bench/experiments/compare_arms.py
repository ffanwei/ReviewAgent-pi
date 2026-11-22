#!/usr/bin/env python
"""成对 A/B 汇总（F-16）：读取两个 metrics_claude_*.json，输出 P/R/B 与 ΔB 的 bootstrap 95% CI。

用法：
  python bench/experiments/compare_arms.py \
    --a bench/experiments/.../metrics_a.json \
    --b bench/experiments/.../metrics_b.json \
    --label-a off --label-b budget \
    --out comparison.json

口径：P = matched_generated / generated；R = covered_gt / expected；
B = 2PR/(P+R)。bootstrap 以实例为重采样单位（paired），默认 20000 次、seed 42。
"""
from __future__ import annotations

import argparse
import json
import random
from pathlib import Path


def load(path: Path) -> tuple[dict[str, dict], int]:
    data = json.loads(path.read_text(encoding="utf-8"))
    rows = {}
    for entry in data.get("eval_res", []):
        comments = entry.get("generated_comments") or []
        rows[entry["instance_id"]] = {
            "hits": sum(1 for comment in comments if comment.get("hit_new_gt") is True),
            "generated": len(comments),
            "gt": len(entry.get("comments") or []),
        }
    expected = data["summary"]["expected_notes"]
    return rows, expected


def score(rows: list[dict]) -> dict[str, float]:
    hits = sum(row["hits"] for row in rows)
    generated = sum(row["generated"] for row in rows)
    gt = sum(row["gt"] for row in rows)
    precision = hits / generated if generated else 0.0
    recall = hits / gt if gt else 0.0
    balanced = (2 * precision * recall / (precision + recall)) if precision + recall else 0.0
    return {
        "generated": generated,
        "matched": hits,
        "covered_gt": gt,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "balanced": round(balanced, 4),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--a", type=Path, required=True)
    parser.add_argument("--b", type=Path, required=True)
    parser.add_argument("--label-a", default="a")
    parser.add_argument("--label-b", default="b")
    parser.add_argument("--out", type=Path)
    parser.add_argument("--iterations", type=int, default=20_000)
    parser.add_argument("--seed", type=int, default=42)
    args = parser.parse_args()

    rows_a, expected_a = load(args.a)
    rows_b, expected_b = load(args.b)
    ids = sorted(set(rows_a) & set(rows_b))
    if not ids:
        raise SystemExit("两个 metrics 文件没有共同实例")

    base_a = score([rows_a[i] for i in ids])
    base_b = score([rows_b[i] for i in ids])
    rng = random.Random(args.seed)
    diffs: list[float] = []
    for _ in range(args.iterations):
        sample = [ids[rng.randrange(len(ids))] for _ in ids]
        a = score([rows_a[i] for i in sample])["balanced"]
        b = score([rows_b[i] for i in sample])["balanced"]
        diffs.append(b - a)
    diffs.sort()
    low = diffs[int(len(diffs) * 0.025)]
    high = diffs[int(len(diffs) * 0.975)]

    payload = {
        "instances": len(ids),
        "labels": {"a": args.label_a, "b": args.label_b},
        "expected_notes": {"a": expected_a, "b": expected_b},
        "a": base_a,
        "b": base_b,
        "delta": {
            key: round(base_b[key] - base_a[key], 4)
            for key in ("precision", "recall", "balanced")
        },
        "delta_balanced_ci95": [round(low, 4), round(high, 4)],
        "significant": low > 0 or high < 0,
    }
    text = json.dumps(payload, ensure_ascii=False, indent=2)
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(text + "\n", encoding="utf-8")
    print(text)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
