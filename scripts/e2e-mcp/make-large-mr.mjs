#!/usr/bin/env node
/**
 * Regenerate the large-MR review fixture.
 *
 * The fixture has two halves:
 *   - testdata/e2e/large-mr/before/**  — the "before" snapshot (small skeleton)
 *   - testdata/repos/large-mr/**       — the "after" snapshot (reviewed tree)
 *
 * This script builds a throwaway git repository, commits the before snapshot,
 * overlays the after snapshot, and captures `git diff --cached` as a real
 * unified diff at testdata/e2e/large-mr.diff. Running it twice produces the
 * same file, so the fixture can be rebuilt after any edit.
 *
 * Usage:
 *   node scripts/e2e-mcp/make-large-mr.mjs [--check-only]
 */

import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..");
const BEFORE_DIR = join(REPO_ROOT, "packages", "review-pi", "testdata", "e2e", "large-mr", "before");
const AFTER_DIR = join(REPO_ROOT, "packages", "review-pi", "testdata", "repos", "large-mr");
const DIFF_FILE = join(REPO_ROOT, "packages", "review-pi", "testdata", "e2e", "large-mr.diff");

const LIMITS = {
  maxFiles: 10,
  maxDiffLines: 2000,
  minAddedLines: 1000,
};

const cleanupDirs = [];

function cleanup() {
  for (const dir of cleanupDirs.splice(0)) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best effort
    }
  }
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? REPO_ROOT,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    throw result.error;
  }
  if (result.status !== 0 && options.allowFailure !== true) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status}):\n${result.stderr}`);
  }
  return result;
}

function listFiles(root, base = root, out = []) {
  for (const entry of readdirSync(base).sort()) {
    const full = join(base, entry);
    if (statSync(full).isDirectory()) {
      listFiles(root, full, out);
    } else {
      out.push(relative(root, full).split(sep).join("/"));
    }
  }
  return out;
}

function assertFixtureShape() {
  if (!existsSync(BEFORE_DIR)) {
    throw new Error(`missing before snapshot: ${BEFORE_DIR}`);
  }
  if (!existsSync(AFTER_DIR)) {
    throw new Error(`missing after snapshot: ${AFTER_DIR}`);
  }
  const before = listFiles(BEFORE_DIR);
  const after = listFiles(AFTER_DIR);
  const missing = before.filter((file) => !after.includes(file));
  if (missing.length > 0) {
    throw new Error(`after snapshot is missing before files: ${missing.join(", ")}`);
  }
  return { before, after };
}

function gitIn(cwd) {
  return (args) =>
    run(
      "git",
      [
        "-c",
        "core.autocrlf=false",
        "-c",
        "user.name=fixture",
        "-c",
        "user.email=fixture@example.com",
        ...args,
      ],
      { cwd },
    );
}

function buildDiff() {
  const scratch = mkdtempSync(join(tmpdir(), "large-mr-"));
  cleanupDirs.push(scratch);
  const work = join(scratch, "work");
  mkdirSync(work, { recursive: true });
  cpSync(BEFORE_DIR, work, { recursive: true });

  const git = gitIn(work);
  git(["init", "--quiet"]);
  git(["add", "--all"]);
  git(["commit", "--quiet", "-m", "before"]);

  cpSync(AFTER_DIR, work, { recursive: true });
  git(["add", "--all"]);
  const diff = git(["diff", "--cached", "--no-color", "--no-ext-diff", "-U3"]).stdout;
  return diff;
}

function countDiff(diff) {
  const files = new Map();
  let added = 0;
  let removed = 0;
  let current = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      const match = /^diff --git a\/(.+) b\/(.+)$/.exec(line);
      current = match === null ? null : { path: match[2], added: 0, removed: 0 };
      if (current !== null) {
        files.set(current.path, current);
      }
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) {
      continue;
    }
    if (line.startsWith("+")) {
      added += 1;
      if (current !== null) current.added += 1;
    } else if (line.startsWith("-")) {
      removed += 1;
      if (current !== null) current.removed += 1;
    }
  }
  return { files: [...files.values()], added, removed, changed: added + removed };
}

/** Apply a patch with line-ending conversion disabled (Windows git defaults hurt). */
function applyPatch(cwd, patchFile, extraArgs = []) {
  return run(
    "git",
    [
      "-c",
      "core.autocrlf=false",
      "-c",
      "core.eol=lf",
      "apply",
      ...extraArgs,
      patchFile,
    ],
    { cwd, allowFailure: true },
  );
}

function verifyApplies(diff) {
  const scratch = mkdtempSync(join(tmpdir(), "large-mr-apply-"));
  cleanupDirs.push(scratch);
  cpSync(BEFORE_DIR, scratch, { recursive: true });
  const patchFile = join(scratch, "__patch.diff");
  writeFileSync(patchFile, diff, "utf8");
  const result = applyPatch(scratch, patchFile, ["--check"]);
  if (result.status !== 0) {
    throw new Error(`generated diff does not apply to the before snapshot:\n${result.stderr}`);
  }
}

function verifyAfterMatches(diff) {
  // Applying the diff to before must reproduce the after tree byte for byte.
  const scratch = mkdtempSync(join(tmpdir(), "large-mr-roundtrip-"));
  cleanupDirs.push(scratch);
  cpSync(BEFORE_DIR, scratch, { recursive: true });
  const patchFile = join(scratch, "__patch.diff");
  writeFileSync(patchFile, diff, "utf8");
  const applied = applyPatch(scratch, patchFile);
  if (applied.status !== 0) {
    throw new Error(`round-trip apply failed:\n${applied.stderr}`);
  }
  for (const file of listFiles(AFTER_DIR)) {
    const applied = join(scratch, file.split("/").join(sep));
    if (!existsSync(applied)) {
      throw new Error(`round-trip lost file: ${file}`);
    }
    if (readFileSync(applied, "utf8") !== readFileSync(join(AFTER_DIR, file), "utf8")) {
      throw new Error(`round-trip mismatch: ${file}`);
    }
  }
}

function main() {
  const checkOnly = process.argv.includes("--check-only");
  const { before, after } = assertFixtureShape();

  const diff = buildDiff();
  const stats = countDiff(diff);

  const problems = [];
  if (stats.added < LIMITS.minAddedLines) {
    problems.push(`added lines ${stats.added} < ${LIMITS.minAddedLines}`);
  }
  if (stats.files.length > LIMITS.maxFiles) {
    problems.push(`changed files ${stats.files.length} > ${LIMITS.maxFiles}`);
  }
  if (stats.changed > LIMITS.maxDiffLines) {
    problems.push(`changed lines ${stats.changed} > ${LIMITS.maxDiffLines}`);
  }
  if (problems.length > 0) {
    throw new Error(`fixture out of bounds:\n  - ${problems.join("\n  - ")}`);
  }

  verifyApplies(diff);
  verifyAfterMatches(diff);

  console.log(`before files: ${before.length}`);
  console.log(`after files:  ${after.length}`);
  console.log(`diff files:   ${stats.files.length}`);
  console.log(`added:        ${stats.added}`);
  console.log(`removed:      ${stats.removed}`);
  console.log(`changed:      ${stats.changed}`);
  console.log("numstat:");
  for (const file of stats.files) {
    console.log(`  +${file.added}\t-${file.removed}\t${file.path}`);
  }

  if (checkOnly) {
    console.log("check-only: diff not written");
    return;
  }

  writeFileSync(DIFF_FILE, diff, "utf8");
  console.log(`wrote ${relative(REPO_ROOT, DIFF_FILE).split(sep).join("/")} (${diff.length} chars)`);
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  cleanup();
}
