#!/usr/bin/env node
/**
 * OpenCode 兼容会话的真机验证（ADR-0072 验收 6，opt-in）：不参与常规 CI，
 * 需要本机有 `opencode` 二进制与已构建的 `packages/review-pi/dist`。
 *
 * 用法：
 *   node scripts/opencode-compat/verify.mjs <native-transcript.json>
 *
 * 行为：
 *   1. 从原生转录重建 `info` + 原生 `messages`，调用 `buildOpenCodeSession`
 *      生成 `{ info, messages }` 兼容文件；
 *   2. 用隔离的 XDG_DATA_HOME（本机真实库零污染）跑
 *      `opencode --standalone session import`；
 *   3. `session export` 回读，断言消息条数一致且文档无 `null`。
 *
 * 依赖：先 `pnpm --filter @baize/review-pi build`（本脚本从 dist 导入，
 * 不重复编译 TS）。
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = path.join(repoRoot, "packages", "review-pi", "dist", "export", "opencode-compat.js");

const { buildOpenCodeSession } = await import(pathToFileURL(dist).href).catch((error) => {
  console.error(
    `无法从 dist 导入 buildOpenCodeSession（${error.message}）。请先运行：` +
      `pnpm --filter @baize/review-pi build`,
  );
  process.exit(2);
});

const transcriptPath = process.argv[2];
if (transcriptPath === undefined) {
  console.error("usage: node scripts/opencode-compat/verify.mjs <native-transcript.json>");
  process.exit(2);
}

const doc = JSON.parse(readFileSync(path.resolve(transcriptPath), "utf8"));
const info = doc.info;
const systemPrompt = doc.messages[0].content;
const messages = doc.messages.slice(1);

const session = buildOpenCodeSession({ info, systemPrompt, messages });

const workDir = mkdtempSync(path.join(tmpdir(), "oc-verify-"));
try {
  const compatFile = path.join(workDir, `${info.id}.json`);
  writeFileSync(compatFile, `${JSON.stringify(session, null, 2)}\n`, "utf8");

  const env = {
    ...process.env,
    XDG_DATA_HOME: path.join(workDir, "data"),
    XDG_CONFIG_HOME: path.join(workDir, "config"),
    XDG_STATE_HOME: path.join(workDir, "state"),
  };

  const run = (args) => spawnSync("opencode", args, { shell: true, env, encoding: "utf8" });

  const importRun = run(["--standalone", "session", "import", compatFile]);
  if (importRun.status !== 0) {
    console.error(`import 失败（exit ${importRun.status}）:\n${importRun.stdout}${importRun.stderr}`);
    process.exit(1);
  }
  console.log(`imported: ${info.id}`);

  const exportFile = path.join(workDir, "export.json");
  const exportRun = run(["--standalone", "session", "export", info.id]);
  if (exportRun.status !== 0) {
    console.error(`export 失败（exit ${exportRun.status}）:\n${exportRun.stdout}${exportRun.stderr}`);
    process.exit(1);
  }
  writeFileSync(exportFile, exportRun.stdout, "utf8");
  const roundtrip = JSON.parse(readFileSync(exportFile, "utf8").replace(/^\uFEFF/, ""));
  if (roundtrip.messages.length !== session.messages.length) {
    console.error(
      `消息条数不一致：生成 ${session.messages.length}，回读 ${roundtrip.messages.length}`,
    );
    process.exit(1);
  }
  if (JSON.stringify(roundtrip).includes(":null")) {
    console.error("回读文档含 null（非 import-clean）");
    process.exit(1);
  }
  console.log(
    `roundtrip ok: ${roundtrip.messages.length} messages, ` +
      `${roundtrip.messages.map((message) => message.type).join(",")}`,
  );
} finally {
  rmSync(workDir, { recursive: true, force: true });
}
