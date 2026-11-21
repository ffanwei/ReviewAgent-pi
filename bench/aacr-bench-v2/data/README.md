# 数据说明

- `aacr_bench_v2.jsonl`：151 条 AACR-Bench v2 标准样本（JSONL，每行一个 `ReviewInstance`）。
- `aacr_bench_v2_run.jsonl`：同一批样本，按仓库样本数由小到大排序，用于本次评审运行。
- `aacr_bench_v2_eval_ok.jsonl`：108 条 `ok` 样本，仅这些进入本次 judge 评测。
- `raw_positive_samples.json`：AACR-Bench v2 原始 `positive_samples.json`（未改动）。
- `exclusion-analysis.json/md`：151 条逐样本状态、GT 统计、diff 体积与主要 diff 文件块。

来源与许可：

- AACR-Bench v2（Alibaba Aone，Apache-2.0）：<https://github.com/alibaba/aacr-bench>
- `raw_positive_samples.json` 的 sha256 为 `2e83975aba1ca06544ccecdee8d99ab7152bc1d02a3d86bce3022d8d4e3010ba`，与
  `evaluation/benchmark/AACR-Bench/v2/positive_samples.meta.json` 一致。

转换命令（在 `aacr-bench/evaluation/` 内）：

```bash
python -m converters.aacr_bench \
  --input benchmark/AACR-Bench/v2/positive_samples.json \
  --output data/aacr_bench_v2.jsonl --validate
```
