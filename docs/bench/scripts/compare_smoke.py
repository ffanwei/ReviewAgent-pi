"""对比 OCR 与 review-pi 在 smoke10 上的指标、token、耗时。

输入：
  - smoke10 数据集（10 条）
  - OCR metrics（pipeline eval 产出）+ OCR 结果 JSON
  - review-pi metrics（全量 108 条）+ review-pi 结果 JSON
  - review-pi 3 轮 smoke 基线（可选，用于总体 P/R/B）

用法：
  python compare_smoke.py \
    --ocr-metrics results/aacr_bench_v2_smoke10/ocr/ocr-smoke10/metrics_ocr_average.json \
    --ocr-results results/aacr_bench_v2_smoke10/ocr/ocr-smoke10 \
    --rp-metrics results/aacr_bench_v2/reviewpi/arm2/metrics_claude_20261116_102219.json \
    --rp-results results/aacr_bench_v2/reviewpi/arm2 \
    --rp-baseline metrics/smoke10-baseline.json \
    --dataset data/aacr_bench_v2_smoke10.jsonl
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any, Dict, Optional, Tuple


def load_json(path: Path) -> Dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def row_metrics(metrics: Dict[str, Any], instance_id: str) -> Optional[Dict[str, Any]]:
    for row in metrics.get("eval_res") or []:
        if row.get("instance_id") == instance_id:
            comments = [c for c in (row.get("comments") or []) if c.get("note")]
            generated = row.get("generated_comments") or []
            covered = sum(1 for c in comments if c.get("file_semantic_match"))
            matched = sum(1 for g in generated if g.get("hit_new_gt"))
            precision = matched / len(generated) if generated else 0.0
            recall = covered / len(comments) if comments else 0.0
            balanced = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
            return {
                "precision": round(precision, 3),
                "recall": round(recall, 3),
                "balanced": round(balanced, 3),
                "generated": len(generated),
                "covered_gt": covered,
                "expected_gt": len(comments),
            }
    return None


def ocr_usage(results_dir: Path, safe_id: str) -> Dict[str, Any]:
    path = results_dir / f"{safe_id}.json"
    if not path.is_file():
        return {}
    data = load_json(path)
    summary = (data.get("review") or {}).get("summary") or {}
    total = summary.get("total_tokens") or 0
    cached = summary.get("cache_read_tokens") or 0
    output = summary.get("output_tokens") or 0
    return {
        "total_tokens": total,
        "noncached_plus_output": max(0, total - cached) if total else 0,
        "duration_seconds": data.get("duration_seconds") or 0,
    }


def rp_usage(results_dir: Path, safe_id: str) -> Dict[str, Any]:
    path = results_dir / f"{safe_id}.json"
    if not path.is_file():
        return {}
    data = load_json(path)
    usage = data.get("token_usage") or {}
    input_tokens = usage.get("input_tokens") or 0
    output = usage.get("output_tokens") or 0
    cache = usage.get("cache_read_input_tokens") or 0
    return {
        "total_tokens": input_tokens + output + cache,
        "noncached_plus_output": input_tokens + output,
        "duration_seconds": data.get("duration_seconds") or 0,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--ocr-metrics", type=Path, required=True)
    parser.add_argument("--ocr-per-instance", type=Path, default=None,
                        help="多轮评测时用于逐样本的 round 文件；缺省自动取最新 round")
    parser.add_argument("--ocr-results", type=Path, required=True)
    parser.add_argument("--rp-metrics", type=Path, required=True)
    parser.add_argument("--rp-results", type=Path, required=True)
    parser.add_argument("--rp-baseline", type=Path, default=None)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--out", type=Path, default=None)
    args = parser.parse_args()

    smoke = [json.loads(line) for line in args.dataset.read_text(encoding="utf-8").splitlines() if line.strip()]
    ocr = load_json(args.ocr_metrics)
    if args.ocr_per_instance is not None:
        ocr_rows = load_json(args.ocr_per_instance)
    else:
        rounds = sorted(args.ocr_results.glob("metrics_ocr_*_round_*.json"), key=lambda p: p.stat().st_mtime)
        ocr_rows = load_json(rounds[-1]) if rounds else ocr
    rp = load_json(args.rp_metrics)
    rp_base = load_json(args.rp_baseline)["baseline"] if args.rp_baseline and args.rp_baseline.is_file() else None

    print(f"{'instance':<45}{'OCR P/R/B':>18}{'OCR tok':>12}{'OCR s':>8}{'RP P/R/B':>18}{'RP tok':>12}{'RP s':>8}")
    totals = {"ocr_tok": 0, "ocr_non": 0, "ocr_s": 0, "rp_tok": 0, "rp_non": 0, "rp_s": 0}
    rows_out = []
    for instance in smoke:
        iid = instance["instance_id"]
        safe = iid.replace("/", "__")
        om = row_metrics(ocr_rows, iid) or {}
        rm = row_metrics(rp, iid) or {}
        ou = ocr_usage(args.ocr_results, safe)
        ru = rp_usage(args.rp_results, safe)
        totals["ocr_tok"] += ou.get("total_tokens", 0)
        totals["ocr_non"] += ou.get("noncached_plus_output", 0)
        totals["ocr_s"] += ou.get("duration_seconds", 0)
        totals["rp_tok"] += ru.get("total_tokens", 0)
        totals["rp_non"] += ru.get("noncached_plus_output", 0)
        totals["rp_s"] += ru.get("duration_seconds", 0)
        rows_out.append({"instance_id": iid, "ocr": {**om, **ou}, "review_pi": {**rm, **ru}})
        print(
            f"{iid:<45}"
            f"{om.get('precision',0):>6.3f}/{om.get('recall',0):.3f}/{om.get('balanced',0):.3f}"
            f"{ou.get('total_tokens',0):>12}{ou.get('duration_seconds',0):>8.0f}"
            f"{rm.get('precision',0):>6.3f}/{rm.get('recall',0):.3f}/{rm.get('balanced',0):.3f}"
            f"{ru.get('total_tokens',0):>12}{ru.get('duration_seconds',0):>8.0f}"
        )

    os_ = ocr.get("summary") or {}
    rs = rp.get("summary") or {}
    print("\n=== 总体 ===")
    print(f"OCR       P {os_.get('file_semantic_match_rate')} R {os_.get('file_semantic_recall_rate')} "
          f"B {os_.get('balanced_score')} | evaluated {os_.get('evaluated_instances')} "
          f"generated {os_.get('generated_notes')} covered {os_.get('matched_file_semantic_notes')}")
    print(f"review-pi full 108（仅参考） P {rs.get('file_semantic_match_rate')} R {rs.get('file_semantic_recall_rate')} "
          f"B {rs.get('balanced_score')} | evaluated {rs.get('evaluated_instances')} "
          f"generated {rs.get('generated_notes')} covered {rs.get('matched_file_semantic_notes')}")
    if rp_base:
        print(f"review-pi smoke10 基线: P {rp_base.get('precision')} R {rp_base.get('recall')} "
              f"B {rp_base.get('balanced')} | covered {rp_base.get('covered_gt')}")
    print(f"\nToken（含 cache）: OCR {totals['ocr_tok']:,} vs review-pi {totals['rp_tok']:,}")
    print(f"Token（非缓存 input+output）: OCR {totals['ocr_non']:,} vs review-pi {totals['rp_non']:,}")
    print(f"耗时: OCR {totals['ocr_s']:.0f}s vs review-pi {totals['rp_s']:.0f}s")
    if args.out is not None:
        args.out.parent.mkdir(parents=True, exist_ok=True)
        args.out.write_text(json.dumps({
            "dataset": str(args.dataset),
            "aggregate": {
                "ocr": {k: os_.get(k) for k in ("file_semantic_match_rate", "file_semantic_recall_rate", "balanced_score", "generated_notes", "matched_file_semantic_notes", "evaluated_instances")},
                "review_pi": {k: rs.get(k) for k in ("file_semantic_match_rate", "file_semantic_recall_rate", "balanced_score", "generated_notes", "matched_file_semantic_notes", "evaluated_instances")},
                "review_pi_smoke_baseline": rp_base,
                "tokens": totals,
            },
            "per_sample": rows_out,
        }, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
        print(f"wrote {args.out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
