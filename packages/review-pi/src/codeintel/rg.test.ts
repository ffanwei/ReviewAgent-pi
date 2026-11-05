import { expect, test } from "vitest";
import { repoFixturePath } from "../testing/repos.js";
import { rgListFiles, rgSearchWord } from "./rg.js";

// ripgrep 封装（测量常量面）：结果按 (file, line) 排序消除并行输出顺序不确定性，
// 路径归一为仓库相对 POSIX；退出码 0/1 都不是错误，2 才是错误；
// 不用任何静默截断开关（截断一律由预算层显式留痕）。

const SAMPLE = repoFixturePath("sample");

test("rgListFiles：glob 过滤、排序去重、仓库相对 POSIX 路径", async () => {
  const files = await rgListFiles(SAMPLE, "*.java");
  expect(files).toEqual([
    "src/main/java/com/example/Alpha.java",
    "src/main/java/com/example/Beta.java",
    "src/main/java/com/example/Gamma.java",
  ]);
});

test("rgSearchWord：大小写敏感全词匹配，按 (file, line) 排序，保留缩进去尾空白", async () => {
  const matches = await rgSearchWord(SAMPLE, "getBase");
  expect(matches).toEqual([
    {
      file: "src/main/java/com/example/Alpha.java",
      line: 11,
      text: "    public int getBase() {",
    },
    {
      file: "src/main/java/com/example/Beta.java",
      line: 6,
      text: "        int value = alpha.getBase();",
    },
  ]);
});

test("rgSearchWord：大小写敏感与全词边界（getbase / Base 均无匹配）", async () => {
  await expect(rgSearchWord(SAMPLE, "getbase")).resolves.toEqual([]);
  await expect(rgSearchWord(SAMPLE, "Base")).resolves.toEqual([]);
});

test("rgSearchWord：无匹配返回空数组（退出码 1 不是错误）", async () => {
  await expect(rgSearchWord(SAMPLE, "nonexistentWord")).resolves.toEqual([]);
});

test("rgListFiles / rgSearchWord：多 glob 一次扫描（任一匹配）", async () => {
  const files = await rgListFiles(SAMPLE, ["*.ts", "*.java"]);
  expect(files).toHaveLength(3);
  // 只扫未启用的语言 → 0 命中（rg 退出码 1 不是错误）
  await expect(rgSearchWord(SAMPLE, "getBase", { globs: ["*.ts"] })).resolves.toEqual([]);
  // 空 glob 列表 = 显式关闭：不 spawn rg、不退化成扫全仓
  await expect(rgListFiles(SAMPLE, [])).resolves.toEqual([]);
});

test("rgListFiles / rgSearchWord：excludeGlobs 生效（多语言 glob 下排除依赖与生成物）", async () => {
  const MULTILANG = repoFixturePath("multilang");
  const globs = ["*.ts", "*.tsx", "*.js", "*.py"];
  const excludeGlobs = ["**/vendor/**", "**/*.d.ts", "**/__pycache__/**"];
  await expect(rgListFiles(MULTILANG, globs, { excludeGlobs })).resolves.toEqual([
    "service/pkg/__init__.py",
    "service/pkg/util.py",
    "web/src/app.ts",
    "web/src/view.tsx",
  ]);
  // 命中只在被排除的 vendor 里 → 空结果
  await expect(
    rgSearchWord(MULTILANG, "bundledThing", { globs: ["*.js"], excludeGlobs }),
  ).resolves.toEqual([]);
});

test("runRg 错误路径：不存在的根目录显式抛错", async () => {
  await expect(rgListFiles("D:/definitely/not/a/repo", "*.java")).rejects.toThrow();
});
