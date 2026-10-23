"""Render the A/B six-phase pipeline (phases vs. transport vs. gate) to docs/png/ab-six-phase.*"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

DOCS = Path(__file__).resolve().parent
OUT = DOCS / "png"
FONT = "Microsoft YaHei"

DOT = r'''
digraph ab_pipeline {
  graph [rankdir=TB, bgcolor="white", fontname="FONT", nodesep=0.30, ranksep=0.36, pad=0.2];
  node  [shape=box, style="rounded,filled", fontname="FONT", fontsize=11, color="#4A5568",
         fillcolor="#F7FAFC", margin="0.14,0.08"];
  edge  [fontname="FONT", fontsize=9, color="#4A5568", arrowsize=0.7];

  start [label="一轮开始（round）", fillcolor="#2B6CB0", fontcolor="white"];

  six [label="六阶段循环\nPhase 1 变更理解\nPhase 2 风险分类\nPhase 3 上下文决策\nPhase 4 上下文检索\nPhase 5 深度推理\nPhase 6 证据验证",
       fillcolor="#C6F6D5", shape=box];
  req [label="runReviewTurn\npi-ai provider.stream", fillcolor="#BEE3F8"];
  wire [label="onPayload 捕获 wire\n内存 requests[]", fillcolor="#FEFCBF"];
  parse [label="阶段解析\nPhase 5 → candidates\nPhase 6 → verdicts + complete"];
  gate [label="轮末：applyCandidateGate\nschema / 英文 / 证据 / 裁决 / 去重", fillcolor="#C6F6D5"];
  done [label="complete=true\n结束本次 run", fillcolor="#2B6CB0", fontcolor="white"];
  next [label="complete=false\nround+1（最多 5 轮）", fillcolor="#FED7D7"];

  start -> six;
  six -> req [label=" 每阶段 1 次请求 "];
  req -> wire [label=" 发送前 "];
  wire -> parse [label=" assistant 回复 "];
  parse -> six [label=" phase+1（未满 6） ", style=dashed];
  parse -> gate [label=" 六阶段结束 "];
  gate -> done [label=" true "];
  gate -> next [label=" false "];
  next -> six [label=" 下一轮 "];

  note [shape=note, label="wire 捕获属于每次请求；\n门禁在六阶段之后，二者都不是阶段", fillcolor="#EDF2F7", fontsize=9];
  wire -> note [style=dotted, arrowhead=none];
  gate -> note [style=dotted, arrowhead=none];
}
'''.replace("FONT", FONT)


def main() -> int:
    dot = shutil.which("dot")
    if dot is None:
        print("Graphviz 'dot' not found on PATH.", file=sys.stderr)
        return 1
    OUT.mkdir(parents=True, exist_ok=True)
    src = OUT / "ab-six-phase.dot"
    src.write_text(DOT, encoding="utf-8")
    for ext, extra in (("png", ["-Gdpi=170"]), ("svg", [])):
        out = OUT / f"ab-six-phase.{ext}"
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
