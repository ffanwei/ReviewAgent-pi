"""在 smoke10 快速验证集上跑 review-pi + judge，并与基线对比。

前置：review-pi 代码改动后先重新构建 dist：
    cd D:/Project/ReviewAgent-pi
    pnpm --filter @baize/review-pi build

用法（在 aacr-bench/evaluation 内）：
    python run_smoke.py --config C:/Users/Li/.PiAgent/benchmark-aacr-v2.jsonc --run-id after-change
    python run_smoke.py --config ... --skip-review   # 只重评已有结果

产物：results/aacr_bench_v2_smoke10/reviewpi/<run_id>/
基线：metrics/smoke10-baseline.json（由 make_smoke_subset.py 生成）
"""
from __future__ import annotations

import argparse
import json
import subprocess
import sys
import time
from pathlib import Path
from typing import Any, Dict, List

EVAL = Path(__file__).resolve().parent
BRIDGE = EVAL / "aacr_reviewpi_bridge.py"
SMOKE_DATASET = EVAL / "data/aacr_bench_v2_smoke10.jsonl"
BASELINE = EVAL / "metrics/smoke10-baseline.json"
RESULTS_ROOT = EVAL / "results/aacr_bench_v2_smoke10/reviewpi"


def run(command: List[str], cwd: Path) -> None:
    print("$", " ".join(command), flush=True)
    subprocess.run(command, cwd=str(cwd), check=True)


def resolve_metrics(results_dir: Path) -> tuple[Path, Path]:
    """返回 (summary 来源, 逐样本来源)。

    多轮评测会写 `metrics_claude_average.json`（只有 summary）和
    `metrics_claude_*_round_N.json`（含 eval_res）；单轮只有一个 metrics 文件。
    """
    average = results_dir / "metrics_claude_average.json"
    rounds = sorted(results_dir.glob("metrics_claude_*_round_*.json"), key=lambda p: p.stat().st_mtime)
    all_metrics = sorted(results_dir.glob("metrics_claude_*.json"), key=lambda p: p.stat().st_mtime)
    if not all_metrics:
        raise SystemExit(f"没有找到 metrics 文件：{results_dir}")
    summary_path = average if average.is_file() else all_metrics[-1]
    per_instance_path = rounds[-1] if rounds else summary_path
    return summary_path, per_instance_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--dataset", type=Path, default=SMOKE_DATASET)
    parser.add_argument("--results-root", type=Path, default=None)
    parser.add_argument("--config", type=Path, default=None)
    parser.add_argument("--concurrency", type=int, default=5)
    parser.add_argument("--timeout-minutes", type=int, default=20)
    parser.add_argument("--skip-review", action="store_true")
    parser.add_argument("--eval-rounds", type=int, default=3)
    parser.add_argument("--baseline", type=Path, default=BASELINE)
    args = parser.parse_args()

    dataset = args.dataset.resolve()
    if not dataset.is_file():
        raise SystemExit(f"缺少数据集：{dataset}")
    baseline = json.loads(args.baseline.read_text(encoding="utf-8"))
    run_id = args.run_id or time.strftime("%Y%m%d_%H%M%S")
    results_root = args.results_root.resolve() if args.results_root is not None else (EVAL / "results" / dataset.stem / "reviewpi")
    results_dir = results_root / run_id
    results_dir.mkdir(parents=True, exist_ok=True)

    if not args.skip_review:
        command = [
            sys.executable, str(BRIDGE),
            "--dataset", str(dataset),
            "--results-dir", str(results_dir),
            "--concurrency", str(args.concurrency),
            "--timeout-minutes", str(args.timeout_minutes),
        ]
        if args.config is not None:
            command.extend(["--config", str(args.config)])
        run(command, EVAL)

    run([
        sys.executable, "-m", "pipeline", "run",
        "--stage", "eval", "--reviewer", "claude",
        "--dataset", str(dataset),
        "--results-dir", str(results_dir),
        "--eval-rounds", str(args.eval_rounds),
    ], EVAL)

    summary_path, per_instance_path = resolve_metrics(results_dir)
    metrics = json.loads(summary_path.read_text(encoding="utf-8"))
    per_instance = json.loads(per_instance_path.read_text(encoding="utf-8"))
    summary = metrics.get("summary") or {}
    base = baseline["baseline"]
    new = {
        "precision": summary.get("file_semantic_match_rate", 0.0),
        "recall": summary.get("file_semantic_recall_rate", 0.0),
        "balanced": summary.get("balanced_score", 0.0),
        "generated": summary.get("generated_notes", 0),
        "covered_gt": summary.get("matched_file_semantic_notes", 0),
        "matched_generated": summary.get("matched_generated_notes", 0),
        "missing": summary.get("missing_instances", 0),
    }

    print("\n=== smoke10 对比 ===")
    print(f"{'指标':<18}{'baseline':>10}{'new':>10}{'delta':>10}")
    for key in ("precision", "recall", "balanced", "generated", "covered_gt", "matched_generated"):
        b = base.get(key, 0)
        n = new.get(key, 0)
        print(f"{key:<18}{b:>10}{n:>10}{n - b:>+10}")
    if new["missing"]:
        print(f"WARN missing_instances={new['missing']}（有样本没有结果文件）")

    baseline_by_id = {row["instance_id"]: row for row in baseline.get("selected", [])}
    rows = sorted(per_instance.get("eval_res") or [], key=lambda row: row.get("instance_id", ""))
    print(f"\n{'instance':<45}{'P':>7}{'R':>7}{'B':>7}{'gen':>6}{'cov':>6}{'base':>6}{'Δcov':>7}")
    for row in rows:
        comments = [c for c in (row.get("comments") or []) if c.get("note")]
        covered = sum(1 for c in comments if c.get("file_semantic_match"))
        generated = len(row.get("generated_comments") or [])
        matched = sum(1 for g in (row.get("generated_comments") or []) if g.get("hit_new_gt"))
        precision = matched / generated if generated else 0.0
        recall = covered / len(comments) if comments else 0.0
        balanced = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        base_row = baseline_by_id.get(row.get("instance_id", ""))
        base_covered = (base_row.get("matched_gt", base_row.get("matched")) if base_row else None)
        delta = covered - base_covered if base_covered is not None else 0
        print(f"{row.get('instance_id',''):<45}{precision:>7.3f}{recall:>7.3f}{balanced:>7.3f}"
              f"{generated:>6}{covered:>6}{base_covered if base_covered is not None else '-':>6}{delta:>+7}")
    print(f"\nsummary: {summary_path}")
    print(f"per-instance: {per_instance_path}")
    print(f"baseline: {args.baseline}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
