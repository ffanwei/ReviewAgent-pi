/**
 * ramp 报告（ADR-0048 决策 9）：机器口径 + 人读 Markdown。
 * 主口径含模拟延迟（用户视角）；`overheadBaseline`（latency none）用于相减
 * 得到 harness 自身开销。
 */

export function percentile(values, p) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return sorted[Math.min(rank, sorted.length) - 1];
}

export function summarizeRuns(runs) {
  const walls = runs
    .filter((run) => run.ok && Number.isFinite(run.wallMs))
    .map((run) => run.wallMs);
  return {
    total: runs.length,
    success: runs.filter((run) => run.ok).length,
    medianMs: median(walls),
    p95Ms: percentile(walls, 95),
    minMs: walls.length > 0 ? Math.min(...walls) : null,
    maxMs: walls.length > 0 ? Math.max(...walls) : null,
  };
}

function median(values) {
  if (values.length === 0) {
    return null;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined) {
    return "n/a";
  }
  if (ms < 1000) {
    return `${ms.toFixed(0)}ms`;
  }
  return `${(ms / 1000).toFixed(2)}s`;
}

export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined) {
    return "n/a";
  }
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(1)} MB`;
}

/** CPU 口径是「核」：1.0 = 占满一个逻辑核 */
export function formatCores(cores) {
  if (cores === null || cores === undefined) {
    return "n/a";
  }
  return cores.toFixed(2);
}

export function renderRampMarkdown(result) {
  const lines = [
    `# Offline replay ramp — ${result.scenario}`,
    "",
    `- trace: \`${result.trace}\``,
    `- latency: ${describeLatency(result.latency)}`,
    `- baseline（1 worker，${String(result.measure)} 次中位数）：${formatDuration(result.baseline.stats.medianMs)}`,
  ];
  if (result.overheadBaseline !== undefined) {
    const baselineMedian = result.baseline.stats.medianMs;
    const overheadMedian = result.overheadBaseline.stats.medianMs;
    const delta =
      baselineMedian === null || overheadMedian === null
        ? null
        : baselineMedian - overheadMedian;
    lines.push(
      `- harness 基线（latency none，${String(result.measure)} 次中位数）：${formatDuration(overheadMedian)}`,
      `- 模拟延迟带来的增量：${formatDuration(delta)}`,
    );
  }
  if (result.machine !== undefined) {
    const cpus = result.machine.logicalCpus;
    const memGb = (result.machine.totalMemBytes / 1024 ** 3).toFixed(1);
    lines.push(`- 机器：${String(cpus)} 逻辑核 / ${memGb} GB（CPU 列 = 进程树累计 CPU 时间差分 ÷ 采样间隔）`);
  }
  lines.push(
    `- 停止：${result.stop.reason}${result.stop.atWorkers !== undefined ? `（workers=${String(result.stop.atWorkers)}）` : ""}`,
    `- 并发上限：${result.limit.workers === null ? "未测到稳定档位" : `${String(result.limit.workers)} workers`}`,
    "",
    "| workers | success | median | p95 | min | max | peak RSS | peak handles | CPU 峰值(核) | CPU 均值(核) | CPU 占机 % | 备注 |",
    "|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|",
  );
  const logicalCpus = result.machine?.logicalCpus ?? null;
  for (const step of result.steps) {
    const stats = step.stats;
    const cpuShare =
      step.meanCpuCores === null || step.meanCpuCores === undefined || logicalCpus === null
        ? "n/a"
        : `${((step.meanCpuCores / logicalCpus) * 100).toFixed(0)}%`;
    lines.push(
      `| ${String(step.workers)} | ${String(stats.success)}/${String(stats.total)} | ` +
        `${formatDuration(stats.medianMs)} | ${formatDuration(stats.p95Ms)} | ` +
        `${formatDuration(stats.minMs)} | ${formatDuration(stats.maxMs)} | ` +
        `${formatBytes(step.peakRssBytes)} | ${step.peakHandles === null ? "n/a" : String(step.peakHandles)} | ` +
        `${formatCores(step.peakCpuCores)} | ${formatCores(step.meanCpuCores)} | ${cpuShare} | ` +
        `${step.note ?? ""} |`,
    );
  }
  if (result.steps.some((step) => step.failures.length > 0)) {
    lines.push("", "## 失败样本", "");
    for (const step of result.steps) {
      for (const failure of step.failures.slice(0, 3)) {
        lines.push(`- workers=${String(step.workers)}：${failure}`);
      }
    }
  }
  lines.push(
    "",
    `> 数字只在「本机 + ${describeLatency(result.latency)}」下成立；换延迟档位或机器不可直接比较。`,
    "",
  );
  return lines.join("\n");
}

export function describeLatency(latency) {
  if (latency.mode !== "fixed" || latency.ms <= 0) {
    return "none（0ms）";
  }
  const jitter = latency.jitter > 0 ? ` ±${Math.round(latency.jitter * 100)}%` : "";
  return `fixed ${String(latency.ms)}ms${jitter}（seed ${String(latency.seed)}）`;
}
