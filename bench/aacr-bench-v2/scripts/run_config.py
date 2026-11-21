"""按配置名跑 review-pi + judge 的便捷入口，复用 bench/aacr-bench-v2/configs 与 metrics/configs。

用法：
    python run_config.py --list
    python run_config.py --config iters10 --run-id after-change
    python run_config.py --config iterB5 --run-id after-change --review-config C:/Users/Li/.PiAgent/benchmark-aacr-v2.jsonc
    python run_config.py --config iterM20 --run-id after-change --skip-review   # 只重评已有结果

实际执行的是 run_smoke.py，并自动传入：
  --dataset  bench/aacr-bench-v2/configs/<config>.jsonl
  --baseline bench/aacr-bench-v2/metrics/configs/<config>-baseline.json
"""
from __future__ import annotations

import argparse
import subprocess
import sys
from pathlib import Path

DOCS = Path("D:/Project/ReviewAgent-pi/bench/aacr-bench-v2")
CONFIGS = DOCS / "configs"
BASELINES = DOCS / "metrics/configs"
SMOKE_RUNNER = Path(__file__).resolve().parent / "run_smoke.py"


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--config", default=None, help="配置名（iters10/s20/iterB2/...）")
    parser.add_argument("--list", action="store_true")
    parser.add_argument("--run-id", default=None)
    parser.add_argument("--review-config", type=Path, default=None, help="review-pi 的 PiAgent 配置")
    parser.add_argument("--eval-rounds", type=int, default=1)
    parser.add_argument("--skip-review", action="store_true")
    parser.add_argument("--concurrency", type=int, default=5)
    parser.add_argument("--timeout-minutes", type=int, default=30)
    args = parser.parse_args()

    if args.list or args.config is None:
        for path in sorted(CONFIGS.glob("*.jsonl")):
            print(path.stem)
        return 0

    dataset = CONFIGS / f"{args.config}.jsonl"
    baseline = BASELINES / f"{args.config}-baseline.json"
    if not dataset.is_file():
        raise SystemExit(f"缺少配置数据集：{dataset}")
    if not baseline.is_file():
        raise SystemExit(f"缺少基线：{baseline}")

    command = [
        sys.executable, str(SMOKE_RUNNER),
        "--dataset", str(dataset),
        "--baseline", str(baseline),
        "--run-id", args.run_id or f"{args.config}-run",
        "--eval-rounds", str(args.eval_rounds),
        "--concurrency", str(args.concurrency),
        "--timeout-minutes", str(args.timeout_minutes),
    ]
    if args.review_config is not None:
        command.extend(["--config", str(args.review_config)])
    if args.skip_review:
        command.append("--skip-review")
    print("$", " ".join(command), flush=True)
    subprocess.run(command, cwd=str(SMOKE_RUNNER.parent), check=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
