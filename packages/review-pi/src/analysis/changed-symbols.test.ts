import { expect, test } from "vitest";
import { repoFixturePath } from "../testing/repos.js";
import { analyzeDiff } from "./diff-analysis.js";
import { loadRepoContext } from "./repo-context.js";
import {
  changedMethodNames,
  changedMethodRefs,
  qualifiedName,
  resolveChangedFileSymbols,
  type ChangedSymbolRef,
} from "./changed-symbols.js";
import type { CodeSymbol } from "./symbols.js";

// Diff 层 → Symbol 层的桥（测量常量面）：hunk 旧侧行区间与符号 [line, endLine] 求交，
// 方法级符号作为 Reference / Call Chain 层的检索对象。

const SAMPLE = repoFixturePath("sample");
const BETA_FILE = "src/main/java/com/example/Beta.java";
const ALPHA_FILE = "src/main/java/com/example/Alpha.java";

function diffOf(file: string, hunk: string): string {
  return [`diff --git a/${file} b/${file}`, `--- a/${file}`, `+++ b/${file}`, hunk].join("\n");
}

test("resolveChangedFileSymbols：span 命中 combine → 剪枝树 + 最内层方法符号", async () => {
  const repo = await loadRepoContext(SAMPLE);
  const changed = await resolveChangedFileSymbols(
    repo,
    analyzeDiff(diffOf(BETA_FILE, "@@ -5,4 +5,4 @@")),
  );
  expect(changed).toEqual([
    {
      file: BETA_FILE,
      presentInSnapshot: true,
      pruned: [
        {
          kind: "class",
          name: "Beta",
          line: 3,
          endLine: 14,
          modifiers: ["public"],
          members: [
            {
              kind: "method",
              name: "combine",
              line: 5,
              endLine: 8,
              modifiers: ["public"],
              returnType: "int",
              params: "(Alpha alpha, int factor)",
              members: [],
            },
          ],
        },
      ],
      innermost: [
        {
          file: BETA_FILE,
          typeName: "Beta",
          symbol: {
            kind: "method",
            name: "combine",
            line: 5,
            endLine: 8,
            modifiers: ["public"],
            returnType: "int",
            params: "(Alpha alpha, int factor)",
            members: [],
          },
        },
      ],
    },
  ]);
});

test("resolveChangedFileSymbols：文件不在快照中 → 显式标记、无符号", async () => {
  const repo = await loadRepoContext(SAMPLE);
  const changed = await resolveChangedFileSymbols(
    repo,
    analyzeDiff(diffOf("src/main/java/com/example/Missing.java", "@@ -1 +1 @@")),
  );
  expect(changed).toEqual([
    { file: "src/main/java/com/example/Missing.java", presentInSnapshot: false, pruned: [], innermost: [] },
  ]);
});

test("changedMethodNames：方法级名字排序去重；无方法命中时回退到最内层符号名", async () => {
  const repo = await loadRepoContext(SAMPLE);
  const bothMethods = await resolveChangedFileSymbols(
    repo,
    analyzeDiff(diffOf(BETA_FILE, "@@ -5,9 +5,9 @@")),
  );
  expect(changedMethodNames(bothMethods)).toEqual(["combine", "scale"]);

  const fieldOnly = await resolveChangedFileSymbols(
    repo,
    analyzeDiff(diffOf(ALPHA_FILE, "@@ -5 +5 @@")),
  );
  expect(changedMethodNames(fieldOnly)).toEqual(["base"]);
});

test("changedMethodRefs：方法/构造器级变更符号按限定名排序去重；字段变更不入选", async () => {
  const repo = await loadRepoContext(SAMPLE);
  const bothMethods = await resolveChangedFileSymbols(
    repo,
    analyzeDiff(diffOf(BETA_FILE, "@@ -5,9 +5,9 @@")),
  );
  const refs = changedMethodRefs(bothMethods);
  expect(refs.map((ref) => qualifiedName(ref))).toEqual(["Beta.combine", "Beta.scale"]);

  const fieldOnly = await resolveChangedFileSymbols(
    repo,
    analyzeDiff(diffOf(ALPHA_FILE, "@@ -5 +5 @@")),
  );
  expect(changedMethodRefs(fieldOnly)).toEqual([]);
});

test("qualifiedName：有类型名时 Type.name，无类型名时裸名", () => {
  const symbol = { kind: "method", name: "combine", line: 5, endLine: 8, modifiers: [], members: [] } as CodeSymbol;
  const withType: ChangedSymbolRef = { file: BETA_FILE, symbol, typeName: "Beta" };
  const bare: ChangedSymbolRef = { file: BETA_FILE, symbol, typeName: "" };
  expect(qualifiedName(withType)).toBe("Beta.combine");
  expect(qualifiedName(bare)).toBe("combine");
});
