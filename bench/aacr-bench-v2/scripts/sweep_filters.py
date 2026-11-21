"""离线置信度 / 严重级过滤扫描：复用已有 judge 结果，不调用模型。

背景：review-pi 的 `limits.confidence.min` / `limits.severity.min` 只过滤
tips / MCP 输出，不改变 `reviews_all.json` 真源；本次 benchmark 用的是
reviews_all，所以直接改配置不会改变指标。本脚本把已有 metrics JSON 里的
逐条生成意见与结果文件里的 confidence / severity 做 join，按阈值过滤后
重放覆盖关系，重新计算 P/R/B。

关键点：
  - 不重新 judge。metrics 的 generated_comments 已含 matched_gt_indices；
  - recall 用“保留意见覆盖的 GT 并集”精确重算；
  - precision 用“按原顺序重放，命中此前未覆盖 GT 的保留意见数 / 保留意见数”精确重算；
  - 无过滤时结果必须与原始 summary 一致（脚本会校验）。
"""
from __future__ import annotations

import argparse
import json
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

SEVERITY_RANK = {"P0": 0, "P1": 1, "P2": 2, "P3": 3}


def load_instance_result(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def attach_filters(metrics: Dict[str, Any], results_dir: Path) -> Tuple[List[Dict[str, Any]], int]:
    """给 metrics.generated_comments 挂上 confidence / severity；返回 (eval_res, unmatched)。"""
    unmatched = 0
    for row in metrics.get("eval_res") or []:
        instance_id = row.get("instance_id", "")
        safe_id = instance_id.replace("/", "__")
        result_path = results_dir / f"{safe_id}.json"
        if not result_path.is_file():
            continue
        result = load_instance_result(result_path)
        buckets: Dict[Tuple[str, int, str], List[Dict[str, Any]]] = defaultdict(list)
        for finding in result.get("review_output") or []:
            note = "\n".join(
                part for part in [finding.get("summary", ""), finding.get("failure_scenario", "")] if part
            ).strip()
            key = (finding.get("file", ""), finding.get("line"), note)
            buckets[key].append(finding)
        for record in row.get("generated_comments") or []:
            key = (record.get("path", ""), record.get("from_line"), record.get("note", ""))
            candidates = buckets.get(key)
            if not candidates:
                unmatched += 1
                record["confidence"] = None
                record["severity"] = None
                continue
            finding = candidates.pop()
            record["confidence"] = finding.get("confidence")
            record["severity"] = finding.get("severity")
    return metrics.get("eval_res") or [], unmatched


def replay(rows: List[Dict[str, Any]], confidence_min: float, severity_min: str) -> Dict[str, Any]:
    min_rank = SEVERITY_RANK[severity_min]
    expected = covered = generated = matched_new = 0
    gen_on_gt = 0
    matched_on_gt = 0
    for row in rows:
        comments = [c for c in (row.get("comments") or []) if c.get("note")]
        expected += len(comments)
        gt_paths = {c.get("path") for c in comments}
        covered_here = set()
        for record in row.get("generated_comments") or []:
            confidence = record.get("confidence")
            severity = record.get("severity")
            # SEVERITY_RANK 越大越不严重；min=P1 表示保留 P0/P1，即 rank <= 1。
            keep = (
                confidence is not None
                and severity in SEVERITY_RANK
                and float(confidence) >= confidence_min
                and SEVERITY_RANK[severity] <= min_rank
            )
            if not keep:
                continue
            generated += 1
            matched = list(record.get("matched_gt_indices") or [])
            new = [index for index in matched if index not in covered_here]
            if new:
                matched_new += 1
            covered_here.update(matched)
            if record.get("path") in gt_paths:
                gen_on_gt += 1
                if new:
                    matched_on_gt += 1
        covered += len(covered_here)
    precision = matched_new / generated if generated else 0.0
    recall = covered / expected if expected else 0.0
    balanced = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
    return {
        "confidence_min": confidence_min,
        "severity_min": severity_min,
        "generated": generated,
        "matched_new": matched_new,
        "covered_gt": covered,
        "expected_gt": expected,
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "balanced": round(balanced, 3),
        "gen_on_gt_file": gen_on_gt,
        "precision_on_gt_file": round(matched_on_gt / gen_on_gt, 3) if gen_on_gt else 0.0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--metrics", type=Path, required=True)
    parser.add_argument("--results-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    metrics = json.loads(args.metrics.read_text(encoding="utf-8"))
    rows, unmatched = attach_filters(metrics, args.results_dir)
    if unmatched:
        print(f"WARN unmatched generated_comments: {unmatched}")

    baseline = replay(rows, 0.0, "P3")
    print("baseline:", baseline)
    original = metrics.get("summary") or {}
    print(
        "original summary:",
        {"precision": original.get("file_semantic_match_rate"),
         "recall": original.get("file_semantic_recall_rate"),
         "balanced": original.get("balanced_score"),
         "generated": original.get("generated_notes"),
         "matched_gt": original.get("matched_file_semantic_notes")},
    )

    confidences = [0.0, 0.5, 0.6, 0.7, 0.8]
    severities = ["P3", "P2", "P1", "P0"]
    table = [replay(rows, confidence, severity) for confidence in confidences for severity in severities]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(
        json.dumps({"baseline": baseline, "original": original, "unmatched": unmatched, "table": table},
                   ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    print("\nconf>= sev_min  generated  P      R      B      P@GT")
    for row in table:
        print(
            f"{row['confidence_min']:<6} {row['severity_min']:<7} {row['generated']:<10} "
            f"{row['precision']:<6} {row['recall']:<6} {row['balanced']:<6} {row['precision_on_gt_file']}"
        )
    print(f"\nwrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
