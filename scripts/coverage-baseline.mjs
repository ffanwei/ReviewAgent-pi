#!/usr/bin/env node
// 覆盖账本零模型基线（F-01a）：只解析 diff、建分母、可选模拟分片/截取，
// 不发任何模型请求、不读用户配置。
//
// 用法：
//   pnpm build:dist
//   node scripts/coverage-baseline.mjs --diff <file.diff>
//   node scripts/coverage-baseline.mjs --dir data/clean-mr/diffs --limit 20
//   node scripts/coverage-baseline.mjs --dir data/clean-mr/diffs --shard-chars 120000 --json
//
// 口径：没有 findings，因此所有 hunk 都是 not-reached(no-signal)；
// 输出的是**分母基线**（文件数 / hunk 数 / 排除数 / 截取数），不是质量指标。

import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const DEFAULT_DIR = "data/clean-mr/diffs";
const SHARD_LIMITS = { maxShards: 12, contextSummaryChars: 8_000 };

function usage() {
  console.error(
    [
      "用法: node scripts/coverage-baseline.mjs [--diff <file>]... [--dir <dir>] [--limit N] [--shard-chars N] [--json]",
      "",
      "  --diff <file>       检视一个 diff（可重复；与 --dir 二选一）",
      "  --dir <dir>         批量读取目录下 *.diff（缺省 data/clean-mr/diffs）",
      "  --limit N           最多处理 N 个文件",
      "  --shard-chars N     模拟分片：按该字符预算切分并统计截取",
      "  --json              只输出 JSON 汇总",
    ].join("\n"),
  );
}

function parseArgs(argv) {
  const options = {
    diffs: [],
    dir: undefined,
    limit: undefined,
    shardChars: undefined,
    json: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      usage();
      process.exit(0);
    }
    if (arg === "--json") {
      options.json = true;
      continue;
    }
    if (arg === "--diff" || arg === "--dir" || arg === "--limit" || arg === "--shard-chars") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error(`${arg} 需要一个值`);
      }
      index += 1;
      if (arg === "--diff") options.diffs.push(value);
      else if (arg === "--dir") options.dir = value;
      else if (arg === "--limit") options.limit = parsePositiveInt(value, arg);
      else options.shardChars = parsePositiveInt(value, arg);
      continue;
    }
    throw new Error(`未知参数: ${arg}`);
  }
  if (options.diffs.length > 0 && options.dir !== undefined) {
    throw new Error("--diff 与 --dir 不能同时使用");
  }
  return options;
}

function parsePositiveInt(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${flag} 必须是正整数，当前 ${value}`);
  }
  return parsed;
}

function collectFiles(options) {
  if (options.diffs.length > 0) {
    return options.diffs;
  }
  const dir = options.dir ?? DEFAULT_DIR;
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".diff"))
    .sort()
    .map((name) => path.join(dir, name));
  return options.limit === undefined ? files : files.slice(0, options.limit);
}

async function loadModules() {
  try {
    const ledger = await import("../packages/review-pi/dist/run/coverage-ledger.js");
    const planner = await import("../packages/review-pi/dist/run/shard-planner.js");
    return { ledger, planner };
  } catch (error) {
    throw new Error(
      `无法加载 dist（${error instanceof Error ? error.message : String(error)}）；先运行 pnpm build:dist`,
      { cause: error },
    );
  }
}

function analyzeSingle(diff, modules) {
  const { buildCoverageLedger, closeCoverage } = modules.ledger;
  return {
    ledger: closeCoverage(buildCoverageLedger(diff)),
    shards: 1,
    truncation: [],
  };
}

function analyzeSharded(diff, shardChars, modules) {
  const { buildCoverageLedger, closeCoverage, mergeCoverageLedgers, truncatedRangesFromShardRecords } =
    modules.ledger;
  const { planShards } = modules.planner;
  const plan = planShards(diff, {
    maxShardChars: shardChars,
    maxShards: SHARD_LIMITS.maxShards,
    contextSummaryChars: SHARD_LIMITS.contextSummaryChars,
  });
  if (plan.shards.length === 0) {
    return { ledger: closeCoverage(buildCoverageLedger(diff)), shards: 0, truncation: [] };
  }
  const realShards =
    plan.shards.length === 1 && plan.shards[0].truncated.length === 0
      ? [{ diff, truncated: [] }]
      : plan.shards;
  const ledgers = realShards.map((shard) =>
    closeCoverage(
      buildCoverageLedger(shard.diff, {
        truncated: truncatedRangesFromShardRecords(shard.truncated),
      }),
    ),
  );
  return {
    ledger: mergeCoverageLedgers(ledgers),
    shards: realShards.length,
    truncation: realShards.flatMap((shard) => shard.truncated),
  };
}

function summarize(file, diff, result) {
  const { counts } = result.ledger;
  return {
    file,
    chars: diff.length,
    shards: result.shards,
    files: result.ledger.files.length,
    hunks: counts.hunks,
    excluded: result.ledger.excluded.length,
    unattributedHunks: result.ledger.unattributedHunks,
    candidate: counts.candidate,
    noIssue: counts.noIssue,
    notReached: counts.notReached,
    notReachedRatio: counts.hunks === 0 ? 0 : counts.notReached / counts.hunks,
    truncatedHunks: result.truncation.reduce(
      (sum, record) => sum + record.droppedHunks,
      0,
    ),
    byCause: counts.byCause,
  };
}

function formatRow(summary) {
  const ratio = `${(summary.notReachedRatio * 100).toFixed(1)}%`;
  return [
    summary.file.padEnd(52),
    String(summary.files).padStart(5),
    String(summary.hunks).padStart(6),
    String(summary.excluded).padStart(8),
    String(summary.truncatedHunks).padStart(9),
    ratio.padStart(8),
    String(summary.shards).padStart(6),
  ].join("  ");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const modules = await loadModules();
  const files = collectFiles(options);
  if (files.length === 0) {
    throw new Error("没有找到任何 diff 文件");
  }

  const summaries = [];
  for (const file of files) {
    const diff = readFileSync(file, "utf8");
    try {
      const result =
        options.shardChars === undefined
          ? analyzeSingle(diff, modules)
          : analyzeSharded(diff, options.shardChars, modules);
      summaries.push(summarize(file, diff, result));
    } catch (error) {
      summaries.push({
        file,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (options.json) {
    console.log(JSON.stringify({ options, summaries }, null, 2));
    return;
  }

  console.log(
    [
      "file".padEnd(52),
      "files".padStart(5),
      "hunks".padStart(6),
      "excluded".padStart(8),
      "truncated".padStart(9),
      "not-reach".padStart(8),
      "shards".padStart(6),
    ].join("  "),
  );
  console.log("-".repeat(104));
  for (const summary of summaries) {
    if (summary.error !== undefined) {
      console.log(`${summary.file.padEnd(52)}  ERROR  ${summary.error}`);
      continue;
    }
    console.log(formatRow(summary));
  }

  const ok = summaries.filter((summary) => summary.error === undefined);
  if (ok.length > 1) {
    const totals = ok.reduce(
      (acc, summary) => ({
        files: acc.files + summary.files,
        hunks: acc.hunks + summary.hunks,
        excluded: acc.excluded + summary.excluded,
        notReached: acc.notReached + summary.notReached,
        truncatedHunks: acc.truncatedHunks + summary.truncatedHunks,
        shards: acc.shards + summary.shards,
      }),
      { files: 0, hunks: 0, excluded: 0, notReached: 0, truncatedHunks: 0, shards: 0 },
    );
    console.log("-".repeat(104));
    console.log(
      `合计 ${String(ok.length)} 个 diff：files ${String(totals.files)} · hunks ${String(
        totals.hunks,
      )} · excluded ${String(totals.excluded)} · truncated ${String(
        totals.truncatedHunks,
      )} · not-reached ${String(totals.notReached)} · shards ${String(totals.shards)}`,
    );
  }
}

main().catch((error) => {
  console.error(`coverage-baseline: ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
