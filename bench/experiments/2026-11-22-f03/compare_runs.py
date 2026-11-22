#!/usr/bin/env python3
"""F-03 串行 / 并行批次对比：墙钟、token、片数、findings、429。

用法：
  python bench/experiments/2026-11-22-f03/compare_runs.py \
    --serial  D:/.../results/iterF91/reviewpi/f03-serial-20261122 \
    --parallel D:/.../results/iterF91/reviewpi/f03-parallel-20261122 \
    --out bench/experiments/2026-11-22-f03/comparison.json

不跑 judge；只读 top-level 结果 JSON、审计摘要与 request-timeline。
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Any


def load_result(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def timeline_stats(audit_path: str | None) -> dict[str, int]:
    if not audit_path:
        return {"attempts": 0, "status429": 0, "errors": 0}
    audit = Path(audit_path)
    task_dir = audit.parents[1]
    runs_dir = task_dir / "runs"
    attempts = 0
    status429 = 0
    errors = 0
    for tl in runs_dir.rglob("request-timeline.jsonl"):
        for line in tl.read_text(encoding="utf-8", errors="replace").splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                entry = json.loads(line)
            except json.JSONDecodeError:
                continue
            if entry.get("kind") != "attempt":
                continue
            attempts += 1
            if entry.get("status") == 429:
                status429 += 1
            if entry.get("error") is not None:
                errors += 1
    return {"attempts": attempts, "status429": status429, "errors": errors}


def summarize(results_dir: Path) -> dict[str, dict[str, Any]]:
    out: dict[str, dict[str, Any]] = {}
    for path in sorted(results_dir.glob("*.json")):
        if path.name.startswith("metrics_"):
            continue
        result = load_result(path)
        instance = result.get("instance_id") or path.stem
        usage = result.get("token_usage") or {}
        audit_path = result.get("audit_path")
        audit: dict[str, Any] = {}
        if audit_path:
            try:
                audit = json.loads(Path(audit_path).read_text(encoding="utf-8"))
            except Exception:
                audit = {}
        shards = audit.get("shards") or []
        coverage = (audit.get("coverage") or {}).get("counts") or {}
        out[instance] = {
            "status": result.get("status"),
            "duration_seconds": result.get("duration_seconds"),
            "findings": result.get("findings_count"),
            "input_tokens": usage.get("input_tokens"),
            "output_tokens": usage.get("output_tokens"),
            "cache_read_tokens": usage.get("cache_read_input_tokens"),
            "total_tokens": sum(
                int(usage.get(key) or 0)
                for key in ("input_tokens", "output_tokens", "cache_read_input_tokens")
            ),
            "shards": len(shards),
            "coverage": coverage,
            **timeline_stats(audit_path),
        }
    return out


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--serial", type=Path, required=True)
    parser.add_argument("--parallel", type=Path, required=True)
    parser.add_argument("--out", type=Path, required=True)
    args = parser.parse_args()

    serial = summarize(args.serial)
    parallel = summarize(args.parallel)
    rows = []
    for instance in sorted(set(serial) | set(parallel)):
        s = serial.get(instance, {})
        p = parallel.get(instance, {})
        s_dur = s.get("duration_seconds")
        p_dur = p.get("duration_seconds")
        rows.append(
            {
                "instance": instance,
                "serial": s,
                "parallel": p,
                "speedup": round(s_dur / p_dur, 2) if s_dur and p_dur else None,
                "token_ratio": (
                    round(p.get("total_tokens", 0) / s.get("total_tokens", 1), 3)
                    if s.get("total_tokens")
                    else None
                ),
            }
        )

    aggregate = {
        "samples": len(rows),
        "serial_total_seconds": sum(r["serial"].get("duration_seconds") or 0 for r in rows),
        "parallel_total_seconds": sum(r["parallel"].get("duration_seconds") or 0 for r in rows),
        "serial_tokens": sum(r["serial"].get("total_tokens") or 0 for r in rows),
        "parallel_tokens": sum(r["parallel"].get("total_tokens") or 0 for r in rows),
        "serial_429": sum(r["serial"].get("status429") or 0 for r in rows),
        "parallel_429": sum(r["parallel"].get("status429") or 0 for r in rows),
        "serial_attempts": sum(r["serial"].get("attempts") or 0 for r in rows),
        "parallel_attempts": sum(r["parallel"].get("attempts") or 0 for r in rows),
    }
    aggregate["wall_clock_speedup"] = (
        round(aggregate["serial_total_seconds"] / aggregate["parallel_total_seconds"], 2)
        if aggregate["parallel_total_seconds"]
        else None
    )
    payload = {"aggregate": aggregate, "rows": rows}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    print("| instance | 片数 | 串行 s | 并行 s | 加速 | 串行 token | 并行 token | 429(s/p) |")
    print("|---|---:|---:|---:|---:|---:|---:|---:|")
    for row in rows:
        s, p = row["serial"], row["parallel"]
        print(
            f"| {row['instance']} | {s.get('shards')}/{p.get('shards')} | "
            f"{s.get('duration_seconds')} | {p.get('duration_seconds')} | "
            f"{row['speedup']}x | {s.get('total_tokens')} | {p.get('total_tokens')} | "
            f"{s.get('status429')}/{p.get('status429')} |"
        )
    print()
    print(json.dumps(aggregate, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
