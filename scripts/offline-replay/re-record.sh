#!/usr/bin/env bash
# 重录一个场景并自检（ADR-0090 中文原生重录）：
#   record（真网关，跳过断言）→ 从产物提取期望 → 更新场景 → once 自检
# 用法：bash scripts/offline-replay/re-record.sh <scenario-name>
set -euo pipefail
cd "$(dirname "$0")/../.."

NAME="$1"
SCENARIO="scripts/offline-replay/scenarios/${NAME}.json"
TRACE="packages/review-pi/testdata/traces/${NAME}.json"

echo "=== [1/4] record ${NAME}（真网关） ==="
REPLAY_UPSTREAM_BASE_URL="${REPLAY_UPSTREAM_BASE_URL:?需设置 REPLAY_UPSTREAM_BASE_URL}" \
REPLAY_UPSTREAM_API_KEY="${REPLAY_UPSTREAM_API_KEY:?需设置 REPLAY_UPSTREAM_API_KEY}" \
node scripts/offline-replay/run.mjs record --scenario "$SCENARIO" \
  --skip-assert --no-verify --timeout-ms 900000

RUN_DIR=$(ls -dt "replay-runs"/*"-${NAME}" | head -1)
LANE_TASKS="${RUN_DIR}/workers/record/tasks/t-1"
echo "=== [2/4] 提取期望（${LANE_TASKS}） ==="
node scripts/offline-replay/expect-from-run.mjs "$LANE_TASKS" > "${RUN_DIR}/expect.json"
cat "${RUN_DIR}/expect.json"

echo "=== [3/4] 更新场景期望 ==="
node -e "
const fs = require('node:fs');
const scenarioPath = process.argv[1];
const expectPath = process.argv[2];
const scenario = JSON.parse(fs.readFileSync(scenarioPath, 'utf8'));
const expect = JSON.parse(fs.readFileSync(expectPath, 'utf8'));
if (scenario.mcp.mode === 'off') {
  expect.mcpCalls = [];
  delete expect.mcpFilePathCounts;
}
scenario.expect = expect;
fs.writeFileSync(scenarioPath, JSON.stringify(scenario, null, 2) + '\n');
console.log('scenario updated:', scenarioPath);
" "$SCENARIO" "${RUN_DIR}/expect.json"

echo "=== [4/4] once 自检 ==="
node scripts/offline-replay/run.mjs once --scenario "$SCENARIO"
