"""AACR-Bench -> review-pi 桥接：跑 review-pi，把结果写成评测框架能读的结果文件。

为什么是外部桥接而不是改 review-pi：
  - 产品零改动；`--config` 负责单次口径覆盖（如 findingScope），`reviews_all.json`
    是恒产真源，字段足以映射到框架的 Claude 结果结构。
  - 评测框架只按 `<safe_id>.json` 读结果，因此本脚本只要把文件写对即可。

关键对齐纪律（详见 README / 讨论）：
  1. 每条样本都必须落结果文件——包括 review-pi 的「跳过」与失败。否则框架把它
     计入 missing_instances 并从分母剔除，指标会虚高。
  2. 用顶层合并后的 reviews_all.json（分片模式下不要读 shards/*）。
  3. 只做路径归一（反斜杠 / ./ 前缀 / 绝对路径去仓库前缀），不按 diff 文件集
     过滤——越界 finding 交给评测框架算误报，保持诚实。
  4. 产物落在 results_dir 下的 .reviewpi/（tasks / cwd / diff），便于复盘。

用法（在 evaluation/ 内、venv 激活、网络代理只影响 git）：
    python aacr_reviewpi_bridge.py \
        --dataset data/aacr_bench_v2.jsonl \
        --results-dir results/aacr_bench_v2/reviewpi/arm2 \
        --config C:/Users/Li/.PiAgent/benchmark-aacr-v2.jsonc \
        --concurrency 4
"""
from __future__ import annotations

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import threading
import time
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

EVAL_DIR = Path(__file__).resolve().parent
sys.path.insert(0, str(EVAL_DIR))

from repo_utils import clean_worktree  # noqa: E402
from schema import ReviewInstance, load_instances  # noqa: E402

DEFAULT_REVIEW_PI_BIN = Path("D:/Project/ReviewAgent-pi/packages/review-pi/bin/review-pi.js")
DEFAULT_REPO_DIR = EVAL_DIR / "repo"

_print_lock = threading.Lock()


def log(message: str) -> None:
    with _print_lock:
        print(f"[{time.strftime('%H:%M:%S')}] {message}", flush=True)


def run(command: List[str], cwd: Optional[Path] = None, timeout: Optional[int] = None,
        env: Optional[Dict[str, str]] = None) -> subprocess.CompletedProcess:
    return subprocess.run(
        command,
        cwd=str(cwd) if cwd else None,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=timeout,
        env=env,
        check=False,
    )


def git(repo: Path, *args: str, timeout: int = 3600) -> subprocess.CompletedProcess:
    return run(["git", "-c", "core.longpaths=true", "-c", "core.autocrlf=false", "-C", str(repo), *args],
               timeout=timeout)


def enable_sparse_exclude(repo: Path, top_level: str) -> None:
    """Windows 无法创建含尾随空格/点的目录：关掉 NTFS 路径保护，并把该顶层目录
    排除出工作区（只影响 checkout 的文件，不影响 git diff 的对象比对）。

    这些是公开 benchmark 仓库，不是恶意输入；保护关闭仅作用于评测缓存仓库。
    """
    git(repo, "config", "core.protectNTFS", "false")
    git(repo, "config", "core.sparseCheckout", "true")
    git(repo, "config", "core.sparseCheckoutCone", "false")
    sparse = repo / ".git" / "info" / "sparse-checkout"
    lines = [line for line in sparse.read_text(encoding="utf-8").splitlines() if line.strip()] \
        if sparse.is_file() else []
    if "/*" not in lines:
        lines.insert(0, "/*")
    for pattern in (f"!/{top_level}/", f"!/{top_level}/**"):
        if pattern not in lines:
            lines.append(pattern)
    sparse.parent.mkdir(parents=True, exist_ok=True)
    sparse.write_text("\n".join(lines) + "\n", encoding="utf-8")


def checkout_commit(repo: Path, commit: str) -> None:
    """checkout head；遇到 Windows 非法路径时按顶层目录做 sparse 排除后重试。"""
    for _ in range(6):
        result = git(repo, "checkout", "-f", commit, timeout=1800)
        if result.returncode == 0:
            return
        stderr = result.stderr
        invalid = "invalid path" in stderr or "cannot create directory" in stderr \
            or "unable to create file" in stderr
        if not invalid:
            raise RuntimeError(f"checkout {commit} failed: {stderr.strip()[-800:]}")
        matched = re.search(r"invalid path '([^']+)'", stderr) \
            or re.search(r"cannot create directory at '([^']+)'", stderr) \
            or re.search(r"unable to create file ([^:]+):", stderr)
        if matched is None:
            raise RuntimeError(f"checkout {commit} failed: {stderr.strip()[-800:]}")
        top_level = matched.group(1).replace("\\", "/").lstrip("/").split("/")[0]
        if not top_level:
            raise RuntimeError(f"checkout {commit} failed: {stderr.strip()[-800:]}")
        log(f"windows-invalid path under {top_level}/; excluding it from worktree and retrying")
        enable_sparse_exclude(repo, top_level)
    raise RuntimeError(f"checkout {commit} failed after sparse-exclusion retries")


def ensure_repo(repo_dir: Path, instance: ReviewInstance) -> Path:
    """准备仓库：partial clone（只拉元数据 + 按需 blob）→ checkout head。"""
    target = repo_dir / instance.repo.replace("/", "__")
    fresh_clone = not (target / ".git").exists()
    if fresh_clone:
        target.parent.mkdir(parents=True, exist_ok=True)
        log(f"clone {instance.repo} -> {target}")
        result = run(
            ["git", "-c", "core.longpaths=true", "clone", "--filter=blob:none",
             "--no-checkout", instance.resolved_clone_url, str(target)],
            timeout=7200,
        )
        if result.returncode != 0:
            raise RuntimeError(f"git clone failed: {result.stderr.strip()[-800:]}")

    for commit in (instance.base_commit, instance.head_commit):
        check = git(target, "cat-file", "-e", f"{commit}^{{commit}}")
        if check.returncode == 0:
            continue
        log(f"fetch commit {commit[:10]} for {instance.repo}")
        fetched = git(target, "fetch", "--filter=blob:none", "origin", commit, timeout=3600)
        if fetched.returncode != 0:
            fetched = git(target, "fetch", "--filter=blob:none", "origin", timeout=3600)
        if fetched.returncode != 0:
            raise RuntimeError(f"fetch {commit} failed: {fetched.stderr.strip()[-800:]}")

    # 新 clone 还没 checkout，不需要（也不应该）先 reset——partial clone 下
    # reset --hard 会为默认分支白拉一整棵树。
    if not fresh_clone and any(child.name != ".git" for child in target.iterdir()):
        clean_worktree(target)
    checkout_commit(target, instance.head_commit)
    return target


def make_diff(repo: Path, instance: ReviewInstance, diff_path: Path) -> str:
    # PR range semantics: base_commit is the target-branch tip recorded in the
    # dataset, not the fork point. Diffing base..head directly folds unrelated
    # target-branch changes into the review scope. Resolve the merge-base first
    # (same as `git diff base...head` and the other reviewers).
    base = git(repo, "merge-base", instance.base_commit, instance.head_commit, timeout=1800)
    resolved_base = instance.base_commit
    if base.returncode == 0 and base.stdout.strip():
        resolved_base = base.stdout.strip()
    result = git(repo, "diff", "--no-color", "--unified=3",
                 resolved_base, instance.head_commit, timeout=1800)
    if result.returncode != 0:
        raise RuntimeError(f"git diff failed: {result.stderr.strip()[-800:]}")
    diff_path.parent.mkdir(parents=True, exist_ok=True)
    diff_path.write_text(result.stdout, encoding="utf-8")
    return result.stdout


def normalize_path(value: Any, repo_path: Path) -> str:
    text = str(value or "").strip().replace("\\", "/")
    while text.startswith("./"):
        text = text[2:]
    repo_posix = str(repo_path).replace("\\", "/").rstrip("/") + "/"
    if text.startswith(repo_posix):
        text = text[len(repo_posix):]
    return text


def parse_skip(stdout: str) -> Optional[str]:
    """review-pi 跳过路径的 stdout 是 JSON 文档；取出 skipped 原因。"""
    text = stdout.strip()
    candidates = [text]
    if not text.startswith("{"):
        # 兼容前面有日志行的形态：取最后一个 JSON 对象
        start = text.rfind("{")
        if start >= 0:
            candidates.append(text[start:])
    for candidate in candidates:
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and data.get("skipped"):
            return str(data["skipped"])
    return None


def map_findings(findings: List[Dict[str, Any]], repo_path: Path) -> List[Dict[str, Any]]:
    mapped: List[Dict[str, Any]] = []
    for finding in findings:
        if not isinstance(finding, dict):
            continue
        file_path = normalize_path(finding.get("file"), repo_path)
        line = finding.get("line")
        if not file_path or not isinstance(line, int) or line < 1:
            continue
        title = str(finding.get("title") or "").strip()
        description = str(finding.get("description") or "").strip()
        if not title and not description:
            continue
        mapped.append({
            "file": file_path,
            "line": line,
            "summary": title,
            "failure_scenario": description,
            # 以下字段框架不评分，仅存档，便于离线扫 severity/confidence
            "severity": finding.get("severity"),
            "category": finding.get("category"),
            "confidence": finding.get("confidence"),
            "rule": finding.get("rule"),
        })
    return mapped


def read_usage(tasks_root: Path, task_id: str) -> Dict[str, Any]:
    """从 review-pi 审计文件取 token 用量（框架的用量统计会读 token_usage）。"""
    audit_dir = tasks_root / task_id / "audit"
    if not audit_dir.is_dir():
        return {}
    files = sorted(audit_dir.glob("*.json"), key=lambda path: path.stat().st_mtime, reverse=True)
    if not files:
        return {}
    try:
        audit = json.loads(files[0].read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return {}
    usage = audit.get("usage") or {}
    repair_usage = (audit.get("coverageRepair") or {}).get("usage") or {}

    def total(key: str) -> int:
        # audit.usage 只含 Agent 内调用（ADR-0066）；补漏是 run 内独立 one-shot，
        # 单独记在 coverageRepair.usage。基准的 token 口径必须把两者相加，
        # 否则会低估启用补漏时的真实成本。
        return (usage.get(key, 0) or 0) + (repair_usage.get(key, 0) or 0)

    payload: Dict[str, Any] = {
        "model": audit.get("model"),
        "audit_path": str(files[0]),
        "token_usage": {
            "input_tokens": total("inputTokens"),
            "output_tokens": total("outputTokens"),
            "cache_read_input_tokens": total("cacheReadTokens"),
        },
    }
    if repair_usage:
        payload["token_usage_breakdown"] = {
            "agent": {
                "input_tokens": usage.get("inputTokens", 0) or 0,
                "output_tokens": usage.get("outputTokens", 0) or 0,
                "cache_read_input_tokens": usage.get("cacheReadTokens", 0) or 0,
            },
            "coverage_repair": {
                "input_tokens": repair_usage.get("inputTokens", 0) or 0,
                "output_tokens": repair_usage.get("outputTokens", 0) or 0,
                "cache_read_input_tokens": repair_usage.get("cacheReadTokens", 0) or 0,
            },
        }
    return payload


def write_result(path: Path, payload: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".part")
    tmp.write_text(json.dumps(payload, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def review_instance(
    instance: ReviewInstance,
    repo_dir: Path,
    results_dir: Path,
    review_pi_bin: Path,
    config_path: Optional[Path],
    rule_skills: List[Path],
    node: str,
    timeout_seconds: int,
    force: bool,
) -> Dict[str, Any]:
    safe_id = instance.safe_id
    out_path = results_dir / f"{safe_id}.json"
    if out_path.exists() and not force:
        try:
            existing = json.loads(out_path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError):
            existing = None
        if isinstance(existing, dict) and existing.get("status") in ("ok", "skipped"):
            return {"instance_id": instance.instance_id, "status": "cached",
                    "findings": existing.get("findings_count", 0)}

    started = time.monotonic()
    work = results_dir / ".reviewpi"
    task_id = safe_id
    tasks_root = work / "tasks"
    cwd = work / "cwd" / safe_id
    diff_path = work / "diff" / f"{safe_id}.diff"
    cwd.mkdir(parents=True, exist_ok=True)
    tasks_root.mkdir(parents=True, exist_ok=True)

    status = "ok"
    skip_reason: Optional[str] = None
    findings: List[Dict[str, Any]] = []
    stderr_tail = ""
    repo_path: Optional[Path] = None
    review_rc: Optional[int] = None

    try:
        repo_path = ensure_repo(repo_dir, instance)
        diff_text = make_diff(repo_path, instance, diff_path)
        if not diff_text.strip():
            status = "skipped"
            skip_reason = "empty-diff"
        else:
            command = [node, str(review_pi_bin), "review",
                       "--repo", str(repo_path),
                       "--mr-diff", str(diff_path),
                       "--taskId", task_id,
                       "--tasks-dir", str(tasks_root),
                       "--no-progress"]
            if config_path is not None:
                command.extend(["--config", str(config_path)])
            for skill in rule_skills:
                command.extend(["--rule-skill", str(skill)])
            env = os.environ.copy()
            env.setdefault("NO_COLOR", "1")
            env.setdefault("GIT_TERMINAL_PROMPT", "0")
            proc = run(command, cwd=cwd, timeout=timeout_seconds, env=env)
            review_rc = proc.returncode
            stderr_tail = (proc.stderr or "")[-2000:]
            reviews_path = tasks_root / task_id / "runs" / "reviews_all.json"
            if reviews_path.is_file():
                envelope = json.loads(reviews_path.read_text(encoding="utf-8"))
                raw = envelope.get("findings") if isinstance(envelope, dict) else None
                findings = raw if isinstance(raw, list) else []
            else:
                skip_reason = parse_skip(proc.stdout or "")
                if skip_reason is not None:
                    status = "skipped"
                    findings = []
                else:
                    status = "failed"

            if status == "ok":
                findings = map_findings(findings, repo_path)
            else:
                findings = []
    except subprocess.TimeoutExpired:
        status = "failed"
        stderr_tail = f"timeout after {timeout_seconds}s"
    except Exception as error:  # noqa: BLE001 - 单条失败不中断整批
        status = "failed"
        stderr_tail = f"{type(error).__name__}: {error}"
    finally:
        if repo_path is not None:
            try:
                clean_worktree(repo_path)
            except Exception:  # noqa: BLE001
                pass

    duration = round(time.monotonic() - started, 1)
    usage_info = read_usage(tasks_root, task_id) if status == "ok" else {}
    payload = {
        "instance_id": instance.instance_id,
        "repo": instance.repo,
        "base_commit": instance.base_commit,
        "head_commit": instance.head_commit,
        "status": status,
        "skip_reason": skip_reason,
        "duration_seconds": duration,
        "review_output_source": "review-pi/reviews_all.json",
        "review_pi_exit_code": review_rc,
        "findings_count": len(findings),
        "review_output": findings,
        "stderr_tail": stderr_tail,
        **usage_info,
    }
    write_result(out_path, payload)
    log(f"{instance.instance_id}: {status} findings={len(findings)} {duration}s")
    return {"instance_id": instance.instance_id, "status": status, "findings": len(findings)}


def group_by_repo(instances: List[ReviewInstance]) -> List[List[ReviewInstance]]:
    groups: Dict[str, List[ReviewInstance]] = {}
    order: List[str] = []
    for instance in instances:
        if instance.repo not in groups:
            groups[instance.repo] = []
            order.append(instance.repo)
        groups[instance.repo].append(instance)
    return [groups[repo] for repo in order]


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="review-pi -> AACR-Bench 结果桥接")
    parser.add_argument("--dataset", type=Path, required=True)
    parser.add_argument("--results-dir", type=Path, required=True)
    parser.add_argument("--repo-dir", type=Path, default=DEFAULT_REPO_DIR)
    parser.add_argument("--review-pi-bin", type=Path,
                        default=Path(os.environ.get("REVIEW_PI_BIN", DEFAULT_REVIEW_PI_BIN)))
    parser.add_argument("--config", type=Path, default=None,
                        help="review-pi 配置（缺省用 ~/.PiAgent/PiAgent.jsonc）")
    parser.add_argument("--rule-skill", action="append", type=Path, default=[],
                        help="传给 review-pi 的 --rule-skill 目录；可重复")
    parser.add_argument("--node", default="node")
    parser.add_argument("--limit", type=int, default=None)
    parser.add_argument("--only", default=None, help="逗号分隔的 instance_id 或 repo")
    parser.add_argument("--concurrency", type=int, default=1)
    parser.add_argument("--timeout-minutes", type=int, default=30)
    parser.add_argument("--force", action="store_true", help="重跑已成功/跳过的样本")
    parser.add_argument("--prepare-only", action="store_true", help="只 clone/checkout，不调用模型")
    args = parser.parse_args(argv)

    # 所有路径先绝对化：review-pi 子进程的 cwd 是每条样本独立目录，
    # 相对路径会被二次解析（--mr-diff / --tasks-dir 必须是不依赖 cwd 的绝对路径）。
    args.dataset = args.dataset.resolve()
    args.results_dir = args.results_dir.resolve()
    args.repo_dir = args.repo_dir.resolve()
    args.review_pi_bin = args.review_pi_bin.resolve()
    if args.config is not None:
        args.config = args.config.resolve()
    args.rule_skill = [p.resolve() for p in args.rule_skill]

    instances = load_instances(args.dataset, args.limit)
    if args.only:
        wanted = {item.strip() for item in args.only.split(",") if item.strip()}
        instances = [i for i in instances if i.instance_id in wanted or i.repo in wanted]
    if not instances:
        log("no instances selected")
        return 0

    args.results_dir.mkdir(parents=True, exist_ok=True)
    log(f"instances={len(instances)} concurrency={args.concurrency} results={args.results_dir}")
    if not args.review_pi_bin.is_file():
        log(f"review-pi bin not found: {args.review_pi_bin}")
        return 2

    groups = group_by_repo(instances)
    log(f"repo groups={len(groups)}")
    effective = max(1, min(args.concurrency, len(groups)))

    if args.prepare_only:
        for group in groups:
            for instance in group:
                repo = ensure_repo(args.repo_dir, instance)
                log(f"prepared {instance.repo} -> {repo}")
        return 0

    stats: Dict[str, int] = {"ok": 0, "skipped": 0, "failed": 0, "cached": 0}
    stats_lock = threading.Lock()
    failures: List[str] = []

    def run_group(group: List[ReviewInstance]) -> None:
        for instance in group:
            result = review_instance(
                instance=instance,
                repo_dir=args.repo_dir,
                results_dir=args.results_dir,
                review_pi_bin=args.review_pi_bin,
                config_path=args.config,
                rule_skills=args.rule_skill,
                node=args.node,
                timeout_seconds=args.timeout_minutes * 60,
                force=args.force,
            )
            with stats_lock:
                stats[result["status"]] = stats.get(result["status"], 0) + 1
                if result["status"] == "failed":
                    failures.append(instance.instance_id)

    with ThreadPoolExecutor(max_workers=effective) as pool:
        futures = [pool.submit(run_group, group) for group in groups]
        for future in as_completed(futures):
            future.result()

    log(f"done: {stats}")
    if failures:
        log(f"failed ({len(failures)}): {', '.join(failures)}")
    return 0 if not failures else 1


if __name__ == "__main__":
    sys.exit(main())
