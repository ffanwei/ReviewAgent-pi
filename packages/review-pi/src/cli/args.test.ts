import path from "node:path";
import { describe, expect, test } from "vitest";
import { REVIEW_MODEL_ID } from "../provider/pi-client.js";
import { parseCliArgs, USAGE_TEXT } from "./args.js";

// CLI 参数解析契约（#7 P3b，进程内主缝的第一层）：`review-pi review` /
// `review-pi smoke` / `review-pi disposition` 三个子命令的 argv 用法面。
// 形态对齐 DSH 线 args.ts（union 结果、不抛异常——用户输入错误是预期
// 路径），pi 线差异：
// - 缺省 config = E（生产入口切流，ADR-0011：自主拉取 + Context Ledger；
//   2026-10-19 决策前曾为 B；DSH 线缺省 A）；
// - 无 --language 旗标（输出语言是 DSH 线后分家决策，pi 线自立 ADR 前不实装）；
// - smoke = P1b 双探针（无工具调用探针——config B 零工具，检视链不需要）；
// - disposition（#15）= Finding 处置落库 + KPI：本地数据面，--decision
//   三值枚举在 parse 层校验，库缺省 <out>/review-pi-cli/dispositions.json。

test("空 argv 与未知子命令 → 用法错误（不抛异常）", () => {
  expect(parseCliArgs([])).toEqual({
    ok: false,
    message: "missing command (expected `review`, `smoke` or `disposition`)",
  });
  expect(parseCliArgs(["deploy"])).toEqual({
    ok: false,
    message: 'unknown command "deploy" (expected `review`, `smoke` or `disposition`)',
  });
});

test("review 最小 argv：必填旗标 + 全缺省（config E = 生产入口切流 ADR-0011 / out / model / issue）", () => {
  const parsed = parseCliArgs(["review", "--repo", "repo", "--mr", "case.diff"]);
  expect(parsed).toEqual({
    ok: true,
    command: "review",
    args: {
      repo: "repo",
      mr: "case.diff",
      caseId: "case",
      config: "E",
      issue: "",
      out: "review-pi-output",
      model: REVIEW_MODEL_ID,
    },
  });
});

test("caseId 派生：--mr 文件名去扩展名（含路径与无扩展名形态）", () => {
  const withPath = parseCliArgs(["review", "--repo", "r", "--mr", "a/b/VUL4J-1.diff"]);
  expect(withPath.ok && withPath.command === "review" && withPath.args.caseId).toBe("VUL4J-1");
  const noExtension = parseCliArgs(["review", "--repo", "r", "--mr", "diffs/mr-7"]);
  expect(noExtension.ok && noExtension.command === "review" && noExtension.args.caseId).toBe("mr-7");
  const doubleDot = parseCliArgs(["review", "--repo", "r", "--mr", "x/case.old.diff"]);
  expect(doubleDot.ok && doubleDot.command === "review" && doubleDot.args.caseId).toBe("case.old");
});

test("--config：A-F 全矩阵合法；非法值 → 用法错误并列出合法集", () => {
  for (const configId of ["A", "B", "C", "D", "E", "F"] as const) {
    const parsed = parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--config", configId]);
    expect(parsed.ok && parsed.command === "review" && parsed.args.config).toBe(configId);
  }
  const bad = parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--config", "G"]);
  expect(bad).toEqual({
    ok: false,
    message: 'invalid --config "G": expected one of A, B, C, D, E, F',
  });
});

test("规则 Skill 旗标：--rule-skill-zip / --rule-skill-name / --strict-rule-skill（布尔无值）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr",
    "m.diff",
    "--rule-skill-zip",
    "packs/rules.zip",
    "--rule-skill-name",
    "sample-rule",
    "--strict-rule-skill",
  ]);
  expect(parsed).toEqual({
    ok: true,
    command: "review",
    args: {
      repo: "r",
      mr: "m.diff",
      caseId: "m",
      config: "E",
      issue: "",
      out: "review-pi-output",
      model: REVIEW_MODEL_ID,
      ruleSkillZips: ["packs/rules.zip"],
      ruleSkillName: "sample-rule",
      strictRuleSkill: true,
    },
  });
});

test("--rule-skill-zip 可重复，顺序 = CLI 顺序（ADR-0014 多包）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr",
    "m.diff",
    "--rule-skill-zip",
    "b.zip",
    "--rule-skill-zip",
    "a.zip",
  ]);
  expect(parsed.ok && parsed.command === "review" && parsed.args.ruleSkillZips).toEqual([
    "b.zip",
    "a.zip",
  ]);
});

test("--rule-skill 可重复（目录形态）；与 --rule-skill-zip 共存且各自保持 CLI 顺序（ADR-0018）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr",
    "m.diff",
    "--rule-skill-zip",
    "b.zip",
    "--rule-skill",
    "dirs/second",
    "--rule-skill-zip",
    "a.zip",
    "--rule-skill",
    "dirs/first",
  ]);
  expect(parsed.ok && parsed.command === "review" && parsed.args.ruleSkillZips).toEqual([
    "b.zip",
    "a.zip",
  ]);
  expect(parsed.ok && parsed.command === "review" && parsed.args.ruleSkillDirs).toEqual([
    "dirs/second",
    "dirs/first",
  ]);
});

test("规则 Skill 旗标缺席即省键（A–E 行为逐字不变）", () => {
  const parsed = parseCliArgs(["review", "--repo", "r", "--mr", "m.diff"]);
  expect(parsed.ok && parsed.command === "review" && "ruleSkillZips" in parsed.args).toBe(false);
  expect(parsed.ok && parsed.command === "review" && "ruleSkillDirs" in parsed.args).toBe(false);
  expect(parsed.ok && parsed.command === "review" && "strictRuleSkill" in parsed.args).toBe(false);
});

test("--strict-rule-skill 重复 → 用法错误；缺值旗标照旧报错", () => {
  expect(
    parseCliArgs(["review", "--repo", "r", "--mr", "m", "--strict-rule-skill", "--strict-rule-skill"]),
  ).toEqual({ ok: false, message: "duplicate flag --strict-rule-skill" });
  expect(parseCliArgs(["review", "--repo", "r", "--mr", "m", "--rule-skill-zip"])).toEqual({
    ok: false,
    message: "flag --rule-skill-zip requires a value",
  });
});

test("未知旗标 / 重复旗标 / 值缺席（含值吞旗标）→ 用法错误", () => {
  expect(parseCliArgs(["review", "--repo", "r", "--mr", "m", "--language", "zh"])).toEqual({
    ok: false,
    message: 'unknown flag "--language"',
  });
  expect(parseCliArgs(["review", "--repo", "r", "--repo", "r2", "--mr", "m"])).toEqual({
    ok: false,
    message: "duplicate flag --repo",
  });
  expect(parseCliArgs(["review", "--repo"])).toEqual({
    ok: false,
    message: "flag --repo requires a value",
  });
  // 值以 -- 开头 = 相邻旗标被吞（如 `--issue --out x`）——fail fast 不静默
  expect(parseCliArgs(["review", "--repo", "r", "--mr", "m", "--issue", "--out", "x"])).toEqual({
    ok: false,
    message: "flag --issue requires a value",
  });
});

test("--model：缺省钉住的评审模型；自由 id 透传；空白 id 拒绝", () => {
  const free = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--model", "custom-gateway-model"]);
  expect(free.ok && free.command === "review" && free.args.model).toBe("custom-gateway-model");
  const blank = parseCliArgs(["review", "--repo", "r", "--mr", "m", "--model", "  "]);
  expect(blank).toEqual({
    ok: false,
    message: 'invalid --model "  ": must be a non-empty model id (free ids accepted)',
  });
});

test("缺必填旗标：--repo / --mr", () => {
  expect(parseCliArgs(["review", "--mr", "m.diff"])).toEqual({
    ok: false,
    message: "missing required flag --repo",
  });
  expect(parseCliArgs(["review", "--repo", "r"])).toEqual({
    ok: false,
    message: "missing required flag --mr",
  });
});

test("smoke：窄旗标面（仅 --model）；review 专属旗标对 smoke 是未知旗标", () => {
  const smoke = parseCliArgs(["smoke"]);
  expect(smoke).toEqual({ ok: true, command: "smoke", args: { model: REVIEW_MODEL_ID } });
  const withModel = parseCliArgs(["smoke", "--model", "probe-model"]);
  expect(withModel).toEqual({ ok: true, command: "smoke", args: { model: "probe-model" } });
  expect(parseCliArgs(["smoke", "--repo", "r"])).toEqual({
    ok: false,
    message: 'unknown flag "--repo"',
  });
});

test("USAGE_TEXT：宣告两个子命令（stderr 错误路径同款文案，单一来源）", () => {
  expect(USAGE_TEXT).toContain("review-pi review --repo");
  expect(USAGE_TEXT).toContain("review-pi smoke");
});

describe("disposition 子命令（#15 处置落库 + KPI）", () => {
  const DEFAULT_STORE = path.join("review-pi-output", "review-pi-cli", "dispositions.json");

  test("记录面最小 argv：必填三旗标 + 库缺省派生（review-pi-output/review-pi-cli/dispositions.json）；note 缺席省键", () => {
    expect(
      parseCliArgs(["disposition", "--run", "r.json", "--finding", "F100", "--decision", "accept"]),
    ).toEqual({
      ok: true,
      command: "disposition",
      args: {
        mode: "record",
        args: { run: "r.json", finding: "F100", decision: "accept", store: DEFAULT_STORE },
      },
    });
  });

  test("三种处置决定合法（accept / reject / false-positive）；非法值 → 用法错误列三值", () => {
    for (const decision of ["accept", "reject", "false-positive"] as const) {
      const parsed = parseCliArgs([
        "disposition",
        "--run",
        "r.json",
        "--finding",
        "F100",
        "--decision",
        decision,
      ]);
      expect(
        parsed.ok &&
          parsed.command === "disposition" &&
          parsed.args.mode === "record" &&
          parsed.args.args.decision,
      ).toBe(decision);
    }
    expect(
      parseCliArgs(["disposition", "--run", "r.json", "--finding", "F100", "--decision", "maybe"]),
    ).toEqual({
      ok: false,
      message: 'invalid --decision "maybe": expected one of accept, reject, false-positive',
    });
  });

  test("--note 透传；--store 显式覆盖；--out 派生库路径（<out>/review-pi-cli/dispositions.json）", () => {
    const withNote = parseCliArgs([
      "disposition",
      "--run",
      "r",
      "--finding",
      "F",
      "--decision",
      "reject",
      "--note",
      "历史回归",
    ]);
    expect(
      withNote.ok && withNote.command === "disposition" && withNote.args.mode === "record" &&
        withNote.args.args.note,
    ).toBe("历史回归");
    const explicitStore = parseCliArgs([
      "disposition",
      "--run",
      "r",
      "--finding",
      "F",
      "--decision",
      "accept",
      "--store",
      "runs/exp1/dispositions.json",
    ]);
    expect(
      explicitStore.ok &&
        explicitStore.command === "disposition" &&
        explicitStore.args.mode === "record" &&
        explicitStore.args.args.store,
    ).toBe("runs/exp1/dispositions.json");
    const derived = parseCliArgs([
      "disposition",
      "--run",
      "r",
      "--finding",
      "F",
      "--decision",
      "accept",
      "--out",
      "custom-out",
    ]);
    expect(
      derived.ok &&
        derived.command === "disposition" &&
        derived.args.mode === "record" &&
        derived.args.args.store,
    ).toBe(path.join("custom-out", "review-pi-cli", "dispositions.json"));
  });

  test("--store 与 --out 互斥（显式库文件 vs 派生根，二义性 fail fast）", () => {
    expect(
      parseCliArgs([
        "disposition",
        "--run",
        "r",
        "--finding",
        "F",
        "--decision",
        "accept",
        "--store",
        "s.json",
        "--out",
        "o",
      ]),
    ).toEqual({
      ok: false,
      message:
        "flags --store and --out are mutually exclusive: pass --store <file> explicitly, or let the store derive from --out",
    });
  });

  test("缺必填旗标：--run / --finding / --decision", () => {
    expect(parseCliArgs(["disposition", "--finding", "F", "--decision", "accept"])).toEqual({
      ok: false,
      message: "missing required flag --run",
    });
    expect(parseCliArgs(["disposition", "--run", "r", "--decision", "accept"])).toEqual({
      ok: false,
      message: "missing required flag --finding",
    });
    expect(parseCliArgs(["disposition", "--run", "r", "--finding", "F"])).toEqual({
      ok: false,
      message: "missing required flag --decision",
    });
  });

  test("未知旗标 / 重复旗标 / 值缺席 / 空白值 → 用法错误", () => {
    expect(
      parseCliArgs([
        "disposition",
        "--run",
        "r",
        "--finding",
        "F",
        "--decision",
        "accept",
        "--repo",
        "x",
      ]),
    ).toEqual({ ok: false, message: 'unknown flag "--repo"' });
    expect(
      parseCliArgs([
        "disposition",
        "--run",
        "r",
        "--run",
        "r2",
        "--finding",
        "F",
        "--decision",
        "accept",
      ]),
    ).toEqual({ ok: false, message: "duplicate flag --run" });
    expect(parseCliArgs(["disposition", "--run"])).toEqual({
      ok: false,
      message: "flag --run requires a value",
    });
    expect(parseCliArgs(["disposition", "--run", "", "--finding", "F", "--decision", "accept"])).toEqual(
      { ok: false, message: "flag --run requires a non-empty value" },
    );
    expect(
      parseCliArgs([
        "disposition",
        "--run",
        "r",
        "--finding",
        "F",
        "--decision",
        "accept",
        "--note",
        "  ",
      ]),
    ).toEqual({ ok: false, message: "flag --note requires a non-empty value" });
  });

  test("KPI 面：--stats 裸用走缺省库；--store/--out 同规则派生", () => {
    expect(parseCliArgs(["disposition", "--stats"])).toEqual({
      ok: true,
      command: "disposition",
      args: { mode: "stats", args: { store: DEFAULT_STORE } },
    });
    const explicit = parseCliArgs(["disposition", "--stats", "--store", "s.json"]);
    expect(
      explicit.ok && explicit.command === "disposition" && explicit.args.mode === "stats" &&
        explicit.args.args.store,
    ).toBe("s.json");
    const derived = parseCliArgs(["disposition", "--stats", "--out", "o"]);
    expect(
      derived.ok && derived.command === "disposition" && derived.args.mode === "stats" &&
        derived.args.args.store,
    ).toBe(path.join("o", "review-pi-cli", "dispositions.json"));
  });

  test("记录面旗标在 KPI 面是模式错误（错误点名可用集）；--stats 重复拒绝", () => {
    expect(parseCliArgs(["disposition", "--stats", "--finding", "F1"])).toEqual({
      ok: false,
      message: 'unknown flag "--finding" (with --stats, accepted flags: --store, --out)',
    });
    expect(parseCliArgs(["disposition", "--stats", "--stats"])).toEqual({
      ok: false,
      message: "duplicate flag --stats",
    });
  });

  test("USAGE_TEXT 宣告 disposition 两用法面（单一来源）", () => {
    expect(USAGE_TEXT).toContain("review-pi disposition --run");
    expect(USAGE_TEXT).toContain("review-pi disposition --stats");
    expect(USAGE_TEXT).toContain("accept|reject|false-positive");
  });
});

test("进度旗标：--progress / --no-progress 三态（缺省 = 自动）", () => {
  const auto = parseCliArgs(["review", "--repo", "r", "--mr", "m.diff"]);
  expect(auto.ok && auto.command === "review" && "progress" in auto.args).toBe(false);

  const on = parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--progress"]);
  expect(on.ok && on.command === "review" && on.args.progress).toBe(true);

  const off = parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--no-progress"]);
  expect(off.ok && off.command === "review" && off.args.progress).toBe(false);
});

test("进度旗标：互斥与重复都是用法错误（fail fast，不静默取其一）", () => {
  expect(
    parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--progress", "--no-progress"]),
  ).toEqual({ ok: false, message: "conflicting flags --progress and --no-progress" });
  expect(
    parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--progress", "--progress"]),
  ).toEqual({ ok: false, message: "duplicate flag --progress" });
  expect(
    parseCliArgs(["review", "--repo", "r", "--mr", "m.diff", "--no-progress", "--no-progress"]),
  ).toEqual({ ok: false, message: "duplicate flag --no-progress" });
});

test("进度旗标：smoke / disposition 面不认（只有 review 显示进度）", () => {
  expect(parseCliArgs(["smoke", "--progress"])).toEqual({
    ok: false,
    message: 'unknown flag "--progress"',
  });
  expect(
    parseCliArgs(["disposition", "--run", "r.json", "--finding", "F1", "--decision", "accept", "--no-progress"]),
  ).toEqual({ ok: false, message: 'unknown flag "--no-progress"' });
});
