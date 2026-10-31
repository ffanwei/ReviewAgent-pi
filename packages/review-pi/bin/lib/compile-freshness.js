/**
 * bin 编译判鲜（#7 P3b）：review-pi bin 的「在位检查 + mtime 新鲜度门」
 * 共享实现（纯 node 内建、零依赖，供 bin 与单元测试共用——
 * src/cli/compile-freshness.test.ts 经同目录 .d.ts 消费）。
 *
 * 判鲜语义与 DSH 线 bin/lib/compile-freshness 一致：产物缺席 → 陈旧；
 * 任一源树中最新文件的 mtime 严格晚于产物 mtime → 陈旧；等于视为新鲜；
 * 源根缺席不贡献信号（多根判鲜允许某根不存在）。
 *
 * pi 线扩展——构建不可见的源不计数：*.test.ts 文件与 testing / e2e
 * 目录（镜像 packages/review-pi/tsconfig.build.json 的 exclude 集）
 * 不进 dist 构建，改它们不应触发拒跑。tsconfig.build.json 若改 exclude，
 * 此处需同步（漂移锚点）。
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** 不进 dist 构建的文件后缀（tsconfig.build.json exclude 的文件面） */
const EXCLUDED_FILE_SUFFIXES = [".test.ts"];

/** 不进 dist 构建的目录名（tsconfig.build.json exclude 的目录面 + 防御性跳过） */
const EXCLUDED_DIR_NAMES = ["testing", "e2e", "node_modules", "dist"];

/** 目录树内最新文件 mtime（递归，构建可见文件才算）；目录缺席或不可读返回入参 latest（不贡献信号） */
function newestMtime(dir, latest) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return latest;
  }
  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (!EXCLUDED_DIR_NAMES.includes(entry.name)) {
        latest = newestMtime(path, latest);
      }
    } else if (entry.isFile() && !EXCLUDED_FILE_SUFFIXES.some((suffix) => entry.name.endsWith(suffix))) {
      const mtime = statSync(path).mtimeMs;
      if (mtime > latest) {
        latest = mtime;
      }
    }
  }
  return latest;
}

/**
 * 产物是否陈旧：缺席 → true；任一源根的最新 mtime（构建可见文件）严格晚于
 * 产物 mtime → true。等于视为新鲜（同刻产物不拒跑）。
 */
export function isCompileStale(outputPath, sourceRoots) {
  if (!existsSync(outputPath)) {
    return true;
  }
  let outputMtime;
  try {
    outputMtime = statSync(outputPath).mtimeMs;
  } catch {
    return true;
  }
  for (const root of sourceRoots) {
    if (newestMtime(root, 0) > outputMtime) {
      return true;
    }
  }
  return false;
}
