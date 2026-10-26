import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import type { DispositionRecord } from "./record.js";
import {
  appendDispositionToStore,
  dispositionStorePath,
  DISPOSITION_STORE_FILENAME,
  loadDispositionStore,
  parseDispositionStore,
} from "./store.js";

// 处置库契约（#15）：append-only JSON 文件——只追加、绝不改写既有记录；
// 读取侧对条目做形状校验（store 是外部数据面，手工编辑/损坏要 fail fast
// 人话报错，带 entry 序号定位）。全部用临时目录（runs/ 在 .gitignore，
// 测试绝不读写真实 runs/）。

function recordFixture(overrides: Partial<DispositionRecord> = {}): DispositionRecord {
  return {
    source: "vul4j",
    caseId: "VUL4J-1",
    configId: "E",
    rep: 1,
    model: "deepseek-v4-flash",
    findingId: "F100",
    disposition: "accept",
    notedAt: "2026-10-19T10:30:00.000Z",
    ...overrides,
  };
}

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "review-pi-disposition-"));
  tempDirs.push(dir);
  return dir;
}

describe("dispositionStorePath", () => {
  test("布局：<out>/<experimentId>/dispositions.json（experimentId 目录下、与 runs/ 同层）", () => {
    expect(dispositionStorePath("review-pi-output", "review-pi-cli")).toBe(
      path.join("review-pi-output", "review-pi-cli", DISPOSITION_STORE_FILENAME),
    );
  });
});

describe("appendDispositionToStore / loadDispositionStore", () => {
  test("首次落库：无既有文件也正常——创建库文件（2 空格缩进 + 尾随换行）", async () => {
    const storePath = path.join(tempDir(), "dispositions.json");
    const record = recordFixture();
    const view = await appendDispositionToStore(storePath, record);
    expect(view).toEqual([record]);
    expect(readFileSync(storePath, "utf8")).toBe(`${JSON.stringify([record], null, 2)}\n`);
    expect(await loadDispositionStore(storePath)).toEqual([record]);
  });

  test("同一 finding 重复处置 = 追加新记录：既有记录零改写（append-only 纪律）", async () => {
    const storePath = path.join(tempDir(), "dispositions.json");
    const first = recordFixture({ disposition: "accept", notedAt: "2026-10-19T10:00:00.000Z" });
    const second = recordFixture({ disposition: "reject", notedAt: "2026-10-19T11:00:00.000Z" });
    const view = await appendDispositionToStore(storePath, first);
    await appendDispositionToStore(storePath, second);
    // 第一次返回的视图不受后续追加影响（每次都造新数组，绝不改既有记录）
    expect(view).toEqual([first]);
    expect(await loadDispositionStore(storePath)).toEqual([first, second]);
  });

  test("库文件缺席 → 空视图（首次落库前无文件是正常态）", async () => {
    expect(await loadDispositionStore(path.join(tempDir(), "nope.json"))).toEqual([]);
  });

  test("库文件不可解析 → 人话错误（含路径；追加路径同样先读到旧库才写）", async () => {
    const storePath = path.join(tempDir(), "dispositions.json");
    writeFileSync(storePath, "{oops", "utf8");
    await expect(loadDispositionStore(storePath)).rejects.toThrow("not valid JSON");
    await expect(appendDispositionToStore(storePath, recordFixture())).rejects.toThrow(
      "not valid JSON",
    );
  });
});

describe("parseDispositionStore（条目形状校验，外部数据面 fail fast）", () => {
  test("顶层非数组 → 人话错误", () => {
    expect(() => parseDispositionStore('{"a":1}', "s.json")).toThrow(
      "expected a JSON array of disposition records",
    );
  });

  test("坏条目带序号定位：非对象 / source / disposition / findingId / notedAt / configId / rep / 空白 note", () => {
    const base = recordFixture() as unknown as Record<string, unknown>;
    const bad = (mutate: (entry: Record<string, unknown>) => void): string => {
      const copy: Record<string, unknown> = JSON.parse(JSON.stringify(base));
      mutate(copy);
      return JSON.stringify([recordFixture(), copy]);
    };
    expect(() => parseDispositionStore("[3]", "s.json")).toThrow("entry #1: expected a JSON object");
    expect(() => parseDispositionStore(bad((e) => {
      e.source = "github";
    }), "s.json")).toThrow('entry #2: field "source"');
    expect(() => parseDispositionStore(bad((e) => {
      e.disposition = "ok";
    }), "s.json")).toThrow('entry #2: field "disposition"');
    expect(() => parseDispositionStore(bad((e) => {
      delete e.findingId;
    }), "s.json")).toThrow('entry #2: field "findingId"');
    expect(() => parseDispositionStore(bad((e) => {
      e.notedAt = "yesterday";
    }), "s.json")).toThrow('entry #2: field "notedAt"');
    expect(() => parseDispositionStore(bad((e) => {
      e.configId = "G";
    }), "s.json")).toThrow('entry #2: field "configId"');
    expect(() => parseDispositionStore(bad((e) => {
      e.rep = 0;
    }), "s.json")).toThrow('entry #2: field "rep"');
    expect(() => parseDispositionStore(bad((e) => {
      e.note = "  ";
    }), "s.json")).toThrow('entry #2: field "note"');
  });

  test("合法条目（note 缺席与在场）往返一致，键序保持", () => {
    const withNote = recordFixture({ note: "回归确认" });
    const parsed = parseDispositionStore(
      JSON.stringify([recordFixture(), withNote]),
      "s.json",
    );
    expect(parsed).toEqual([recordFixture(), withNote]);
    expect("note" in parsed[0]).toBe(false);
    expect(parsed[1].note).toBe("回归确认");
    expect(Object.keys(parsed[0])).toEqual([
      "source",
      "caseId",
      "configId",
      "rep",
      "model",
      "findingId",
      "disposition",
      "notedAt",
    ]);
  });
});
