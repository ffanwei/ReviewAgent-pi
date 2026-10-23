"""Render the review-run.ts execution flow to PNG/SVG under docs/png/.

Usage:
    python docs/render_review_flow.py

Requires Graphviz (`dot`) on PATH.
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent
OUT = DOCS / "png"
DOT_PATH = OUT / "review-run-flow.dot"
PNG_PATH = OUT / "review-run-flow.png"
SVG_PATH = OUT / "review-run-flow.svg"

FONT = "Microsoft YaHei"

DOT = r'''
digraph review_run_flow {
  graph [rankdir=TB, bgcolor="white", fontname="FONT", nodesep=0.32, ranksep=0.42, pad=0.25];
  node  [shape=box, style="rounded,filled", fontname="FONT", fontsize=11, color="#4A5568",
         fillcolor="#F7FAFC", penwidth=1.2, margin="0.16,0.09"];
  edge  [fontname="FONT", fontsize=9, color="#4A5568", arrowsize=0.7];

  start [label="runReview(input)", fillcolor="#2B6CB0", fontcolor="white", penwidth=0];
  parse [label="读取 CONFIGS[configId]\n解析 startedAt / modelId"];
  guard [label="guardMrBoundary(diff)\n≤10 文件 且 ≤2K 变更行"];
  tools [label="config.toolsEnabled ?", shape=diamond, fillcolor="#FEFCBF"];

  start -> parse -> guard -> tools;

  // ---------- A / B ----------
  tools -> ab_guard [label=" false（A/B） "];
  ab_guard [label="input.prefetch 注入\n且 config.prefetch=false ?",
            shape=diamond, fillcolor="#FEFCBF"];
  ab_throw [label="抛错：A 零预取，注入矛盾", fillcolor="#FED7D7"];
  ab_src [label="预取来源", shape=diamond, fillcolor="#FEFCBF"];
  ab_inject [label="使用 input.prefetch"];
  ab_calc [label="buildPrefetchContext\nDiff→Symbol→Reference→CallChain\n（B，零 LLM）"];
  ab_none [label="无预取（A）"];
  ab_ctx [label="buildInitialContextMessages\nZone B → MR → 预取层"];
  ab_loop [label="runReviewLoop\n每轮固定 6 阶段请求\n最多 5 轮"];
  ab_turn [label="runReviewTurn → pi-ai\nonPayload 捕获 wire"];
  ab_gate [label="applyCandidateGate\nSCHEMA→ENGLISH→EVIDENCE\n→VERIFY→DUP"];
  ab_audit [label="审计内容\n+ prefetch / mrBoundary"];

  ab_guard -> ab_throw [label=" 是 "];
  ab_guard -> ab_src [label=" 否 "];
  ab_src -> ab_inject [label=" 调用方注入 "];
  ab_src -> ab_calc [label=" B：现场计算 "];
  ab_src -> ab_none [label=" A：无预取 "];
  ab_inject -> ab_ctx;
  ab_calc -> ab_ctx;
  ab_none -> ab_ctx;
  ab_ctx -> ab_loop -> ab_turn -> ab_gate -> ab_audit;

  // ---------- C / D / E ----------
  tools -> cde_guard [label=" true（C/D/E） "];
  cde_guard [label="input.prefetch 已注入 ?", shape=diamond, fillcolor="#FEFCBF"];
  cde_throw [label="抛错：工具路径禁用预取", fillcolor="#FED7D7"];
  full_q [label="config.fullRepo ?\n（仅 C）", shape=diamond, fillcolor="#FEFCBF"];
  full [label="loadRepoContext\n+ buildFullRepoInjection\n（80k 字符预算）", fillcolor="#BEE3F8"];
  nofull [label="不注入全仓"];
  cde_ctx [label="初始上下文\nMR + 全仓注入（C）\n或仅 MR（D/E）"];
  toolkit [label="buildReviewToolkit\n七工具 + RepoContext 懒加载\nE: Ledger enabled / C,D: inert", fillcolor="#BEE3F8"];
  agent [label="runAgentReviewLoop\npi-agent-core Agent\nshouldStopAfterTurn 推进六阶段\n工具预算 6 / 轮次上限 5", fillcolor="#BEE3F8"];
  hooks [label="onPayload / phaseLog\ntoolCallLog / usage"];
  cde_audit [label="审计内容\n+ fullRepo / ledger / mrBoundary"];

  cde_guard -> cde_throw [label=" 是 "];
  cde_guard -> full_q [label=" 否 "];
  full_q -> full [label=" 是 "];
  full_q -> nofull [label=" 否 "];
  full -> cde_ctx [label=" 全仓注入 "];
  nofull -> cde_ctx [label=" 仅 MR "];
  cde_ctx -> toolkit -> agent -> hooks -> cde_audit;

  // ---------- shared tail ----------
  ab_audit -> write;
  cde_audit -> write;
  write [label="buildRunId + writeAuditFile", fillcolor="#C6F6D5"];
  result [label="build RunResult\nfindings / usage / rounds / toolCalls / audit"];
  record [label="buildRunRecord"];
  persist [label="persistRecord === false ?", shape=diamond, fillcolor="#FEFCBF"];
  no_write [label="不落盘\nrecordPath = ''"];
  do_write [label="writeRunRecord"];
  ret [label="return\n{runId, record, recordPath, auditPath}", fillcolor="#2B6CB0", fontcolor="white", penwidth=0];

  write -> result -> record -> persist;
  persist -> no_write [label=" 是 "];
  persist -> do_write [label=" 否 "];
  no_write -> ret;
  do_write -> ret;
}
'''.replace("FONT", FONT)


def main() -> int:
    dot = shutil.which("dot")
    if dot is None:
        print("Graphviz 'dot' not found on PATH. Install Graphviz first.", file=sys.stderr)
        return 1

    OUT.mkdir(parents=True, exist_ok=True)
    DOT_PATH.write_text(DOT, encoding="utf-8")

    for target, fmt, extra in (
        (PNG_PATH, "png", ["-Gdpi=170"]),
        (SVG_PATH, "svg", []),
    ):
        result = subprocess.run(
            [dot, f"-T{fmt}", *extra, str(DOT_PATH), "-o", str(target)],
            capture_output=True,
            text=True,
        )
        if result.returncode != 0:
            print(f"dot failed for {target.name}:\n{result.stderr}", file=sys.stderr)
            return result.returncode
        print(f"wrote {target} ({target.stat().st_size} bytes)")

    print(f"dot source: {DOT_PATH}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
