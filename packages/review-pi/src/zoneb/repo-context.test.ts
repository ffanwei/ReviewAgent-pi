import { expect, test } from "vitest";
import { repoFixturePath } from "../testing/repos.js";
import { derivePackageFromPath, loadRepoContext } from "./repo-context.js";

// 仓库快照上下文（测量常量面）：Zone B 构造的确定性读取层。
// 文件清单来自 ripgrep；包名走文件头部词法提取（无 package 声明 → 默认包 ""）；
// 源码读取与符号解析按需 memoize。

const SAMPLE = repoFixturePath("sample");

test("loadRepoContext：清单 / 词法包名 / 根文件名 / 读取与符号索引", async () => {
  const context = await loadRepoContext(SAMPLE);
  expect(context.repoName).toBe("sample");
  expect(context.javaFiles).toEqual([
    "src/main/java/com/example/Alpha.java",
    "src/main/java/com/example/Beta.java",
    "src/main/java/com/example/Gamma.java",
  ]);
  expect(context.packageNameByFile.get("src/main/java/com/example/Alpha.java")).toBe("com.example");
  expect(context.packageNameByFile.get("src/main/java/com/example/Beta.java")).toBe("com.example");
  // Gamma.java 无 package 声明：词法提取兜底为默认包
  expect(context.packageNameByFile.get("src/main/java/com/example/Gamma.java")).toBe("");
  expect(context.rootFileNames).toContain("pom.xml");
  expect(context.rootFileNames).toContain("README.md");

  expect(context.hasFile("src/main/java/com/example/Alpha.java")).toBe(true);
  expect(context.hasFile("src/main/java/com/example/Missing.java")).toBe(false);

  const alphaSource = await context.readSource("src/main/java/com/example/Alpha.java");
  expect(alphaSource).toContain("public class Alpha");

  const index = await context.symbolIndex("src/main/java/com/example/Beta.java");
  expect(index.symbols[0]?.name).toBe("Beta");
  expect(index.symbols[0]?.members.map((member) => member.name)).toEqual(["combine", "scale"]);
});

test("loadRepoContext：memoize——同一文件读取/解析各只一次（同一对象复用）", async () => {
  const context = await loadRepoContext(SAMPLE);
  const first = await context.symbolIndex("src/main/java/com/example/Alpha.java");
  const second = await context.symbolIndex("src/main/java/com/example/Alpha.java");
  expect(second).toBe(first);
});

test("loadRepoContext：读不存在的仓库路径显式抛错（fail fast）", async () => {
  await expect(loadRepoContext("D:/definitely/not/a/repo")).rejects.toThrow(
    /failed to list Java files/,
  );
});

test("derivePackageFromPath：src/main/java 与 src/test/java 前缀剥离，其余按目录推导", () => {
  expect(derivePackageFromPath("src/main/java/com/example/Alpha.java")).toBe("com.example");
  expect(derivePackageFromPath("src/test/java/org/x/Y.java")).toBe("org.x");
  // 嵌套模块：不以 src/main/java 开头 → 取最后一个 java 段之后的目录
  expect(derivePackageFromPath("core/src/main/java/a/b/C.java")).toBe("a.b");
  expect(derivePackageFromPath("src/Alpha.java")).toBe("src");
  expect(derivePackageFromPath("Alpha.java")).toBe("");
});
