import { describe, expect, it } from "vitest";

import type { ReviewCliArgs } from "./args.js";
import { formatReviewArgs, type ReviewArgsEcho } from "./args-echo.js";

/**
 * 参数回显的对外契约：一行一个旗标、值已解析/已落成生效值、可重复旗标全列、
 * `--issue` 多行不破行。stdout 契约与本模块无关（只产 stderr 文本）。
 */

const FLAG_WIDTH = 20;
const row = (label: string, value: string): string => `  ${label.padEnd(FLAG_WIDTH)}${value}`;

const BASE_ARGS: ReviewCliArgs = {
  repo: "repo",
  mr: "in/VUL4J-1.diff",
  caseId: "VUL4J-1",
  issue: "",
  taskId: "VUL4J-1",
};

function echo(overrides: Partial<ReviewArgsEcho> = {}): ReviewArgsEcho {
  return {
    repoPath: "D:\\repo",
    mrPath: "D:\\in\\VUL4J-1.diff",
    taskId: "VUL4J-1",
    tasksRoot: "C:\\Users\\me\\.PiAgent\\tasks",
    tasksDirFromFlag: false,
    configPath: "C:\\Users\\me\\.PiAgent\\PiAgent.jsonc",
    modelId: "deepseek-v4-flash",
    modelFromFlag: false,
    configFromFlag: false,
    progressOn: false,
    progressExplicit: false,
    stderrIsTty: false,
    ...overrides,
  };
}

describe("formatReviewArgs", () => {
  it("统一 diff 形态：全部旗标各占一行，缺省值标注来源", () => {
    const lines = formatReviewArgs(BASE_ARGS, echo()).split("\n");
    expect(lines[0]).toBe("review-pi: 本次 review 传入参数");
    expect(lines).toContain(row("--repo", "D:\\repo"));
    expect(lines).toContain(row("--mr-diff", "D:\\in\\VUL4J-1.diff"));
    expect(lines).toContain(row("caseId", "VUL4J-1"));
    expect(lines).toContain(row("--issue", "(未传)"));
    expect(lines).toContain(row("--taskId", "VUL4J-1"));
    expect(lines).toContain(
      row("--tasks-dir", "C:\\Users\\me\\.PiAgent\\tasks（缺省：~/.PiAgent/tasks）"),
    );
    expect(lines).toContain(row("--model", "deepseek-v4-flash（缺省：配置文件 model.default）"));
    expect(lines).toContain(row("--config", "C:\\Users\\me\\.PiAgent\\PiAgent.jsonc（缺省用户级路径）"));
    expect(lines).toContain(row("--rule-skill-zip", "(未传)"));
    expect(lines).toContain(row("--rule-skill", "(未传)"));
    expect(lines).toContain(row("--strict-rule-skill", "未启用"));
    expect(lines).toContain(row("--progress", "关（缺省自动：stderr 非 TTY）"));
    // 头部 + 12 个参数行（--taskId / --tasks-dir 取代原 --out；--rule-skill-name 随 ADR-0034 移除）
    expect(lines).toHaveLength(13);
  });

  it("JSON 形态：标签换成 --mr-json；--issue 多行转义后不破行", () => {
    const text = formatReviewArgs(
      {
        ...BASE_ARGS,
        mrFormat: "json",
        mr: "in/files.json",
        issue: "第一行\n第二行",
      },
      echo({ mrPath: "D:\\in\\files.json" }),
    );
    expect(text).toContain(row("--mr-json", "D:\\in\\files.json"));
    expect(text).toContain(row("--issue", '"第一行\\n第二行"'));
    expect(text.split("\n")).toHaveLength(13);
  });

  it("显式参数：不带缺省标注，可重复旗标按传入顺序全列", () => {
    const text = formatReviewArgs(
      {
        ...BASE_ARGS,
        model: "glm-5.3",
        configPath: "cfg/team.jsonc",
        ruleSkillZips: ["a.zip", "b.zip"],
        ruleSkillDirs: ["rules"],
        strictRuleSkill: true,
        progress: true,
      },
      echo({
        modelId: "glm-5.3",
        modelFromFlag: true,
        configFromFlag: true,
        tasksDirFromFlag: true,
        progressOn: true,
        progressExplicit: true,
      }),
    );
    expect(text.split("\n")).toContain(row("--model", "glm-5.3"));
    expect(text.split("\n")).toContain(row("--config", "C:\\Users\\me\\.PiAgent\\PiAgent.jsonc"));
    expect(text.split("\n")).toContain(row("--tasks-dir", "C:\\Users\\me\\.PiAgent\\tasks"));
    expect(text).toContain(row("--rule-skill-zip", "a.zip, b.zip"));
    expect(text).toContain(row("--rule-skill", "rules"));
    expect(text).toContain(row("--strict-rule-skill", "已启用"));
    expect(text.split("\n")).toContain(row("--progress", "开"));
  });
});
