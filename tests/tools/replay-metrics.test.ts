// 回放工具链的资源采样解析（ramp 报告里的 RSS / 句柄 / CPU 核数）。
//
// scripts/ 不在 tsconfig 的编译面里，也没有 .d.mts 声明；这里只借 vitest 跑纯函数，
// 用 @ts-expect-error 关掉「声明文件缺失」那一条。
// @ts-expect-error -- scripts/offline-replay/lib/metrics.mjs 无类型声明
import { parsePowershellJson, parsePs, parseWmicCsv } from "../../scripts/offline-replay/lib/metrics.mjs";
// @ts-expect-error -- scripts/offline-replay/lib/report.mjs 无类型声明
import { formatCores, formatStepLine } from "../../scripts/offline-replay/lib/report.mjs";

import { describe, expect, test } from "vitest";

describe("metrics: ps 后端（Linux）", () => {
  test("pid=,ppid=,rss=,times= → rss 换算为字节，times 是累计 CPU 秒", () => {
    const snapshot = parsePs("  123   1  2048   3\n  456   123  1024  0\n");
    expect(snapshot.get(123)).toEqual({
      pid: 123,
      ppid: 1,
      rssBytes: 2048 * 1024,
      handles: null,
      cpuSeconds: 3,
    });
    expect(snapshot.get(456)?.cpuSeconds).toBe(0);
  });

  test("缺 times 列 → cpuSeconds 为 null（不编数字）", () => {
    const snapshot = parsePs("123 1 2048\n");
    expect(snapshot.get(123)?.cpuSeconds).toBeNull();
  });

  test("坏行（列数不足 / 非数字 pid）被跳过", () => {
    const snapshot = parsePs("123 1\nnot-a-pid 1 2048\n");
    expect(snapshot.size).toBe(0);
  });
});

describe("metrics: wmic 后端（Windows，100ns 时间单位）", () => {
  test("UserModeTime + KernelModeTime 换算为秒", () => {
    const csv = [
      "Node,HandleCount,KernelModeTime,ParentProcessId,ProcessId,UserModeTime,WorkingSetSize",
      "HOST,370,20000000,1,4242,30000000,131072000",
    ].join("\r\n");
    const snapshot = parseWmicCsv(csv);
    expect(snapshot?.get(4242)).toEqual({
      pid: 4242,
      ppid: 1,
      rssBytes: 131_072_000,
      handles: 370,
      // (20_000_000 + 30_000_000) / 1e7 = 5s
      cpuSeconds: 5,
    });
  });

  test("缺 PID 表头 → undefined（采样降级而不是崩）", () => {
    expect(parseWmicCsv("Node,HandleCount\r\nHOST,1\r\n")).toBeUndefined();
  });
});

describe("metrics: PowerShell 后端（Windows 兜底）", () => {
  test("单对象输出（只有一条记录时 ConvertTo-Json 不产数组）", () => {
    const snapshot = parsePowershellJson(
      JSON.stringify({
        ProcessId: 99,
        ParentProcessId: 1,
        WorkingSetSize: 1_048_576,
        HandleCount: 12,
        UserModeTime: 10_000_000,
        KernelModeTime: 5_000_000,
      }),
    );
    expect(snapshot?.get(99)).toEqual({
      pid: 99,
      ppid: 1,
      rssBytes: 1_048_576,
      handles: 12,
      cpuSeconds: 1.5,
    });
  });

  test("缺时间字段 → cpuSeconds 为 null", () => {
    const snapshot = parsePowershellJson(
      JSON.stringify({ ProcessId: 7, ParentProcessId: 1, WorkingSetSize: 4096, HandleCount: 3 }),
    );
    expect(snapshot?.get(7)?.cpuSeconds).toBeNull();
  });

  test("非法 JSON → undefined", () => {
    expect(parsePowershellJson("not json")).toBeUndefined();
  });
});

describe("report: CPU 核数格式", () => {
  test("保留两位小数，缺值写 n/a", () => {
    expect(formatCores(1.234)).toBe("1.23");
    expect(formatCores(0)).toBe("0.00");
    expect(formatCores(null)).toBe("n/a");
  });
});

describe("report: 每档即时行", () => {
  test("档位行带 success/median/p95/RSS/句柄/CPU，缺值写 n/a", () => {
    const line = formatStepLine({
      workers: 16,
      stats: { success: 3, total: 3, medianMs: 12_600, p95Ms: 13_100 },
      peakRssBytes: 2_069_000_000,
      peakHandles: 5937,
      peakCpuCores: 6.82,
      meanCpuCores: 5.11,
    });
    expect(line).toBe(
      "  workers= 16  3/3 ok  median 12.60s  p95 13.10s  RSS 1973.2 MB  handles 5937  CPU 6.82/5.11 核",
    );
  });

  test("停止原因作为尾注", () => {
    const line = formatStepLine({
      workers: 96,
      stats: { success: 3, total: 3, medianMs: 900, p95Ms: 950 },
      peakRssBytes: null,
      peakHandles: null,
      peakCpuCores: null,
      meanCpuCores: null,
      note: "peak RSS 超阈值",
    });
    expect(line).toContain("RSS n/a");
    expect(line).toContain("handles n/a");
    expect(line).toContain("CPU n/a/n/a");
    expect(line.endsWith("peak RSS 超阈值")).toBe(true);
  });

  test("基线行可用自定义标签", () => {
    const line = formatStepLine({
      label: "no-latency",
      workers: 1,
      stats: { success: 3, total: 3, medianMs: 1200, p95Ms: 1300 },
      peakRssBytes: 1024 * 1024,
      peakHandles: 12,
      peakCpuCores: 1.5,
      meanCpuCores: 1.1,
    });
    expect(line.startsWith("  no-latency  3/3 ok")).toBe(true);
  });
});
