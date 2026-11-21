#!/usr/bin/env python3
"""归档一次 review-pi 实验：只收 top-level 结果 / metrics / 精简审计，不收 .reviewpi 大目录。

用法：
  python bench/experiments/archive_run.py \
    --results-dir D:/.../results/iterB10/reviewpi/<run-id> \
    --out bench/experiments/2026-11-21-f01/<run-id> \
    --label f01b-v3 \
    --dataset bench/aacr-bench-v2/configs/iterB10.jsonl \
    --log .artifacts/f01b/arm-b-v3-c10.log

纪律：审计 config 快照里任何 key/secret/token 字段一律写成 "[redacted]"。
"""
from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[2]


def redact(value: Any) -> Any:
    if isinstance(value, dict):
        out = {}
        for key, item in value.items():
            lowered = str(key).lower()
            if any(part in lowered for part in ("apikey", "api_key", "secret", "token")):
                out[key] = "[redacted]"
            else:
                out[key] = redact(item)
        return out
    if isinstance(value, list):
        return [redact(item) for item in value]
    return value


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def git_commit() -> str | None:
    try:
        return subprocess.run(
            ["git", "rev-parse", "HEAD"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout.strip()
    except Exception:
        return None


def git_dirty() -> bool | None:
    try:
        out = subprocess.run(
            ["git", "status", "--porcelain"],
            cwd=ROOT,
            capture_output=True,
            text=True,
            check=True,
        ).stdout
        return len(out.strip()) > 0
    except Exception:
        return None


def git_diff_sha256() -> str | None:
    try:
        diff = subprocess.run(
            ["git", "diff", "--binary"],
            cwd=ROOT,
            capture_output=True,
            check=True,
        ).stdout
        return hashlib.sha256(diff).hexdigest()
    except Exception:
        return None


def latest_metrics(results_dir: Path) -> Path | None:
    files = sorted(results_dir.glob("metrics_*.json"), key=lambda p: p.stat().st_mtime, reverse=True)
    return files[0] if files else None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--results-dir", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--log", type=Path, action="append", default=[])
    parser.add_argument("--note", default="")
    args = parser.parse_args()

    results_dir = args.results_dir.resolve()
    out = args.out.resolve()
    out.mkdir(parents=True, exist_ok=True)
    (out / "results").mkdir(exist_ok=True)

    result_files = sorted(
        p for p in results_dir.glob("*.json") if not p.name.startswith("metrics_")
    )
    for path in result_files:
        shutil.copy2(path, out / "results" / path.name)

    metrics = latest_metrics(results_dir)
    if metrics is not None:
        shutil.copy2(metrics, out / "metrics.json")

    audit_rows: list[dict[str, Any]] = []
    statuses: dict[str, int] = {}
    findings = 0
    for path in result_files:
        try:
            result = json.loads(path.read_text(encoding="utf-8"))
        except Exception as error:  # noqa: BLE001 - 归档不应因单条坏文件中止
            audit_rows.append({"file": path.name, "error": str(error)})
            continue
        status = result.get("status", "unknown")
        statuses[status] = statuses.get(status, 0) + 1
        findings += int(result.get("findings_count") or 0)
        row: dict[str, Any] = {
            "file": path.name,
            "instance_id": result.get("instance_id"),
            "repo": result.get("repo"),
            "status": status,
            "findings_count": result.get("findings_count"),
            "duration_seconds": result.get("duration_seconds"),
            "token_usage": result.get("token_usage"),
            "review_pi_exit_code": result.get("review_pi_exit_code"),
        }
        audit_path = result.get("audit_path")
        if isinstance(audit_path, str):
            try:
                audit = json.loads(Path(audit_path).read_text(encoding="utf-8"))
            except Exception as error:  # noqa: BLE001
                row["audit_error"] = str(error)
            else:
                row["audit"] = redact(
                    {
                        "runId": audit.get("runId"),
                        "model": audit.get("model"),
                        "usage": audit.get("usage"),
                        "rounds": audit.get("rounds"),
                        "toolCalls": audit.get("toolCalls"),
                        "truncated": audit.get("truncated"),
                        "mrFilter": audit.get("mrFilter"),
                        "mrBoundary": audit.get("mrBoundary"),
                        "coverage": audit.get("coverage", {}).get("counts"),
                        "coverageSummary": audit.get("coverageSummary"),
                        "shards": audit.get("shards"),
                        "shardTruncation": audit.get("shardTruncation"),
                        "coverageRepair": audit.get("coverageRepair"),
                        "rejectionCounts": audit.get("rejectionCounts"),
                        "config": audit.get("config"),
                    }
                )
        audit_rows.append(row)

    (out / "audit-summary.json").write_text(
        json.dumps(redact(audit_rows), ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )

    logs: list[str] = []
    for log in args.log:
        if log.is_file():
            target = out / "logs" / log.name
            target.parent.mkdir(exist_ok=True)
            shutil.copy2(log, target)
            logs.append(str(target.relative_to(out)))

    manifest = {
        "label": args.label,
        "note": args.note,
        "archived_at": datetime.now(timezone.utc).isoformat(),
        "source_results_dir": str(results_dir),
        "dataset": str(args.dataset),
        "dataset_sha256": sha256(args.dataset) if args.dataset.is_file() else None,
        "review_pi_commit": git_commit(),
        "review_pi_dirty": git_dirty(),
        "review_pi_diff_sha256": git_diff_sha256(),
        "samples": len(result_files),
        "statuses": statuses,
        "findings_count": findings,
        "metrics_file": "metrics.json" if metrics is not None else None,
        "logs": logs,
        "excluded": [".reviewpi (raw audit / transcripts; external, not archived)"],
    }
    (out / "manifest.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(f"archived {len(result_files)} results -> {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
