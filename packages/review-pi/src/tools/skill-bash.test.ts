import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import {
  buildSkillBashTool,
  formatHostPlatformNote,
  resolveExecutable,
  runSkillBashCommand,
  splitSkillCommand,
  type SkillBashProcessOutcome,
} from "./skill-bash.js";

// skill 会话 bash 边界（ADR-0014 决策 7）：命令白名单已移除（任意 PATH 可执行
// 文件），其余边界不变——env 白名单 + cwd = pack 根 + 禁引号外 shell 元字符 +
// 120s + 结果预算。

const PACK_ROOT = "C:\\cache\\deadbeef\\sample-rule";

function runnerReturning(outcome: Partial<SkillBashProcessOutcome> = {}) {
  const calls: Array<{ command: string; args: readonly string[]; cwd: string; env: Record<string, string> }> = [];
  const runner = async (
    command: string,
    args: readonly string[],
    options: { cwd: string; env: Record<string, string> },
  ): Promise<SkillBashProcessOutcome> => {
    calls.push({ command, args, cwd: options.cwd, env: options.env });
    return { stdout: "", stderr: "", exitCode: 0, timedOut: false, ...outcome };
  };
  return { runner, calls };
}

test("命令按引号分组切 argv（反斜杠字面保留）", () => {
  expect(splitSkillCommand("python scripts/a.py --keyword null")).toEqual([
    "python",
    "scripts/a.py",
    "--keyword",
    "null",
  ]);
  expect(splitSkillCommand(`python "C:\\pack dir\\a.py" 'x y'`)).toEqual([
    "python",
    "C:\\pack dir\\a.py",
    "x y",
  ]);
  expect(splitSkillCommand("   ")).toEqual([]);
});

test("未闭合引号被拒绝（不抛穿工具边界）", async () => {
  const text = await runSkillBashCommand(`python "a.py`, { packRoot: PACK_ROOT, runner: runnerReturning().runner });
  expect(text).toContain("unterminated");
  expect(text.startsWith("Error: ")).toBe(true);
});

test("引号外的 shell 元字符一律拒绝（管道/重定向/链接/替换/换行）", async () => {
  for (const command of [
    "python a.py | tee out",
    "python a.py > out",
    "python a.py && python b.py",
    "python a.py; rm -rf /",
    "python a.py $(whoami)",
    "python a.py `whoami`",
    "python a.py\nrm -rf /",
  ]) {
    const text = await runSkillBashCommand(command, {
      packRoot: PACK_ROOT,
      runner: runnerReturning().runner,
    });
    expect(text, command).toContain("metacharacters");
  }
});

test("引号内的 shell 元字符按字面透传（`python -c` 的语句分隔符不被误拦）", async () => {
  const { runner, calls } = runnerReturning({ stdout: "C:\\pack" });
  for (const command of [
    `python -c "import os; print(os.getcwd())"`,
    `python -c "print('a|b')"`,
    `python -c "print('$HOME')"`,
  ]) {
    const text = await runSkillBashCommand(command, { packRoot: PACK_ROOT, runner });
    expect(text, command).toBe("C:\\pack");
  }
  expect(calls).toHaveLength(3);
  // 引号剥掉，整段代码作为单个 argv 元素交给 python
  expect(calls[0]?.args).toEqual(["-c", "import os; print(os.getcwd())"]);
});

test("NUL 即使出现在引号内也拒绝（argv 无法承载）", async () => {
  const { runner, calls } = runnerReturning();
  const text = await runSkillBashCommand('python -c "a\u0000b"', { packRoot: PACK_ROOT, runner });
  expect(text).toContain("metacharacters");
  expect(calls).toHaveLength(0);
});

test("引号外紧邻引号的分号仍被拒绝（闭合后不再豁免）", async () => {
  const { runner, calls } = runnerReturning();
  const text = await runSkillBashCommand(`python -c "print(1)"; rm -rf /`, {
    packRoot: PACK_ROOT,
    runner,
  });
  expect(text).toContain("metacharacters");
  expect(calls).toHaveLength(0);
});

test("任意可执行命令都放行（命令白名单已移除，仍无 shell）", async () => {
  const { runner, calls } = runnerReturning({ stdout: "ok" });
  for (const command of [
    "git status --porcelain",
    "node verify.js",
    "sh -c 'ls'",
    "rg TODO --glob *.java",
  ]) {
    const text = await runSkillBashCommand(command, { packRoot: PACK_ROOT, runner });
    expect(text, command).toBe("ok");
  }
  expect(calls.map((call) => call.command)).toEqual(["git", "node", "sh", "rg"]);
});

test("argv[0] 原样透传（不做白名单归一 / 大小写改写）", async () => {
  const { runner, calls } = runnerReturning({ stdout: "ok" });
  for (const executable of ["python", "python3", "python.exe", "PYTHON3", "GIT"]) {
    const text = await runSkillBashCommand(`${executable} a.py`, { packRoot: PACK_ROOT, runner });
    expect(text, executable).toBe("ok");
  }
  expect(calls.map((call) => call.command)).toEqual([
    "python",
    "python3",
    "python.exe",
    "PYTHON3",
    "GIT",
  ]);
});

test("PATH 上找不到可执行文件 → 显式 Error 文本（不伪装成脚本失败）", async () => {
  const { runner } = runnerReturning({ notFound: true });
  const text = await runSkillBashCommand("nosuchcmd --version", { packRoot: PACK_ROOT, runner });
  expect(text).toBe("Error: command not found on PATH: nosuchcmd");
});

test("cwd = pack 根；env 只含白名单键且强制 UTF-8", async () => {
  const { runner, calls } = runnerReturning({ stdout: "ok" });
  await runSkillBashCommand("python a.py", {
    packRoot: PACK_ROOT,
    runner,
    env: {
      PATH: "/usr/bin",
      HOME: "/home/u",
      PYTHONIOENCODING: "latin-1",
      SECRET_TOKEN: "leak-me",
      AWS_ACCESS_KEY_ID: "leak-me",
    },
  });
  const call = calls[0];
  expect(call?.cwd).toBe(PACK_ROOT);
  expect(call?.args).toEqual(["a.py"]);
  expect(call?.env).toEqual({ PATH: "/usr/bin", HOME: "/home/u", PYTHONIOENCODING: "utf-8" });
  expect(call?.env.SECRET_TOKEN).toBeUndefined();
});

test("stdout 原样返回；stderr 分段追加；非零退出带退出码", async () => {
  const { runner } = runnerReturning({
    stdout: "line1\nline2\n",
    stderr: "bad thing\n",
    exitCode: 2,
  });
  const text = await runSkillBashCommand("python a.py", { packRoot: PACK_ROOT, runner });
  expect(text).toBe("line1\nline2\n[stderr]\nbad thing\n[exit code 2]");
});

test("超时留痕；无输出时给出占位文本", async () => {
  const { runner } = runnerReturning({ timedOut: true, exitCode: -1 });
  const text = await runSkillBashCommand("python a.py", { packRoot: PACK_ROOT, runner, timeoutMs: 1000 });
  expect(text).toBe("[timed out after 1000 ms]");

  const empty = await runSkillBashCommand("python a.py", { packRoot: PACK_ROOT, runner: runnerReturning().runner });
  expect(empty).toBe("(no output)");
});

test("输出走结果预算层（截断留痕，不静默丢弃）", async () => {
  const stdout = Array.from({ length: 40 }, (_, index) => `line-${String(index).padStart(2, "0")}`).join("\n");
  const { runner } = runnerReturning({ stdout });
  const text = await runSkillBashCommand("python a.py", {
    packRoot: PACK_ROOT,
    runner,
    resultBudgetChars: 60,
  });
  expect(text).toContain("output truncated: 7/40 lines shown");
  expect(text.split("\n")[0]).toBe("line-00");
});

test("AgentTool 形状：name = bash、schema 只收 command、执行走同一边界", async () => {
  const { runner, calls } = runnerReturning({ stdout: "ran" });
  const tool = buildSkillBashTool({ packRoot: PACK_ROOT, runner });
  expect(tool.name).toBe("bash");
  const parameters = tool.parameters as { required: readonly string[] };
  expect(parameters.required).toEqual(["command"]);

  const result = await tool.execute("call-1", { command: "python a.py", ignored: true });
  expect(result.content).toEqual([{ type: "text", text: "ran" }]);
  expect(calls).toHaveLength(1);
});

// ---- 宿主平台提示（ADR-0020）：同一条命令在 Windows/POSIX 上不通用 ----

test("宿主平台提示：Windows 明示路径风格、.cmd 被拒、python 优先于 python3", () => {
  const note = formatHostPlatformNote("win32", "x64");
  expect(note).toContain("Host platform: Windows (win32, x64)");
  expect(note).toContain(".cmd/.bat shims such as npx are rejected");
  expect(note).toContain("prefer `python` over `python3`");
  expect(note).toContain("without a shell");
});

test("宿主平台提示：macOS / Linux 用 POSIX 路径、python3 常在而 python 可能缺席", () => {
  const mac = formatHostPlatformNote("darwin", "arm64");
  expect(mac).toContain("Host platform: macOS (darwin, arm64)");
  expect(mac).toContain("POSIX paths");
  expect(mac).toContain("`python3` is normally present");
  const linux = formatHostPlatformNote("linux", "x64");
  expect(linux).toContain("Host platform: Linux (linux, x64)");
  expect(linux).toContain("POSIX paths");
});

test("宿主平台提示：未知平台的兜底文案仍含平台名与无 shell 约束", () => {
  const note = formatHostPlatformNote("aix" as NodeJS.Platform, "ppc64");
  expect(note).toContain("Host platform: aix (aix, ppc64)");
  expect(note).toContain("Shell builtins");
});

test("bash 工具描述带上平台提示（且不改 name/schema）", () => {
  const windows = buildSkillBashTool({ packRoot: PACK_ROOT, platform: "win32", arch: "x64" });
  expect(windows.name).toBe("bash");
  expect(windows.description).toContain("120s timeout");
  expect(windows.description).toContain("Host platform: Windows (win32, x64)");
  expect(windows.description).toContain("prefer `python` over `python3`");

  const posix = buildSkillBashTool({ packRoot: PACK_ROOT, platform: "linux", arch: "x64" });
  expect(posix.description).toContain("Host platform: Linux (linux, x64)");
  expect(posix.description).not.toContain("cmd/.bat");
});

// ---- 可执行文件定位（决策 7 修订：不再有命令白名单，仍然不搜 cwd）----

const tempRoots: string[] = [];

/** 建一个临时「bin 目录」，按平台放一个可被认作可执行文件的文件 */
function fakeBinDir(executable: string): string {
  const root = mkdtempSync(path.join(tmpdir(), "skill-bash-"));
  tempRoots.push(root);
  const file = path.join(root, process.platform === "win32" ? `${executable}.exe` : executable);
  writeFileSync(file, "", "utf8");
  return root;
}

afterAll(() => {
  for (const root of tempRoots) {
    rmSync(root, { recursive: true, force: true });
  }
});

test("裸名只搜 PATH 的绝对目录（找到即返回绝对路径）", () => {
  const bin = fakeBinDir("git");
  const resolved = resolveExecutable("git", { PATH: bin });
  expect(resolved).toBe(
    path.join(bin, process.platform === "win32" ? "git.exe" : "git"),
  );
});

test("裸名不搜 cwd / 相对 PATH 条目 / pack 根", () => {
  const bin = fakeBinDir("git");
  const packRoot = mkdtempSync(path.join(tmpdir(), "skill-bash-pack-"));
  tempRoots.push(packRoot);
  writeFileSync(
    path.join(packRoot, process.platform === "win32" ? "git.exe" : "git"),
    "",
    "utf8",
  );
  // 只有 pack 根（不在 PATH）→ 解析不到
  expect(resolveExecutable("git", { PATH: "" })).toBeUndefined();
  // 相对 PATH 条目一律不认（否则等价于搜 cwd）
  expect(resolveExecutable("git", { PATH: "." })).toBeUndefined();
  // 混合时取绝对目录里的那个，绝不取当前目录
  const resolved = resolveExecutable("git", { PATH: `.${path.delimiter}${bin}` });
  expect(resolved).toBe(
    path.join(bin, process.platform === "win32" ? "git.exe" : "git"),
  );
});

test("显式路径按原样交给 spawn（含分隔符即视为调用方已指定文件）", () => {
  const bin = fakeBinDir("git");
  const explicit = path.join(bin, process.platform === "win32" ? "git.exe" : "git");
  expect(resolveExecutable(explicit, { PATH: "" })).toBe(explicit);
  expect(resolveExecutable("./scripts/run.sh", { PATH: "" })).toBe("./scripts/run.sh");
  expect(resolveExecutable("scripts\\run.bat", { PATH: "" })).toBe("scripts\\run.bat");
});

test("Windows 不解析 .cmd / .bat（shell: false 下由 Node 拒绝）", () => {
  if (process.platform !== "win32") {
    return;
  }
  const bin = mkdtempSync(path.join(tmpdir(), "skill-bash-cmd-"));
  tempRoots.push(bin);
  writeFileSync(path.join(bin, "npm.cmd"), "", "utf8");
  expect(resolveExecutable("npm", { PATH: bin })).toBeUndefined();
});
