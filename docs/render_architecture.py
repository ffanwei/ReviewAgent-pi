"""Render the end-to-end architecture call flow to docs/png/architecture-call-flow.*"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent
OUT = DOCS / "png"
FONT = "Microsoft YaHei"

DOT = r'''
digraph architecture {
  graph [rankdir=LR, bgcolor="white", fontname="FONT", nodesep=0.28, ranksep=0.50, pad=0.2];
  node  [shape=box, style="rounded,filled", fontname="FONT", fontsize=10.5, color="#4A5568",
         fillcolor="#F7FAFC", margin="0.13,0.07"];
  edge  [fontname="FONT", fontsize=8.5, color="#4A5568", arrowsize=0.65];

  subgraph cluster_root {
    label="根仓应用层 src/"; fontsize=12; color="#CBD5E0"; style="rounded";
    cli [label="cli.ts\n参数/预检"];
    plan [label="plan.ts\n配置×数据×reps"];
    runner [label="runner.ts\n逐单元/续跑"];
    kernel [label="pi-kernel.ts\n适配缝", fillcolor="#BEE3F8"];
    store [label="run-store.ts\nRunRecord"];
    judge [label="judge/orchestrate.ts\nT10 + LLM"];
    metrics [label="metrics/aggregate.ts\ncold/hot"];
    report [label="report.ts/report.json"];
  }

  subgraph cluster_runtime {
    label="review-pi（Review Runtime）"; fontsize=12; color="#CBD5E0"; style="rounded";
    run [label="run/review-run.ts\nrunReview", fillcolor="#2B6CB0", fontcolor="white"];
    guard [label="mr-boundary-guard.ts"];
    ab [label="review-loop.ts\nA/B 六阶段", fillcolor="#C6F6D5"];
    cde [label="agent-review-loop.ts\nC/D/E Agent", fillcolor="#C6F6D5"];
    tools [label="tools/toolkit.ts\n七个 review.*"];
    gate [label="gate/candidate-gate.ts"];
    audit [label="audit-writer.ts\n审计 JSON"];
    record [label="run-record.ts\nRunRecord"];
  }

  subgraph cluster_kernel {
    label="pi / review-llm"; fontsize=12; color="#CBD5E0"; style="rounded";
    llm [label="review-llm\nkey/URL/profile"];
    pai [label="pi-ai\nprovider.stream", fillcolor="#BEE3F8"];
    agent [label="pi-agent-core\nAgent/loop", fillcolor="#BEE3F8"];
    remote [label="远端模型服务", fillcolor="#FEFCBF"];
  }

  cli -> plan -> runner -> kernel -> run;
  run -> guard [label=" 护栏 "];
  run -> ab [label=" tools=false "];
  run -> cde [label=" tools=true "];
  ab -> pai [label=" runReviewTurn "];
  cde -> agent -> pai;
  cde -> tools [label=" executeTool "];
  ab -> gate;
  cde -> gate;
  gate -> audit -> record -> store;
  store -> judge -> metrics -> report;
  llm -> kernel [label=" apiKey/baseUrl "];
  pai -> remote [label=" HTTPS "];
}
'''.replace("FONT", FONT)


def main() -> int:
    dot = shutil.which("dot")
    if dot is None:
        print("Graphviz 'dot' not found on PATH.", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    src = OUT / "architecture-call-flow.dot"
    src.write_text(DOT, encoding="utf-8")
    for ext, extra in (("png", ["-Gdpi=170"]), ("svg", [])):
        out = OUT / f"architecture-call-flow.{ext}"
        r = subprocess.run(
            [dot, f"-T{ext}", *extra, str(src), "-o", str(out)],
            capture_output=True,
            text=True,
        )
        if r.returncode != 0:
            print(r.stderr, file=sys.stderr)
            return r.returncode
        print(f"wrote {out}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
