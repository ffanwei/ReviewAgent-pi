import { execFile } from "node:child_process";
import { lstat, open, readdir, stat } from "node:fs/promises";
import path from "node:path";

import type { EnumeratedRepo, RepoFile, SkippedFile } from "./types.js";

/** git 输出缓冲上限：全仓文件清单可能很大，但仍是纯文本。 */
const GIT_MAX_BUFFER = 64 * 1024 * 1024;
/** 与 OCR / git 常用的二进制嗅探窗口一致。 */
const BINARY_SNIFF_BYTES = 8_000;

/**
 * spike 的默认源码扩展名白名单。
 *
 * 刻意不包含 Markdown / HTML / CSS：探针阶段先看代码与常见配置；
 * 需要更宽的范围时应在后续 scan 模式里做显式配置，而不是在 spike 里放开。
 */
const SOURCE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".go",
  ".java",
  ".kt",
  ".kts",
  ".c",
  ".cc",
  ".cpp",
  ".cxx",
  ".h",
  ".hh",
  ".hpp",
  ".hxx",
  ".cs",
  ".rs",
  ".php",
  ".rb",
  ".swift",
  ".scala",
  ".sh",
  ".bash",
  ".zsh",
  ".ps1",
  ".sql",
  ".proto",
  ".graphql",
  ".gql",
  ".prisma",
  ".json",
  ".jsonc",
  ".yaml",
  ".yml",
  ".toml",
  ".gradle",
  ".xml",
  ".properties",
  ".tf",
  ".bicep",
  ".nix",
  ".rego",
  ".sol",
  ".vy",
  ".lua",
  ".dart",
  ".ex",
  ".exs",
]);

/** 目录名级排除：spike 不做 glob 解析，按路径段判断，确定性且快。 */
const EXCLUDED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  "node_modules",
  "dist",
  "build",
  "out",
  "target",
  "vendor",
  "third_party",
  "external",
  "__pycache__",
  ".venv",
  "venv",
  "generated",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  "tmp",
  "temp",
  "testdata",
  "fixtures",
  "snapshots",
  "__snapshots__",
]);

/** 文件名级排除：锁文件 / 源映射 / 压缩产物。 */
const EXCLUDED_BASENAMES = new Set([
  "package-lock.json",
  "pnpm-lock.yaml",
  "yarn.lock",
  "Cargo.lock",
  "composer.lock",
  "poetry.lock",
  "Gemfile.lock",
]);

const EXCLUDED_SUFFIXES = [".min.js", ".min.css", ".map", ".d.ts"];

export interface EnumerateRepoOptions {
  readonly repoPath: string;
  readonly maxFiles: number;
  readonly maxFileChars: number;
  /** 只检视该仓库相对路径前缀（POSIX，空 = 全仓） */
  readonly pathPrefix?: string;
  /** 只检视这些仓库相对路径（POSIX，精确匹配） */
  readonly files?: readonly string[];
  /** 路径白名单正则（`--include`）：命中任一才保留；空 = 不过滤 */
  readonly includeRegexes?: readonly RegExp[];
  /** 路径黑名单正则（`--exclude`）：命中即剔除，优先于白名单 */
  readonly excludeRegexes?: readonly RegExp[];
}

/**
 * 枚举仓库里可送进 spike 的源码/配置文件。
 *
 * - git 仓库：`git ls-files` + untracked（完整 .gitignore 语义）；
 * - 非 git：递归 walk，按目录/文件名黑名单过滤；
 * - 输出按路径排序，后续分组/合成 diff 因此完全确定。
 */
export async function enumerateRepoFiles(options: EnumerateRepoOptions): Promise<EnumeratedRepo> {
  const repoPath = path.resolve(options.repoPath);
  const info = await stat(repoPath);
  if (!info.isDirectory()) {
    throw new Error(`--repo is not a directory: ${repoPath}`);
  }

  const all = [...(await listRepoPaths(repoPath))].sort(compareText);
  const prefix = normalizePrefix(options.pathPrefix);
  const requested = options.files === undefined ? undefined : new Set(options.files.map(toPosix));
  if (requested !== undefined) {
    const missing = [...requested].filter((rel) => !all.includes(rel));
    if (missing.length > 0) {
      throw new Error(`--files contains path(s) not found in repo: ${missing.join(", ")}`);
    }
  }
  const skipped: SkippedFile[] = [];
  const files: RepoFile[] = [];
  const include = options.includeRegexes ?? [];
  const exclude = options.excludeRegexes ?? [];

  for (const rel of all) {
    if (requested !== undefined && !requested.has(rel)) {
      continue;
    }
    if (prefix !== "" && rel !== prefix && !rel.startsWith(`${prefix}/`)) {
      continue;
    }
    // 检视范围过滤（ADR-0078 同语义）：白名单先选、黑名单后剔。
    if (include.length > 0 && !matchesAny(include, rel)) {
      skipped.push({ path: rel, reason: "excluded-path" });
      continue;
    }
    if (matchesAny(exclude, rel)) {
      skipped.push({ path: rel, reason: "excluded-path" });
      continue;
    }
    if (isExcludedPath(rel)) {
      skipped.push({ path: rel, reason: "excluded-path" });
      continue;
    }
    if (!isSourceFile(rel)) {
      skipped.push({ path: rel, reason: "unsupported-extension" });
      continue;
    }
    const full = path.join(repoPath, ...rel.split("/"));
    // lstat 而非 stat：符号链接一律不跟随，避免把仓库外文件带进检视范围。
    const fileStat = await lstat(full).catch(() => undefined);
    if (fileStat === undefined || !fileStat.isFile()) {
      skipped.push({ path: rel, reason: "not-a-regular-file" });
      continue;
    }
    if (fileStat.size === 0) {
      skipped.push({ path: rel, reason: "empty" });
      continue;
    }
    if (fileStat.size > options.maxFileChars) {
      skipped.push({ path: rel, reason: `too-large(${fileStat.size}>${options.maxFileChars})` });
      continue;
    }
    if (await looksBinary(full)) {
      skipped.push({ path: rel, reason: "binary" });
      continue;
    }
    files.push({ path: rel, size: fileStat.size });
  }

  const limited = files.slice(0, options.maxFiles);
  for (const extra of files.slice(options.maxFiles)) {
    skipped.push({ path: extra.path, reason: "max-files" });
  }

  return {
    files: limited,
    skipped,
    discovered: all.length,
  };
}

async function listRepoPaths(repoPath: string): Promise<readonly string[]> {
  if (await isGitRepo(repoPath)) {
    const tracked = await runGit(repoPath, ["ls-files", "-z"]).catch(() => undefined);
    const untracked = await runGit(repoPath, ["ls-files", "-z", "--others", "--exclude-standard"]).catch(
      () => undefined,
    );
    if (tracked !== undefined) {
      const seen = new Set<string>();
      for (const raw of [...splitNul(tracked), ...splitNul(untracked ?? "")]) {
        const rel = toPosix(raw);
        if (rel !== "") {
          seen.add(rel);
        }
      }
      return [...seen];
    }
  }
  return walkFiles(repoPath);
}

async function isGitRepo(repoPath: string): Promise<boolean> {
  try {
    await runGit(repoPath, ["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

function runGit(cwd: string, args: readonly string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { cwd, maxBuffer: GIT_MAX_BUFFER, windowsHide: true },
      (error, stdout) => {
        if (error !== null) {
          reject(error);
          return;
        }
        resolve(stdout);
      },
    );
  });
}

async function walkFiles(root: string): Promise<readonly string[]> {
  const out: string[] = [];
  const visit = async (dir: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (entry.isSymbolicLink()) {
        continue;
      }
      const full = path.join(dir, entry.name);
      const rel = toPosix(path.relative(root, full));
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIRS.has(entry.name)) {
          await visit(full);
        }
        continue;
      }
      if (entry.isFile()) {
        out.push(rel);
      }
    }
  };
  await visit(root);
  return out;
}

async function looksBinary(fullPath: string): Promise<boolean> {
  const handle = await open(fullPath, "r");
  try {
    const buffer = Buffer.alloc(BINARY_SNIFF_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, BINARY_SNIFF_BYTES, 0);
    return buffer.subarray(0, bytesRead).includes(0);
  } finally {
    await handle.close();
  }
}

function isExcludedPath(rel: string): boolean {
  const parts = rel.split("/");
  if (parts.some((part) => EXCLUDED_DIRS.has(part))) {
    return true;
  }
  const base = parts.at(-1) ?? "";
  if (EXCLUDED_BASENAMES.has(base)) {
    return true;
  }
  return EXCLUDED_SUFFIXES.some((suffix) => base.toLowerCase().endsWith(suffix));
}

function isSourceFile(rel: string): boolean {
  const base = rel.split("/").at(-1) ?? rel;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) {
    return false;
  }
  return SOURCE_EXTENSIONS.has(base.slice(dot).toLowerCase());
}

function normalizePrefix(raw: string | undefined): string {
  if (raw === undefined) {
    return "";
  }
  return raw
    .trim()
    .replaceAll("\\", "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+$/, "");
}

function splitNul(value: string): readonly string[] {
  return value.split("\u0000").filter((item) => item.length > 0);
}

function toPosix(value: string): string {
  return value.split(path.sep).join("/");
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function matchesAny(patterns: readonly RegExp[], value: string): boolean {
  return patterns.some((pattern) => pattern.test(value));
}
