"""生成小/大/混合/全量测试配置（不改模型、不重跑；基线全部来自已有结果）。

定义：
  - 小 diff：`git diff` 文件 < 50KB
  - 大 diff：`git diff` 文件 >= 50KB
  - 小池排序：按语言轮转（字母序）；语言内正/负样本交替，再按耗时+0.2*改动行数排序
  - 大池排序：按语言轮转（语言按该语言最大 B 差距降序）；语言内按 B 差距/无 GT 意见数降序

配置：
  iterS10  = 小池前 10
  iterS20      = 小池前 20
  iterB2   = 大池前 2
  iterB5   = 大池前 5
  iterB10  = 大池前 10
  iterM10  = 小池前 8 + 大池前 2
  iterM20  = 小池前 15 + 大池前 5
  iterM50  = 小池前 40 + 大池前 10
  iterF91  = 91 条交集全量

产物：
  docs/bench/configs/<set>.jsonl
  docs/bench/metrics/configs/<set>-baseline.json
  docs/bench/metrics/configs/summary.{json,md}
"""
from __future__ import annotations

import json
import re
from collections import Counter, defaultdict
from pathlib import Path
from typing import Any, Dict, List

BENCH = Path("D:/Project/bench/aacr-bench")
EVAL = BENCH / "evaluation"
SRC_DATASET = EVAL / "data/aacr_bench_v2.jsonl"
INTERSECTION = EVAL / "data/aacr_bench_v2_ocr_rp_ok.jsonl"
RAW = BENCH / "dataset/v2/positive_samples.json"
RP_METRICS = EVAL / "results/aacr_bench_v2/reviewpi/arm2/metrics_claude_20261116_102219.json"
OCR_METRICS = EVAL / "results/aacr_bench_v2/ocr/ocr-full-v41flash/metrics_ocr_20261116_161311.json"
RP_RESULTS = EVAL / "results/aacr_bench_v2/reviewpi/arm2"
OCR_RESULTS = EVAL / "results/aacr_bench_v2/ocr/ocr-full-v41flash"
DIFFS = RP_RESULTS / ".reviewpi/diff"

OUT_CONFIGS = Path("D:/Project/ReviewAgent-pi/docs/bench/configs")
OUT_METRICS = Path("D:/Project/ReviewAgent-pi/docs/bench/metrics/configs")
SMALL_MAX = 50_000


def stats(row: Dict[str, Any]) -> Dict[str, int]:
    comments = [c for c in (row.get("comments") or []) if c.get("note")]
    gt_paths = {c.get("path") for c in comments}
    generated = row.get("generated_comments") or []
    on_gt = sum(1 for g in generated if g.get("path") in gt_paths)
    matched = sum(1 for g in generated if g.get("hit_new_gt"))
    duplicate = sum(
        1 for g in generated
        if g.get("path") in gt_paths and not g.get("hit_new_gt") and (g.get("matched_gt_indices") or [])
    )
    unmatched_on_gt = on_gt - matched - duplicate
    return {
        "gt": len(comments),
        "covered": sum(1 for c in comments if c.get("file_semantic_match")),
        "generated": len(generated),
        "matched": matched,
        "on_gt": on_gt,
        "non_gt": len(generated) - on_gt,
        "duplicate": duplicate,
        "unmatched_on_gt": unmatched_on_gt,
        "fp_total": len(generated) - matched,
    }


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


def fp_aggregate(rows: List[Dict[str, Any]], prefix: str) -> Dict[str, Any]:
    def key(k: str) -> str:
        return f"{prefix}{k}" if prefix else k
    generated = sum(r[key("generated")] for r in rows)
    matched = sum(r[key("matched")] for r in rows)
    fp = generated - matched
    non_gt = sum(r[key("non_gt")] for r in rows)
    unmatched = sum(r[key("unmatched_on_gt")] for r in rows)
    duplicate = sum(r[key("duplicate")] for r in rows)
    rate = (lambda v: round(v / generated, 4) if generated else 0.0)
    return {
        "generated": generated,
        "matched_generated": matched,
        "false_positives": fp,
        "false_positive_rate": rate(fp),
        "non_gt_file": non_gt,
        "non_gt_file_rate": rate(non_gt),
        "unmatched_on_gt_file": unmatched,
        "unmatched_on_gt_rate": rate(unmatched),
        "duplicate_hit": duplicate,
        "duplicate_rate": rate(duplicate),
    }


def interleave(rows: List[Dict[str, Any]]) -> List[Dict[str, Any]]:
    positives = [r for r in rows if r["matched"] >= 1]
    negatives = [r for r in rows if r["matched"] == 0]
    out: List[Dict[str, Any]] = []
    for i in range(max(len(positives), len(negatives))):
        if i < len(positives):
            out.append(positives[i])
        if i < len(negatives):
            out.append(negatives[i])
    return out


def main() -> int:
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    meta: Dict[str, Dict[str, Any]] = {}
    for record in raw:
        matched = re.search(r"github\.com/([^/]+)/([^/]+)/pull/\d+", record.get("githubPrUrl", ""))
        if matched:
            meta[f"{matched.group(1)}__{matched.group(2)}@{record['target_commit'][:7]}"] = record
    intersection = [
        json.loads(line)["instance_id"]
        for line in INTERSECTION.read_text(encoding="utf-8").splitlines()
        if line.strip()
    ]
    instances = {
        json.loads(line)["instance_id"]: json.loads(line)
        for line in SRC_DATASET.read_text(encoding="utf-8").splitlines()
        if line.strip()
    }
    rp = json.loads(RP_METRICS.read_text(encoding="utf-8"))
    ocr = json.loads(OCR_METRICS.read_text(encoding="utf-8"))
    rp_rows = {r["instance_id"]: r for r in rp["eval_res"] if r["instance_id"] in intersection}
    ocr_rows = {r["instance_id"]: r for r in ocr["eval_res"] if r["instance_id"] in intersection}

    samples: List[Dict[str, Any]] = []
    for iid in intersection:
        rp_s = stats(rp_rows[iid])
        ocr_s = stats(ocr_rows[iid])
        result = json.loads((RP_RESULTS / f"{iid.replace('/', '__')}.json").read_text(encoding="utf-8"))
        usage = result.get("token_usage") or {}
        diff_path = DIFFS / f"{iid.replace('/', '__')}.diff"
        diff_size = diff_path.stat().st_size if diff_path.is_file() else 0
        record = meta[iid]
        ocr_result = json.loads((OCR_RESULTS / f"{iid.replace('/', '__')}.json").read_text(encoding="utf-8"))
        ocr_summary = (ocr_result.get("review") or {}).get("summary") or {}
        samples.append({
            "instance_id": iid,
            "language": record.get("project_main_language"),
            "change": record.get("change_line_count") or 0,
            "diff_size": diff_size,
            "duration": result.get("duration_seconds") or 0,
            "tokens": (usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0) + (usage.get("cache_read_input_tokens") or 0),
            "noncached": (usage.get("input_tokens") or 0) + (usage.get("output_tokens") or 0),
            "ocr_tokens": ocr_summary.get("total_tokens") or 0,
            "ocr_noncached": (ocr_summary.get("total_tokens") or 0) - (ocr_summary.get("cache_read_tokens") or 0),
            "ocr_duration": ocr_result.get("duration_seconds") or 0,
            "context": Counter(c.get("context") for c in (record.get("comments") or [])),
            "category": Counter(c.get("category") for c in (record.get("comments") or [])),
            **{k: rp_s[k] for k in ("gt", "covered", "generated", "matched", "on_gt", "non_gt", "duplicate", "unmatched_on_gt", "fp_total")},
            **{f"ocr_{k}": ocr_s[k] for k in ("covered", "generated", "matched", "on_gt", "non_gt", "duplicate", "unmatched_on_gt", "fp_total")},
        })
    for s in samples:
        s["gap"] = round((s["ocr_matched"] / s["ocr_generated"] if s["ocr_generated"] else 0) - (s["matched"] / s["generated"] if s["generated"] else 0), 4)
        # use B gap instead of precision gap for ordering
        def b(m, g, c, e):
            p = m / g if g else 0; r = c / e if e else 0
            return 2 * p * r / (p + r) if p + r else 0
        s["gap"] = round(b(s["ocr_matched"], s["ocr_generated"], s["ocr_covered"], s["gt"]) - b(s["matched"], s["generated"], s["covered"], s["gt"]), 4)

    small = [s for s in samples if s["diff_size"] < SMALL_MAX]
    large = [s for s in samples if s["diff_size"] >= SMALL_MAX]

    # 小池：语言字母序轮转；语言内正负交替 + 耗时/改动量评分
    small_by_lang: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for s in small:
        small_by_lang[s["language"]].append(s)
    for lang in small_by_lang:
        small_by_lang[lang].sort(key=lambda s: s["duration"] + 0.2 * s["change"])
        small_by_lang[lang] = interleave(small_by_lang[lang])
    small_order: List[Dict[str, Any]] = []
    langs = sorted(small_by_lang)
    for i in range(max((len(v) for v in small_by_lang.values()), default=0)):
        for lang in langs:
            if i < len(small_by_lang[lang]):
                small_order.append(small_by_lang[lang][i])

    # 大池：语言按该语言最大 B 差距降序；语言内按差距/无 GT 意见降序
    large_by_lang: Dict[str, List[Dict[str, Any]]] = defaultdict(list)
    for s in large:
        large_by_lang[s["language"]].append(s)
    for lang in large_by_lang:
        large_by_lang[lang].sort(key=lambda s: (-s["gap"], -s["non_gt"], s["duration"]))
    lang_order = sorted(large_by_lang, key=lambda lang: -max(x["gap"] for x in large_by_lang[lang]))
    large_order: List[Dict[str, Any]] = []
    for i in range(max((len(v) for v in large_by_lang.values()), default=0)):
        for lang in lang_order:
            if i < len(large_by_lang[lang]):
                large_order.append(large_by_lang[lang][i])

    sets_def = {
        "iterS10": small_order[:10],
        "iterS20": small_order[:20],
        "iterB2": large_order[:2],
        "iterB5": large_order[:5],
        "iterB10": large_order[:10],
        "iterM10": small_order[:8] + large_order[:2],
        "iterM20": small_order[:15] + large_order[:5],
        "iterM50": small_order[:40] + large_order[:10],
        "iterF91": samples,
    }

    OUT_CONFIGS.mkdir(parents=True, exist_ok=True)
    OUT_METRICS.mkdir(parents=True, exist_ok=True)
    summary = []
    for name, rows in sets_def.items():
        # unique by instance_id, preserve order
        seen = set(); selected = []
        for r in rows:
            if r["instance_id"] not in seen:
                seen.add(r["instance_id"]); selected.append(r)
        with (OUT_CONFIGS / f"{name}.jsonl").open("w", encoding="utf-8") as fh:
            for r in selected:
                fh.write(json.dumps(instances[r["instance_id"]], ensure_ascii=False) + "\n")
        rp_tokens = sum(r["tokens"] for r in selected)
        rp_noncached = sum(r["noncached"] for r in selected)
        rp_duration = sum(r["duration"] for r in selected)
        ocr_tokens = sum(r["ocr_tokens"] for r in selected)
        ocr_noncached = sum(r["ocr_noncached"] for r in selected)
        ocr_duration = sum(r["ocr_duration"] for r in selected)
        baseline = {
            "definition": {
                "name": name,
                "small_max_bytes": SMALL_MAX,
                "small": sum(1 for r in selected if r["diff_size"] < SMALL_MAX),
                "large": sum(1 for r in selected if r["diff_size"] >= SMALL_MAX),
                "policy": "small = diff < 50KB; large = diff >= 50KB; small/large pools ordered by language round-robin; not an unbiased benchmark",
            },
            "selected": [{**r, "matched_gt": r["matched"], "covered_gt": r["covered"]} for r in selected],
            "baseline": {**aggregate(selected, ""), "sum_duration_seconds": round(rp_duration, 1),
                         "max_duration_seconds": round(max((r["duration"] for r in selected), default=0), 1),
                         "total_tokens": rp_tokens, "noncached_plus_output": rp_noncached},
            "false_positives": fp_aggregate(selected, ""),
            "ocr_false_positives": fp_aggregate(selected, "ocr_"),
            "ocr_baseline": {**aggregate(selected, "ocr_"), "sum_duration_seconds": round(ocr_duration, 1),
                             "total_tokens": ocr_tokens, "noncached_plus_output": ocr_noncached},
            "coverage": {
                "languages": dict(Counter(r["language"] for r in selected)),
                "context": dict(sum((r["context"] for r in selected), Counter())),
                "category": dict(sum((r["category"] for r in selected), Counter())),
            },
        }
        (OUT_METRICS / f"{name}-baseline.json").write_text(
            json.dumps(baseline, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
        )
        summary.append({
            "name": name,
            "samples": len(selected),
            "small": baseline["definition"]["small"],
            "large": baseline["definition"]["large"],
            "review_pi": baseline["baseline"],
            "review_pi_fp": baseline["false_positives"],
            "ocr": baseline["ocr_baseline"],
            "ocr_fp": baseline["ocr_false_positives"],
            "coverage": baseline["coverage"],
        })
        print(name, "n", len(selected), "small", baseline["definition"]["small"], "large", baseline["definition"]["large"],
              "RP B", baseline["baseline"]["balanced"], "OCR B", baseline["ocr_baseline"]["balanced"])

    (OUT_METRICS / "summary.json").write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    lines = ["# 测试配置基线", "", "| 配置 | 样本 | 小 diff | 大 diff | review-pi B | OCR B | GT |", "|---|---:|---:|---:|---:|---:|---:|"]
    for row in summary:
        lines.append(f"| {row['name']} | {row['samples']} | {row['small']} | {row['large']} | "
                     f"{row['review_pi']['balanced']} | {row['ocr']['balanced']} | {row['review_pi']['expected_gt']} |")
    (OUT_METRICS / "summary.md").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("wrote", OUT_CONFIGS, OUT_METRICS)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
