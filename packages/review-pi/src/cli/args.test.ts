import { describe, expect, test } from "vitest";
import { parseCliArgs, USAGE_TEXT } from "./args.js";

// CLI 参数解析契约（#7 P3b，进程内主缝的第一层）：`review-pi review` /
// `review-pi smoke` / `review-pi config` 三个子命令的 argv 用法面。形态对齐
// DSH 线 args.ts（union 结果、不抛异常——用户输入错误是预期路径），pi 线差异：
// - 检视形态唯一（ADR-0024：A–E 配置矩阵删除，规则 Skill 是唯一形态）；
// - `--config` = 用户级 JSONC 配置路径（ADR-0025；旧的 `--env` 已移除）；
// - 落盘位置由 `--taskId` 决定（ADR-0033；旧的 `--out` 已移除），
//   产物落 `<tasks 根>/<taskId>/{runs,audit}/`；
// - 无 --language 旗标（输出语言是 DSH 线后分家决策，pi 线自立 ADR 前不实装）；
// - smoke = P1b 双探针（网关健康 + 模型可达）。

test("空 argv 与未知子命令 → 用法错误（不抛异常）", () => {
  expect(parseCliArgs([])).toEqual({
    ok: false,
    message: "missing command (expected `review`, `smoke`, `config` or `export`)",
  });
  expect(parseCliArgs(["deploy"])).toEqual({
    ok: false,
    message: 'unknown command "deploy" (expected `review`, `smoke`, `config` or `export`)',
  });
});

test("review 最小 argv：必填旗标 + 全缺省（issue / tasks 根；model 交给配置）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "repo",
    "--mr-diff",
    "case.diff",
    "--taskId",
    "t-1",
  ]);
  expect(parsed).toEqual({
    ok: true,
    command: "review",
    args: {
      repo: "repo",
      mr: "case.diff",
      caseId: "case",
      issue: "",
      taskId: "t-1",
    },
  });
});

test("caseId 派生：--mr-diff / --mr-json 文件名去扩展名（含路径与无扩展名形态）", () => {
  const withPath = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "a/b/VUL4J-1.diff",
    "--taskId",
    "t-1",
  ]);
  expect(withPath.ok && withPath.command === "review" && withPath.args.caseId).toBe("VUL4J-1");
  const noExtension = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "diffs/mr-7",
    "--taskId",
    "t-1",
  ]);
  expect(noExtension.ok && noExtension.command === "review" && noExtension.args.caseId).toBe("mr-7");
  const doubleDot = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "x/case.old.diff",
    "--taskId",
    "t-1",
  ]);
  expect(doubleDot.ok && doubleDot.command === "review" && doubleDot.args.caseId).toBe("case.old");
  // JSON 输入同款派生：MR-1234.json → MR-1234（扩展名不参与 caseId）
  const json = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-json",
    "d/MR-1234.json",
    "--taskId",
    "t-1",
  ]);
  expect(json.ok && json.command === "review" && json.args.caseId).toBe("MR-1234");
});

test("MR 输入形态（ADR-0029）：--mr-diff 省键 = 统一 diff；--mr-json 标 json；二选一", () => {
  const diff = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
  ]);
  expect(diff.ok && diff.command === "review" && "mrFormat" in diff.args).toBe(false);

  const json = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-json",
    "m.json",
    "--taskId",
    "t-1",
  ]);
  expect(json).toEqual({
    ok: true,
    command: "review",
    args: {
      repo: "r",
      mr: "m.json",
      mrFormat: "json",
      caseId: "m",
      issue: "",
      taskId: "t-1",
    },
  });

  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m.diff",
      "--mr-json",
      "m.json",
      "--taskId",
      "t-1",
    ]),
  ).toEqual({
    ok: false,
    message: "conflicting flags --mr-diff and --mr-json (give exactly one)",
  });
});

test("taskId（ADR-0033）：必需；单段目录名；首尾空白 trim 后生效", () => {
  expect(parseCliArgs(["review", "--repo", "r", "--mr-diff", "m.diff"])).toEqual({
    ok: false,
    message: "missing required flag --taskId (output goes to <tasks root>/<taskId>)",
  });
  const trimmed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "  VUL4J-38  ",
  ]);
  expect(trimmed.ok && trimmed.command === "review" && trimmed.args.taskId).toBe("VUL4J-38");
  // 校验口径单源在 shared/tasks-dir.ts（该单测覆盖全部分支）；这里只钉「透传成用法错误」
  expect(
    parseCliArgs(["review", "--repo", "r", "--mr-diff", "m.diff", "--taskId", "../escape"]),
  ).toMatchObject({ ok: false, message: expect.stringContaining("invalid --taskId") });
});

test("--tasks-dir：根目录透传（相对路径原样保留，由 main 按 cwd 解析）；缺席省键；空白拒绝", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
    "--tasks-dir",
    "sandbox/tasks",
  ]);
  expect(parsed.ok && parsed.command === "review" && parsed.args.tasksDir).toBe("sandbox/tasks");
  const absent = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
  ]);
  expect(absent.ok && absent.command === "review" && "tasksDir" in absent.args).toBe(false);
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m.diff",
      "--taskId",
      "t-1",
      "--tasks-dir",
      "  ",
    ]),
  ).toEqual({
    ok: false,
    message: 'invalid --tasks-dir "  ": must be a non-empty directory path',
  });
});

test("--out 已移除：给专用迁移提示（不是裸 unknown flag）", () => {
  expect(
    parseCliArgs(["review", "--repo", "r", "--mr-diff", "m.diff", "--out", "out"]),
  ).toEqual({
    ok: false,
    message:
      "--out 已移除（ADR-0033）：产物改落 ~/.PiAgent/tasks/<taskId>/，改用 --taskId <id>（--tasks-dir <dir> 只覆盖 tasks 根目录）",
  });
});

test("--mr 旧旗标：给专用迁移提示（不是裸 unknown flag）", () => {
  expect(parseCliArgs(["review", "--repo", "r", "--mr", "m.diff"])).toEqual({
    ok: false,
    message: "--mr 已改名（ADR-0029）：统一 diff 文件用 --mr-diff，接口 JSON 用 --mr-json",
  });
});

test("--config：路径透传（review / smoke / config 三面）；缺席省键；空白拒绝", () => {
  const review = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m",
    "--taskId",
    "t-1",
    "--config",
    "conf/pi.json",
  ]);
  expect(review.ok && review.command === "review" && review.args.configPath).toBe("conf/pi.json");
  const absent = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m",
    "--taskId",
    "t-1",
  ]);
  expect(absent.ok && absent.command === "review" && "configPath" in absent.args).toBe(false);
  expect(parseCliArgs(["smoke", "--config", "x.json"])).toEqual({
    ok: true,
    command: "smoke",
    args: { configPath: "x.json" },
  });
  expect(parseCliArgs(["config", "show", "--config", "x.json"])).toEqual({
    ok: true,
    command: "config",
    args: { action: "show", configPath: "x.json" },
  });
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m",
      "--taskId",
      "t-1",
      "--config",
      "  ",
    ]),
  ).toEqual({
    ok: false,
    message: 'invalid --config "  ": must be a non-empty file path',
  });
});

test("--env 已移除：任何子命令都给专用迁移提示（不是裸 unknown flag）", () => {
  const message = "--env 已移除（配置见 --config <file> 或 ~/.PiAgent/PiAgent.jsonc）";
  expect(
    parseCliArgs(["review", "--repo", "r", "--mr-diff", "m", "--taskId", "t-1", "--env", "creds.env"]),
  ).toEqual({
    ok: false,
    message,
  });
  expect(parseCliArgs(["smoke", "--env=x.env"])).toEqual({ ok: false, message });
});

test("规则 Skill 旗标：--rule-skill-zip / --strict-rule-skill（布尔无值）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
    "--rule-skill-zip",
    "packs/rules.zip",
    "--strict-rule-skill",
  ]);
  expect(parsed).toEqual({
    ok: true,
    command: "review",
    args: {
      repo: "r",
      mr: "m.diff",
      caseId: "m",
      issue: "",
      taskId: "t-1",
      ruleSkillZips: ["packs/rules.zip"],
      strictRuleSkill: true,
    },
  });
});

test("--rule-skill-zip 可重复，顺序 = CLI 顺序（ADR-0014 多包）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
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
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
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

test("--rule-skill-zip 逗号列表：引号内的 `a.zip, b.zip` 展开为多个包，顺序 = 列表顺序（ADR-0034）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
    "--rule-skill-zip",
    "r1.zip, r2.zip,r3.zip",
  ]);
  expect(parsed.ok && parsed.command === "review" && parsed.args.ruleSkillZips).toEqual([
    "r1.zip",
    "r2.zip",
    "r3.zip",
  ]);
});

test("逗号列表对空白不敏感：逗号前后有没有空格等价（ADR-0034）", () => {
  for (const raw of ["a.zip,b.zip", "a.zip, b.zip", "a.zip , b.zip", "  a.zip ,b.zip  "]) {
    const parsed = parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m.diff",
      "--taskId",
      "t-1",
      "--rule-skill-zip",
      raw,
    ]);
    expect(parsed.ok && parsed.command === "review" && parsed.args.ruleSkillZips).toEqual([
      "a.zip",
      "b.zip",
    ]);
  }
  // shell 已经按空白切开、逗号前还带空格的 token 形态
  const split = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
    "--rule-skill",
    "r1/ ,",
    " r2/",
  ]);
  expect(split.ok && split.command === "review" && split.args.ruleSkillDirs).toEqual(["r1/", "r2/"]);
});

test("--rule-skill-zip 逗号列表：shell 按空白切开的 `r1.zip, r2.zip` 归并成一个列表（ADR-0034）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
    "--rule-skill-zip",
    "r1.zip,",
    "r2.zip,",
    "r3.zip",
  ]);
  expect(parsed.ok && parsed.command === "review" && parsed.args.ruleSkillZips).toEqual([
    "r1.zip",
    "r2.zip",
    "r3.zip",
  ]);
});

test("--rule-skill-zip 逗号列表：PowerShell 吞掉逗号的形态（`r1.zip r2.zip r3.zip`）同样成立（ADR-0034）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
    "--rule-skill-zip",
    "r1.zip",
    "r2.zip",
    "r3.zip",
  ]);
  expect(parsed.ok && parsed.command === "review" && parsed.args.ruleSkillZips).toEqual([
    "r1.zip",
    "r2.zip",
    "r3.zip",
  ]);
});

test("--rule-skill 目录逗号列表：`r1/, r2/, r3/` 与重复旗标等价；与 zip 各自保持顺序", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
    "--rule-skill",
    "r1/,",
    "r2/,",
    "r3/",
    "--rule-skill-zip",
    "a.zip,b.zip",
  ]);
  expect(parsed.ok && parsed.command === "review" && parsed.args.ruleSkillDirs).toEqual([
    "r1/",
    "r2/",
    "r3/",
  ]);
  expect(parsed.ok && parsed.command === "review" && parsed.args.ruleSkillZips).toEqual([
    "a.zip",
    "b.zip",
  ]);
});

test("逗号列表与重复旗标混用：按出现顺序展开，空项丢弃（`a.zip,,b.zip` 仍两项）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
    "--rule-skill-zip",
    "a.zip,,b.zip",
    "--rule-skill-zip",
    "c.zip",
  ]);
  expect(parsed.ok && parsed.command === "review" && parsed.args.ruleSkillZips).toEqual([
    "a.zip",
    "b.zip",
    "c.zip",
  ]);
});

test("逗号列表整值无有效项 → 用法错误（不静默退化成 0 个包）", () => {
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m.diff",
      "--taskId",
      "t-1",
      "--rule-skill-zip",
      " , ",
    ]),
  ).toEqual({
    ok: false,
    message: 'invalid --rule-skill-zip " , ": must be a non-empty path list',
  });
});

test("--rule-skill-name 已移除（ADR-0034）：给专用迁移文案，不是裸 unknown flag", () => {
  const message =
    "--rule-skill-name 已移除（ADR-0034）：一个规则包就是一个 skill；多个包用 --rule-skill-zip a.zip,b.zip（或重复旗标）一次传入";
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m.diff",
      "--taskId",
      "t-1",
      "--rule-skill-name",
      "sample-rule",
    ]),
  ).toEqual({ ok: false, message });
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m.diff",
      "--taskId",
      "t-1",
      "--rule-skill-name=sample-rule",
    ]),
  ).toEqual({ ok: false, message });
});

test("规则 Skill 旗标缺席即省键（缺省形态不带任何规则键）", () => {
  const parsed = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
  ]);
  expect(parsed.ok && parsed.command === "review" && "ruleSkillZips" in parsed.args).toBe(false);
  expect(parsed.ok && parsed.command === "review" && "ruleSkillDirs" in parsed.args).toBe(false);
  expect(parsed.ok && parsed.command === "review" && "strictRuleSkill" in parsed.args).toBe(false);
});

test("--strict-rule-skill 重复 → 用法错误；缺值旗标照旧报错", () => {
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m",
      "--taskId",
      "t-1",
      "--strict-rule-skill",
      "--strict-rule-skill",
    ]),
  ).toEqual({ ok: false, message: "duplicate flag --strict-rule-skill" });
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m",
      "--taskId",
      "t-1",
      "--rule-skill-zip",
    ]),
  ).toEqual({
    ok: false,
    message: "flag --rule-skill-zip requires a value",
  });
});

test("未知旗标 / 重复旗标 / 值缺席（含值吞旗标）→ 用法错误", () => {
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m",
      "--taskId",
      "t-1",
      "--language",
      "zh",
    ]),
  ).toEqual({
    ok: false,
    message: 'unknown flag "--language"',
  });
  expect(
    parseCliArgs(["review", "--repo", "r", "--repo", "r2", "--mr-diff", "m", "--taskId", "t-1"]),
  ).toEqual({
    ok: false,
    message: "duplicate flag --repo",
  });
  expect(parseCliArgs(["review", "--repo"])).toEqual({
    ok: false,
    message: "flag --repo requires a value",
  });
  // 值以 -- 开头 = 相邻旗标被吞（如 `--issue --taskId x`）——fail fast 不静默
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m",
      "--issue",
      "--taskId",
      "x",
    ]),
  ).toEqual({
    ok: false,
    message: "flag --issue requires a value",
  });
});

test("--env：显式凭据文件路径已不再支持（ADR-0025 废止 ADR-0019）", () => {
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m",
      "--taskId",
      "t-1",
      "--env",
      "creds\\team.env.local",
    ]),
  ).toEqual({
    ok: false,
    message: "--env 已移除（配置见 --config <file> 或 ~/.PiAgent/PiAgent.jsonc）",
  });
});

test("config 子命令：init/show + 旗标组合校验", () => {
  expect(parseCliArgs(["config"])).toEqual({
    ok: false,
    message: "missing config action (expected `init` or `show`)",
  });
  expect(parseCliArgs(["config", "edit"])).toEqual({
    ok: false,
    message: 'unknown config action "edit" (expected `init` or `show`)',
  });
  expect(parseCliArgs(["config", "init"])).toEqual({
    ok: true,
    command: "config",
    args: { action: "init" },
  });
  expect(parseCliArgs(["config", "init", "--force", "--from-env", ".env.local"])).toEqual({
    ok: true,
    command: "config",
    args: { action: "init", force: true, fromEnv: ".env.local" },
  });
  expect(parseCliArgs(["config", "show", "--json"])).toEqual({
    ok: true,
    command: "config",
    args: { action: "show", json: true },
  });
  // 旗标面互斥：show 不写盘，init 不产出 JSON
  expect(parseCliArgs(["config", "show", "--force"])).toEqual({
    ok: false,
    message: "--force / --from-env are only valid with `config init`",
  });
  expect(parseCliArgs(["config", "init", "--json"])).toEqual({
    ok: false,
    message: "--json is only valid with `config show`",
  });
  expect(parseCliArgs(["config", "init", "--from-env"])).toEqual({
    ok: false,
    message: "flag --from-env requires a value",
  });
  expect(parseCliArgs(["config", "init", "--from-env", "  "])).toEqual({
    ok: false,
    message: 'invalid --from-env "  ": must be a non-empty file path',
  });
  expect(parseCliArgs(["config", "init", "--nope"])).toEqual({
    ok: false,
    message: 'unknown flag "--nope"',
  });
});

test("--model：自由 id 透传；缺席省键（缺省来自配置 model.default）；空白 id 拒绝", () => {
  const free = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m",
    "--taskId",
    "t-1",
    "--model",
    "custom-gateway-model",
  ]);
  expect(free.ok && free.command === "review" && free.args.model).toBe("custom-gateway-model");
  const absent = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m",
    "--taskId",
    "t-1",
  ]);
  expect(absent.ok && absent.command === "review" && "model" in absent.args).toBe(false);
  const blank = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m",
    "--taskId",
    "t-1",
    "--model",
    "  ",
  ]);
  expect(blank).toEqual({
    ok: false,
    message: 'invalid --model "  ": must be a non-empty model id (free ids accepted)',
  });
});

test("缺必填旗标：--repo / （--mr-diff | --mr-json）/ --taskId", () => {
  expect(parseCliArgs(["review", "--mr-diff", "m.diff", "--taskId", "t-1"])).toEqual({
    ok: false,
    message: "missing required flag --repo",
  });
  expect(parseCliArgs(["review", "--repo", "r", "--taskId", "t-1"])).toEqual({
    ok: false,
    message: "missing required flag --mr-diff (or --mr-json)",
  });
  expect(parseCliArgs(["review", "--repo", "r", "--mr-diff", "m.diff"])).toEqual({
    ok: false,
    message: "missing required flag --taskId (output goes to <tasks root>/<taskId>)",
  });
});

test("smoke：窄旗标面（仅 --model / --config）；review 专属旗标对 smoke 是未知旗标", () => {
  const smoke = parseCliArgs(["smoke"]);
  expect(smoke).toEqual({ ok: true, command: "smoke", args: {} });
  const withModel = parseCliArgs(["smoke", "--model", "probe-model"]);
  expect(withModel).toEqual({ ok: true, command: "smoke", args: { model: "probe-model" } });
  expect(parseCliArgs(["smoke", "--repo", "r"])).toEqual({
    ok: false,
    message: 'unknown flag "--repo"',
  });
});

test("USAGE_TEXT：宣告三个子命令（stderr 错误路径同款文案，单一来源）", () => {
  expect(USAGE_TEXT).toContain("review-pi review --repo");
  expect(USAGE_TEXT).toContain("review-pi smoke");
  expect(USAGE_TEXT).toContain("review-pi config <init|show>");
  // 落盘位置只在 taskId 面上出现（--out 已从用法面移除）
  expect(USAGE_TEXT).toContain("--taskId <id>");
  expect(USAGE_TEXT).toContain("--tasks-dir <dir>");
  expect(USAGE_TEXT).not.toContain("--out ");
  // 一个包就是一个 skill（ADR-0034）：包内消歧旗标不再宣告
  expect(USAGE_TEXT).not.toContain("--rule-skill-name");
});

test("进度旗标：--progress / --no-progress 三态（缺省 = 自动）", () => {
  const auto = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
  ]);
  expect(auto.ok && auto.command === "review" && "progress" in auto.args).toBe(false);

  const on = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
    "--progress",
  ]);
  expect(on.ok && on.command === "review" && on.args.progress).toBe(true);

  const off = parseCliArgs([
    "review",
    "--repo",
    "r",
    "--mr-diff",
    "m.diff",
    "--taskId",
    "t-1",
    "--no-progress",
  ]);
  expect(off.ok && off.command === "review" && off.args.progress).toBe(false);
});

test("进度旗标：互斥与重复都是用法错误（fail fast，不静默取其一）", () => {
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m.diff",
      "--taskId",
      "t-1",
      "--progress",
      "--no-progress",
    ]),
  ).toEqual({ ok: false, message: "conflicting flags --progress and --no-progress" });
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m.diff",
      "--taskId",
      "t-1",
      "--progress",
      "--progress",
    ]),
  ).toEqual({ ok: false, message: "duplicate flag --progress" });
  expect(
    parseCliArgs([
      "review",
      "--repo",
      "r",
      "--mr-diff",
      "m.diff",
      "--taskId",
      "t-1",
      "--no-progress",
      "--no-progress",
    ]),
  ).toEqual({ ok: false, message: "duplicate flag --no-progress" });
});

test("进度旗标：smoke 面不认（只有 review 显示进度）", () => {
  expect(parseCliArgs(["smoke", "--progress"])).toEqual({
    ok: false,
    message: 'unknown flag "--progress"',
  });
  expect(parseCliArgs(["smoke", "--no-progress"])).toEqual({
    ok: false,
    message: 'unknown flag "--no-progress"',
  });
});

test("export 子命令：三个旗标全可选，缺省全缺席", () => {
  expect(parseCliArgs(["export"])).toEqual({
    ok: true,
    command: "export",
    args: {},
  });
  expect(
    parseCliArgs(["export", "--taskId", "t-1", "--tasks-dir", "D:/tasks", "--path", "out"]),
  ).toEqual({
    ok: true,
    command: "export",
    args: { taskId: "t-1", tasksDir: "D:/tasks", destPath: "out" },
  });
});

test("export 子命令：taskId 走 review 同口径校验；--path / --tasks-dir 不许空值", () => {
  expect(parseCliArgs(["export", "--taskId", "../escape"])).toEqual({
    ok: false,
    message: 'invalid --taskId "../escape": must not start with "." (task dirs stay visible in ~/.PiAgent/tasks)',
  });
  expect(parseCliArgs(["export", "--taskId", "a/b"])).toEqual({
    ok: false,
    message: 'invalid --taskId "a/b": must not contain path separators (taskId is a single directory name)',
  });
  expect(parseCliArgs(["export", "--tasks-dir", " "])).toEqual({
    ok: false,
    message: 'invalid --tasks-dir " ": must be a non-empty directory path',
  });
  expect(parseCliArgs(["export", "--path", " "])).toEqual({
    ok: false,
    message: 'invalid --path " ": must be a non-empty directory path',
  });
  expect(parseCliArgs(["export", "--config", "x.json"])).toEqual({
    ok: false,
    message: 'unknown flag "--config"',
  });
});
