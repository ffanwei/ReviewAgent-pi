#!/usr/bin/env node
/**
 * review-pi Agent Skill — deterministic review preparation + optional run.
 *
 * Why this script exists:
 *   `review-pi review` needs two explicit inputs that a host agent should not
 *   hand-assemble with shell-specific quoting:
 *     1. a repository snapshot on the POST-CHANGE (head) side, so the review
 *        tools read the code that the diff describes;
 *     2. a unified diff file, including untracked files (git diff omits them).
 *   This script produces both, derives a safe taskId, writes everything under
 *   one temp work directory, and can invoke the CLI directly (no shell).
 *
 * Modes:
 *   workspace  HEAD -> working tree (staged + unstaged + untracked), default
 *   range      merge-base(from, to) -> to   (pull-request style)
 *   commit     commit^ -> commit            (merge: first parent)
 *   diff       use an existing unified diff file
 *   json       use an existing GitCode/GitLab file-change JSON
 *
 * Usage:
 *   node scripts/prepare-review.mjs --mode workspace --repo . --json --run
 *   node scripts/prepare-review.mjs --mode range --repo . --base main --head feature --json --run
 *   node scripts/prepare-review.mjs --mode commit --repo . --commit abc123 --json --run
 *   node scripts/prepare-review.mjs --mode diff --repo . --diff-file change.diff --json --run
 *
 * Exit codes: 0 = preparation (and run, when --run) succeeded; 1 = any failure.
 */

import { spawnSync } from "node:child_process";
import {
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

const SCRIPT = "review-pi skill prepare-review";
const MAX_UNTRACKED_BYTES = 5 * 1024 * 1024;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;
const MAX_BUFFER = 256 * 1024 * 1024;
const SECRET_LIKE_PATH =
  /(^|\/)(\.env(\..*)?|id_rsa|id_ed25519|credentials.*|.*\.(pem|key|p12|pfx|keystore))$/i;

const MODES = new Set(["workspace", "range", "commit", "diff", "json"]);
const REPEATABLE = new Set(["rule-skill", "include", "exclude"]);
const BOOLEAN = new Set(["run", "json", "cleanup", "no-untracked", "no-worktree", "help"]);

function main(argv) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error), undefined, argv.includes("--json"));
    return;
  }

  if (args.help === true) {
    process.stdout.write(helpText());
    return;
  }

  const json = args.json === true;
  try {
    const result = prepare(args);
    if (json) {
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    } else {
      printHuman(result);
    }
    if (result.ok === false) process.exitCode = 1;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    fail(message, error instanceof PrepareError ? error.hint : undefined, json);
  }
}

class PrepareError extends Error {
  constructor(message, hint) {
    super(message);
    this.hint = hint;
  }
}

function parseArgs(argv) {
  const out = Object.create(null);
  for (const key of REPEATABLE) out[key] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (typeof token !== "string" || !token.startsWith("--")) {
      throw new Error(`无法识别的参数：${String(token)}`);
    }
    const eq = token.indexOf("=");
    const key = eq === -1 ? token.slice(2) : token.slice(2, eq);
    if (BOOLEAN.has(key)) {
      if (eq !== -1) throw new Error(`布尔旗标不接受值：--${key}`);
      out[key] = true;
      continue;
    }
    if (!KNOWN_VALUE_FLAGS.has(key)) {
      throw new Error(`未知旗标：--${key}（--help 查看用法）`);
    }
    let value;
    if (eq !== -1) {
      value = token.slice(eq + 1);
    } else {
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) {
        throw new Error(`旗标缺值：--${key}`);
      }
      value = next;
      index += 1;
    }
    if (REPEATABLE.has(key)) {
      out[key].push(value);
    } else if (out[key] !== undefined) {
      throw new Error(`旗标重复：--${key}`);
    } else {
      out[key] = value;
    }
  }
  return out;
}

const KNOWN_VALUE_FLAGS = new Set([
  "mode",
  "repo",
  "base",
  "head",
  "commit",
  "diff-file",
  "json-file",
  "out-dir",
  "task-id",
  "issue",
  "rule-skill",
  "config",
  "include",
  "exclude",
  "tasks-dir",
  "bin",
  "timeout-ms",
]);

function prepare(args) {
  const mode = typeof args.mode === "string" ? args.mode : "workspace";
  if (!MODES.has(mode)) {
    throw new PrepareError(
      `未知 mode：${mode}`,
      `可选：${[...MODES].join(" / ")}`,
    );
  }

  const warnings = [];
  const repoArg = typeof args.repo === "string" ? args.repo : ".";
  // diff/json modes only need a directory to read; the other modes need Git.
  const repo =
    mode === "diff" || mode === "json"
      ? resolveSnapshotDirectory(repoArg)
      : resolveRepo(repoArg);
  const headCommit =
    mode === "diff" || mode === "json"
      ? ((isGitWorktree(repo) ? tryRevParse(repo, "HEAD") : null) ?? "nongit")
      : revParseCommit(repo, "HEAD", "当前仓库没有可用的 HEAD 提交");
  // Prefer the reviewed commit over the current checkout for the task id.
  let taskHead = headCommit;
  if (mode === "range" && typeof args.head === "string") {
    taskHead = revParseCommit(repo, args.head, `无法解析 --head：${args.head}`);
  } else if (mode === "commit" && typeof args.commit === "string") {
    taskHead = revParseCommit(repo, args.commit, `无法解析 --commit：${args.commit}`);
  }
  const taskId =
    typeof args["task-id"] === "string" ? validateTaskId(args["task-id"]) : defaultTaskId(mode, taskHead);

  // ---- 1. Build the diff + decide which directory the tools should read ----
  let diffText;
  let headSideRepo = repo;
  let worktree = null;
  let baseLabel = "HEAD";
  let headLabel = headCommit.slice(0, 12);
  let inputKind = "mr-diff";

  if (mode === "workspace") {
    diffText = gitText(repo, ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", "--"]);
    if (args["no-untracked"] !== true) {
      const untracked = untrackedPatches(repo, warnings);
      if (untracked.text !== "") {
        if (diffText !== "" && !diffText.endsWith("\n")) diffText += "\n";
        diffText += untracked.text;
      }
      if (untracked.count > 0) {
        warnings.push(`已在 diff 中补入 ${untracked.count} 个未跟踪文件`);
      }
    }
    headSideRepo = repo;
    headLabel = "working tree";
  } else if (mode === "range") {
    if (typeof args.base !== "string" || args.base.trim() === "") {
      throw new PrepareError("--mode range 需要 --base <ref>", "例如 --base main --head feature");
    }
    const baseRef = args.base;
    const headRef = typeof args.head === "string" ? args.head : "HEAD";
    const baseCommit = revParseCommit(repo, baseRef, `无法解析 --base：${baseRef}`);
    const toCommit = revParseCommit(repo, headRef, `无法解析 --head：${headRef}`);
    const mergeBase = gitText(repo, ["merge-base", baseCommit, toCommit]).trim();
    if (mergeBase === "") {
      throw new PrepareError(
        `--base ${baseRef} 与 --head ${headRef} 没有共同祖先`,
        "确认两个 ref 属于同一个仓库历史",
      );
    }
    diffText = gitText(repo, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      `${mergeBase}..${toCommit}`,
      "--",
    ]);
    baseLabel = mergeBase.slice(0, 12);
    headLabel = `${headRef} (${toCommit.slice(0, 12)})`;
    if (args["no-worktree"] !== true) {
      worktree = createWorktree(repo, toCommit, taskId);
      headSideRepo = worktree.path;
    } else {
      const currentHead = tryRevParse(repo, "HEAD");
      warnings.push(
        currentHead === toCommit
          ? `--no-worktree：当前检出就是 ${headRef} 的改后侧`
          : `--no-worktree：当前 HEAD 是 ${currentHead?.slice(0, 12) ?? "未知"}，不是 ${headRef}（${toCommit.slice(0, 12)}）；工具可能读到混合快照`,
      );
    }
  } else if (mode === "commit") {
    if (typeof args.commit !== "string" || args.commit.trim() === "") {
      throw new PrepareError("--mode commit 需要 --commit <sha>", "例如 --commit abc1234");
    }
    const commit = revParseCommit(repo, args.commit, `无法解析 --commit：${args.commit}`);
    const parents = gitText(repo, ["rev-list", "--parents", "-n", "1", commit])
      .trim()
      .split(/\s+/)
      .filter(Boolean);
    const firstParent = parents.length > 1 ? parents[1] : EMPTY_TREE;
    if (parents.length > 2) {
      warnings.push(`检出合并提交，按第一父提交 ${firstParent.slice(0, 12)} 检视本次引入的变更`);
    }
    diffText = gitText(repo, [
      "diff",
      "--no-ext-diff",
      "--no-textconv",
      "--no-color",
      `${firstParent}..${commit}`,
      "--",
    ]);
    baseLabel = firstParent === EMPTY_TREE ? "(root commit)" : firstParent.slice(0, 12);
    headLabel = commit.slice(0, 12);
    if (args["no-worktree"] !== true) {
      worktree = createWorktree(repo, commit, taskId);
      headSideRepo = worktree.path;
    } else {
      const currentHead = tryRevParse(repo, "HEAD");
      warnings.push(
        currentHead === commit
          ? "--no-worktree：当前检出就是该提交的改后侧"
          : `--no-worktree：当前 HEAD 是 ${currentHead?.slice(0, 12) ?? "未知"}，不是 ${commit.slice(0, 12)}；工具可能读到混合快照`,
      );
    }
  } else if (mode === "diff") {
    if (typeof args["diff-file"] !== "string") {
      throw new PrepareError("--mode diff 需要 --diff-file <path>", "指向一份标准 unified diff 文本文件");
    }
    const diffPath = path.resolve(process.cwd(), args["diff-file"]);
    if (!existsSync(diffPath) || !statSync(diffPath).isFile()) {
      throw new PrepareError(`diff 文件不存在或不是文件：${diffPath}`, "检查 --diff-file 路径");
    }
    diffText = readFileSync(diffPath, "utf8");
    baseLabel = "provided diff";
    headLabel = "provided diff";
    warnings.push("已有 diff 模式：请确认 --repo 指向改后（head）侧的工作树");
  } else if (mode === "json") {
    if (typeof args["json-file"] !== "string") {
      throw new PrepareError(
        "--mode json 需要 --json-file <path>",
        "指向 GitCode/GitLab `pulls/:number/files` 原样 JSON",
      );
    }
    const jsonPath = path.resolve(process.cwd(), args["json-file"]);
    if (!existsSync(jsonPath) || !statSync(jsonPath).isFile()) {
      throw new PrepareError(`MR JSON 文件不存在或不是文件：${jsonPath}`, "检查 --json-file 路径");
    }
    inputKind = "mr-json";
    // Used only for the emptiness check and stats; the original bytes are copied.
    diffText = readFileSync(jsonPath, "utf8");
    baseLabel = "provided MR JSON";
    headLabel = "provided MR JSON";
    warnings.push("MR JSON 模式：请确认 --repo 指向改后（head）侧的工作树");
  }

  if (diffText.trim() === "") {
    throw new PrepareError(
      "变更集为空：没有可检视的 diff",
      mode === "workspace"
        ? "先修改 / 暂存文件，或改用 --mode range / commit / diff / json"
        : "确认 base/head/commit 选择正确",
    );
  }

  // ---- 2. Materialize the work directory + write the input ----
  const workDir = path.resolve(
    typeof args["out-dir"] === "string"
      ? args["out-dir"]
      : path.join(os.tmpdir(), "review-pi-skill", taskId),
  );
  mkdirSync(workDir, { recursive: true });
  const inputDir = path.join(workDir, "input");
  mkdirSync(inputDir, { recursive: true });

  // Keep the caller's filename for provided inputs: review-pi derives caseId
  // from the input filename, and losing it would silently rename the case.
  const diffPath =
    mode === "diff"
      ? path.join(inputDir, path.basename(args["diff-file"]))
      : mode === "json"
        ? path.join(inputDir, path.basename(args["json-file"]))
        : path.join(inputDir, "change.diff");
  if (inputKind === "mr-json") {
    copyFileSync(path.resolve(process.cwd(), args["json-file"]), diffPath);
  } else {
    writeFileSync(diffPath, diffText, "utf8");
  }

  const tasksDir = path.resolve(
    typeof args["tasks-dir"] === "string" ? args["tasks-dir"] : path.join(workDir, "tasks"),
  );
  const runsDir = path.join(tasksDir, taskId, "runs");
  const stats =
    inputKind === "mr-json"
      ? { files: null, added: null, removed: null, chars: diffText.length }
      : countDiff(diffText);

  // ---- 3. Persist the plan (useful when a host tool dies mid-run) ----
  const plan = {
    ok: true,
    mode,
    inputKind,
    taskId,
    workDir,
    repo: headSideRepo,
    repoRoot: repo,
    diff: diffPath,
    tasksDir,
    runsDir,
    base: baseLabel,
    head: headLabel,
    stats,
    worktree,
    cleanup: worktree === null ? [] : [worktreeCleanupCommand(repo, worktree.path)],
    warnings,
  };
  writeFileSync(path.join(workDir, "plan.json"), `${JSON.stringify(plan, null, 2)}\n`, "utf8");

  // ---- 4. Optional: run the CLI without a shell ----
  if (args.run === true) {
    const runResult = runReview({
      args,
      plan,
      diffPath,
      inputKind,
      headSideRepo,
      taskId,
      workDir,
      tasksDir,
      runsDir,
    });
    if (args.cleanup === true && worktree !== null) {
      cleanupWorktree(repo, worktree.path, runResult.warnings);
      runResult.cleanup = [];
    }
    return runResult;
  }

  return { ...plan, command: buildCommand(args, plan, diffPath, inputKind) };
}

function runReview({ args, plan, diffPath, inputKind, headSideRepo, taskId, workDir, tasksDir, runsDir }) {
  const cli = resolveCli(args, headSideRepo);
  if (cli === null) {
    return {
      ...plan,
      ok: false,
      exitCode: null,
      error: "找不到 review-pi CLI",
      hint: "安装：npm i -g @baize/review-pi；或传 --bin <...>/bin/review-pi.js（也可设 REVIEW_PI_BIN）",
    };
  }

  const cliArgs = [
    "review",
    "--repo",
    headSideRepo,
    inputKind === "mr-json" ? "--mr-json" : "--mr-diff",
    diffPath,
    "--taskId",
    taskId,
    "--tasks-dir",
    tasksDir,
    "--no-progress",
  ];
  if (typeof args.issue === "string" && args.issue.trim() !== "") cliArgs.push("--issue", args.issue);
  if (typeof args.config === "string") cliArgs.push("--config", path.resolve(process.cwd(), args.config));
  for (const value of args["rule-skill"] ?? []) cliArgs.push("--rule-skill", path.resolve(process.cwd(), value));
  for (const value of args.include ?? []) cliArgs.push("--include", value);
  for (const value of args.exclude ?? []) cliArgs.push("--exclude", value);

  const timeoutMs =
    typeof args["timeout-ms"] === "string" ? Number.parseInt(args["timeout-ms"], 10) : DEFAULT_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return { ...plan, ok: false, exitCode: null, error: "timeout-ms 必须是正整数" };
  }

  const stdoutPath = path.join(workDir, "review.stdout.json");
  const stderrPath = path.join(workDir, "review.stderr.log");
  const startedAt = new Date().toISOString();
  const result = spawnCli(cli, cliArgs, {
    cwd: workDir,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    timeout: timeoutMs,
    windowsHide: true,
  });
  const finishedAt = new Date().toISOString();
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  writeFileSync(stdoutPath, stdout, "utf8");
  writeFileSync(stderrPath, stderr, "utf8");

  let review = null;
  let parseError = null;
  if (stdout.trim() !== "") {
    try {
      review = JSON.parse(stdout);
    } catch (error) {
      parseError = error instanceof Error ? error.message : String(error);
    }
  }

  const reviewsAllPath = path.join(runsDir, "reviews_all.json");
  const tipsPath = path.join(runsDir, "reviews_tips_zh.json");
  const severityCounts = countSeverities(review?.findings);
  const ok = result.status === 0 && review !== null && review.ok === true;

  const output = {
    ...plan,
    ok,
    cli: describeCli(cli),
    exitCode: result.status,
    startedAt,
    finishedAt,
    stdoutPath,
    stderrPath,
    reviewsAllPath: existsSync(reviewsAllPath) ? reviewsAllPath : null,
    tipsPath: existsSync(tipsPath) ? tipsPath : null,
    review:
      review === null
        ? null
        : {
            ok: review.ok,
            caseId: review.caseId,
            runId: review.runId,
            truncated: review.truncated,
            rounds: review.rounds,
            toolCalls: review.toolCalls,
            auditPath: review.auditPath,
            findingCount: Array.isArray(review.findings) ? review.findings.length : null,
            severityCounts,
          },
  };

  if (result.error !== undefined) {
    output.error = `CLI 启动或超时失败：${result.error.message}`;
    output.hint =
      result.error.code === "ETIMEDOUT"
        ? `超过 ${timeoutMs}ms；可用 --timeout-ms 放大，或检查配置 / 网关`
        : "检查 review-pi 是否可执行、Node 版本是否 >= 22.19";
    output.stderrTail = tailLines(stderr, 40);
    return output;
  }
  if (parseError !== null) {
    output.error = `stdout 不是单个 JSON 文档：${parseError}`;
    output.hint = "看 stderrTail；stdout 混入非 JSON 通常意味着 CLI 入口不对（例如跑到了 shim）";
    output.stderrTail = tailLines(stderr, 40);
    return output;
  }
  if (!ok) {
    output.error =
      result.status === 0
        ? `review-pi 退出码 0，但 stdout 的 ok 不是 true（ok=${String(review?.ok)}）`
        : `review-pi 退出码 ${String(result.status)}`;
    output.hint = hintForFailure(stderr);
    output.stderrTail = tailLines(stderr, 40);
  }
  return output;
}

function resolveCli(args, repo) {
  const candidates = [];
  if (typeof args.bin === "string" && args.bin.trim() !== "") candidates.push(args.bin);
  if (typeof process.env.REVIEW_PI_BIN === "string" && process.env.REVIEW_PI_BIN !== "") {
    candidates.push(process.env.REVIEW_PI_BIN);
  }

  // Repo-local dev form: walk up from the reviewed repo.
  let dir = repo;
  for (let depth = 0; depth < 8; depth += 1) {
    candidates.push(path.join(dir, "packages", "review-pi", "bin", "review-pi.js"));
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  // Global npm install: resolve the JS entry, never a .cmd/.ps1 shim.
  const npmRoot = npmGlobalRoot();
  if (npmRoot !== null) {
    candidates.push(path.join(npmRoot, "@baize", "review-pi", "bin", "review-pi.js"));
  }

  for (const candidate of candidates) {
    const resolved = path.resolve(candidate);
    if (!existsSync(resolved)) continue;
    let stat;
    try {
      stat = statSync(resolved);
    } catch {
      continue;
    }
    if (!stat.isFile()) continue;
    if (resolved.endsWith(".js") || resolved.endsWith(".mjs") || resolved.endsWith(".cjs")) {
      return { kind: "node", path: resolved };
    }
    return { kind: "exec", path: resolved };
  }

  if (typeof args.bin === "string" && args.bin.trim() !== "") {
    // Explicit bare command (e.g. "review-pi"): try it as-is.
    return { kind: "command", path: args.bin };
  }
  return null;
}

function npmGlobalRoot() {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const result = spawnSync(command, ["root", "-g"], {
    encoding: "utf8",
    timeout: 15_000,
    // npm on Windows is a .cmd shim; shell:true is required. The args are fixed.
    shell: process.platform === "win32",
    windowsHide: true,
  });
  if (result.error !== undefined || result.status !== 0) return null;
  const root = (result.stdout ?? "").trim();
  return root === "" ? null : root;
}

function spawnCli(cli, args, options) {
  if (cli.kind === "node") return spawnSync(process.execPath, [cli.path, ...args], options);
  if (cli.kind === "exec") return spawnSync(cli.path, args, options);
  // Bare command. On Windows a npm shim is .cmd and needs a shell; the caller
  // explicitly opted into this form, and arguments come from the skill user.
  return spawnSync(cli.path, args, {
    ...options,
    shell: process.platform === "win32",
  });
}

function describeCli(cli) {
  return cli.kind === "node" ? `node ${cli.path}` : cli.path;
}

// ---------------------------------------------------------------------------
// git helpers
// ---------------------------------------------------------------------------

function git(cwd, args) {
  return spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: MAX_BUFFER,
    windowsHide: true,
  });
}

function gitText(cwd, args) {
  const result = git(cwd, args);
  if (result.error !== undefined) {
    throw new PrepareError(`git ${args.join(" ")} 启动失败：${result.error.message}`, "确认 git 已安装且在 PATH 中");
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? "").trim().split("\n").slice(-3).join(" / ");
    throw new PrepareError(`git ${args.join(" ")} 失败（exit ${String(result.status)}）：${detail}`);
  }
  return result.stdout ?? "";
}

function resolveDirectory(repoArg) {
  const input = path.resolve(process.cwd(), repoArg);
  if (!existsSync(input) || !statSync(input).isDirectory()) {
    throw new PrepareError(`--repo 不是目录：${input}`, "传仓库快照目录");
  }
  return input;
}

/** diff/json: a Git subdirectory must resolve to its toplevel, because diff
 *  paths are repository-relative; a plain directory is used as-is. */
function resolveSnapshotDirectory(repoArg) {
  const input = resolveDirectory(repoArg);
  return isGitWorktree(input) ? resolveRepo(input) : input;
}

function isGitWorktree(dir) {
  const result = git(dir, ["rev-parse", "--is-inside-work-tree"]);
  return result.error === undefined && result.status === 0 && (result.stdout ?? "").trim() === "true";
}

function resolveRepo(repoArg) {
  const input = path.resolve(process.cwd(), repoArg);
  if (!existsSync(input)) {
    throw new PrepareError(`--repo 不存在：${input}`, "传仓库工作树路径（默认当前目录）");
  }
  const result = git(input, ["rev-parse", "--show-toplevel"]);
  if (result.error !== undefined || result.status !== 0 || (result.stdout ?? "").trim() === "") {
    throw new PrepareError(
      `--repo 不是 Git 工作树：${input}`,
      "传仓库根目录或任意子目录；非 Git 仓库请改用 --mode diff / json",
    );
  }
  return path.resolve((result.stdout ?? "").trim());
}

function revParseCommit(repo, ref, hint) {
  const result = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  if (result.error !== undefined || result.status !== 0) {
    throw new PrepareError(`无法解析 ref：${ref}`, hint);
  }
  return (result.stdout ?? "").trim();
}

function tryRevParse(repo, ref) {
  const result = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return result.error === undefined && result.status === 0 ? (result.stdout ?? "").trim() : null;
}

function createWorktree(repo, commit, taskId) {
  const target = path.join(os.tmpdir(), "review-pi-skill", taskId, "repo");
  if (existsSync(target)) {
    rmSync(target, { recursive: true, force: true });
  }
  mkdirSync(path.dirname(target), { recursive: true });
  const result = git(repo, ["worktree", "add", "--detach", target, commit]);
  if (result.error !== undefined || result.status !== 0) {
    const detail = (result.stderr ?? "").trim().split("\n").slice(-3).join(" / ");
    throw new PrepareError(
      `创建改后侧 worktree 失败：${detail}`,
      "可改用 --no-worktree 并自行准备 head 侧检出，或 --mode diff 传入已有 diff",
    );
  }
  return { path: target, commit };
}

function worktreeCleanupCommand(repo, target) {
  return `git -C "${repo}" worktree remove --force "${target}"`;
}

function cleanupWorktree(repo, target, warnings) {
  const result = git(repo, ["worktree", "remove", "--force", target]);
  if (result.error !== undefined || result.status !== 0) {
    warnings.push(`worktree 清理失败，请手动执行：${worktreeCleanupCommand(repo, target)}`);
  }
}

// ---------------------------------------------------------------------------
// Untracked files -> new-file unified diff
// ---------------------------------------------------------------------------

function untrackedPatches(repo, warnings) {
  const result = git(repo, ["ls-files", "--others", "--exclude-standard", "-z"]);
  if (result.error !== undefined || result.status !== 0) {
    warnings.push("读取未跟踪文件失败；本次 diff 不包含未跟踪文件");
    return { text: "", count: 0 };
  }
  const paths = (result.stdout ?? "").split("\0").filter(Boolean).sort();
  const chunks = [];
  let count = 0;
  for (const relative of paths) {
    if (relative.includes("\n")) {
      warnings.push(`跳过含换行的未跟踪路径：${JSON.stringify(relative)}`);
      continue;
    }
    const absolute = path.join(repo, ...relative.split("/"));
    let stat;
    try {
      stat = lstatSync(absolute);
    } catch {
      warnings.push(`跳过无法访问的未跟踪文件：${relative}`);
      continue;
    }
    if (!stat.isFile()) {
      warnings.push(`跳过非普通文件的未跟踪条目：${relative}`);
      continue;
    }
    if (stat.size > MAX_UNTRACKED_BYTES) {
      warnings.push(`跳过超过 ${MAX_UNTRACKED_BYTES} 字节的未跟踪文件：${relative}`);
      continue;
    }
    if (SECRET_LIKE_PATH.test(relative)) {
      warnings.push(
        `未跟踪文件疑似包含凭据，仍会进入 diff：${relative}（如不打算送检请加 --no-untracked）`,
      );
    }
    let bytes;
    try {
      bytes = readFileSync(absolute);
    } catch {
      warnings.push(`跳过无法读取的未跟踪文件：${relative}`);
      continue;
    }
    if (bytes.includes(0)) {
      warnings.push(`跳过二进制未跟踪文件：${relative}`);
      continue;
    }
    let text = bytes.toString("utf8");
    if (text.startsWith("﻿")) text = text.slice(1);
    const lines = splitLines(text);
    const quoted = quoteGitPath(relative);
    const header = [
      `diff --git "a/${quoted}" "b/${quoted}"`,
      "new file mode 100644",
      "--- /dev/null",
      `+++ "b/${quoted}"`,
    ];
    if (lines.length > 0) {
      header.push(`@@ -0,0 +1,${lines.length} @@`);
      for (const line of lines) header.push(`+${line}`);
    }
    chunks.push(`${header.join("\n")}\n`);
    count += 1;
  }
  return { text: chunks.join(""), count };
}

function splitLines(text) {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

function quoteGitPath(relative) {
  const bytes = Buffer.from(relative, "utf8");
  let out = "";
  for (const byte of bytes) {
    if (byte === 0x22) out += '\\"';
    else if (byte === 0x5c) out += "\\\\";
    else if (byte === 0x0a) out += "\\n";
    else if (byte === 0x09) out += "\\t";
    else if (byte === 0x0d) out += "\\r";
    else if (byte < 0x20 || byte >= 0x7f) out += `\\${byte.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(byte);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Task id / stats / presentation
// ---------------------------------------------------------------------------

function defaultTaskId(mode, headCommit) {
  const now = new Date();
  const pad = (value, width = 2) => String(value).padStart(width, "0");
  const stamp = [
    now.getFullYear(),
    pad(now.getMonth() + 1),
    pad(now.getDate()),
    "-",
    pad(now.getHours()),
    pad(now.getMinutes()),
    pad(now.getSeconds()),
    "-",
    pad(now.getMilliseconds(), 3),
  ].join("");
  const sha = headCommit === "nongit" ? "file" : headCommit.slice(0, 7);
  return sanitizeTaskId(`review-${mode}-${sha}-${stamp}`);
}

function sanitizeTaskId(value) {
  let id = value.replace(/[^A-Za-z0-9._-]/g, "-").replace(/^\.+/, "").replace(/-+/g, "-");
  if (id === "") id = "review";
  if (isWindowsReserved(id)) id = `review-${id}`;
  return id.slice(0, 80);
}

function validateTaskId(value) {
  if (
    value.trim() === "" ||
    /[\\/:*?"<>|]/.test(value) ||
    value.startsWith(".") ||
    /[\u0000-\u001f]/.test(value)
  ) {
    throw new PrepareError(
      `--task-id 不是合法的单段目录名：${JSON.stringify(value)}`,
      "只能用单段名字：不能含路径分隔符、控制字符、<>:\"|?* 或前导点",
    );
  }
  if (isWindowsReserved(value)) {
    throw new PrepareError(`--task-id 命中 Windows 保留设备名：${value}`, "换一个名字");
  }
  return value;
}

function isWindowsReserved(value) {
  const stem = value.split(".")[0]?.toUpperCase() ?? "";
  return /^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/.test(stem);
}

function countDiff(diff) {
  let files = 0;
  let added = 0;
  let removed = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) files += 1;
    else if (line.startsWith("+") && !line.startsWith("+++")) added += 1;
    else if (line.startsWith("-") && !line.startsWith("---")) removed += 1;
  }
  return { files, added, removed, chars: diff.length };
}

function countSeverities(findings) {
  const counts = { P0: 0, P1: 0, P2: 0, P3: 0 };
  if (!Array.isArray(findings)) return counts;
  for (const finding of findings) {
    const severity = finding?.severity;
    if (typeof severity === "string" && Object.hasOwn(counts, severity)) counts[severity] += 1;
  }
  return counts;
}

function buildCommand(args, plan, diffPath, inputKind) {
  const command = [
    "review-pi",
    "review",
    "--repo",
    plan.repo,
    inputKind === "mr-json" ? "--mr-json" : "--mr-diff",
    diffPath,
    "--taskId",
    plan.taskId,
    "--tasks-dir",
    plan.tasksDir,
  ];
  if (typeof args.issue === "string" && args.issue.trim() !== "") command.push("--issue", args.issue);
  if (typeof args.config === "string") command.push("--config", path.resolve(process.cwd(), args.config));
  for (const value of args["rule-skill"] ?? []) command.push("--rule-skill", path.resolve(process.cwd(), value));
  for (const value of args.include ?? []) command.push("--include", value);
  for (const value of args.exclude ?? []) command.push("--exclude", value);
  return command;
}

function hintForFailure(stderr) {
  if (/apiKey|api key|API 密钥/i.test(stderr)) return "配置缺少 reviewer.apiKey：运行 review-pi config init 并填写";
  if (/model\.default|model default/i.test(stderr)) return "配置缺少 model.default：在 ~/.PiAgent/PiAgent.jsonc 中填写";
  if (/ENOTFOUND|ECONNREFUSED|ETIMEDOUT|网关|gateway/i.test(stderr)) return "网关不可达：运行 review-pi smoke 诊断";
  if (/--repo|mr-diff|mr-json|用法|usage/i.test(stderr)) return "输入或参数有误：看 stderrTail 前几行";
  return "看 stderrTail；必要时原样转述给人，不要自行重试超过一次";
}

function tailLines(text, limit) {
  const lines = text.split("\n");
  return lines.slice(Math.max(0, lines.length - limit)).join("\n");
}

function printHuman(result) {
  const lines = [];
  if (result.ok === false) {
    lines.push(`准备/运行失败：${result.error ?? "未知错误"}`);
    if (typeof result.hint === "string") lines.push(`建议：${result.hint}`);
    if (typeof result.stderrTail === "string" && result.stderrTail.trim() !== "") {
      lines.push("", "stderr 末尾：", result.stderrTail.trim());
    }
  } else {
    lines.push(`mode: ${result.mode}`);
    lines.push(`taskId: ${result.taskId}`);
    lines.push(`repo: ${result.repo}`);
    lines.push(result.inputKind === "mr-json" ? `MR JSON: ${result.diff}` : `diff: ${result.diff}`);
    if (result.stats?.files === null) {
      lines.push(`MR JSON：${result.stats.chars} 字符`);
    } else if (result.stats !== undefined) {
      lines.push(`diff 统计：${result.stats.files} 文件 / +${result.stats.added} / -${result.stats.removed}`);
    }
    if (Array.isArray(result.cleanup) && result.cleanup.length > 0) {
      lines.push(`清理：${result.cleanup.join(" ; ")}`);
    }
    if (Array.isArray(result.warnings) && result.warnings.length > 0) {
      lines.push("", "注意：");
      for (const warning of result.warnings) lines.push(`- ${warning}`);
    }
    if (result.review !== undefined && result.review !== null) {
      const review = result.review;
      lines.push(
        "",
        `检视完成：exit ${String(result.exitCode)} · ${review.findingCount ?? 0} 条意见` +
          `（P0 ${review.severityCounts.P0} / P1 ${review.severityCounts.P1} / P2 ${review.severityCounts.P2} / P3 ${review.severityCounts.P3}）` +
          ` · truncated=${String(review.truncated)}`,
        `stdout: ${result.stdoutPath}`,
        `stderr: ${result.stderrPath}`,
      );
    }
  }
  process.stdout.write(`${lines.join("\n")}\n`);
}

function fail(message, hint, json) {
  if (json === true) {
    process.stdout.write(`${JSON.stringify({ ok: false, error: message, ...(hint !== undefined ? { hint } : {}) }, null, 2)}\n`);
  } else {
    process.stderr.write(`${SCRIPT}: ${message}\n`);
    if (hint !== undefined) process.stderr.write(`建议：${hint}\n`);
  }
  process.exitCode = 1;
}

function helpText() {
  return `usage: node scripts/prepare-review.mjs [options]

Modes:
  --mode workspace             HEAD -> working tree (staged + unstaged + untracked)  [default]
  --mode range --base <ref> [--head <ref>]
  --mode commit --commit <sha>
  --mode diff --diff-file <path>
  --mode json --json-file <path>

Options:
  --repo <path>               repository worktree (default: cwd)
  --issue <text>              business context passed to review-pi
  --rule-skill <dir>          explicit rule-skill pack (repeatable; never auto-discovered)
  --include <regex>           review scope whitelist (repeatable)
  --exclude <regex>           review scope blacklist (repeatable)
  --config <path>             review-pi JSONC config
  --task-id <id>              single-segment task id (default: generated)
  --out-dir <path>            work dir (default: <tmp>/review-pi-skill/<taskId>)
  --tasks-dir <path>          review-pi tasks root (default: <workDir>/tasks)
  --bin <path|command>        review-pi entry (default: auto-detect)
  --run                       run review-pi after preparation
  --timeout-ms <n>            CLI timeout when --run (default: ${DEFAULT_TIMEOUT_MS})
  --cleanup                   remove the temporary worktree after --run
  --no-untracked              exclude untracked files (workspace mode)
  --no-worktree               use --repo as-is for range/commit
  --json                      machine-readable output
  --help                      this text
`;
}

main(process.argv.slice(2));
