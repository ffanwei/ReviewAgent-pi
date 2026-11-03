import { describe, expect, test } from "vitest";

import { checkTaskId, resolveTasksRoot, taskDirPath, TASK_ID_MAX_CHARS } from "./tasks-dir.js";

describe("resolveTasksRoot：缺省 `<home>/.PiAgent/tasks`", () => {
  test("Windows 读 USERPROFILE、POSIX 读 HOME", () => {
    expect(
      resolveTasksRoot({ env: { USERPROFILE: "C:\\Users\\Li" }, platform: "win32" }),
    ).toBe("C:\\Users\\Li\\.PiAgent\\tasks");
    expect(resolveTasksRoot({ env: { HOME: "/home/li" }, platform: "linux" })).toBe(
      "/home/li/.PiAgent/tasks",
    );
  });

  test("--tasks-dir 相对路径按 cwd 解析，且不碰 home", () => {
    expect(
      resolveTasksRoot({ tasksDir: "sandbox/tasks", cwd: "C:\\work", env: {}, platform: "win32" }),
    ).toBe("C:\\work\\sandbox\\tasks");
    expect(
      resolveTasksRoot({ tasksDir: "/tmp/tasks", cwd: "/work", env: {}, platform: "linux" }),
    ).toBe("/tmp/tasks");
  });

  test("home 为空 = fail fast（提示 --tasks-dir，不猜路径）", () => {
    expect(() => resolveTasksRoot({ env: {}, platform: "linux" })).toThrow(/--tasks-dir/);
    expect(() =>
      resolveTasksRoot({ env: { USERPROFILE: "  " }, platform: "win32" }),
    ).toThrow(/--tasks-dir/);
  });
});

describe("taskDirPath：tasks 根 + 单段 taskId", () => {
  test("拼接即落盘根（其下仍是 runs/ + audit/）", () => {
    expect(taskDirPath("C:\\Users\\Li\\.PiAgent\\tasks", "VUL4J-38")).toBe(
      "C:\\Users\\Li\\.PiAgent\\tasks\\VUL4J-38",
    );
  });
});

describe("checkTaskId：单段目录名校验", () => {
  test("常见形态通过（含中文与空格）", () => {
    for (const raw of ["VUL4J-38", "mr_1234", "review.2026-11-03", "登录超时修复", "sp 1"]) {
      expect(checkTaskId(raw)).toEqual({ ok: true, taskId: raw });
    }
  });

  test("首尾空白被 trim", () => {
    expect(checkTaskId("  t-1  ")).toEqual({ ok: true, taskId: "t-1" });
  });

  test("空串 / 纯空白 = 拒绝", () => {
    for (const raw of ["", "   "]) {
      expect(checkTaskId(raw)).toMatchObject({ ok: false });
    }
  });

  test("超长 = 拒绝", () => {
    const long = "a".repeat(TASK_ID_MAX_CHARS + 1);
    expect(checkTaskId(long)).toMatchObject({ ok: false, message: expect.stringContaining("at most") });
  });

  test("路径拐弯一律拒绝", () => {
    for (const raw of [".", "..", "../x", "a/b", "a\\b", "C:\\abs", "C:x", "/abs", "..\\x"]) {
      expect(checkTaskId(raw)).toMatchObject({ ok: false });
    }
  });

  test("隐藏目录名（前导点）= 拒绝", () => {
    expect(checkTaskId(".cache")).toMatchObject({ ok: false, message: expect.stringContaining('"') });
  });

  test("控制字符与 Windows 非法字符 = 拒绝", () => {
    for (const raw of ["a\u0000b", "a\nb", "a<b", "a>b", "a:b", "a|b", "a?b", "a*b", 'a"b']) {
      expect(checkTaskId(raw)).toMatchObject({ ok: false });
    }
  });

  test("Windows 保留设备名 = 拒绝（大小写不敏感、带扩展名同样拒绝）", () => {
    for (const raw of ["CON", "con", "nul", "COM1", "lpt9", "con.txt", "aux.log"]) {
      expect(checkTaskId(raw)).toMatchObject({ ok: false, message: expect.stringContaining("reserved") });
    }
    // 只是前缀相似不算保留名
    expect(checkTaskId("console")).toEqual({ ok: true, taskId: "console" });
  });

  test("尾随点 = 拒绝（Windows 会静默裁掉）", () => {
    expect(checkTaskId("task.")).toMatchObject({ ok: false });
  });

  test("首尾空格被 trim 后合法（空格不进入目录名）", () => {
    expect(checkTaskId("task ")).toEqual({ ok: true, taskId: "task" });
  });
});
