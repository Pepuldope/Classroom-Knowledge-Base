#!/usr/bin/env bash
# test.sh — combined test gate for the Classroom Knowledge Base.
# Runs the fast API tests + the real-browser UI e2e (local), and optionally the
# live-site e2e (only if KB_LIVE_URL is set). Used by the autonomous loop's
# verification step and by `scripts/guard.py`.
#
# Usage: bash scripts/test.sh [port]
#   port  defaults to 4321 (the dev-server port)
set -u
PORT="${1:-4321}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

# Playwright browsers live in the repo's .pw-browsers (the default system
# cache at /opt/hermes is root-owned and not writable by the agent).
export PLAYWRIGHT_BROWSERS_PATH="${PLAYWRIGHT_BROWSERS_PATH:-$ROOT/.pw-browsers}"

echo "==> API / retrieval tests"
node scripts/kb_e2e_test.mjs
API_OK=$?
if [ "$API_OK" -ne 0 ]; then echo "API tests FAILED"; exit 1; fi

echo "==> Starting dev server on :$PORT"
node scripts/dev-server.mjs "$PORT" > /tmp/kb_dev.log 2>&1 &
SRV=$!
# wait for server
for i in $(seq 1 30); do
  curl -s --max-time 2 "http://localhost:$PORT/api/oauth-config" >/dev/null && break
  sleep 0.5
done

echo "==> Seeding dev data"
node scripts/seed-dev.mjs "$PORT" 400 >/dev/null 2>&1

echo "==> Browser UI e2e (local)"
BASE_URL="http://localhost:$PORT" node scripts/kb_ui_test.mjs
UI_OK=$?

echo "==> KB loading-state e2e (local)"
BASE_URL="http://localhost:$PORT" node scripts/kb_loading_test.mjs
LOAD_OK=$?
if [ "$LOAD_OK" -ne 0 ]; then echo "loading e2e FAILED"; kill "$SRV" 2>/dev/null; exit 1; fi

kill "$SRV" 2>/dev/null

if [ "$UI_OK" -ne 0 ]; then echo "UI e2e FAILED"; exit 1; fi

echo "==> Live-site e2e (skipped if KB_LIVE_URL unset)"
if [ -z "${KB_LIVE_URL:-}" ]; then
  echo "[live] KB_LIVE_URL unset — skipping live verification."
  LIVE_OK=0
else
  node scripts/kb_live_test.mjs
  LIVE_OK=$?
fi

if [ "$LIVE_OK" -ne 0 ]; then
  echo "LIVE E2E FAILED (production regression detected)"
  exit 1
fi

echo "ALL TESTS PASSED"
