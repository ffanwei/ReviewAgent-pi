"""从 91 条交集里挑 20 条代表性样本（每语言 2 条，一正一负），用于低成本迭代。

选法：
  - 每个语言 1 条“基线有命中”（hit>=1）+ 1 条“基线零命中”（hit=0）；
  - 优先低耗时/小改动；尽量不同仓库；
  - 覆盖 10 语言、Diff/File/Repo 三种 GT context、四类 category。

产物：
  - data/aacr_bench_v2_iter20.jsonl
  - metrics/iter20-baseline.json（单轮 review-pi + OCR 基线；3 轮基线由 run_iter20 生成）
  - metrics/iter20-selection.md
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List

BENCH = Path("D:/Project/bench/aacr-bench")
EVAL = BENCH / "evaluation"
RAW = BENCH / "dataset/v2/positive_samples.json"
DATASET = EVAL / "data/aacr_bench_v2.jsonl"
INTERSECTION = EVAL / "data/aacr_bench_v2_ocr_rp_ok.jsonl"
RP_METRICS = EVAL / "results/aacr_bench_v2/reviewpi/arm2/metrics_claude_20261116_102219.json"
OCR_METRICS = EVAL / "results/aacr_bench_v2/ocr/ocr-full-v41flash/metrics_ocr_20261116_161311.json"
RP_RESULTS = EVAL / "results/aacr_bench_v2/reviewpi/arm2"
OCR_RESULTS = EVAL / "results/aacr_bench_v2/ocr/ocr-full-v41flash"


def row_stats(row: Dict[str, Any]) -> Dict[str, int]:
    comments = [c for c in (row.get("comments") or []) if c.get("note")]
    generated = row.get("generated_comments") or []
    return {
        "gt": len(comments),
        "covered": sum(1 for c in comments if c.get("file_semantic_match")),
        "generated": len(generated),
        "matched": sum(1 for g in generated if g.get("hit_new_gt")),
    }


def main() -> int:
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    meta: Dict[str, Dict[str, Any]] = {}
    for record in raw:
        matched = re.search(r"github\.com/([^/]+)/([^/]+)/pull/\d+", record.get("githubPrUrl", ""))
        if not matched:
            continue
        iid = f"{matched.group(1)}__{matched.group(2)}@{record['target_commit'][:7]}"
        meta[iid] = {
            "language": record.get("project_main_language"),
            "change": record.get("change_line_count"),
            "comments": record.get("comments") or [],
        }

    intersection = {
        json.loads(line)["instance_id"]
        for line in INTERSECTION.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
    rp = json.loads(RP_METRICS.read_text(encoding="utf-8"))
    ocr = json.loads(OCR_METRICS.read_text(encoding="utf-8"))
    rp_rows = {r["instance_id"]: r for r in rp["eval_res"] if r["instance_id"] in intersection}
    ocr_rows = {r["instance_id"]: r for r in ocr["eval_res"] if r["instance_id"] in intersection}

    by_language: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for iid in intersection:
        rp_stats = row_stats(rp_rows[iid])
        ocr_stats = row_stats(ocr_rows[iid]) if iid in ocr_rows else {"covered": 0, "generated": 0, "matched": 0}
        result = json.loads((RP_RESULTS / f"{iid.replace('/', '__')}.json").read_text(encoding="utf-8"))
        info = meta[iid]
        by_language[info["language"]].append({
            "instance_id": iid,
            "language": info["language"],
            "repo": iid.split("@")[0].replace("__", "/"),
            "gt": rp_stats["gt"],
            "covered": rp_stats["covered"],
            "generated": rp_stats["generated"],
            "matched": rp_stats["matched"],
            "ocr_covered": ocr_stats["covered"],
            "ocr_generated": ocr_stats["generated"],
            "ocr_matched": ocr_stats["matched"],
            "duration": result.get("duration_seconds") or 0,
            "change": info["change"],
            "context": dict(Counter(c.get("context") for c in info["comments"])),
            "category": dict(Counter(c.get("category") for c in info["comments"])),
        })

    selected: List[Dict[str, Any]] = []
    for language in sorted(by_language):
        pool = sorted(by_language[language], key=lambda r: r["duration"] + 0.2 * (r["change"] or 0))
        positives = [r for r in pool if r["matched"] >= 1]
        negatives = [r for r in pool if r["matched"] == 0]
        pick_pos = positives[0] if positives else pool[0]
        pick_neg = next((r for r in negatives if r["repo"] != pick_pos["repo"]), None)
        if pick_neg is None:
            pick_neg = negatives[0] if negatives else next((r for r in pool if r["repo"] != pick_pos["repo"]), None)
        chosen = [pick_pos] + ([pick_neg] if pick_neg and pick_neg["instance_id"] != pick_pos["instance_id"] else [])
        for row in pool:
            if len(chosen) >= 2:
                break
            if all(row["instance_id"] != c["instance_id"] for c in chosen) and all(
                row["repo"] != c["repo"] for c in chosen
            ):
                chosen.append(row)
        selected.extend(chosen)

    selected.sort(key=lambda r: (r["language"], -r["matched"], r["duration"]))
    instances = {
        json.loads(line)["instance_id"]: json.loads(line)
        for line in DATASET.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
    out_dataset = EVAL / "data/aacr_bench_v2_iter20.jsonl"
    with out_dataset.open("w", encoding="utf-8") as handle:
        for row in selected:
            handle.write(json.dumps(instances[row["instance_id"]], ensure_ascii=False) + "\n")

    def aggregate(rows: List[Dict[str, Any]], prefix: str) -> Dict[str, Any]:
        expected = sum(r["gt"] for r in rows)
        covered = sum(r[f"{prefix}covered"] for r in rows)
        generated = sum(r[f"{prefix}generated"] for r in rows)
        matched = sum(r[f"{prefix}matched"] for r in rows)
        precision = matched / generated if generated else 0.0
        recall = covered / expected if expected else 0.0
        balanced = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0
        return {
            "samples": len(rows),
            "expected_gt": expected,
            "covered_gt": covered,
            "generated": generated,
            "matched_generated": matched,
            "precision": round(precision, 4),
            "recall": round(recall, 4),
            "balanced": round(balanced, 4),
        }

    # token/time
    rp_tokens = rp_noncached = rp_duration = 0
    ocr_tokens = ocr_noncached = ocr_duration = 0
    for row in selected:
        safe = row["instance_id"].replace("/", "__")
        r = json.loads((RP_RESULTS / f"{safe}.json").read_text(encoding="utf-8"))
        tu = r.get("token_usage") or {}
        rp_tokens += (tu.get("input_tokens") or 0) + (tu.get("output_tokens") or 0) + (tu.get("cache_read_input_tokens") or 0)
        rp_noncached += (tu.get("input_tokens") or 0) + (tu.get("output_tokens") or 0)
        rp_duration += r.get("duration_seconds") or 0
        o = json.loads((OCR_RESULTS / f"{safe}.json").read_text(encoding="utf-8"))
        s = (o.get("review") or {}).get("summary") or {}
        ocr_tokens += s.get("total_tokens") or 0
        ocr_noncached += (s.get("total_tokens") or 0) - (s.get("cache_read_tokens") or 0)
        ocr_duration += o.get("duration_seconds") or 0

    baseline = {
        "dataset": str(out_dataset),
        "selection": {
            "source": "91 条交集",
            "languages": 10,
            "per_language": 2,
            "policy": "1 条基线有命中 + 1 条基线零命中；优先低耗时/小改动；尽量不同仓库",
            "note": "outcome-stratified development set, not an unbiased benchmark",
        },
        "selected": selected,
        "baseline": {**aggregate(selected, ""), "sum_duration_seconds": round(rp_duration, 1),
                     "max_duration_seconds": round(max(r["duration"] for r in selected), 1),
                     "total_tokens": rp_tokens, "noncached_plus_output": rp_noncached},
        "ocr_baseline": {**aggregate(selected, "ocr_"), "sum_duration_seconds": round(ocr_duration, 1),
                         "total_tokens": ocr_tokens, "noncached_plus_output": ocr_noncached},
        "coverage": {
            "languages": dict(Counter(r["language"] for r in selected)),
            "context": dict(sum((Counter(r["context"]) for r in selected), Counter())),
            "category": dict(sum((Counter(r["category"]) for r in selected), Counter())),
        },
    }
    (EVAL / "metrics/iter20-baseline.json").write_text(
        json.dumps(baseline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    lines = ["# iter20 迭代集", "", "来源：91 条交集，每语言 2 条（一正一负）。", "",
             "| 语言 | instance | 仓库 | GT | 基线命中 | 生成 | 耗时 | OCR 覆盖 |",
             "|---|---|---|---:|---:|---:|---:|---:|"]
    for row in selected:
        lines.append(
            f"| {row['language']} | {row['instance_id']} | {row['repo']} | {row['gt']} | {row['matched']} | "
            f"{row['generated']} | {row['duration']:.0f} | {row['ocr_covered']} |"
        )
    lines += ["", "## 覆盖", "",
              f"- 语言：{baseline['coverage']['languages']}",
              f"- GT context：{baseline['coverage']['context']}",
              f"- GT category：{baseline['coverage']['category']}",
              f"- 单轮基线：P {baseline['baseline']['precision']} / R {baseline['baseline']['recall']} / B {baseline['baseline']['balanced']}",
              f"- 评审耗时合计 {baseline['baseline']['sum_duration_seconds']:.0f}s；最长 {baseline['baseline']['max_duration_seconds']:.0f}s",
              f"- OCR 参考：P {baseline['ocr_baseline']['precision']} / R {baseline['ocr_baseline']['recall']} / B {baseline['ocr_baseline']['balanced']}"]
    (EVAL / "metrics/iter20-selection.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print(json.dumps({"selected": len(selected), "baseline": baseline["baseline"], "ocr": baseline["ocr_baseline"],
                      "coverage": baseline["coverage"]}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
