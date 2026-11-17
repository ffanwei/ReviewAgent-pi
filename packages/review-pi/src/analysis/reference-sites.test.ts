import { expect, test } from "vitest";
import { repoFixturePath } from "../testing/repos.js";
import { loadRepoContext } from "./repo-context.js";
import { enclosingLabel, findReferenceSites } from "./reference-sites.js";
import type { CodeSymbol } from "./symbols.js";

// Reference 层解析（测量常量面）：rg 名字级全词匹配 + 符号链定位「谁在引用」；
// 整行注释匹配被确定性过滤（注释提及不是代码引用）。

const SAMPLE = repoFixturePath("sample");
const MULTILANG = repoFixturePath("multilang");

test("findReferenceSites：声明处与非声明处区分，含符号链", async () => {
  const repo = await loadRepoContext(SAMPLE);
  const sites = await findReferenceSites(repo, "getBase");
  expect(
    sites.map((site) => ({
      file: site.file,
      line: site.line,
      isDeclaration: site.isDeclaration,
      enclosing: enclosingLabel(site.enclosing),
    })),
  ).toEqual([
    {
      file: "src/main/java/com/example/Alpha.java",
      line: 11,
      isDeclaration: true,
      enclosing: "Alpha.getBase",
    },
    {
      file: "src/main/java/com/example/Beta.java",
      line: 6,
      isDeclaration: false,
      enclosing: "Beta.combine",
    },
  ]);
  const betaSite = sites[1];
  expect(betaSite?.text).toBe("        int value = alpha.getBase();");
});

test("findReferenceSites：整行注释中的匹配被过滤", async () => {
  const repo = await loadRepoContext(SAMPLE);
  const sites = await findReferenceSites(repo, "label");
  // Gamma.java 第 8 行的整行注释提及被过滤，只剩声明处
  expect(sites.map((site) => site.line)).toEqual([3]);
});

test("findReferenceSites：Python 的 # 整行注释被过滤（注释前缀按语言取）", async () => {
  const repo = await loadRepoContext(MULTILANG);
  const sites = await findReferenceSites(repo, "format_name");
  // util.py 第 11 行的 `# format_name must not be ...` 是注释，只剩声明处
  expect(
    sites.map((site) => ({
      file: site.file,
      line: site.line,
      isDeclaration: site.isDeclaration,
      enclosing: enclosingLabel(site.enclosing),
    })),
  ).toEqual([
    {
      file: "service/pkg/util.py",
      line: 10,
      isDeclaration: true,
      enclosing: "Formatter.format_name",
    },
  ]);
});

test("findReferenceSites：无匹配返回空数组", async () => {
  const repo = await loadRepoContext(SAMPLE);
  await expect(findReferenceSites(repo, "nonexistentWord")).resolves.toEqual([]);
});

test("enclosingLabel：Type.method / Type / (top-level)", () => {
  const method = { kind: "method", name: "label", line: 3, endLine: 5, modifiers: [], members: [] } as CodeSymbol;
  const type = { kind: "class", name: "Gamma", line: 1, endLine: 6, modifiers: [], members: [method] } as CodeSymbol;
  expect(enclosingLabel([type, method])).toBe("Gamma.label");
  expect(enclosingLabel([type])).toBe("Gamma");
  expect(enclosingLabel([])).toBe("(top-level)");
});
