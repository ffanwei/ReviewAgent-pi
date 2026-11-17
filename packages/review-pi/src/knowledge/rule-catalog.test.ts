import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, test } from "vitest";

import {
  buildCatalog,
  loadRuleCatalog,
  parseRulePack,
  resolveRules,
  type RuleEntry,
} from "./rule-catalog.js";

const temps: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-rules-"));
  temps.push(dir);
  return dir;
}

function writePack(
  root: string,
  options: {
    readonly skill: string;
    readonly rules?: Readonly<Record<string, string>>;
  },
): void {
  mkdirSync(path.join(root, "rules"), { recursive: true });
  writeFileSync(path.join(root, "SKILL.md"), options.skill, "utf8");
  for (const [name, content] of Object.entries(options.rules ?? {})) {
    writeFileSync(path.join(root, "rules", name), content, "utf8");
  }
}

afterAll(() => {
  for (const dir of temps.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("parseRulePack", () => {
  test("可解析规则 → declarative，字段与正文齐全", () => {
    const root = tempDir();
    writePack(root, {
      skill: "---\nname: general-code-review\ndescription: rule base\n---\n\n# Pack\n",
      rules: {
        "01.md":
          "---\nid: GEN-001\ntitle: Null deref\nseverity: high\ncategory: null-safety\nlanguages: [typescript]\nglobs: [src/**/*.ts]\ntags: [null, npe]\n---\n\nDo not dereference null.\n",
      },
    });

    const pack = parseRulePack(root, "builtin");

    expect(pack.kind).toBe("declarative");
    if (pack.kind !== "declarative") {
      return;
    }
    expect(pack.name).toBe("general-code-review");
    expect(pack.rules).toHaveLength(1);
    expect(pack.rules[0]).toMatchObject({
      id: "GEN-001",
      title: "Null deref",
      severity: "high",
      category: "null-safety",
      languages: ["typescript"],
      globs: ["src/**/*.ts"],
      tags: ["null", "npe"],
      source: "builtin",
      pack: "general-code-review",
    });
    expect(pack.rules[0]?.text).toContain("Do not dereference null.");
  });

  test("没有可解析规则 → opaque，保留 scope 元数据", () => {
    const root = tempDir();
    writePack(root, {
      skill:
        "---\nname: custom-skill\ndescription: runs its own workflow\nopaque: true\nlanguages: [go]\nglobs: [cmd/**]\ntags: [security]\n---\n\nRun the workflow.\n",
    });

    const pack = parseRulePack(root, "user");

    expect(pack.kind).toBe("opaque");
    if (pack.kind !== "opaque") {
      return;
    }
    expect(pack.name).toBe("custom-skill");
    expect(pack.languages).toEqual(["go"]);
    expect(pack.globs).toEqual(["cmd/**"]);
    expect(pack.tags).toEqual(["security"]);
  });

  test("显式 opaque: true 的混合包不进入规则目录", () => {
    const root = tempDir();
    writePack(root, {
      skill: "---\nname: hybrid\nopaque: true\n---\n\nRun script.\n",
      rules: {
        "01.md": "---\nid: H-001\ntitle: hybrid rule\n---\n\nBody.\n",
      },
    });

    const pack = parseRulePack(root, "user");

    expect(pack.kind).toBe("opaque");
  });
});

describe("loadRuleCatalog", () => {
  test("用户声明式包并入目录，并标记为不应再开 skill 会话", () => {
    const root = tempDir();
    writePack(root, {
      skill: "---\nname: user-pack\ndescription: user rules\n---\n\n# User\n",
      rules: {
        "01.md": "---\nid: USER-001\ntitle: User rule\n---\n\nUser rule body.\n",
      },
    });

    const catalog = loadRuleCatalog({
      builtinPack: "general",
      optionalPacks: [],
      userSkills: [{ filePath: path.join(root, "SKILL.md") }],
    });

    expect(catalog.declarativeUserNames).toEqual(["user-pack"]);
    expect(catalog.rules.some((entry) => entry.id === "USER-001" && entry.source === "user")).toBe(true);
  });

  test("内置 general pack 可装载并参与规则选择", () => {
    const catalog = loadRuleCatalog({ builtinPack: "general", optionalPacks: [], userSkills: [] });
    expect(catalog.rules.length).toBeGreaterThanOrEqual(12);
    expect(catalog.rules.every((entry) => entry.source === "builtin")).toBe(true);

    const resolved = resolveRules(catalog, ["src/a.ts"], 6_000);
    expect(resolved.rules.length).toBeGreaterThan(0);
    expect(resolved.text).toContain("<rule");
  });
});

describe("resolveRules", () => {
  function rule(overrides: Partial<RuleEntry> & Pick<RuleEntry, "id">): RuleEntry {
    return {
      title: overrides.id,
      languages: [],
      globs: [],
      tags: [],
      text: `Rule ${overrides.id}`,
      pack: "pack",
      source: "builtin",
      ...overrides,
    };
  }

  test("按语言/glob 选择；用户同 id 覆盖内置", () => {
    const builtinTs = rule({ id: "R1", languages: ["typescript"], source: "builtin" });
    const builtinPy = rule({ id: "R2", globs: ["**/*.py"], source: "builtin" });
    const userR1 = rule({ id: "R1", languages: ["typescript"], source: "user", text: "User R1" });
    const catalog = buildCatalog([
      { kind: "declarative", name: "builtin", description: "", rules: [builtinTs, builtinPy], root: "" },
      { kind: "declarative", name: "user", description: "", rules: [userR1], root: "" },
    ]);

    const resolved = resolveRules(catalog, ["src/a.ts", "src/b.py"], 10_000);

    expect(resolved.rules.map((entry) => entry.id).sort()).toEqual(["R1", "R2"]);
    expect(resolved.rules.find((entry) => entry.id === "R1")?.source).toBe("user");
    expect(resolved.text).toContain("User R1");
  });

  test("字符上限截断，不注入超限规则", () => {
    const one = rule({ id: "R1", text: "x".repeat(5_000) });
    const two = rule({ id: "R2", text: "y".repeat(5_000) });
    const catalog = buildCatalog([
      { kind: "declarative", name: "pack", description: "", rules: [one, two], root: "" },
    ]);

    const resolved = resolveRules(catalog, ["a.ts"], 6_000);

    expect(resolved.rules).toHaveLength(1);
    expect(resolved.chars).toBeLessThanOrEqual(6_000);
  });

  test("不命中语言/glob 的规则不注入", () => {
    const catalog = buildCatalog([
      {
        kind: "declarative",
        name: "pack",
        description: "",
        rules: [rule({ id: "GO", languages: ["go"] })],
        root: "",
      },
    ]);

    expect(resolveRules(catalog, ["src/a.ts"], 10_000).rules).toHaveLength(0);
  });
});
