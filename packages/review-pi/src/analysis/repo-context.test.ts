import { expect, test } from "vitest";
import { repoFixturePath } from "../testing/repos.js";
import { derivePackageFromPath, loadRepoContext } from "./repo-context.js";

// 仓库快照上下文（测量常量面）：Zone B 构造的确定性读取层。
// 文件清单来自 ripgrep；模块名走文件头部词法提取（仅声明型语言；无声明 → ""）；
// 源码读取与符号解析按需 memoize。

const SAMPLE = repoFixturePath("sample");

test("loadRepoContext：清单 / 词法包名 / 根文件名 / 读取与符号索引", async () => {
  const context = await loadRepoContext(SAMPLE);
  expect(context.repoName).toBe("sample");
  expect(context.languages.map((language) => language.id)).toEqual([
    "java",
    "typescript",
    "python",
    "go",
    "cpp",
  ]);
  // auto 启用全部语言，但展示面只列仓库里真实存在的语言
  expect(context.detectedLanguages.map((language) => language.id)).toEqual(["java"]);
  expect(context.languageLabel).toBe("Java");
  expect(context.sourceFiles).toEqual([
    "src/main/java/com/example/Alpha.java",
    "src/main/java/com/example/Beta.java",
    "src/main/java/com/example/Gamma.java",
  ]);
  expect(context.moduleNameByFile.get("src/main/java/com/example/Alpha.java")).toBe("com.example");
  expect(context.moduleNameByFile.get("src/main/java/com/example/Beta.java")).toBe("com.example");
  // Gamma.java 无 package 声明：词法提取兜底为默认包
  expect(context.moduleNameByFile.get("src/main/java/com/example/Gamma.java")).toBe("");
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
    /failed to list .* source files/,
  );
});

test("loadRepoContext：codeintel.languages 可收窄/显式关闭；未实现语言退化为 0 源文件", async () => {
  const disabled = await loadRepoContext(SAMPLE, { languages: [] });
  expect(disabled.languages).toEqual([]);
  expect(disabled.languageLabel).toBe("");
  expect(disabled.sourceFiles).toEqual([]);

  const nonJava = await loadRepoContext(SAMPLE, { languages: ["kotlin"] });
  // 未实现语言在 resolveLanguages 里被过滤（配置装载期已告警）；运行时同样退化为 0 文件
  expect(nonJava.languages).toEqual([]);
  expect(nonJava.sourceFiles).toEqual([]);
});

test("loadRepoContext：excludeGlobs 生效（多语言 glob 下不把依赖/生成物当源码）", async () => {
  const context = await loadRepoContext(repoFixturePath("multilang"));
  expect(context.sourceFiles.some((file) => file.includes("vendor/"))).toBe(false);
  expect(context.sourceFiles.some((file) => file.endsWith(".d.ts"))).toBe(false);
  expect(context.sourceFiles.some((file) => file.includes("__pycache__"))).toBe(false);
  expect(context.sourceFiles).toEqual([
    "native/src/math.cpp",
    "service/cmd/main.go",
    "service/pkg/__init__.py",
    "service/pkg/util.py",
    "web/src/app.ts",
    "web/src/view.tsx",
  ]);
});

test("loadRepoContext：多语言仓——检测语言、模块名与符号索引按文件分派", async () => {
  const context = await loadRepoContext(repoFixturePath("multilang"));
  expect(context.detectedLanguages.map((language) => language.id)).toEqual([
    "typescript",
    "python",
    "go",
    "cpp",
  ]);
  expect(context.languageLabel).toBe("TypeScript/JavaScript, Python, Go, C/C++");
  // 只有 Go 做文件头部预读（package 子句）；TS/Python/C++ 都不需要
  expect(context.moduleNameByFile.size).toBe(1);
  expect(context.moduleNameByFile.get("service/cmd/main.go")).toBe("main");
  expect(context.languageFor("web/src/app.ts")?.id).toBe("typescript");
  expect(context.languageFor("web/src/view.tsx")?.id).toBe("typescript");
  expect(context.languageFor("service/pkg/util.py")?.id).toBe("python");
  expect(context.languageFor("service/cmd/main.go")?.id).toBe("go");
  expect(context.languageFor("native/src/math.cpp")?.id).toBe("cpp");

  const ts = await context.symbolIndex("web/src/app.ts");
  expect(ts.moduleName).toBe("");
  expect(ts.symbols.map((symbol) => symbol.name)).toEqual([
    "Renderer",
    "Greeter",
    "greetAll",
    "shout",
  ]);
  expect(ts.invocations.map((invocation) => invocation.name)).toContain("renderName");

  const py = await context.symbolIndex("service/pkg/util.py");
  expect(py.moduleName).toBe("service.pkg.util");
  expect(py.symbols.map((symbol) => symbol.name)).toEqual(["Formatter", "make_default"]);
  expect(py.invocations.map((invocation) => invocation.name)).toContain("upper");

  const go = await context.symbolIndex("service/cmd/main.go");
  expect(go.moduleName).toBe("main");
  expect(go.symbols.map((symbol) => `${symbol.kind}:${symbol.name}`)).toEqual([
    "struct:Greeter",
    "function:NewGreeter",
    "method:Greet",
    "function:main",
  ]);
  expect(go.symbols.find((symbol) => symbol.name === "Greet")?.owner).toBe("Greeter");
  expect(go.invocations.map((invocation) => invocation.name)).toContain("Greet");

  const cpp = await context.symbolIndex("native/src/math.cpp");
  expect(cpp.moduleName).toBe("");
  expect(cpp.symbols.map((symbol) => symbol.name)).toEqual(["math"]);
  expect(cpp.symbols[0]?.members.map((member) => `${member.kind}:${member.name}`)).toEqual([
    "struct:Point",
    "method:sum",
    "function:make_point",
    "function:doubled",
  ]);
  expect(cpp.invocations.map((invocation) => invocation.name)).toContain("sum");
});

test("candidateFilesForName：rg 预收窄（多语言 glob 下只返回文本命中文件）", async () => {
  const context = await loadRepoContext(repoFixturePath("multilang"));
  await expect(context.candidateFilesForName("renderName")).resolves.toEqual(["web/src/app.ts"]);
  await expect(context.candidateFilesForName("noSuchSymbolAnywhere")).resolves.toEqual([]);
});

test("derivePackageFromPath：src/main/java 与 src/test/java 前缀剥离，其余按目录推导", () => {
  expect(derivePackageFromPath("src/main/java/com/example/Alpha.java")).toBe("com.example");
  expect(derivePackageFromPath("src/test/java/org/x/Y.java")).toBe("org.x");
  // 嵌套模块：不以 src/main/java 开头 → 取最后一个 java 段之后的目录
  expect(derivePackageFromPath("core/src/main/java/a/b/C.java")).toBe("a.b");
  expect(derivePackageFromPath("src/Alpha.java")).toBe("src");
  expect(derivePackageFromPath("Alpha.java")).toBe("");
});
