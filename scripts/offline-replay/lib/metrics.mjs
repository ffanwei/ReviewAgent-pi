import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * 进程树资源采样（best effort）。
 *
 * 用途只有一个：给 ramp 报告补「峰值 RSS / 句柄数」，并在超过阈值时停阶梯。
 * 采样失败不是错误（不同 Windows/Linux 环境的进程查询工具差异很大），
 * 报告里显式标 `null` 而不是编造数字。
 *
 * 采样频率 1.5s、单实例、异步——不阻塞 liftcycle，也不随 worker 数线性增开销。
 */
export function createResourceSampler({ intervalMs = 400 } = {}) {
  let backend = process.platform === "win32" ? "wmic" : "ps";
  const roots = new Set();
  const state = {
    available: backend !== "none",
    peakRssBytes: 0,
    peakHandles: 0,
    samples: 0,
    error: undefined,
  };
  let timer;
  let inflight = false;

  function track(pid) {
    if (typeof pid === "number") {
      roots.add(pid);
    }
  }

  function untrack(pid) {
    roots.delete(pid);
  }

  async function tick() {
    if (inflight || roots.size === 0) {
      return;
    }
    inflight = true;
    try {
      const snapshot = await sampleProcesses(backend);
      if (snapshot === undefined) {
        if (backend === "wmic") {
          backend = "powershell";
          return;
        }
        if (backend !== "none") {
          backend = "none";
          state.available = false;
        }
        return;
      }
      const tree = treeOf(snapshot, roots);
      let rss = 0;
      let handles = 0;
      for (const entry of tree) {
        rss += entry.rssBytes ?? 0;
        handles += entry.handles ?? 0;
      }
      if (rss > state.peakRssBytes) {
        state.peakRssBytes = rss;
      }
      if (handles > state.peakHandles) {
        state.peakHandles = handles;
      }
      state.samples += 1;
    } catch (error) {
      state.error = String(error);
    } finally {
      inflight = false;
    }
  }

  return {
    track,
    untrack,
    start() {
      if (backend === "none" || timer !== undefined) {
        return;
      }
      timer = setInterval(() => {
        void tick();
      }, intervalMs);
      timer.unref?.();
    },
    async stop() {
      if (timer !== undefined) {
        clearInterval(timer);
        timer = undefined;
      }
      // 收尾再采一次，抓退出前的最后状态
      await tick();
      return {
        available: state.available && state.samples > 0,
        peakRssBytes: state.samples > 0 ? state.peakRssBytes : null,
        peakHandles: state.samples > 0 ? state.peakHandles : null,
        samples: state.samples,
        backend,
        error: state.error,
      };
    },
  };
}

async function sampleProcesses(backend) {
  try {
    if (backend === "ps") {
      const { stdout } = await execFileAsync("ps", ["-eo", "pid=,ppid=,rss="], {
        maxBuffer: 8 * 1024 * 1024,
      });
      return parsePs(stdout);
    }
    if (backend === "wmic") {
      const { stdout } = await execFileAsync(
        "wmic",
        ["process", "get", "ProcessId,ParentProcessId,WorkingSetSize,HandleCount", "/format:csv"],
        { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      return parseWmicCsv(stdout);
    }
    if (backend === "powershell") {
      const { stdout } = await execFileAsync(
        "powershell",
        [
          "-NoProfile",
          "-NonInteractive",
          "-Command",
          "Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,WorkingSetSize,HandleCount | ConvertTo-Json -Compress",
        ],
        { maxBuffer: 16 * 1024 * 1024, windowsHide: true },
      );
      return parsePowershellJson(stdout);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function parsePs(stdout) {
  const byPid = new Map();
  for (const line of stdout.split("\n")) {
    const parts = line.trim().split(/\s+/u);
    if (parts.length < 3) {
      continue;
    }
    const pid = Number(parts[0]);
    const ppid = Number(parts[1]);
    const rssKb = Number(parts[2]);
    if (!Number.isFinite(pid)) {
      continue;
    }
    byPid.set(pid, { pid, ppid, rssBytes: rssKb * 1024, handles: null });
  }
  return byPid;
}

function parseWmicCsv(stdout) {
  const lines = stdout.split(/\r?\n/u).filter((line) => line.trim() !== "");
  if (lines.length < 2) {
    return undefined;
  }
  const header = lines[0].split(",").map((cell) => cell.trim());
  const index = {
    pid: header.indexOf("ProcessId"),
    ppid: header.indexOf("ParentProcessId"),
    rss: header.indexOf("WorkingSetSize"),
    handles: header.indexOf("HandleCount"),
  };
  if (index.pid < 0 || index.ppid < 0) {
    return undefined;
  }
  const byPid = new Map();
  for (const line of lines.slice(1)) {
    const cells = line.split(",");
    const pid = Number(cells[index.pid]);
    if (!Number.isFinite(pid)) {
      continue;
    }
    byPid.set(pid, {
      pid,
      ppid: Number(cells[index.ppid]),
      rssBytes: index.rss >= 0 ? Number(cells[index.rss]) : null,
      handles: index.handles >= 0 ? Number(cells[index.handles]) : null,
    });
  }
  return byPid;
}

function parsePowershellJson(stdout) {
  let parsed;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return undefined;
  }
  const list = Array.isArray(parsed) ? parsed : [parsed];
  const byPid = new Map();
  for (const item of list) {
    const pid = Number(item?.ProcessId);
    if (!Number.isFinite(pid)) {
      continue;
    }
    byPid.set(pid, {
      pid,
      ppid: Number(item?.ParentProcessId),
      rssBytes: Number(item?.WorkingSetSize) || null,
      handles: Number(item?.HandleCount) || null,
    });
  }
  return byPid;
}

function treeOf(snapshot, roots) {
  const children = new Map();
  for (const entry of snapshot.values()) {
    const list = children.get(entry.ppid) ?? [];
    list.push(entry.pid);
    children.set(entry.ppid, list);
  }
  const seen = new Set();
  const result = [];
  const stack = [...roots];
  while (stack.length > 0) {
    const pid = stack.pop();
    if (seen.has(pid)) {
      continue;
    }
    seen.add(pid);
    const entry = snapshot.get(pid);
    if (entry !== undefined) {
      result.push(entry);
    }
    for (const child of children.get(pid) ?? []) {
      stack.push(child);
    }
  }
  return result;
}
