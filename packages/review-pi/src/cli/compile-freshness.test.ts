import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, expect, test } from "vitest";
import { isCompileStale } from "../../bin/lib/compile-freshness.js";

// bin 判鲜核心（#7 P3b）：产物在位/mtime 新鲜度门的语义单元面。
// 与 DSH 线 bin/lib/compile-freshness 同判鲜语义（缺席→陈旧；任一源根最新
// mtime 严格晚于产物→陈旧；等于视为新鲜；源根缺席不贡献信号），pi 线扩展：
// 不进 dist 构建的源（*.test.ts 与 testing/e2e 目录——镜像
// tsconfig.build.json exclude）不计数——否则改测试文件即误触拒跑。

const tempDirs: string[] = [];

function makeTree(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-freshness-"));
  tempDirs.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** 写文件并钉 mtime（同一 Date 对象 → 同刻；判鲜口径「等于视为新鲜」靠它构造） */
function writeFileAt(filePath: string, at: Date): void {
  writeFileSync(filePath, "x");
  utimesSync(filePath, at, at);
}

/** 距今 ageMs 毫秒的时间戳（仅次序有意义的场合；同刻断言用共享 Date 对象） */
function ago(ageMs: number): Date {
  return new Date(Date.now() - ageMs);
}

test("产物缺席 → 陈旧（在位检查）", () => {
  const base = makeTree();
  const src = path.join(base, "src");
  mkdirSync(src);
  writeFileAt(path.join(src, "a.ts"), ago(10_000));
  expect(isCompileStale(path.join(base, "dist", "missing.js"), [src])).toBe(true);
});

test("任一源树最新 mtime 严格晚于产物 → 陈旧（多根判鲜）", () => {
  const base = makeTree();
  const srcA = path.join(base, "srcA");
  const srcB = path.join(base, "srcB");
  mkdirSync(srcA);
  mkdirSync(srcB);
  const output = path.join(base, "dist.js");
  writeFileAt(output, ago(5_000));
  // 根 A 全旧、根 B 有新源 → 陈旧（信号来自任一根）
  writeFileAt(path.join(srcA, "old.ts"), ago(50_000));
  writeFileAt(path.join(srcB, "new.ts"), ago(100));
  expect(isCompileStale(output, [srcA, srcB])).toBe(true);
});

test("源不新于产物 → 新鲜（等于视为新鲜，同刻产物不拒跑）", () => {
  const base = makeTree();
  const src = path.join(base, "src");
  mkdirSync(src);
  const output = path.join(base, "dist.js");
  const sameAge = ago(5_000);
  writeFileAt(output, sameAge);
  writeFileAt(path.join(src, "same-age.ts"), sameAge);
  writeFileAt(path.join(src, "older.ts"), ago(6_000));
  expect(isCompileStale(output, [src])).toBe(false);
});

test("不进 dist 构建的源不计数：*.test.ts 与 testing/e2e 目录", () => {
  const base = makeTree();
  const src = path.join(base, "src");
  for (const dir of ["src", "src/testing", "src/e2e", "src/nested"]) {
    mkdirSync(path.join(base, dir), { recursive: true });
  }
  const output = path.join(base, "dist.js");
  writeFileAt(output, ago(5_000));
  // 全部「构建不可见」的源都新于产物——仍必须新鲜
  writeFileAt(path.join(src, "args.test.ts"), ago(100));
  writeFileAt(path.join(src, "testing", "helper.ts"), ago(100));
  writeFileAt(path.join(src, "e2e", "smoke.e2e.ts"), ago(100));
  expect(isCompileStale(output, [src])).toBe(false);
  // 构建可见的源（任意非测试 .ts，含嵌套）新于产物 → 陈旧
  mkdirSync(path.join(src, "nested", "deep"), { recursive: true });
  writeFileAt(path.join(src, "nested", "deep", "main.ts"), ago(100));
  expect(isCompileStale(output, [src])).toBe(true);
});

test("源根缺席 → 不贡献信号（多根判鲜允许某根不存在）", () => {
  const base = makeTree();
  const src = path.join(base, "src");
  mkdirSync(src);
  const output = path.join(base, "dist.js");
  writeFileAt(output, ago(5_000));
  writeFileAt(path.join(src, "a.ts"), ago(6_000));
  expect(isCompileStale(output, [src, path.join(base, "no-such-root")])).toBe(false);
});
