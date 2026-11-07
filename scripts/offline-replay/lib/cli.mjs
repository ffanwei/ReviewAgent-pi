import { spawn, spawnSync } from "node:child_process";
import { resolve } from "node:path";

import { REPO_ROOT } from "./scenario.mjs";
import { laneEnv, reviewArgs } from "./lane.mjs";

const BIN_PATH = resolve(REPO_ROOT, "packages/review-pi/bin/review-pi.js");

/**
 * spawn 真实 `review-pi` 进程（bin → dist），捕获 stdout / stderr / 退出码 / 墙钟。
 * 超时即杀进程树：bin 用 spawnSync 拉 CLI，单杀 bin 会留下孤儿。
 */
export function runCli({ lane, scenario, timeoutMs, onSpawn }) {
  const args = reviewArgs(lane, scenario);
  const startedAt = process.hrtime.bigint();
  return new Promise((resolvePromise, rejectPromise) => {
    const child = spawn(process.execPath, [BIN_PATH, ...args], {
      cwd: lane.cwd,
      env: laneEnv(lane),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    if (onSpawn !== undefined && child.pid !== undefined) {
      onSpawn(child.pid);
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child.pid);
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      rejectPromise(error);
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      const wallMs = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolvePromise({
        status: code,
        stdout,
        stderr,
        wallMs,
        pid: child.pid,
        timedOut,
        command: [process.execPath, BIN_PATH, ...args],
        cwd: lane.cwd,
      });
    });
  });
}

function killTree(pid) {
  if (pid === undefined) {
    return;
  }
  if (process.platform === "win32") {
    spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // 已经退出
    }
  }
}

export function summarizeCliFailure(run) {
  const stderr = (run.stderr ?? "").trim().split("\n").slice(-12).join("\n");
  return [
    `exit=${String(run.status)}${run.timedOut ? " (timeout)" : ""}`,
    stderr === "" ? "(stderr 为空)" : stderr,
  ].join("\n");
}
