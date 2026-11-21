"""AACR-Bench v2 可复现性检查：逐样本确认 base/head commit 是否仍可从 GitHub 取得。

背景：数据集快照的 PR 分支 commit 可能因 force-push / squash merge 不可达，
GitHub 会返回 "not our ref"。本脚本用元数据级 partial clone（--filter=tree:0）
检查全部样本，并对缺失 commit 尝试按 PR ref 恢复（refs/pull/<N>/head 与 /merge）。

产物：
  results/aacr_bench_v2_availability.json   逐样本状态
  data/aacr_bench_v2_available.jsonl        只含 base+head 都可取得的样本
"""
from __future__ import annotations

import json
import os
import re
import subprocess
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL_DIR))

from schema import ReviewInstance, load_instances  # noqa: E402

DATASET = EVAL_DIR / "data" / "aacr_bench_v2.jsonl"
RAW = EVAL_DIR / "benchmark" / "AACR-Bench" / "v2" / "positive_samples.json"
REPO_DIR = EVAL_DIR / "repo"
OUT_JSON = EVAL_DIR / "results" / "aacr_bench_v2_availability.json"
OUT_JSONL = EVAL_DIR / "data" / "aacr_bench_v2_available.jsonl"


def run(cmd: List[str], timeout: int = 7200) -> subprocess.CompletedProcess:
    return subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", timeout=timeout, check=False)


def git(repo: Path, *args: str, timeout: int = 7200) -> subprocess.CompletedProcess:
    return run(["git", "-c", "core.longpaths=true", "-C", str(repo), *args], timeout=timeout)


def ensure_metadata_clone(repo: str) -> Tuple[Optional[Path], Optional[str]]:
    target = REPO_DIR / repo.replace("/", "__")
    if (target / ".git").exists():
        return target, None
    target.parent.mkdir(parents=True, exist_ok=True)
    result = run(["git", "-c", "core.longpaths=true", "clone", "-q",
                  "--filter=tree:0", "--no-checkout",
                  f"https://github.com/{repo}.git", str(target)])
    if result.returncode != 0:
        return None, result.stderr.strip()[-500:]
    return target, None


def has_commit(repo: Path, commit: str) -> bool:
    env = {**os.environ, "GIT_NO_LAZY_FETCH": "1"}
    result = subprocess.run(["git", "-C", str(repo), "cat-file", "-e", f"{commit}^{{commit}}"],
                            capture_output=True, text=True, env=env, check=False)
    return result.returncode == 0


def try_pr_ref(repo: Path, pr_number: str) -> None:
    for ref in (f"refs/pull/{pr_number}/head", f"refs/pull/{pr_number}/merge"):
        run(["git", "-c", "core.longpaths=true", "-C", str(repo), "fetch", "-q",
             "--filter=tree:0", "origin", f"{ref}:refs/bench/{ref.replace('/', '_')}"], timeout=1800)


def main() -> int:
    instances = load_instances(DATASET)
    raw = json.loads(RAW.read_text(encoding="utf-8"))
    pr_by_commits: Dict[Tuple[str, str, str], str] = {}
    for record in raw:
        matched = re.search(r"github\.com/([^/]+)/([^/]+)/pull/(\d+)", record.get("githubPrUrl", ""))
        if not matched:
            continue
        repo = f"{matched.group(1)}/{matched.group(2)}"
        key = (repo, record.get("source_commit"), record.get("target_commit"))
        pr_by_commits[key] = matched.group(3)

    repos = sorted({instance.repo for instance in instances})
    print(f"repos={len(repos)} instances={len(instances)}", flush=True)
    clone_errors: Dict[str, str] = {}

    def clone_one(repo: str) -> None:
        _, error = ensure_metadata_clone(repo)
        if error:
            clone_errors[repo] = error

    with ThreadPoolExecutor(max_workers=6) as pool:
        list(pool.map(clone_one, repos))
    if clone_errors:
        print(f"clone errors: {json.dumps(clone_errors, ensure_ascii=False)}", flush=True)

    rows: List[Dict[str, Any]] = []
    available: List[ReviewInstance] = []
    for index, instance in enumerate(instances, 1):
        repo_path = REPO_DIR / instance.repo.replace("/", "__")
        base_ok = repo_path.is_dir() and has_commit(repo_path, instance.base_commit)
        head_ok = repo_path.is_dir() and has_commit(repo_path, instance.head_commit)
        recovered = False
        if (not base_ok or not head_ok) and repo_path.is_dir():
            pr_number = pr_by_commits.get((instance.repo, instance.base_commit, instance.head_commit))
            if pr_number:
                try_pr_ref(repo_path, pr_number)
                base_ok = has_commit(repo_path, instance.base_commit)
                head_ok = has_commit(repo_path, instance.head_commit)
                recovered = base_ok and head_ok
        status = "ok" if base_ok and head_ok else ("base_missing" if not base_ok else "head_missing")
        rows.append({
            "instance_id": instance.instance_id,
            "repo": instance.repo,
            "base_ok": base_ok,
            "head_ok": head_ok,
            "recovered": recovered,
            "status": status,
        })
        if base_ok and head_ok:
            available.append(instance)
        print(f"[{index}/{len(instances)}] {instance.instance_id} base={base_ok} head={head_ok}"
              f"{' recovered' if recovered else ''}", flush=True)

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({"rows": rows}, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    with OUT_JSONL.open("w", encoding="utf-8") as handle:
        for instance in available:
            handle.write(json.dumps(instance.to_dict(), ensure_ascii=False) + "\n")

    ok = sum(1 for row in rows if row["status"] == "ok")
    print(f"summary: ok={ok} unavailable={len(rows)-ok} clone_errors={len(clone_errors)}")
    print(f"wrote {OUT_JSON} and {OUT_JSONL} ({len(available)} instances)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
