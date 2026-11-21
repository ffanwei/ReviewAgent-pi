"""全量跑完后的收口：按结果状态生成评测数据集，并报告不可复现样本。

为什么要分类：翻遍 151 条结果后，failed 有两类——
  1) 数据集不可复现（commit 已被 GitHub 删除 / force-push）：应排除出评测分母；
  2) 评审失败（超时 / 网关错误）：应重跑；重跑仍失败才按 0 召回计入。
本脚本只做分类与产物生成，不调用模型。

用法：
    python postprocess_aacr.py \
        --dataset data/aacr_bench_v2_run.jsonl \
        --results-dir results/aacr_bench_v2/reviewpi/arm2 \
        --out-dataset data/aacr_bench_v2_eval_arm2.jsonl
"""
from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Dict, List

EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL_DIR))

from schema import load_instances  # noqa: E402

UNREPRODUCIBLE_MARKERS = (
    "not our ref",
    "reference is not a tree",
    "Not a valid commit name",
    "upload-pack",
    "failed to read tree",
    "unable to read tree",
)


def classify(result: Dict[str, Any]) -> str:
    status = result.get("status")
    if status in ("ok", "skipped"):
        return "include"
    reason = str(result.get("stderr_tail") or "")
    if any(marker in reason for marker in UNREPRODUCIBLE_MARKERS):
        return "unreproducible"
    return "reviewer-failure"


def main(argv: List[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AACR-Bench 结果收口")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--results-dir", type=Path, required=True)
    parser.add_argument("--out-dataset", type=Path, required=True)
    args = parser.parse_args(argv)

    instances = load_instances(args.dataset.resolve())
    included = []
    counts = {"include": 0, "unreproducible": 0, "reviewer-failure": 0, "missing": 0}
    details: Dict[str, List[str]] = {"unreproducible": [], "reviewer-failure": [], "missing": []}

    for instance in instances:
        path = args.results_dir / f"{instance.safe_id}.json"
        if not path.is_file():
            counts["missing"] += 1
            details["missing"].append(instance.instance_id)
            continue
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            counts["reviewer-failure"] += 1
            details["reviewer-failure"].append(instance.instance_id)
            continue
        category = classify(result)
        counts[category] += 1
        if category == "include":
            included.append(instance)
        else:
            details[category].append(instance.instance_id)
        if result.get("findings_count") != len(result.get("review_output") or []):
            print(f"WARN {instance.instance_id}: findings_count mismatch", flush=True)

    args.out_dataset.parent.mkdir(parents=True, exist_ok=True)
    with args.out_dataset.open("w", encoding="utf-8") as handle:
        for instance in included:
            handle.write(json.dumps(instance.to_dict(), ensure_ascii=False) + "\n")

    print(f"dataset={len(instances)} include={len(included)} {counts}")
    for category in ("missing", "unreproducible", "reviewer-failure"):
        if details[category]:
            print(f"{category} ({len(details[category])}): {', '.join(details[category])}")
    print(f"wrote {args.out_dataset}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
